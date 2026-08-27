import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { loadPortalConfig } from './lib/portal-config.mjs';
import { validatePortalManifest } from './lib/portal-manifest.mjs';
import { generateTotp } from './lib/totp.mjs';
import { callPackingListDb } from './lib/automation-db.mjs';
import { claimPortalSubmission, transitionPortalSubmission } from './lib/portal-state.mjs';
import { validateBelPdf } from './lib/bel-validation.mjs';
import { assertPortalAccess } from './lib/portal-access.mjs';
import { getAccessToken, getThread, getHeader, getOrCreateLabel, modifyThreadLabels, sendReply } from './lib/google.mjs';
import { stampPortalPackingList } from './lib/portal-packing-list.mjs';
import { parsePortalSampleApproval } from './lib/portal-sample-approval.mjs';

const MODES = new Set(['validate-config', 'login-smoke', 'navigate-only', 'submit-one', 'submit-fresh', 'scheduled']);

function requireSecret(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function login(page, config) {
  const landingResponse = await page.goto(config.urls.purchaseOrders, {
    waitUntil: 'domcontentloaded', timeout: config.timeouts.navigationMs,
  });
  await assertPortalAccess(landingResponse, page, 'initial navigation before authentication');
  if (page.url().includes('amazoncognito.com')) {
    await page.locator(config.selectors.username).fill(requireSecret('PORTAL_USERNAME', process.env.PORTAL_USERNAME));
    await page.locator(config.selectors.password).fill(requireSecret('PORTAL_PASSWORD', process.env.PORTAL_PASSWORD));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const totp = page.locator(config.selectors.totp).first();
    await totp.waitFor({ state: 'visible', timeout: config.timeouts.actionMs });
    await totp.fill(generateTotp(requireSecret('PORTAL_TOTP_SECRET', process.env.PORTAL_TOTP_SECRET)));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await page.waitForURL(/isc-portal\.debenhamsgroup\.com/, { timeout: config.timeouts.navigationMs });
  await assertPortalAccess(null, page, 'Cognito callback');
}

async function openWizard(page, config, po) {
  const response = await page.goto(config.urls.cartonWizard.replace('{po}', po), {
    waitUntil: 'domcontentloaded', timeout: config.timeouts.navigationMs,
  });
  await assertPortalAccess(response, page, `carton-wizard navigation for PO ${po}`);
  await page.getByRole('button', { name: /Back/i }).waitFor({ timeout: config.timeouts.actionMs });
  const pageText = await page.locator('body').innerText();
  return {
    submitted: await page.getByRole('button', { name: 'Unsubmit', exact: true }).isVisible().catch(() => false),
    canSubmit: await page.getByRole('button', { name: 'Submit', exact: true }).isVisible().catch(() => false),
    sampleApproved: parsePortalSampleApproval(pageText),
  };
}

async function dumpFilterDiagnostics(page) {
  const info = await page.evaluate(() => {
    const textMatches = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length === 0 && el.textContent?.trim() === 'PO Number') {
        let node = el;
        const chain = [];
        for (let i = 0; i < 4 && node; i += 1) {
          chain.push(node.outerHTML?.slice(0, 300));
          node = node.parentElement;
        }
        textMatches.push(chain);
      }
    }
    const buttonRoles = Array.from(document.querySelectorAll('[role="button"], button'))
      .map((el) => el.textContent?.trim().slice(0, 60))
      .filter(Boolean)
      .slice(0, 30);
    return { url: location.href, title: document.title, textMatches: textMatches.slice(0, 5), buttonRoles };
  });
  console.error('[portal-diagnostic]', JSON.stringify(info, null, 2));
}

