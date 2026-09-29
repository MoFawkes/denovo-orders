import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSampleApprovalCSV, planCsvApprovals, processChaseMessage } from '../lib/sample-approval-csv.mjs';
import { validateCsvPairs, approveCsvPairs } from '../../../supabase/functions/mark-sample-approved/csv.mjs';

const csv = 'PO,Style,Sage Sample Approved,Comments\r\n70069756,CNP0933,Yes,"Sent, with ""label""\r\nconfirmed"\r\n70071990,CNP0933,No,\r\n';
function message(text = csv) {
  return { id: 'm1', payload: { headers: [
    { name: 'From', value: 'Lulu Marshall <lulu.marshall@prettylittlething.com>' },
    { name: 'Subject', value: 'Dresses OPO Chase - Denovo Sourcing - 25-Sep-26' },
    { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@prettylittlething.com header.s=google; dmarc=pass (p=REJECT) header.from=prettylittlething.com' },
  ], parts: [{ filename: 'chase.csv', body: { data: Buffer.from(text).toString('base64url') } }] } };
}

test('CSV parser and plan handle quoted text and preserve PO/style approval separation', () => {
  assert.deepEqual(planCsvApprovals(parseSampleApprovalCSV('\uFEFF' + csv)), { pairs: [{ po:'0070069756', style:'CNP0933' }], issues:[] });
  assert.throws(() => parseSampleApprovalCSV('PO,Style\n1,A'));
  assert.throws(() => parseSampleApprovalCSV('PO,Style,Sage Sample Approved\n1,A,"Yes'));
  const plan = planCsvApprovals([{po:'1',style:'A',approval:'yes'},{po:'0000000001',style:'A',approval:'no'},{po:'2',style:'B%',approval:'yes'}]);
  assert.equal(plan.pairs.length,0);
  assert.equal(plan.issues.length,3);
});

test('processes attached CSV and labels only after successful approval', async () => {
  const calls=[];
  await processChaseMessage(message(), { approve: async pairs => { calls.push(pairs); return {unmatched:[]}; }, label:async state=>calls.push(state) });
  assert.deepEqual(calls, [[{po:'0070069756',style:'CNP0933'}], 'processed']);
});

test('unmatched and duplicate rows are flagged, authentication failure never writes approvals', async () => {
  for (const kind of ['unmatched','duplicate','auth']) {
    const msg=message(kind==='duplicate' ? 'PO,Style,Sage Sample Approved\n1,A,Yes\n1,A,No' : csv);
    if(kind==='auth') msg.payload.headers.pop();
    let writes=0; const labels=[];
    await processChaseMessage(msg,{approve:async()=>{writes++;return {unmatched:[{po:'1'}]};},label:async s=>labels.push(s)});
    assert.deepEqual(labels,['review']);
    assert.equal(writes,kind==='unmatched'?1:0);
  }
});

test('failed writes and downloads remain unlabeled for retry; dry-run makes no writes', async () => {
  const labels=[];
  await assert.rejects(processChaseMessage(message(),{approve:async()=>{throw Error('offline');},label:async s=>labels.push(s)}),/offline/);
  const msg=message(); msg.payload.parts[0].body={attachmentId:'a'};
  await assert.rejects(processChaseMessage(msg,{readAttachment:async()=>{throw Object.assign(Error('download'),{retryable:true});},label:async s=>labels.push(s)}),/download/);
  await processChaseMessage(message(),{dryRun:true,approve:async()=>{throw Error('write');},label:async s=>labels.push(s)});
  assert.deepEqual(labels,[]);
});

test('wrong sender is skipped and separately arriving messages both run', async()=>{
  let calls=0;
  const adapters={approve:async()=>{calls++; return {unmatched:[]};},label:async()=>{}};
  const wrong=message(); wrong.payload.headers[0].value='lulu.marshall@prettylittlething.com.evil.test';
  await processChaseMessage(wrong,adapters);
  assert.equal(calls,0);
  await processChaseMessage(message(),adapters);
  await processChaseMessage({...message(),id:'m2'},adapters);
  assert.equal(calls,2);
});

test('strict endpoint rejects broad/wildcard inputs and guards terminal stages on writes',async()=>{
  assert.equal(validateCsvPairs([{po:'0070069756',style:'CNP0933'}]),true);
  for(const pairs of [[],[{po:'1',style:'A'}],[{po:'0070069756',style:'%'}],[{po:'0070069756'}]]) assert.equal(validateCsvPairs(pairs),false);
  const calls=[];
  const database={from(){const call={};calls.push(call);return {
    select(){return this;},in(field,values){call[field]=values;return this;},ilike(field,value){call[field]=value;return this;},
    update(payload){call.payload=payload;return this;},not(...args){call.not=args;return this;},or(value){call.or=value;return this;},
    then(resolve){resolve({data:call.payload?[{id:'a'}]:[{id:'a',stage:'Pending'},{id:'b',stage:'Cancelled'}],error:null});}
  };}};
  const result=await approveCsvPairs(database,[{po:'0070069756',style:'CNP0933'}]);
  assert.equal(result.updated,1);
  assert.deepEqual(calls[0].po,['0070069756','70069756']);
  assert.deepEqual(calls[1].id,['a']);
  assert.deepEqual(calls[1].payload,{sample_approved:true});
  assert.deepEqual(calls[1].not,['stage','in','(Completed,Cancelled)']);
  assert.equal(calls[1].style,'CNP0933');
});
