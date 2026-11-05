import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createR2Media, DIRECT_PART_BYTES, LOCAL_MEDIA_BYTES } from '../server/r2-media.mjs';
import { createHybridMedia } from '../server/hybrid-media.mjs';
import worker, { makeSession } from '../cms-worker/worker.mjs';
import { makeD1 } from './helpers/d1.mjs';

const values = {accountId:'a'.repeat(32),accessKeyId:'b'.repeat(32),secretAccessKey:'c'.repeat(64)};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise,resolve}; };
test('R2 requests are scoped, signed, bounded, and browser part URLs bind the exact byte length', async () => {
  const seen = [];
  const r2 = createR2Media({...values,now:() => Date.UTC(2026,10,5,12),fetch:async (url,options) => {
    seen.push({url:new URL(url),options});
    return new Response(null,{headers:{'content-length':'123','content-type':'application/pdf'}});
  }});
  assert.throws(() => createR2Media({...values,accountId:'other.example/path'}),/configuration/);
  await assert.rejects(r2.head('../outside'),/key/);
  assert.equal((await r2.head('12345678-file.pdf')).size,123);
  const call = seen[0];
  assert.equal(call.url.origin,'https://' + values.accountId + '.r2.cloudflarestorage.com');
  assert.equal(call.url.pathname,'/heichal-media/cms/12345678-file.pdf');
  assert.equal(call.options.redirect,'error');
  assert.match(call.options.headers.authorization,/SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  const part = r2.partUrl('12345678-file.pdf','id+/=',2,123);
  const url = new URL(part.url);
  assert.equal(url.searchParams.get('uploadId'),'id+/=');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'),'content-length;content-type;host');
  assert.equal(url.searchParams.get('X-Amz-Expires'),'600');
  assert.equal(url.searchParams.has('X-Amz-Signature'),true);
  assert.equal(part.url.includes(values.secretAccessKey),false);
  assert.equal(part.headers['Content-Type'],'application/octet-stream');
});
test('R2 multipart completion rejects wrong sizes and accepts only the complete ordered part list',async () => {
  let valid = false, posts = 0;
  const r2 = createR2Media({...values,fetch:async (_url,{method}) => {
    if (method === 'POST') { posts++; return new Response('<CompleteMultipartUploadResult><ETag>ok</ETag></CompleteMultipartUploadResult>'); }
    return new Response('<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>1</PartNumber><Size>' + (valid ? DIRECT_PART_BYTES : 1) + '</Size><ETag>&quot;' + 'a'.repeat(32) + '&quot;</ETag></Part><Part><PartNumber>2</PartNumber><Size>7</Size><ETag>&quot;' + 'b'.repeat(32) + '&quot;</ETag></Part></ListPartsResult>');
  }});
  await assert.rejects(r2.complete('12345678-file.pdf','upload',DIRECT_PART_BYTES + 7),/שלמה/);
  assert.equal(posts,0);
  valid = true; await r2.complete('12345678-file.pdf','upload',DIRECT_PART_BYTES + 7);
  assert.equal(posts,1);
});
test('hybrid uploads persist multipart identity privately and enforce the 90 MiB boundary', async () => {
  const records = new Map(), calls = [];
  const state = {get:async key => records.has(key) ? JSON.parse(records.get(key)) : null,put:async (k,v) => records.set(k,v),delete:async k => records.delete(k)};
  const local = {head:async () => null,put:async () => calls.push('local')};
  const remote = {begin:async () => { calls.push('remote'); return 'private-upload-id'; },partUrl:(_key,id,n,size) => ({id,n,size}),abort:async () => {}};
  const media = createHybridMedia({local,remote,state});
  const row = {id:'12345678',key:'12345678-file.pdf',size:LOCAL_MEDIA_BYTES,email:'editor@example.test',mime:'application/pdf'};
  await assert.rejects(media.beginDirect(row),/ההעלאה/);
  await media.put(row.key,new ReadableStream());
  row.size++; assert.deepEqual(await media.beginDirect(row),{direct:true,partBytes:DIRECT_PART_BYTES});
  assert.deepEqual(calls,['local','remote']);
  const parts = await media.partUrls(row,12,1);
  assert.equal(parts.parts[0].size,row.size - 11 * DIRECT_PART_BYTES);
  await assert.rejects(media.partUrls({...row,email:'someone@example.test'},1),/נמצאה/);
  await assert.rejects(media.partUrls(row,0),/תקין/);
  await assert.rejects(media.partUrls(row,1,17),/תקין/);
  await media.abortDirect(row); assert.equal(records.size,0);
});

async function world(t) {
  const db = makeD1(); t.after(() => db.raw.close());
  const state = {begin:0,aborts:0,forget:0,gate:null,invalid:false,failAbort:false};
  const env = {
    DB:db,REPO:'o/r',BRANCH:'live',GITHUB_TOKEN:'test',SESSION_SECRET:'local-fixture-secret',
    ALLOWED_ORIGIN:'https://site.example',MEDIA_GH_FILE_MB:'90',MEDIA_GH_TOTAL_MB:'250',MEDIA_R2_FILE_MB:'5120',MEDIA_R2_TOTAL_GB:'9',
    EDITORS:{get:async key => key === 'people' ? JSON.stringify([{email:'editor@example.test',name:'Editor',publisher:true}]) : null},
    MEDIA:{
      hybrid:true,localMaxBytes:LOCAL_MEDIA_BYTES,remoteAvailable:true,
      beginDirect:async () => { state.begin++; return {direct:true,partBytes:DIRECT_PART_BYTES}; },
      partUrls:async () => ({parts:[]}),
      finishDirect:async () => { if (state.gate) await state.gate.promise; },
      forgetDirect:async () => {state.forget++;},
      abortDirect:async () => {state.aborts++; if (state.failAbort) throw Error('provider unavailable');},
      head:async key => {const row = db.raw.prepare('SELECT size FROM media WHERE key = ?').get(key);return row && {size:row.size};},
      get:async () => ({arrayBuffer:async () => Buffer.from(state.invalid ? 'wrong format' : '%PDF-1.7 fixture')}),
    },
  };
  const token = await makeSession('editor@example.test',env);
  const api = async (path,body) => {
    const response = await worker.fetch(new Request('https://worker.example' + path,{method:'POST',headers:{Origin:env.ALLOWED_ORIGIN,Authorization:'Bearer ' + token},body:JSON.stringify(body)}),env);
    return {status:response.status,body:await response.json()};
  };
  const row = id => db.raw.prepare('SELECT * FROM media WHERE id = ?').get(id);
  await api('/media/init',{name:'small.pdf',size:10});
  return {env,state,api,row,db};
}
test('every ordinary hybrid upload bypasses Git; exactly 90 MiB stays local and one more byte starts direct upload',async t => {
  const w = await world(t);
  const at = await w.api('/media/init',{name:'boundary.pdf',size:LOCAL_MEDIA_BYTES});
  assert.equal(at.status,200); assert.equal(at.body.store,'r2'); assert.equal(at.body.direct,undefined);
  assert.equal(w.row(at.body.id).status,'uploading');
  const above = await w.api('/media/init',{name:'large.pdf',size:LOCAL_MEDIA_BYTES + 1});
  assert.equal(above.status,200); assert.equal(above.body.direct,true);
  assert.equal(w.row(above.body.id).status,'receiving'); assert.equal(w.state.begin,1);
  w.env.MEDIA.remoteAvailable = false;
  assert.equal((await w.api('/media/init',{name:'unavailable.pdf',size:LOCAL_MEDIA_BYTES + 1})).status,503);
});
test('direct completion claims an exclusive state; concurrent completion and cancellation cannot delete its object',async t => {
  const w = await world(t), init = await w.api('/media/init',{name:'large.pdf',size:LOCAL_MEDIA_BYTES + 1}), id = init.body.id;
  w.state.gate = deferred();
  const completion = w.api('/media/complete',{id});
  while (w.row(id).status !== 'finalizing') await new Promise(resolve => setImmediate(resolve));
  assert.equal((await w.api('/media/complete',{id})).status,409);
  assert.equal((await w.api('/media/abort',{id})).status,409);
  w.state.gate.resolve();
  assert.equal((await completion).status,200); assert.equal(w.row(id).status,'published');
  assert.equal(w.state.aborts,0);
  assert.equal((await w.api('/media/complete',{id})).status,200);
  assert.equal((await w.api('/media/abort',{id})).status,200);
  assert.equal(w.state.aborts,0);
});
test('invalid direct uploads are removed before quota is released; a failed provider cleanup keeps the reservation',async t => {
  const w = await world(t), a = await w.api('/media/init',{name:'invalid.pdf',size:LOCAL_MEDIA_BYTES + 1});
  w.state.invalid = true;
  assert.equal((await w.api('/media/complete',{id:a.body.id})).status,400);
  assert.equal(w.row(a.body.id),undefined); assert.equal(w.state.aborts,1);
  const b = await w.api('/media/init',{name:'retry.pdf',size:LOCAL_MEDIA_BYTES + 1});
  w.state.failAbort = true;
  assert.equal((await w.api('/media/complete',{id:b.body.id})).status,500);
  assert.equal(w.row(b.body.id).status,'finalizing');
});