async function readPurchaseOrderStatus(page, config, po) {
  let response = null;
  if (page.url().split('?')[0] !== config.urls.purchaseOrders) {
    response = await page.goto(config.urls.purchaseOrders, {
      waitUntil: 'domcontentloaded', timeout: config.timeouts.navigationMs,
    });
  }
  await assertPortalAccess(response, page, 'purchase-order list navigation');
  await page.waitForLoadState('networkidle', { timeout: config.timeouts.navigationMs }).catch(() => {});
  const poNumberButton = page.locator(config.selectors.poNumberButton)
    .or(page.getByRole('button', { name: 'PO Number' }));
  try {
    await poNumberButton.first().waitFor({ state: 'visible', timeout: config.timeouts.actionMs });
  } catch (error) {
    await dumpFilterDiagnostics(page).catch(() => {});
    throw error;
  }
  await poNumberButton.first().click();
  const filter = page.locator(config.selectors.poNumberFilter);
  await filter.waitFor({ state: 'visible', timeout: config.timeouts.actionMs });
  await filter.fill(po);
  const addOption = page.getByRole('option').filter({ hasText: 'Add' }).first();
  await addOption.waitFor({ state: 'visible', timeout: config.timeouts.actionMs });
  await addOption.click();
  const row = page.getByRole('row').filter({ hasText: po }).first();
  await row.waitFor({ state: 'visible', timeout: config.timeouts.actionMs });
  return { submitted: /\bSubmitted\b/i.test((await row.textContent()) ?? '') };
}

async function chooseOption(page, control, matcher) {
  await control.click();
  const option = page.getByRole('option').filter({ hasText: matcher }).first();
  await option.waitFor({ state: 'visible' });
  await option.click();
}

async function chooseSkuForSize(page, config, carton) {
  const sku = page.locator(config.selectors.sku);
  await sku.click();
  await sku.fill(carton.baseSku);
  const optionTexts = await page.getByRole('option').filter({ hasText: carton.baseSku }).allTextContents();
  if (optionTexts.length === 0) throw new Error(`Portal has no SKU matching ${carton.baseSku}`);
  for (const optionText of optionTexts) {
    await sku.click();
    await sku.fill(carton.baseSku);
    await page.getByRole('option', { name: optionText, exact: true }).click();
    const portalSize = await page.locator(config.selectors.size).inputValue().catch(async () =>
      (await page.locator(config.selectors.size).textContent()) ?? '');
    if (portalSize.trim().toUpperCase() === carton.size.trim().toUpperCase()) return;
  }
  throw new Error(`Portal has no ${carton.baseSku} SKU whose derived size is ${carton.size}`);
}

async function addCarton(page, config, carton) {
  await chooseSkuForSize(page, config, carton);
  await page.locator(config.selectors.cartonQuantity).fill(String(carton.quantity));
  const remainingText = await page.getByText(/\d+\s+Remaining/i).first().textContent().catch(() => null);
  if (remainingText) {
    const remaining = Number(remainingText.match(/\d+/)?.[0]);
    if (Number.isFinite(remaining) && carton.quantity > remaining) throw new Error(`carton ${carton.cartonId} exceeds Portal remaining quantity`);
  }
  if (carton.cartonSize !== 'BDCM1') {
    await chooseOption(page, page.locator(config.selectors.cartonSize), new RegExp(`^${carton.cartonSize}$`, 'i'));
  }
  await page.getByRole('button', { name: 'Add', exact: true }).click();
}

async function validateAndSubmit(page, config, onBeforeSubmit) {
  await page.getByRole('button', { name: 'Validate', exact: true }).click();
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    const warnings = (await dialog.textContent())?.trim() ?? '';
    console.warn(`Portal validation warnings: ${warnings}`);
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  onBeforeSubmit();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.getByText('Cartons submitted successfully!', { exact: true }).waitFor({ timeout: config.timeouts.actionMs });
}

async function downloadFromButton(page, name, directory, filename, timeout) {
  const downloadPromise = page.waitForEvent('download', { timeout });
  await page.getByRole('button', { name, exact: true }).click();
  const download = await downloadPromise;
  const path = join(directory, filename);
  await download.saveAs(path);
  return path;
}

