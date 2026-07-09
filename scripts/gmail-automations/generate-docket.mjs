// Reads denovosourcing@gmail.com for incoming PO emails (a CSV of order rows
// plus a PDF PO confirmation, occasionally with an extra "sustainability"
// PDF attached alongside it) and automates what the "Generate Dockets &
// Import Orders" button in web/index.html does by hand: parses both
// attachments, looks up style_no/CMT per style from style_costings and
// fabrication per style from the PDF's own "Product Code / Fabrication"
// table, builds the Excel docket workbook, uploads it to Supabase Storage, and
// upserts orders rows (new orders default to Pending, per the stage
// lifecycle in CLAUDE.md). Runs hourly from
// .github/workflows/gmail-automations.yml on a normal GitHub-hosted runner.
//
// No LLM judgment step here, unlike the other two automations: a CSV
// attachment matching the order-rows shape is a deterministic signal, so
// there's no ambiguous free text to classify.
//
// Writes to Supabase directly with the service-role key (bypasses RLS and
// the enforce_role_scoped_order_update trigger, same as the other
// automations' edge functions -- see
// supabase/migrations/20260703000000_trigger_allow_service_role.sql)
// instead of going through a bespoke edge function: the payload here is a
// binary xlsx file plus many order rows per thread, much bigger than the
// other automations' tiny {po, style_no} JSON bodies.
import { createClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
// Same library and version as the browser's extractPdfText() in
// web/index.html (loaded there from a CDN). This matters: pdf.js forces a
// space between every text item it extracts, which several of the regexes
// below (extractPpuValue, extractFabricByProductCode) depend on -- a
// same-ish-language alternative (pdf-parse) was tried first and silently
// glued adjacent table cells together with no separator at all (e.g.
// "CNJ8909/4/72Bengaline", "20Each7.50"), breaking those regexes.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  getAccessToken,
  searchThreads,
  getThread,
  modifyThreadLabels,
  listAttachments,
  getAttachment,
  getOrCreateLabel,
} from './lib/google.mjs';

const SEARCH_QUERY = 'filename:csv -label:Docket-Processed -label:Docket-Needs-Review';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://sfwnmddlmiprvsoxbatz.supabase.co';

const DEFAULT_FABRIC = 'Bengaline';
const FALLBACK_DOCKET_BASE = 241; // matches nextDocketNumber() in web/index.html

// ── Ported from web/index.html (runImport / buildDocketWorkbook et al.) ──────
// Kept as a self-contained copy rather than a shared module: the website has
// no build step (single inline <script>) and this runs in Node, so there's
// no runtime the two could actually share. See CLAUDE.md's "gotchas" for the
// ex_factory YYYY-DD-MM quirk mirrored in ukDateToIso() below.

function isD5StyleNo(ref) {
  return ref && /^D\d+$/i.test(ref.trim());
}

function parseCSV(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const headers = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim());
  return lines.slice(1).map((line) => {
    const vals = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { vals.push(cur); cur = ''; }
      else cur += ch;
    }
    vals.push(cur);
    const row = {};
    headers.forEach((h, i) => (row[h] = (vals[i] || '').replace(/^"|"$/g, '').trim()));
    return row;
  });
}

function pickColourCol(row) {
  const candidates = ['colour', 'color', 'productColour', 'productColor', 'variantColour', 'variantColor', 'colourName', 'colorName', 'colourway', 'colorway'];
  const keys = Object.keys(row).map((k) => k.toLowerCase());
  for (const c of candidates) {
    const idx = keys.indexOf(c.toLowerCase());
    if (idx !== -1) return Object.keys(row)[idx];
  }
  return null;
}

function extractSizeFromName(name) {
  const m = String(name).match(/-(\d+)\s*$/);
  return m ? m[1] : null;
}

function extractColourFromName(name) {
  const parts = String(name).replace(/-\d+\s*$/, '').trim().split(/\s+/);
  return parts[parts.length - 1] || 'Unknown';
}

function skuFromProductCode(code) {
  return String(code).split('/')[0].trim();
}

function buildPltImageUrl(sku, colour) {
  if (!sku || !colour) return '';
  const s = sku.toLowerCase();
  const c = colour.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  return `https://mediahub.prettylittlething.com/${s}_${c}_xl?qlt=70&w=1200&ssz=true&dpr=1`;
}

