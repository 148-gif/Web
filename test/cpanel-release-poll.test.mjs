import test from 'node:test';
import assert from 'node:assert/strict';
import { poll } from '../scripts/poll-cpanel-release.mjs';

const a='a'.repeat(40), b='b'.repeat(40);
function fixture() {
  let live=a,remote=a,time=1000000,applyCount=0,healthy=true,dirty=false;
  let proof={commit:a,currentDigest:'current-'+a,journalDigest:'done',configDigest:'config',fullAt:time};
  const api={now:()=>time,head:async()=>remote,saved:async()=>proof,record:async x=>{proof=x;},
    snapshot:async()=>{if(dirty)throw Error('unfinished');return {commit:live,currentDigest:'current-'+live,journalDigest:'done',configDigest:'config'};},
    health:async()=>{if(!healthy)throw Error('different markers');},
    apply:async()=>{applyCount++;return {outcome:'unchanged',commit:live};}};
  return {api,get count(){return applyCount;},get proof(){return proof;},set remote(x){remote=x;},set live(x){live=x;},set time(x){time=x;},set healthy(x){healthy=x;},set dirty(x){dirty=x;}};
}
test('matching GitHub, durable state and both live markers can skip one expensive check',async()=>{
  const f=fixture();assert.deepEqual(await poll(f.api),{outcome:'matched',commit:a,fullProof:false,lastFullAt:1000000});assert.equal(f.count,0);
  f.time=1900000;assert.equal((await poll(f.api)).outcome,'unchanged');assert.equal(f.count,1);assert.equal(f.proof.fullAt,1900000);
});
test('a changed head remains pending each minute until a committed current and healthy markers agree',async()=>{
  const f=fixture();f.remote=b;const initial=f.proof;
  assert.equal((await poll(f.api)).commit,a);assert.equal((await poll(f.api)).commit,a);assert.equal(f.count,2);assert.equal(f.proof,initial);
  f.api.apply=async()=>{f.live=b;return {outcome:'committed',commit:b};};f.healthy=false;
  await assert.rejects(poll(f.api));assert.equal(f.proof,initial);f.healthy=true;await poll(f.api);assert.equal(f.proof.commit,b);
  assert.equal((await poll(f.api)).outcome,'matched');
});
test('incomplete journal, missing proof, source failure and invalid prior timestamps never suppress the full driver',async()=>{
  const f=fixture();f.dirty=true;await assert.rejects(poll(f.api));assert.equal(f.count,1);f.dirty=false;
  f.api.saved=async()=>{throw Error('missing');};assert.equal((await poll(f.api)).outcome,'unchanged');assert.equal(f.count,2);
  f.api.saved=async()=>({...f.proof,fullAt:2000000});assert.equal((await poll(f.api)).outcome,'unchanged');assert.equal(f.count,3);
  f.api.head=async()=>{throw Error('source unavailable');};await assert.rejects(poll(f.api));assert.equal(f.count,4);
});