async function deliver(manifest, belPath, packingListPath) {
  const accessToken = await getAccessToken({
    clientId: requireSecret('GMAIL_OAUTH_CLIENT_ID', process.env.GMAIL_OAUTH_CLIENT_ID),
    clientSecret: requireSecret('GMAIL_OAUTH_CLIENT_SECRET', process.env.GMAIL_OAUTH_CLIENT_SECRET),
    refreshToken: requireSecret('GMAIL_OAUTH_REFRESH_TOKEN', process.env.GMAIL_OAUTH_REFRESH_TOKEN),
  });
  const thread = await getThread(accessToken, manifest.gmailThreadId);
  const latest = thread.messages.at(-1);
  await sendReply(accessToken, {
    threadId: manifest.gmailThreadId,
    replyTo: latest,
    to: getHeader(latest, 'From'),
    subject: getHeader(latest, 'Subject') || `Portal labels ${manifest.po}`,
    body: `ISC Portal submission completed for PO ${manifest.po}. The validated BEL labels and official Portal packing list are attached. Print labels at 100% / Actual size.`,
    attachments: [
      { filename: `${manifest.po}_BELs.pdf`, mimeType: 'application/pdf', buffer: await readFile(belPath) },
      { filename: `${manifest.po}_packing_list.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await readFile(packingListPath) },
    ],
  });
}

async function deferForSampleApproval(manifest) {
  const accessToken = await getAccessToken({
    clientId: requireSecret('GMAIL_OAUTH_CLIENT_ID', process.env.GMAIL_OAUTH_CLIENT_ID),
    clientSecret: requireSecret('GMAIL_OAUTH_CLIENT_SECRET', process.env.GMAIL_OAUTH_CLIENT_SECRET),
    refreshToken: requireSecret('GMAIL_OAUTH_REFRESH_TOKEN', process.env.GMAIL_OAUTH_REFRESH_TOKEN),
  });
  const [awaitingSample, processed] = await Promise.all([
    getOrCreateLabel(accessToken, 'Packing List/Awaiting Sample Approval'),
    getOrCreateLabel(accessToken, 'Packing List/Processed'),
  ]);
  await modifyThreadLabels(accessToken, manifest.gmailThreadId, {
    add: [awaitingSample],
    remove: [processed],
  });
}
async function loadManifests(directory, requestedPo) {
  if (!directory) return [];
  const files = (await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })).filter((file) => file.endsWith('.json'));
  const manifests = [];
  for (const file of files) {
    const manifest = validatePortalManifest(JSON.parse(await readFile(join(directory, file), 'utf8')));
    if (!requestedPo || manifest.po === requestedPo.padStart(10, '0')) manifests.push(manifest);
  }
  return manifests;
}

async function main() {
  const mode = process.env.PORTAL_RUN_MODE ?? 'validate-config';
  if (!MODES.has(mode)) throw new Error(`unsupported PORTAL_RUN_MODE: ${mode}`);
  const config = await loadPortalConfig();
  console.log('Portal configuration is valid.');
  if (process.env.DRY_RUN === '1' && ['submit-one', 'submit-fresh', 'scheduled'].includes(mode)) {
    throw new Error('Portal submission has no dry-run simulation; use navigate-only instead');
  }
  if (mode === 'validate-config') return;
  if (mode === 'scheduled' && process.env.PORTAL_SCHEDULED_ENABLED !== '1') {
    console.log('Scheduled Portal submission is disabled pending operational sign-off.');
    return;
  }
  const manifests = await loadManifests(process.env.PORTAL_HANDOFF_DIR, process.env.PORTAL_PO);
  if (['navigate-only', 'submit-one', 'submit-fresh', 'scheduled'].includes(mode) && manifests.length === 0) {
    if (mode === 'submit-one') throw new Error('submit-one found no fresh manifest for the requested PO');
    console.log('No fresh Portal handoff manifests found.');
    return;
  }
  if (mode === 'submit-one' && manifests.length !== 1) throw new Error('submit-one requires exactly one matching manifest');

  const headless = process.env.PORTAL_HEADLESS !== '0';
  const browserChannel = process.env.PORTAL_BROWSER_CHANNEL?.trim() || undefined;
  console.log(`Launching ${browserChannel ?? 'bundled Chromium'} in ${headless ? 'headless' : 'headed'} mode.`);
  const browser = await chromium.launch({ headless, channel: browserChannel });
  const context = await browser.newContext({ acceptDownloads: true });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  page.setDefaultTimeout(config.timeouts.actionMs);
  try {
    await login(page, config);
    console.log('Portal login succeeded.');
    if (mode === 'login-smoke') return;
    for (const manifest of manifests) {
      const listState = await readPurchaseOrderStatus(page, config, manifest.po);
      const portalState = await openWizard(page, config, manifest.po);
      if (listState.submitted !== portalState.submitted) {
        throw new Error(`Portal status signals disagree for PO ${manifest.po}; human reconciliation required`);
      }
      if (portalState.submitted) {
        console.log(`PO ${manifest.po} is already Submitted in the Portal; refusing to add cartons.`);
        continue;
      }
      if (portalState.sampleApproved === false) {
        await deferForSampleApproval(manifest);
        console.log(`PO ${manifest.po} is not Sample Approved in the Portal; returned to the automatic waiting queue.`);
        continue;
      }
      if (mode === 'navigate-only') {
        await page.locator(config.selectors.sku).waitFor({ state: 'visible' });
        console.log(`PO ${manifest.po} carton-entry UI is available.`);
        continue;
      }

      const runnerId = process.env.GITHUB_RUN_ID ?? `local-${process.pid}`;
      const claim = await claimPortalSubmission(callPackingListDb, manifest, runnerId);
      if (claim.noOp) { console.log(`PO ${manifest.po} is already ${claim.submission.state}; no-op.`); continue; }
      if (!claim.claimed) throw new Error(`PO ${manifest.po} is claimed by another runner`);
      let submitted = false;
      let state = 'claimed';
      try {
        for (const carton of manifest.cartons) await addCarton(page, config, carton);
        await validateAndSubmit(page, config, () => { submitted = true; });
        await transitionPortalSubmission(callPackingListDb, manifest, state, 'portal-submitted', { confirmedBy: 'success-toast' });
        state = 'portal-submitted';
        await transitionPortalSubmission(callPackingListDb, manifest, state, 'bels-generated');
        state = 'bels-generated';
        const outputDirectory = await mkdtemp(join(tmpdir(), 'denovo-portal-'));
        const belPath = await downloadFromButton(page, 'Print Labels', outputDirectory, `${manifest.po}_BELs.pdf`, config.timeouts.downloadMs);
        const packingListPath = await downloadFromButton(page, 'Download Packing List', outputDirectory, `${manifest.po}_packing_list.xlsx`, config.timeouts.downloadMs);
        const stampedPackingList = await stampPortalPackingList(await readFile(packingListPath), manifest);
        await writeFile(packingListPath, stampedPackingList);
        const validation = await validateBelPdf(belPath, manifest);
        await transitionPortalSubmission(callPackingListDb, manifest, state, 'bels-downloaded', { validation });
        state = 'bels-downloaded';
        await deliver(manifest, belPath, packingListPath);
        await transitionPortalSubmission(callPackingListDb, manifest, state, 'delivered');
        console.log(`PO ${manifest.po} submitted and delivered (${validation.pages} BELs).`);
      } catch (error) {
        const nextState = submitted ? 'uncertain-after-submit' : 'failed-before-submit';
        await transitionPortalSubmission(callPackingListDb, manifest, state, nextState, {}, error).catch((transitionError) => {
          console.error(`Could not record ${nextState}: ${transitionError.message}`);
        });
        throw error;
      }
    }
  } finally {
    if (process.env.PORTAL_TRACE_DIR) {
      await mkdir(process.env.PORTAL_TRACE_DIR, { recursive: true });
      await context.tracing.stop({ path: join(process.env.PORTAL_TRACE_DIR, 'trace.zip') });
    } else {
      await context.tracing.stop();
    }
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error('Fatal error:', error.message); process.exit(1); });
}