function extractFirstDate(label, text) {
  const re = new RegExp(label.replace(/\s/g, '\\s*') + '[:\\s]*([\\d]{2}/[\\d]{2}/[\\d]{4})', 'i');
  const m = text.match(re);
  return m ? m[1] : '';
}

function extractPpuValue(text) {
  const matches = [...text.matchAll(/\bEach\s+£?\s*(\d+(?:\.\d{1,2})?)\b/gi)];
  if (!matches.length) return null;
  return parseFloat(matches[matches.length - 1][1]);
}

function ukDateToIso(d) {
  const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : d;
}

// Mirrors extractPdfText() in web/index.html exactly (see import comment
// above for why the item.str.join(' ') matters).
async function extractPdfText(buffer) {
  const pdf = await getDocument({ data: new Uint8Array(buffer) }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((item) => item.str).join(' ') + '\n';
  }
  return text;
}

// Only the live docket series counts: rows imported from the old Completed
// Orders sheet carry unrelated docket numbers (up to 20512), so restrict to
// source_tab OPO -- the tab every generated docket row is written to. Null
// dockets must be excluded explicitly: they sort FIRST in a bare descending
// order (Postgres NULLS FIRST), which made this fall back to 241 and stamp
// every docket #242.
async function nextDocketNumber(supabase) {
  const { data } = await supabase.from('orders').select('docket')
    .eq('source_tab', 'OPO').not('docket', 'is', null)
    .order('docket', { ascending: false }).limit(1);
  const max = data?.[0]?.docket ?? FALLBACK_DOCKET_BASE;
  return max + 1;
}

async function lookupCosting(supabase, sku, styleNo) {
  if (sku) {
    const { data } = await supabase.from('style_costings').select('style_no, cmt, price').ilike('style', sku).limit(1);
    if (data?.[0]) return data[0];
  }
  if (styleNo && isD5StyleNo(styleNo)) {
    const { data } = await supabase.from('style_costings').select('style_no, cmt, price').ilike('style_no', styleNo).limit(1);
    if (data?.[0]) return data[0];
  }
  return null;
}

// The PO PDF carries a "Product Code / Fabric Weight / Fabrication /
// Workbook Ref" table (after the per-style sustainability section) with one
// row per productCode -- only Product Code and Fabrication are ever
// populated. Text extraction flattens the table, so this walks tokens after
// the "Fabric Weight Fabrication" header and, for each known productCode
// (from the CSV), collects the word(s) immediately following it up to the
// next productCode-shaped token (one containing a digit or "/") or a stop
// word from the trailing "Deliver To:" section.
function extractFabricByProductCode(text, productCodes) {
  const headerIdx = text.search(/Fabric\s*Weight\s*Fabrication/i);
  if (headerIdx === -1) return {};
  const tokens = text.slice(headerIdx).split(/\s+/).filter(Boolean);
  const knownCodes = new Map(productCodes.map((c) => [c.toUpperCase(), c]));
  const stopWords = /^(Deliver|Styles|This|Workbook)/i;

  const result = {};
  let i = 0;
  while (i < tokens.length) {
    const original = knownCodes.get(tokens[i].toUpperCase());
    if (!original) { i++; continue; }

    const words = [];
    let j = i + 1;
    while (j < tokens.length && words.length < 3) {
      const next = tokens[j];
      if (/[\d/]/.test(next) || stopWords.test(next)) break;
      words.push(next);
      j++;
    }
    if (words.length) result[original] = words.join(' ');
    i = j;
  }
  return result;
}

