import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink, link, rename, unlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotatePublic } from '../scripts/archive-cpanel-releases.mjs';

const run=promisify(execFile), hash=v=>createHash('sha256').update(v).digest('hex');
const sha=n=>n.toString(16).padStart(40,'0');
const steps='stage check-source maintenance-on stop-old park-old public-apply runtime-promote verify-combined commit-live maintenance-off'.split(' ');
const put=(path,value)=>writeFile(path,JSON.stringify(value)+'\n',{mode:0o600});
const get=async path=>JSON.parse(await readFile(path));
async function fixture(t,count=5) {
  const root=await mkdtemp(join(tmpdir(),'public-archive-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const document=join(root,'live'), outer=join(root,'combined-state'), publication=join(root,'publication-state');
  for (const dir of [document,join(outer,'journals'),join(outer,'contexts'),join(outer,'candidates'),join(publication,'releases'),join(root,'operator-guarded-config')]) await mkdir(dir,{recursive:true,mode:0o700});
  const archive=n=>join(root,'release-archives',sha(n)), candidate=n=>join(outer,'candidates',sha(n));
  const source='private exact bytes\n', name='public/ספר/old-page.html', sourceHash=hash(source);
  const ids=[];
  for(let n=1;n<=count;n++) {
    const commit=sha(n),previousCommit=sha(n-1),dest=candidate(n),releaseId=randomUUID(); ids.push(releaseId);
    const files=[{path:name,bytes:Buffer.byteLength(source),sha256:sourceHash},{path:'public/index.html',bytes:0,sha256:hash('')}];
    await mkdir(join(dest,'public/ספר'),{recursive:true,mode:0o700});await mkdir(join(dest,'app'),{mode:0o700});
    await writeFile(join(dest,'app/retain'),'app',{mode:0o600});await writeFile(join(dest,name),source,{mode:0o600});await writeFile(join(dest,'public/index.html'),'',{mode:0o600});
    await put(join(dest,'manifest.json'),{format:'heichal-cpanel-release',version:1,commit,branch:'claude/greeting-2i183o',siteOrigin:'https://hichal.yoterberama.com',siteBase:'',secretsIncluded:false,databaseIncluded:false,files});
    const manifestSha256=hash(await readFile(join(dest,'manifest.json'))),artifactSha256=hash(commit),runId=n;
    await put(dest+'.json',{commit,manifestSha256,artifactSha256,runId});
    const cx=join(outer,'contexts',commit+'.json');await put(cx,{commit,previous:{commit:previousCommit},candidateRoot:dest,manifestSha256,artifactSha256,runId});
    const plan={version:2,repo:'148-gif/Web',branch:'claude/greeting-2i183o',domain:'hichal.yoterberama.com',documentRoot:document,commit,previousCommit,artifactSha256,adapterContextSha256:hash(await readFile(cx))};
    const events=steps.flatMap(step=>[{type:'intent',direction:'forward',step},{type:'receipt',direction:'forward',step}]);events.push({type:'complete'});
    await put(n===count?join(outer,'journal.json'):join(outer,'journals',releaseId+'.json'),{format:'heichal-combined-deployment',version:2,releaseId,plan,planSha256:hash(JSON.stringify(plan)),events});
    const backup=join(publication,'releases',releaseId,'backup');await mkdir(backup,{recursive:true,mode:0o700});await writeFile(join(backup,'0'),'preserved rollback',{mode:0o600});
  }
  await put(join(outer,'current.json'),{commit:sha(count)});await put(join(publication,'current.json'),{commit:sha(count),releaseId:ids.at(-1),documentRoot:document});
  return {root,document,outer,publication,archive,candidate,source,name,ids,op:(mode,n)=>rotatePublic({root,document,mode,expected:n===undefined?undefined:sha(n)})};
}
async function registered(f,bundle) {
  const restore=await mkdtemp(join(tmpdir(),'independent-restore-'));
  try {
    await run('/usr/bin/tar',['-xzf',join(f.archive(1),'public.tar.gz'),'-C',restore]);
    const inv=await get(join(f.archive(1),'inventory.json'));
    for(const row of inv.files) {assert.equal(hash(await readFile(join(restore,row.path))),row.sha256);assert.equal((await lstat(join(restore,row.path))).mode&0o777,0o600);}
    for(const dir of inv.dirs)assert.equal((await lstat(join(restore,dir))).mode&0o777,0o700);
    const attestation={...bundle,version:1,offAccount:true,restoredVerified:true,objectId:'test-vault:verified-copy'};
    await put(join(f.archive(1),'off-account.json'),attestation);
  } finally { await rm(restore,{recursive:true,force:true}); }
}
test('retains three online, archives one oldest, and reclaims only registered public bytes',async t=>{
  const f=await fixture(t); assert.equal((await f.op('plan')).commit,sha(1));
  await assert.rejects(f.op('archive',3),/stale-selection/);
  const bundle=await f.op('archive',1);assert.equal(bundle.outcome,'awaiting-off-account-proof');
  assert.equal(hash(await readFile(join(f.archive(1),'public.tar.gz'))),bundle.archiveSha256);
  assert.equal((await f.op('archive',1)).archiveSha256,bundle.archiveSha256);
  await assert.rejects(f.op('reclaim',1));await access(join(f.candidate(1),f.name));
  await registered(f,bundle);assert.equal((await f.op('reclaim',1)).outcome,'reclaimed');
  await assert.rejects(access(join(f.candidate(1),'public')), {code:'ENOENT'});
  for(const path of [join(f.candidate(1),'app/retain'),join(f.candidate(1),'manifest.json'),join(f.publication,'releases',f.ids[0],'backup/0'),join(f.archive(1),'public.tar.gz')])await access(path);
  assert.equal((await f.op('plan')).commit,sha(2));for(let n=2;n<=5;n++)await access(join(f.candidate(n),f.name));
});
test('absence of spare history, native locks, prepared contexts and incomplete journal cannot authorize archival',async t=>{
  const short=await fixture(t,3);assert.equal((await short.op('plan')).outcome,'none');
  const f=await fixture(t);const pending=join(f.publication,'pending.json');await put(pending,{});await assert.rejects(f.op('archive',1),/active-deployment/);await unlink(pending);
  const pendingCtx=join(f.outer,'contexts',sha(99)+'.json');await put(pendingCtx,{commit:sha(99),previous:{commit:sha(1)}});assert.equal((await f.op('plan')).commit,sha(2));
  const journal=join(f.outer,'journals',f.ids[0]+'.json');const j=await get(journal);j.events.pop();await put(journal,j);await assert.rejects(f.op('plan'),/nonterminal/);
});
for(const problem of ['unknown','symlink','hardlink','drift','missing','receipt'])test('rejects '+problem+' before reclaiming any source',async t=>{
  const f=await fixture(t),target=f.candidate(1),file=join(target,f.name);
  if(problem==='unknown')await writeFile(join(target,'public/extra'),'x',{mode:0o600});
  if(problem==='symlink'||problem==='hardlink'){await unlink(file);await (problem==='symlink'?symlink:link)(join(target,'app/retain'),file);}
  if(problem==='drift')await writeFile(file,'changed');if(problem==='missing')await unlink(file);
  if(problem==='receipt'){const r=await get(target+'.json');r.manifestSha256=hash('false');await put(target+'.json',r);}
  await assert.rejects(f.op('archive',1));await access(join(target,'public/index.html'));await assert.rejects(access(join(f.archive(1),'reclaimed.json')));
});
test('corrupt acknowledgement or archive fails closed and registered partial reclaim resumes',async t=>{
  const f=await fixture(t),bundle=await f.op('archive',1),out=f.archive(1);await registered(f,bundle);
  const ack=await get(join(out,'off-account.json'));await put(join(out,'off-account.json'),{...ack,archiveSha256:hash('wrong')});await assert.rejects(f.op('reclaim',1),/off-account/);
  await put(join(out,'off-account.json'),ack);const decision={...await get(join(out,'bundle.json')),offAccountReceiptSha256:hash(await readFile(join(out,'off-account.json')))};
  await put(join(out,'reclaim-intent.json'),decision);const parked=join(f.candidate(1),'.retiring-public');await rename(join(f.candidate(1),'public'),parked);await unlink(join(parked,'index.html'));
  assert.equal((await f.op('plan')).outcome,'resume-required');assert.equal((await f.op('reclaim',1)).outcome,'reclaimed');
  const other=await fixture(t),b=await other.op('archive',1);await registered(other,b);await writeFile(join(other.archive(1),'public.tar.gz'),'bad');
  await assert.rejects(other.op('reclaim',1));await access(join(other.candidate(1),other.name));
});
test('launch requires the actual exclusive poll.lock held by its flock parent',async t=>{
  const f=await fixture(t,1), lock=join(f.root,'operator-guarded-config/poll.lock');await writeFile(lock,'',{mode:0o600});
  const helper=new URL('../scripts/archive-cpanel-releases.mjs',import.meta.url).href;
  const source='import {requireFlock} from '+JSON.stringify(helper)+';await requireFlock('+JSON.stringify(f.root)+');';
  const args=[process.execPath,'--input-type=module','-e',source];await run('/usr/bin/flock',['-n',lock,...args]);await assert.rejects(run('/usr/bin/flock',['-s','-n',lock,...args]));await assert.rejects(run(process.execPath,args.slice(1)));
});

test('a verified Actions equivalent binds remote bytes separately from the local tar and enforces seven days remaining', async t=>{
  const f=await fixture(t), bundle=await f.op('archive',1), out=f.archive(1), inv=await get(join(out,'inventory.json'));
  const verifiedAt=new Date().toISOString(), expiresAt=new Date(Date.now()+9*86400000).toISOString();
  const ack={version:1,kind:'github-actions-equivalent-v1',commit:inv.commit,runId:inv.runId,artifactId:456,artifactBytes:12345,
    artifactSha256:inv.artifactSha256,manifestSha256:inv.manifestSha256,inventorySha256:bundle.inventorySha256,localArchiveSha256:bundle.archiveSha256,
    verifiedAt,expiresAt,files:inv.files.length,dirs:inv.dirs.length,bytes:inv.bytes,restoredVerified:true};
  for(const extra of [{artifactSha256:bundle.archiveSha256},{artifactId:0},{runId:9},{files:0},{restoredVerified:false},
    {expiresAt:new Date(Date.now()+6*86400000).toISOString()},{verifiedAt:new Date(Date.now()-2*86400000).toISOString()}]) {
    await put(join(out,'actions-equivalent.json'),{...ack,...extra});await assert.rejects(f.op('reclaim',1),/invalid-actions-equivalent/);await access(join(f.candidate(1),'public'));
  }
  await put(join(out,'actions-equivalent.json'),ack);const result=await f.op('reclaim',1);
  assert.equal(result.equivalence,ack.kind);assert.equal(result.artifactId,ack.artifactId);assert.equal(result.artifactSha256,inv.artifactSha256);
  assert.equal(result.archiveSha256,bundle.archiveSha256);assert.notEqual(result.artifactSha256,result.archiveSha256);await access(join(out,'public.tar.gz'));
});
