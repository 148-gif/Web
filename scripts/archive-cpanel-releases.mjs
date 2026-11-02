// Run on Linux as the account owner, directly under flock -n <private>/operator-guarded-config/poll.lock.
// --plan selects at most one old public/ tree. --archive SHA emits a tar.gz and its inventory.
// --reclaim SHA additionally requires an independently supplied off-account.json (see attest below).
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as F } from 'node:fs';
import { lstat, open, realpath, readdir, readFile, readlink, mkdir, link, unlink, rmdir, rename, stat, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = '/home/yoterber/heichal-cms', PUBLIC = '/home/yoterber/hichal.yoterberama.com';
const SHA = /^[0-9a-f]{40}$/, HASH = /^[0-9a-f]{64}$/, UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const STEPS = 'stage check-source maintenance-on stop-old park-old public-apply runtime-promote verify-combined commit-live maintenance-off'.split(' ');
const MiB = 1024 ** 2;
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
function requireState(ok, code) { if (!ok) throw new Error(code); }
async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function directory(path) {
  const s = await lstat(path);
  requireState(s.isDirectory() && s.uid === process.getuid() && (s.mode & 0o7777) === 0o700 && await realpath(path) === path, 'unsafe-directory');
}
async function syncDir(path) { const d = await open(path, F.O_DIRECTORY | F.O_NOFOLLOW); try { await d.sync(); } finally { await d.close(); } }
async function checkedFile(path, limit, collect = false) {
  requireState(await realpath(path) === path, 'unsafe-path');
  const h = await open(path, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  try {
    const s = await h.stat({ bigint: true });
    requireState(s.isFile() && s.uid === BigInt(process.getuid()) && s.nlink === 1n && (s.mode & 0o7777n) === 0o600n && s.size <= BigInt(limit), 'unsafe-file');
    const digest = createHash('sha256'), chunks = []; let bytes = 0;
    for await (const chunk of h.createReadStream({ autoClose: false })) {
      bytes += chunk.length; requireState(bytes <= limit, 'size'); digest.update(chunk); if (collect) chunks.push(chunk);
    }
    const after = await lstat(path, { bigint: true });
    requireState(s.dev === after.dev && s.ino === after.ino && s.ctimeNs === after.ctimeNs && BigInt(bytes) === s.size, 'file-changed');
    return { bytes, sha256: digest.digest('hex'), ...(collect ? { value: JSON.parse(Buffer.concat(chunks).toString()) } : {}) };
  } finally { await h.close(); }
}
const readJson = (path, limit = 8 * MiB) => checkedFile(path, limit, true);
async function newJson(path, value) {
  const temp = path + '.' + randomUUID(), handle = await open(temp, 'wx', 0o600);
  try {
    try { await handle.writeFile(json(value)); await handle.sync(); } finally { await handle.close(); }
    await link(temp, path);
  } finally { await unlink(temp); }
  await syncDir(dirname(path));
}
async function idle(root, document, ownClaim = false) {
  const combined = join(root, 'combined-state'), publication = join(root, 'publication-state');
  const paths = [join(root, 'deployment-admission.lock'), ...['lock','recovery.lock','recovery-admission.lock'].map(p => join(combined,p)),
    ...['pending.json','lock','runner.lock','runner-admission.lock'].map(p => join(publication,p)),
    ...['.cpanel-maintenance','.heichal-runtime-drain-canonical','.heichal-runtime-drain-candidate'].map(p => join(document,p))];
  if (!ownClaim) paths.push(join(root,'deployment-claim.lock'));
  for (const path of paths) requireState(!await exists(path), 'active-deployment');
}
async function names(path) { await directory(path); const result = await readdir(path); requireState(result.length <= 10000, 'too-many-records'); return result; }
async function oldest(root, document) {
  const outer = join(root,'combined-state'), contexts = join(outer,'contexts'), journals = join(outer,'journals');
  const current = (await readJson(join(outer,'current.json'))).value;
  const published = (await readJson(join(root,'publication-state/current.json'),16*MiB)).value;
  const live = (await readJson(join(outer,'journal.json'))).value;
  requireState(SHA.test(current.commit) && current.commit === published.commit && current.commit === live.plan.commit && published.releaseId === live.releaseId && published.documentRoot === document, 'inconsistent-current');
  const forward = new Map(), keep = new Set(), known = new Set();
  const entries = await exists(journals) ? await names(journals) : [];
  const all = [...entries.map(n => join(journals,n)), join(outer,'journal.json')];
  for (const path of all) {
    const j = path === all.at(-1) ? live : (await readJson(path)).value, p = j.plan;
    requireState(j.format === 'heichal-combined-deployment' && j.version === 2 && UUID.test(j.releaseId) && (j === live || path === join(journals,j.releaseId+'.json')) && p.repo === '148-gif/Web' && p.branch === 'claude/greeting-2i183o' && p.documentRoot === document && SHA.test(p.commit) && SHA.test(p.previousCommit) && hash(JSON.stringify(p)) === j.planSha256 && HASH.test(p.adapterContextSha256) && HASH.test(p.artifactSha256), 'untrusted-journal');
    requireState(Array.isArray(j.events) && j.events.at(-1)?.type === 'complete', 'nonterminal-journal');
    known.add(p.commit);
    if (j.events.some(e => e.type === 'switch')) { keep.add(p.commit); keep.add(p.previousCommit); continue; }
    const receipts = j.events.filter(e => e.type === 'receipt');
    requireState(receipts.length === STEPS.length && receipts.every((e,i) => e.direction === 'forward' && e.step === STEPS[i]) && !forward.has(p.commit), 'ambiguous-success');
    forward.set(p.commit, p);
  }
  for (const name of await names(contexts)) {
    requireState(/^[0-9a-f]{40}\.json$/.test(name), 'unrecognized-context');
    const sha = name.slice(0,-5);
    if (!known.has(sha)) { const c = (await readJson(join(contexts,name))).value; requireState(c.commit === sha && SHA.test(c.previous?.commit), 'invalid-context'); keep.add(sha); keep.add(c.previous.commit); }
  }
  const chain = [], visited = new Set();
  for (let sha = current.commit; forward.has(sha); sha = forward.get(sha).previousCommit) {
    requireState(!visited.has(sha), 'ambiguous-chain'); visited.add(sha); chain.push(sha);
  }
  requireState(chain.length && live.events.every(e => e.type !== 'switch'), 'current-needs-reconciliation');
  for (const sha of chain.slice(0,3)) keep.add(sha);
  for (const sha of chain.reverse()) {
    if (keep.has(sha)) continue;
    const archived = join(root,'release-archives',sha,'reclaimed.json');
    if (await exists(archived)) { requireState((await readJson(archived)).value.commit === sha && !await exists(join(outer,'candidates',sha,'public')), 'reclaimed-state-drift'); continue; }
    return forward.get(sha);
  }
  return null;
}
async function inventory(root, p) {
  const outer = join(root,'combined-state'), target = join(outer,'candidates',p.commit);
  const context = await readJson(join(outer,'contexts',p.commit+'.json')), receipt = (await readJson(target+'.json')).value;
  const manifest = await readJson(join(target,'manifest.json'),8*MiB), m=manifest.value, c=context.value;
  requireState(context.sha256 === p.adapterContextSha256 && c.commit === p.commit && c.previous?.commit === p.previousCommit && c.candidateRoot === target && c.artifactSha256 === p.artifactSha256 && c.manifestSha256 === manifest.sha256 && receipt.commit === p.commit && receipt.manifestSha256 === manifest.sha256 && receipt.artifactSha256 === p.artifactSha256 && Number.isSafeInteger(c.runId) && c.runId > 0 && receipt.runId === c.runId, 'source-receipt');
  requireState(m.format === 'heichal-cpanel-release' && m.version === 1 && m.commit === p.commit && m.branch === p.branch && m.siteOrigin === 'https://hichal.yoterberama.com' && m.siteBase === '' && m.secretsIncluded === false && m.databaseIncluded === false && Array.isArray(m.files) && m.files.length <= 20000, 'invalid-manifest');
  const files = [], seen = new Set(), dirs = new Set(['public']); let bytes = 0;
  for (const f of m.files) {
    requireState(typeof f.path === 'string' && /^(public|app)\//.test(f.path) && !/[\\\p{Cc}]/u.test(f.path) && !f.path.split('/').some(part => !part || part === '.' || part === '..') && !seen.has(f.path) && HASH.test(f.sha256) && Number.isSafeInteger(f.bytes) && f.bytes >= 0 && f.bytes <= 128*MiB, 'invalid-entry');
    seen.add(f.path); if (!f.path.startsWith('public/')) continue;
    bytes += f.bytes; files.push({path:f.path, bytes:f.bytes, sha256:f.sha256});
    for (let dir=dirname(f.path); dir !== '.'; dir=dirname(dir)) dirs.add(dir);
  }
  requireState(files.length && bytes <= 1024*MiB && dirs.size+files.length <= 50000 && !files.some(f=>dirs.has(f.path)), 'inventory-limit');
  files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  return {version:1, commit:p.commit, runId:c.runId, artifactSha256:p.artifactSha256, manifestSha256:manifest.sha256, fileMode:0o600, directoryMode:0o700, bytes, dirs:[...dirs].sort(), files};
}

async function inspectPublic(path, inv, partial = false) {
  const allowedDirs = new Set(inv.dirs), allowedFiles = new Map(inv.files.map(f=>[f.path,f]));
  const foundFiles = [], foundDirs = [], device = (await lstat(dirname(path))).dev;
  async function walk(dir, rel) {
    requireState(allowedDirs.delete(rel), 'unexpected-directory'); await directory(dir);
    requireState((await lstat(dir)).dev === device, 'foreign-device'); foundDirs.push(dir);
    for (const name of await readdir(dir)) {
      const file = join(dir,name), key = rel+'/'+name, st = await lstat(file);
      requireState(st.dev === device, 'foreign-device');
      if (st.isDirectory()) { await walk(file,key); continue; }
      const f=allowedFiles.get(key); requireState(f && st.isFile(), 'unexpected-file');
      const actual=await checkedFile(file,f.bytes);
      requireState(actual.bytes === f.bytes && actual.sha256 === f.sha256, 'payload-drift');
      allowedFiles.delete(key); foundFiles.push(file);
    }
  }
  await walk(path,'public'); requireState(partial || (!allowedDirs.size && !allowedFiles.size), 'missing-entry');
  return {files:foundFiles, dirs:foundDirs.reverse()};
}
async function tar(args, cwd, {input, output} = {}) {
  const child = spawn('/usr/bin/tar', args, {cwd, env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}, stdio:[input?'pipe':'ignore',output??'pipe','ignore']});
  const done = new Promise((ok,no)=>{child.once('error',no); child.once('close',code=>code===0?ok():no(new Error('tar-failed')));});
  const chunks=[]; let bytes=0;
  if (child.stdout) child.stdout.on('data',b=>{bytes+=b.length; if(bytes<=16*MiB)chunks.push(b); else child.kill();});
  if (input) { child.stdin.on('error',()=>{}); child.stdin.end(input); }
  await done; requireState(bytes <= 16*MiB,'tar-output-limit'); return Buffer.concat(chunks).toString();
}
async function ensureDir(path) { try { await mkdir(path,{mode:0o700}); } catch(e) { if(e.code!=='EEXIST')throw e; } await directory(path); }
const members = inv => [...inv.dirs,...inv.files.map(f=>f.path)];
async function verifyTar(archive,target,inv) {
  const listed=(await tar(['-tzf',archive,'--quoting-style=literal'],target)).replace(/\n$/, '').split('\n').map(n=>n.replace(/\/$/,'')).sort();
  requireState(JSON.stringify(listed) === JSON.stringify(members(inv).sort()), 'archive-members');
  await tar(['-dzf',archive],target);
}
async function makeArchive(archive,target,inv) {
  const disk=await statfs(dirname(archive),{bigint:true}), bound=inv.bytes+4096*(inv.files.length+inv.dirs.length)+64*MiB;
  requireState(disk.bavail*disk.bsize >= BigInt(bound), 'archive-space');
  const tmp=archive+'.'+randomUUID(), h=await open(tmp,'wx',0o600);
  try {
    try { await tar(['-czf','-','--format=posix','--no-recursion','--null','--verbatim-files-from','-T','-'],target,{input:Buffer.from(members(inv).join('\0')+'\0'),output:h.fd}); await h.sync(); } finally { await h.close(); }
    await verifyTar(tmp,target,inv); await link(tmp,archive);
  } finally { await unlink(tmp); }
  await syncDir(dirname(archive));
}
async function writeOrMatch(path,value) {
  if (await exists(path)) requireState((await readJson(path,16*MiB)).sha256 === hash(json(value)), 'immutable-record-drift');
  else await newJson(path,value);
}
function attest(ack,bundle) {
  requireState(ack.version === 1 && ack.commit === bundle.commit && ack.archiveSha256 === bundle.archiveSha256 && ack.inventorySha256 === bundle.inventorySha256 && ack.manifestSha256 === bundle.manifestSha256 && ack.offAccount === true && ack.restoredVerified === true && typeof ack.objectId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,249}$/.test(ack.objectId), 'off-account-proof-required');
}
// The off-account transport creates its own private acknowledgement after a full independent restore.
// This program never makes an attestation or accepts a destination from the command line.
export async function rotatePublic({root,document,mode,expected}) {
  requireState(['plan','archive','reclaim'].includes(mode) && (mode==='plan' ? expected===undefined : SHA.test(expected)), 'arguments');
  await directory(root); await idle(root,document);
  const claim=join(root,'deployment-claim.lock'); let held=false;
  try {
    if (mode!=='plan') { await mkdir(claim,{mode:0o700}); held=true; await newJson(join(claim,'archive-owner.json'),{pid:process.pid,claim:randomUUID()}); await idle(root,document,true); }
    const p=await oldest(root,document); if(!p){requireState(mode==='plan','no-eligible-release');return {outcome:'none'};}
    requireState(mode==='plan'||expected===p.commit,'stale-selection');
    const target=join(root,'combined-state/candidates',p.commit), source=join(target,'public'), inv=await inventory(root,p);
    const archives=join(root,'release-archives'), out=join(archives,p.commit), archive=join(out,'public.tar.gz'), quarantine=join(target,'.retiring-public');
    const intent=join(out,'reclaim-intent.json'), inProgress=await exists(intent);
    if(mode==='plan')return {outcome:inProgress?'resume-required':'eligible',commit:p.commit,files:inv.files.length,dirs:inv.dirs.length,bytes:inv.bytes,manifestSha256:inv.manifestSha256};
    await directory(target); await ensureDir(archives); await ensureDir(out);
    const present=await exists(source), parked=await exists(quarantine);
    requireState(!(present&&parked) && (present || inProgress) && (!inProgress || mode==='reclaim'), 'reclaim-state');
    if(present)await inspectPublic(source,inv);
    await writeOrMatch(join(out,'inventory.json'),inv);
    if (!await exists(archive)) { requireState(mode==='archive' && present && !inProgress,'archive-required'); await makeArchive(archive,target,inv); }
    else if (present) await verifyTar(archive,target,inv);
    const packed=await checkedFile(archive,Math.ceil(1.3*1024*MiB));
    const bundle={version:1,commit:p.commit,manifestSha256:inv.manifestSha256,inventorySha256:hash(json(inv)),archiveSha256:packed.sha256,archiveBytes:packed.bytes};
    await writeOrMatch(join(out,'bundle.json'),bundle);
    if (mode==='archive') return {...bundle,outcome:'awaiting-off-account-proof'};
    const acknowledgement=await readJson(join(out,'off-account.json'),4096); attest(acknowledgement.value,bundle);
    await idle(root,document,true); requireState((await oldest(root,document))?.commit===p.commit,'release-became-protected');
    const decision={...bundle,offAccountReceiptSha256:acknowledgement.sha256}; await writeOrMatch(intent,decision);
    if(present){await rename(source,quarantine); await syncDir(target);}
    if(await exists(quarantine)) {
      const remaining=await inspectPublic(quarantine,inv,inProgress);
      for(const file of remaining.files) await unlink(file);
      for(const dir of remaining.dirs) await rmdir(dir);
      await syncDir(target);
    }
    await writeOrMatch(join(out,'reclaimed.json'),decision);
    return {...decision,outcome:'reclaimed',files:inv.files.length,dirs:inv.dirs.length};
  } finally {
    if (held) { const owner=join(claim,'archive-owner.json'); if(await exists(owner))await unlink(owner); await rmdir(claim); await syncDir(root); }
  }
}
export async function requireFlock(root) {
  const lock=join(root,'operator-guarded-config/poll.lock'), parent='/proc/'+process.ppid;
  requireState(await readlink(parent+'/exe') === '/usr/bin/flock' && await realpath(lock) === lock,'external-flock-required');
  const file=await lstat(lock,{bigint:true}); requireState(file.isFile()&&file.nlink===1n&&file.uid===BigInt(process.getuid())&&!(file.mode&0o022n),'unsafe-flock');
  for (const fd of await readdir(parent+'/fd')) {
    try {
      const s=await stat(parent+'/fd/'+fd,{bigint:true}); if(s.ino!==file.ino||s.dev!==file.dev)continue;
      const info=await readFile(parent+'/fdinfo/'+fd,'utf8');
      if(info.split('\n').some(l=>/^lock:.*\bFLOCK\s+ADVISORY\s+WRITE\s+/.test(l)))return;
    } catch(e) { if(e.code!=='ENOENT')throw e; }
  }
  throw new Error('external-flock-required');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [flag,expected,...extra]=process.argv.slice(2);
  (async()=>{requireState(!extra.length && ['--plan','--archive','--reclaim'].includes(flag),'arguments'); await requireFlock(HOME);
    return rotatePublic({root:HOME,document:PUBLIC,mode:flag.slice(2),expected});
  })().then(result=>console.log(JSON.stringify(result)),e=>{console.error('Archive stopped:',/^[-a-z]+$/.test(e.message)?e.message:'private-state-or-I/O');process.exitCode=1;});
}