// Same layout as buildDocketWorkbook in web/index.html, except fabrication
// is per-row (read straight out of the PO PDF's "Product Code / Fabrication"
// table, see extractFabricByProductCode) instead of one value for the whole
// import -- the manual UI only ever had a single text input to fill in.
async function buildDocketWorkbook(docketNumber, poNumber, dateOrdered, exFactory, description, rows) {
  const wb = new ExcelJS.Workbook();
  const thin = { style: 'thin', color: { argb: 'FF000000' } };
  const border = { top: thin, bottom: thin, left: thin, right: thin };
  const grayFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E5E5' } };
  const tnrBold = (size) => ({ name: 'Times New Roman', bold: true, size });
  const tnr = (size) => ({ name: 'Times New Roman', bold: false, size });

  for (const { styleNo, colourSkuMap, sizeTable, colourTotals, totalUnits, sizes, fabrication } of rows) {
    const skuDisplay = Object.entries(colourSkuMap).map(([c, s]) => (s ? `${c}: ${s}` : `${c}: (blank)`)).join(' | ');
    const displaySizes = sizes.slice(0, 13);
    const ncols = displaySizes.length + 1;

    const ws = wb.addWorksheet(String(styleNo || 'Sheet').slice(0, 31));
    ws.pageSetup.orientation = 'landscape';
    ws.pageSetup.fitToPage = true;
    ws.pageSetup.fitToWidth = 1;
    ws.pageSetup.fitToHeight = 0;

    ws.columns = [{ width: 20 }, { width: 15 }, ...displaySizes.slice(1).map(() => ({ width: 13 }))];

    ws.addRow([`DOCKET SHEET #${docketNumber}`]);
    ws.mergeCells(1, 1, 1, ncols);
    const t = ws.getCell('A1');
    t.font = tnrBold(18);
    t.alignment = { horizontal: 'center', vertical: 'middle' };
    t.border = border;
    ws.getRow(1).height = 20;

    ws.addRow([]);

    const meta = [
      ['DATE:', dateOrdered],
      ['EX-FACTORY DATE:', exFactory],
      ['PO NUMBER:', poNumber],
      ['STYLE NO.:', styleNo],
      ['SKU:', skuDisplay],
      ['DESCRIPTION:', description],
      ['SUPPLIER:', 'Denovo Sourcing Limited'],
      ['FABRICATION:', fabrication],
    ];
    for (const [label, value] of meta) {
      const rn = ws.rowCount + 1;
      ws.addRow([label, String(value || '')]);
      ws.getRow(rn).height = 25.5;
      const lc = ws.getRow(rn).getCell(1);
      const vc = ws.getRow(rn).getCell(2);
      lc.font = tnrBold(12); lc.alignment = { horizontal: 'left', vertical: 'middle' }; lc.border = border;
      vc.font = tnr(12); vc.alignment = { horizontal: 'left', vertical: 'top' }; vc.border = border;
    }

    ws.addRow([]);

    const shrn = ws.rowCount + 1;
    ws.addRow(['SIZE', ...displaySizes]);
    ws.getRow(shrn).height = 39.75;
    for (let c = 1; c <= ncols; c++) {
      const cell = ws.getRow(shrn).getCell(c);
      cell.font = tnrBold(12); cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.fill = grayFill; cell.border = border;
    }

    for (const [colour, qtyMap] of Object.entries(sizeTable)) {
      const rn = ws.rowCount + 1;
      ws.addRow([colour, ...displaySizes.map((s) => qtyMap[s] || 0)]);
      ws.getRow(rn).height = 30;
      ws.getRow(rn).getCell(1).font = tnrBold(12);
      ws.getRow(rn).getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
      ws.getRow(rn).getCell(1).border = border;
      for (let c = 2; c <= ncols; c++) {
        const cell = ws.getRow(rn).getCell(c);
        cell.font = { name: 'Calibri', bold: false, size: 11 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = border;
      }
    }

    const crn = ws.rowCount + 1;
    ws.addRow(['Cut', ...displaySizes.map(() => '')]);
    ws.getRow(crn).height = 39.75;
    for (let c = 1; c <= ncols; c++) {
      const cell = ws.getRow(crn).getCell(c);
      cell.fill = grayFill; cell.border = border;
      if (c === 1) { cell.font = tnrBold(12); cell.alignment = { horizontal: 'center', vertical: 'middle' }; }
    }

    ws.addRow([]);

    const prn = ws.rowCount + 1;
    ws.addRow(['Packed Qty', ...displaySizes.map(() => '')]);
    ws.getRow(prn).height = 39.75;
    for (let c = 1; c <= ncols; c++) {
      const cell = ws.getRow(prn).getCell(c);
      cell.fill = grayFill; cell.border = border;
      if (c === 1) { cell.font = tnrBold(12); cell.alignment = { horizontal: 'center', vertical: 'middle' }; }
    }

    ws.addRow([]);
    ws.addRow([]);

    const trn = ws.rowCount + 1;
    const totalParts = Object.entries(colourTotals).map(([c, q]) => `${c} ${q}`).join(' | ');
    ws.addRow([`TOTAL UNITS: ${totalParts} | TOTAL ${totalUnits}`]);
    ws.mergeCells(trn, 1, trn, ncols);
    ws.getRow(trn).height = 33.75;
    const tc = ws.getRow(trn).getCell(1);
    tc.font = tnrBold(12); tc.alignment = { horizontal: 'center', vertical: 'middle' }; tc.border = border;
  }

  return wb.xlsx.writeBuffer();
}

// ── PDF text extraction + PO-confirmation detection ───────────────────────
// A thread may carry an extra "sustainability" PDF alongside the real PO
// confirmation. Score each PDF attachment by how many of the three fields
// we can pull out of it and keep the best-scoring one, rather than assuming
// anything about filenames or attachment order.
async function extractBestPdf(accessToken, messageId, pdfAttachments) {
  let best = { text: '', dateOrdered: '', exFactoryRaw: '', ppu: null, score: -1 };
  for (const att of pdfAttachments) {
    let text;
    try {
      const buffer = await getAttachment(accessToken, messageId, att.attachmentId);
      text = await extractPdfText(buffer);
    } catch (err) {
      console.error(`  failed to parse PDF attachment "${att.filename}": ${err.message}`);
      continue;
    }
    const dateOrdered = extractFirstDate('Date Order Placed', text);
    const exFactoryRaw = extractFirstDate('Ex Factory Date', text);
    const ppu = extractPpuValue(text);
    const score = (dateOrdered ? 1 : 0) + (exFactoryRaw ? 1 : 0) + (ppu ? 1 : 0);
    if (score > best.score) best = { text, dateOrdered, exFactoryRaw, ppu, score };
  }
  return best;
}

async function processThread(accessToken, supabase, thread) {
  const full = await getThread(accessToken, thread.id);
  const latest = full.messages[full.messages.length - 1];
  const attachments = listAttachments(latest);

  const csvAttachment = attachments.find((a) => a.filename.toLowerCase().endsWith('.csv'));
  if (!csvAttachment) {
    return { status: 'needs_review', reason: 'matched search but no CSV attachment on the latest message' };
  }
  const pdfAttachments = attachments.filter((a) => a.filename.toLowerCase().endsWith('.pdf'));

  const csvBuffer = await getAttachment(accessToken, latest.id, csvAttachment.attachmentId);
  const rows = parseCSV(csvBuffer.toString('utf-8'));
  if (!rows.length) {
    return { status: 'needs_review', reason: 'CSV attachment was empty or unparseable' };
  }

  const poNumber = rows[0]['PONumber'] || rows[0]['poNumber'] || rows[0]['ponumber'] || '';
  if (!poNumber) {
    return { status: 'needs_review', reason: 'CSV had no PO number column' };
  }

  // Guards against reprocessing a PO that was already imported (manually,
  // before this automation existed, or via a resent email that landed in a
  // new thread without the Docket-Processed label) -- without this we'd
  // hand out a fresh docket number and duplicate the workbook every time.
  const { data: existing } = await supabase.from('orders').select('id').eq('po', poNumber).not('docket', 'is', null).limit(1);
  if (existing?.length) {
    return { status: 'skipped_existing', poNumber, reason: `PO ${poNumber} already has a docket -- skipping to avoid renumbering` };
  }

  let dateOrdered = '', exFactoryRaw = '', ppu = null, ambiguousPdf = false;
  let fabricByProductCode = {};
  if (pdfAttachments.length) {
    const best = await extractBestPdf(accessToken, latest.id, pdfAttachments);
    dateOrdered = best.dateOrdered;
    exFactoryRaw = best.exFactoryRaw;
    ppu = best.ppu;
    if (best.score === 0) ambiguousPdf = true;
    const productCodes = [...new Set(rows.map((r) => r['productCode'] || r['productcode']).filter(Boolean))];
    fabricByProductCode = extractFabricByProductCode(best.text, productCodes);
  } else {
    ambiguousPdf = true;
  }

  const colourColSample = pickColourCol(rows[0]);
  const allColours = new Set(rows.map((r) => (colourColSample ? r[colourColSample] : extractColourFromName(r['productName']))).filter(Boolean));
  const colourList = [...allColours].sort();

  const allColoursLower = new Set([...allColours].map((c) => c.toLowerCase()));
  const stripColours = (n) => {
    const parts = n.split(/\s+/);
    if (parts.length && allColoursLower.has(parts[parts.length - 1].toLowerCase())) parts.pop();
    let result = parts.join(' ');
    const variants = [...allColours].flatMap((c) => [c, c.charAt(0) + c.slice(1).toLowerCase()]);
    let prev;
    do {
      prev = result;
      for (const v of variants) {
        const re = new RegExp('^' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i');
        result = result.replace(re, '').trim();
      }
    } while (result !== prev);
    return result;
  };
  const baseDesc = rows.map((r) => {
    const n = String(r['productName'] || '').replace(/-\d+\s*$/, '').trim();
    return stripColours(n);
  }).sort((a, b) => rows.filter((r) => r.productName?.includes(b)).length - rows.filter((r) => r.productName?.includes(a)).length)[0] || '';

  const descDisplay = `${colourList.join('/')} ${baseDesc}`.trim();

  const docketNumber = await nextDocketNumber(supabase);

  const groups = {};
  for (const row of rows) {
    const ref = row['supplierRef'] || row['SupplierRef'] || 'Unknown';
    if (!groups[ref]) groups[ref] = [];
    groups[ref].push(row);
  }

  const docketRows = [];
  const dbRows = [];
  let anyMissingCosting = false;
  let anyMissingFabric = false;

  for (const [supplierRef, group] of Object.entries(groups)) {
    const colourCol = pickColourCol(group[0]);
    const colourSkuMap = {};
    for (const r of group) {
      const colour = (colourCol ? r[colourCol] : extractColourFromName(r['productName'])).toUpperCase();
      const sku = skuFromProductCode(r['productCode'] || r['productcode'] || '');
      if (!colourSkuMap[colour]) colourSkuMap[colour] = sku;
    }

    const skuForDb = supplierRef.toUpperCase();
    const costing = await lookupCosting(supabase, supplierRef, isD5StyleNo(supplierRef) ? supplierRef : null);
    const styleNo = costing?.style_no || (isD5StyleNo(supplierRef) ? supplierRef : null);
    const costingCmt = costing?.cmt ?? null;
    if (!costing) anyMissingCosting = true;

    // All sizes of a style share one fabrication in this PO's table, so any
    // row in the group resolves it -- try each until one hits.
    const fabrication = group.map((r) => fabricByProductCode[r['productCode'] || r['productcode']]).find(Boolean) || DEFAULT_FABRIC;
    if (!group.some((r) => fabricByProductCode[r['productCode'] || r['productcode']])) anyMissingFabric = true;

    const sizeTable = {};
    const sizesSet = new Set();
    for (const r of group) {
      const colour = (colourCol ? r[colourCol] : extractColourFromName(r['productName'])).toUpperCase();
      const size = extractSizeFromName(r['productName']);
      if (!size) continue;
      sizesSet.add(size);
      if (!sizeTable[colour]) sizeTable[colour] = {};
      sizeTable[colour][size] = (sizeTable[colour][size] || 0) + (parseInt(r['orderQty']) || 0);
    }
    const sizes = [...sizesSet].sort((a, b) => parseInt(a) - parseInt(b));

    const colourTotals = {};
    for (const [colour, qtyMap] of Object.entries(sizeTable)) {
      colourTotals[colour] = Object.values(qtyMap).reduce((a, b) => a + b, 0);
    }
    const totalUnits = Object.values(colourTotals).reduce((a, b) => a + b, 0);

    docketRows.push({ styleNo: styleNo || skuForDb, colourSkuMap, sizeTable, colourTotals, totalUnits, sizes, fabrication });

    for (const [colour, qty] of Object.entries(colourTotals)) {
      const sku = colourSkuMap[colour] || skuForDb;
      const imageUrl = buildPltImageUrl(sku, colour);
      const colourTitle = colour.charAt(0) + colour.slice(1).toLowerCase();
      const row = {
        source_tab: 'OPO',
        company: 'Sourcing',
        po: poNumber,
        style_no: styleNo || null,
        style: sku,
        description: `${colourTitle} ${baseDesc}`.trim(),
        fabric: fabrication,
        colour,
        qty,
        ex_factory: exFactoryRaw ? ukDateToIso(exFactoryRaw) : null,
        docket: docketNumber,
        invoice_no: '',
        packing_list_url: '',
        stage: 'Pending',
        image_url: imageUrl,
        ppu: ppu ?? null,
      };
      if (costingCmt !== null) row.cmt = costingCmt;
      dbRows.push(row);
    }
  }

  const docketBuffer = await buildDocketWorkbook(docketNumber, poNumber, dateOrdered, exFactoryRaw, descDisplay, docketRows);
  const docketFileName = `${docketNumber}_${poNumber}.xlsx`;
  const storagePath = `${poNumber}/dockets/${docketFileName}`;

  const { error: uploadError } = await supabase.storage.from('orders').upload(storagePath, docketBuffer, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    upsert: true,
  });
  let docketUrl = null;
  if (uploadError) {
    console.error(`  docket upload failed for PO ${poNumber}: ${uploadError.message}`);
  } else {
    docketUrl = supabase.storage.from('orders').getPublicUrl(storagePath).data.publicUrl;
  }
  for (const row of dbRows) row.docket_url = docketUrl;

  let anyDbError = false;
  for (const row of dbRows) {
    const { error } = await supabase.from('orders').upsert(row, { onConflict: 'po,style,colour' });
    if (error) {
      console.error(`  order upsert failed for PO ${row.po} / ${row.style} / ${row.colour}: ${error.message}`);
      anyDbError = true;
    }
  }

  if (anyDbError) {
    return { status: 'failed', poNumber, reason: 'one or more order rows failed to save' };
  }

  const flagged = ambiguousPdf || anyMissingCosting || anyMissingFabric || Boolean(uploadError);
  return {
    status: flagged ? 'processed_needs_review' : 'processed',
    poNumber,
    docketNumber,
    rowCount: dbRows.length,
    reason: flagged
      ? [
          ambiguousPdf && 'could not confidently identify the PO confirmation PDF',
          anyMissingCosting && 'one or more styles missing from style_costings',
          anyMissingFabric && 'could not find a fabrication for one or more styles in the PDF',
          uploadError && 'docket file upload failed',
        ].filter(Boolean).join('; ')
      : null,
  };
}

async function main() {
  const accessToken = await getAccessToken({
    clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_SOURCING_OAUTH_REFRESH_TOKEN,
  });
  const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const [processedLabelId, needsReviewLabelId] = await Promise.all([
    getOrCreateLabel(accessToken, 'Docket-Processed'),
    getOrCreateLabel(accessToken, 'Docket-Needs-Review'),
  ]);

  const threads = await searchThreads(accessToken, SEARCH_QUERY);
  console.log(`Found ${threads.length} unprocessed docket thread(s).`);

  let generated = 0;
  let flaggedAfterGenerate = 0;
  let flaggedNotProcessable = 0;
  let skippedExisting = 0;
  let failed = 0;

  for (const thread of threads) {
    console.log(`Processing thread ${thread.id}...`);
    let result;
    try {
      result = await processThread(accessToken, supabase, thread);
    } catch (err) {
      console.error(`  unexpected error: ${err.message}`);
      failed++;
      continue;
    }

    switch (result.status) {
      case 'processed':
        await modifyThreadLabels(accessToken, thread.id, { add: [processedLabelId] });
        generated++;
        console.log(`  PO ${result.poNumber}: docket #${result.docketNumber}, ${result.rowCount} order row(s) saved.`);
        break;
      case 'processed_needs_review':
        await modifyThreadLabels(accessToken, thread.id, { add: [processedLabelId, needsReviewLabelId] });
        generated++;
        flaggedAfterGenerate++;
        console.log(`  PO ${result.poNumber}: docket #${result.docketNumber} saved, flagged for review (${result.reason}).`);
        break;
      case 'skipped_existing':
        await modifyThreadLabels(accessToken, thread.id, { add: [processedLabelId] });
        skippedExisting++;
        console.log(`  ${result.reason}`);
        break;
      case 'needs_review':
        await modifyThreadLabels(accessToken, thread.id, { add: [needsReviewLabelId] });
        flaggedNotProcessable++;
        console.log(`  flagged for review: ${result.reason}`);
        break;
      case 'failed':
        // Left unlabeled so it's retried next run, same convention as the
        // other two automations.
        failed++;
        console.log(`  failed, left for retry: ${result.reason}`);
        break;
    }
  }

  console.log('');
  console.log('Summary:');
  console.log(`  Threads found: ${threads.length}`);
  console.log(`  Dockets generated: ${generated} (of which ${flaggedAfterGenerate} flagged Needs Review)`);
  console.log(`  Flagged Needs Review without generating a docket: ${flaggedNotProcessable}`);
  console.log(`  Skipped (PO already had a docket): ${skippedExisting}`);
  console.log(`  Failed (left for retry next run): ${failed}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
