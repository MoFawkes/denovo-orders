import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRemittance, planRemittance, applyRemittance, remittanceId } from '../lib/plt-remittance.mjs';
import { extractRemittancePdf, isTrustedRemittance } from '../process-plt-remittances.mjs';

// Transcribed from both user-supplied scanned PDFs; no personal/bank data.
const normal = { payer: 'prettylittlething.com Limited', supplierCode: 'DEN0203A', currency: 'GBP', uncertain: false,
  date: '2026-09-30', reference: '17', totalPence: 2705400,
  lines: [['2026-08-07','0070059448','0242',644280],['2026-08-08','0070059293','0244',1230120],
    ['2026-08-08','0070057677','0246',200940],['2026-08-08','0070056534','0245',518880],
    ['2026-08-08','0070054296','0243',111180]].map(([date,po,reference,amountPence]) => ({date,po,reference,type:'PI',amountPence})) };
const charges = { payer: normal.payer, supplierCode: normal.supplierCode, currency: 'GBP', uncertain: false,
  date: '2026-08-12', reference: '16', totalPence: 2916325,
  lines: [['2026-06-17','0070050910','0209',325680],['2026-06-17','0070046912','207',325680],
    ['2026-06-17','0070046905','208',295800],['2026-06-19','0070048653','0210',510000],
    ['2026-06-19','0070052051','0213',765000],['2026-06-19','0070052878','0211',303960],
    ['2026-06-19','0070046955','0212',445536]].map(([date,po,reference,amountPence]) => ({date,po,reference,type:'PI',amountPence}))
    .concat([{date:'2026-07-14',po:'0070046955',reference:'0212CM',type:'PC',amountPence:10920},
      {date:'2026-08-11',po:'Discount',reference:'0010028396',type:'PC',amountPence:44411}]) };

const gridFor = remittance => [['Invoice No','Invoice Date','PO No','Invoice Amount','Payment Due','Status'],
  ...remittance.lines.filter(line => line.type === 'PI').map(line => [Number(line.reference),'01-06-2026',Number(line.po),line.amountPence/100,'16-07-2026','OVERDUE']),
  ['Subtotal — Overdue'],['Subtotal — Due Soon'],['Subtotal — Not Yet Due'],['TOTAL OUTSTANDING']];

test('both scanned examples reconcile exactly; deductions are not payment credits', () => {
  const a = validateRemittance(normal), b = validateRemittance(charges);
  assert.equal(a.lines.length,5); assert.equal(b.lines.length,9);
  assert.equal(b.lines.filter(line => line.type === 'PC').reduce((sum,line) => sum+line.amountPence,0),55331);
});

test('invalid totals, duplicate refs, uncertain extraction and wrong supplier block processing', () => {
  for (const patch of [{totalPence:1},{uncertain:true},{supplierCode:'OTHER'}, {lines: [...normal.lines,normal.lines[0]]}]) {
    assert.throws(() => validateRemittance({...normal,...patch}), /Remittance:/);
  }
});

test('full payments retain hidden history and disappear from totals; charges are positive overdue disputed rows', () => {
  const remittance=validateRemittance(charges);
  const plan=planRemittance(gridFor(remittance),new Map(),remittance,{today:'2026-10-08',sheetId:10});
  assert.equal(plan.audit.filter(line=>line.type==='paid').length,7);
  const chargeRows=plan.updates.filter(update=>update.range.startsWith('A') && String(update.values[0][0]).startsWith('CHARGE'));
  assert.equal(chargeRows.length,2);
  assert.deepEqual(chargeRows.map(update=>update.values[0][3]).sort((a,b)=>a-b),[109.2,444.11]);
  assert.ok(chargeRows.every(update=>update.values[0][4]==='Immediate' && update.values[0][5]==='OVERDUE / DISPUTED'));
  assert.equal(plan.requests.filter(request=>request.updateDimensionProperties?.properties.hiddenByUser===true).length,7);
  assert.ok(plan.updates.some(update=>String(update.values[0][0]).includes('SUMIFS')));
});

test('missing invoices, mismatched PO and overpayments abort the entire plan', () => {
  const remittance=validateRemittance(normal);
  const grid=gridFor(remittance);
  assert.throws(()=>planRemittance(grid.slice(1),new Map(),remittance,{today:'2026-10-08',sheetId:10}),/header/);
  grid[1][2]='99999999';
  assert.throws(()=>planRemittance(grid,new Map(),remittance,{today:'2026-10-08',sheetId:10}),/PO mismatch/);
  grid[1][2]=remittance.lines[0].po; grid[1][3]=1;
  assert.throws(()=>planRemittance(grid,new Map(),remittance,{today:'2026-10-08',sheetId:10}),/exceeds/);
  grid.splice(1,1);
  assert.throws(()=>planRemittance(grid,new Map(),remittance,{today:'2026-10-08',sheetId:10}),/found 0/);
});

test('partial payments retain their remaining balance and duplicate remittances cannot subtract twice', () => {
  const remittance=validateRemittance(normal), grid=gridFor(remittance), notes=new Map();
  grid[1][3]+=10;
  const plan=planRemittance(grid,notes,remittance,{today:'2026-10-08',sheetId:10});
  for(const request of plan.requests) {
    if(request.updateCells) notes.set(`${request.updateCells.start.rowIndex}:3`,request.updateCells.rows[0].values[0].note);
  }
  for(const update of plan.updates) {
    const match=update.range.match(/^D(\d+):F/);
    if(match) grid[Number(match[1])-1].splice(3,3,...update.values[0]);
  }
  assert.equal(grid[1][3],10);
  const retry=planRemittance(grid,notes,remittance,{today:'2026-10-09',sheetId:10});
  assert.equal(retry.audit.length,0);
  assert.equal(retry.requests.length,0);
});

test('deduction inserts and payment notes survive an atomic-write retry without adding charges again', () => {
  const remittance=validateRemittance(charges), grid=gridFor(remittance), notes=new Map();
  const apply = plan => {
    for(const request of plan.requests) {
      if(request.insertDimension) {
        const {startIndex,endIndex}=request.insertDimension.range;
        const count=endIndex-startIndex;
        const oldNotes=[...notes];notes.clear();
        oldNotes.forEach(([key,value])=>{const [r,c]=key.split(':').map(Number);notes.set(`${r>=startIndex?r+count:r}:${c}`,value);});
        grid.splice(startIndex,0,...Array.from({length:count},()=>[]));
      }
      if(request.updateCells) {
        const {rowIndex,columnIndex}=request.updateCells.start;
        request.updateCells.rows[0].values.forEach((cell,offset)=>{
          if(cell.note) notes.set(`${rowIndex}:${columnIndex+offset}`,cell.note);
          if(cell.userEnteredValue) grid[rowIndex][columnIndex+offset]=cell.userEnteredValue.numberValue??cell.userEnteredValue.stringValue;
        });
      }
    }
    for(const update of plan.updates) {
      const match=update.range.match(/^([A-Z])(\d+)/);
      const row=Number(match[2])-1,column=match[1].charCodeAt(0)-65;
      update.values[0].forEach((value,offset)=>{grid[row][column+offset]=value;});
    }
  };
  apply(planRemittance(grid,notes,remittance,{today:'2026-10-08',sheetId:10}));
  const retry=planRemittance(grid,notes,remittance,{today:'2026-10-08',sheetId:10});
  assert.equal(retry.requests.filter(request=>request.insertDimension).length,0);
  assert.equal(grid.filter(row=>String(row[0]).startsWith('CHARGE')).length,2);
  assert.equal(retry.audit.filter(row=>row.type==='paid').length,0);
});

test('immutable intent precedes writes; checkpoint failure retries read live notes', async () => {
  const remittance=validateRemittance(normal), state=new Map(); let fail=true; let writes=0;
  const database=async(action,body)=> {
    if(action==='checkpoint-get') return {execution:state.get(body.step)};
    if(body.step==='applied' && fail) {fail=false;throw new Error('checkpoint unavailable');}
    state.set(body.step,{status:'completed',result:body.result}); return {};
  };
  const grid=gridFor(remittance), notes=new Map();
  const options={database,remittance,today:'2026-10-08',sheetId:10,readStatement:async()=>({grid,notes}),
    writePlan:async plan=>{
      assert.equal(state.get('prepared').status,'completed'); writes++;
      for(const request of plan.requests) if(request.updateCells) notes.set(`${request.updateCells.start.rowIndex}:3`,request.updateCells.rows[0].values[0].note);
      for(const update of plan.updates) {const m=update.range.match(/^D(\d+):F/);if(m)grid[Number(m[1])-1].splice(3,3,...update.values[0]);}
    }};
  await assert.rejects(applyRemittance(options),/checkpoint unavailable/);
  await applyRemittance(options);
  assert.equal(writes,2); assert.ok(state.has('applied'));
  assert.deepEqual(await applyRemittance(options),{skipped:true});
  assert.equal(remittanceId(remittance),'DEN0203A:2026-09-30:17');
});

test('independent scanned PDF transcriptions must agree before any accounting writes', async () => {
  let calls=0;
  await extractRemittancePdf(Buffer.from('%PDF-test'),{extract:async options=> {
    assert.equal(options.documents.length,1); calls++; return structuredClone(normal);
  }});
  assert.equal(calls,2);
  await assert.rejects(extractRemittancePdf(Buffer.from('%PDF-test'),{extract:async()=>({...normal,reference:String(calls++)})}),/disagree/);
});

test('requires exact sender and Gmail domain authentication', () => {
  const message={payload:{headers:[{name:'From',value:'Accounts <accounts@prettylittlething.com>'},
    {name:'Authentication-Results',value:'mx.google.com; dkim=pass header.i=@prettylittlething.com; dmarc=pass header.from=prettylittlething.com'}]}};
  assert.equal(isTrustedRemittance(message,['accounts@prettylittlething.com']),true);
  assert.equal(isTrustedRemittance(message,['other@prettylittlething.com']),false);
  message.payload.headers[1].value='mx.google.com; dkim=fail; dmarc=fail header.from=prettylittlething.com';
  assert.equal(isTrustedRemittance(message,['accounts@prettylittlething.com']),false);
});
