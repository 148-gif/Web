// The hosting Cron holds one flock across this process and the guarded child.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as F } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOME = '/home/yoterber/heichal-cms', PUBLIC = '/home/yoterber/hichal.yoterberama.com';
const CONFIG = HOME + '/operator-guarded-config/controller.json';
const STAMP = join(dirname(CONFIG), 'poll-proof.json');
const ORIGIN = 'https://hichal.yoterberama.com', BRANCH = 'claude/greeting-2i183o';
const SHA = /^[a-f0-9]{40}$/, FULL_INTERVAL = 15 * 60 * 1000;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('cPanel poll verification failed'); };
async function privateBytes(path, limit) {
  if (!path.startsWith(HOME + '/') || resolve(path) !== path || await realpath(path) !== path) fail();
  const dir = await lstat(dirname(path));
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o7777) !== 0o700) fail();
  const h = await open(path, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  try {
    const before = await h.stat({bigint:true});
    if (!before.isFile() || before.uid !== BigInt(process.getuid()) || (before.mode & 0o7777n) !== 0o600n || before.nlink !== 1n || before.size > BigInt(limit)) fail();
    const bytes = Buffer.alloc(Number(before.size) + 1); let at = 0;
    while (at < bytes.length) { const r = await h.read(bytes,at,bytes.length-at,at); if (!r.bytesRead) break; at += r.bytesRead; }
    const after = await lstat(path,{bigint:true});
    if (at !== Number(before.size) || before.ino !== after.ino || before.dev !== after.dev || before.ctimeNs !== after.ctimeNs) fail();
    return bytes.subarray(0,at);
  } finally { await h.close(); }
}
async function saveStamp(proof) {
  const temp = STAMP + '.' + randomUUID(), h = await open(temp, F.O_CREAT | F.O_EXCL | F.O_WRONLY | F.O_NOFOLLOW, 0o600);
  try {
    try { await h.writeFile(JSON.stringify(proof) + '\n'); await h.sync(); } finally { await h.close(); }
    await rename(temp,STAMP);
    const dir = await open(dirname(STAMP),F.O_RDONLY|F.O_DIRECTORY|F.O_NOFOLLOW); try { await dir.sync(); } finally { await dir.close(); }
  } finally { await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;}); }
}
async function jsonRequest(url, headers, site = false) {
  const r = await fetch(url,{headers,method:'GET',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000)});
  if (!r.ok || r.status !== 200 || r.redirected || !r.body || !/application\/(?:vnd\.github\+)?json/i.test(r.headers.get('content-type') || '')) fail();
  if (site && (!/\bnoindex\b/i.test(r.headers.get('x-robots-tag') || '') || r.headers.has('set-cookie'))) fail();
  if (site && url.endsWith('/version') && !/\bno-store\b/i.test(r.headers.get('cache-control') || '')) fail();
  const rd = r.body.getReader(), chunks = []; let size = 0;
  try { for (;;) { const {done,value}=await rd.read(); if(done)break; size+=value.length; if(size>8192)fail(); chunks.push(value); } }
  finally { await rd.cancel().catch(()=>{}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function poll({ snapshot, head, health, saved, apply, record, now = Date.now }) {
  let current, remote, proof;
  try { [current,remote,proof] = await Promise.all([snapshot(),head(),saved()]); } catch { /* A missing proof cannot skip the release check. */ }
  const t = now();
  if (current && proof && SHA.test(remote || '') && remote === current.commit && proof.commit === remote &&
      proof.currentDigest === current.currentDigest && proof.journalDigest === current.journalDigest && proof.configDigest === current.configDigest &&
      Number.isSafeInteger(proof.fullAt) && t >= proof.fullAt && t - proof.fullAt < FULL_INTERVAL) {
    try { await health(current); return {outcome:'matched',commit:remote,fullProof:false,lastFullAt:proof.fullAt}; }
    catch { /* The native full proof reports the failure and preserves recovery. */ }
  }
  const result = await apply();
  if (['committed','unchanged'].includes(result.outcome) && SHA.test(result.commit || '')) {
    current = await snapshot(); remote = await head();
    if (current.commit === result.commit && remote === current.commit) {
      await health(current); await record({commit:remote,currentDigest:current.currentDigest,journalDigest:current.journalDigest,configDigest:current.configDigest,fullAt:now()});
    }
  }
  return result;
}
async function main(args) {
  if (args.length !== 2 || args[0] !== '--config' || args[1] !== CONFIG) fail();
  const cfg = await privateBytes(CONFIG,65536), config = JSON.parse(cfg), configDigest = digest(cfg);
  if (config.version !== 2 || config.enabled !== true || config.repo !== '148-gif/Web' || config.branch !== BRANCH || config.documentRoot !== PUBLIC ||
      config.outerStateRoot !== HOME+'/combined-state' || config.staticStateRoot !== HOME+'/publication-state' || !config.githubTokenFile.startsWith(HOME+'/config/')) fail();
  const token = (await privateBytes(config.githubTokenFile,4096)).toString().trim(); if (!/^[\x21-\x7e]{1,4096}$/.test(token)) fail();
  async function head() {
    const value = await jsonRequest('https://api.github.com/repos/148-gif/Web/git/ref/heads/'+BRANCH,{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'User-Agent':'heichal-release-poll','X-GitHub-Api-Version':'2022-11-28','Cache-Control':'no-cache'});
    if (value.ref !== 'refs/heads/'+BRANCH || value.object?.type !== 'commit' || !SHA.test(value.object.sha)) fail(); return value.object.sha;
  }
  async function snapshot() {
    for (const path of [HOME+'/deployment-admission.lock',HOME+'/deployment-claim.lock',config.outerStateRoot+'/lock',config.staticStateRoot+'/runner.lock',
      PUBLIC+'/.cpanel-maintenance',PUBLIC+'/.heichal-runtime-drain-canonical',PUBLIC+'/.heichal-runtime-drain-candidate']) {
      try { await lstat(path); } catch(e) { if(e.code==='ENOENT')continue; throw e; } fail();
    }
    const [c,j]=await Promise.all(['current.json','journal.json'].map(n=>privateBytes(join(config.outerStateRoot,n),65536)));
    const current=JSON.parse(c),journal=JSON.parse(j);
    if(!SHA.test(current.commit??'') || !/^[a-f0-9]{64}$/.test(current.runtimeManifestSha256??'') || journal.events?.at(-1)?.type!=='complete')fail();
    return {commit:current.commit,runtime:current.runtimeManifestSha256,currentDigest:digest(c),journalDigest:digest(j),configDigest};
  }
  async function health(current) {
    const headers={Accept:'application/json',Origin:ORIGIN,'Cache-Control':'no-cache'};
    const [marker,api]=await Promise.all(['/admin/build.json','/cms-api/version'].map(p=>jsonRequest(ORIGIN+p,headers,true)));
    if(marker.sha!==current.commit || api.commit!==current.commit || api.runtimeManifestSha256!==current.runtime || api.verified!==true || api.schemaVerified!==true || api.deploymentCandidate!==false)fail();
  }
  async function apply() {
    const child=spawn(process.execPath,[join(dirname(fileURLToPath(import.meta.url)),'deploy-cpanel-guarded.mjs'),'--config',CONFIG,'--apply'],{stdio:['ignore','pipe','inherit'],shell:false});
    const chunks=[];let size=0;child.stdout.on('data',b=>{size+=b.length;if(size<=65536)chunks.push(b);});
    const code=await new Promise((ok,no)=>{child.once('error',no);child.once('close',ok);});
    if(code!==0||!size||size>65536)fail();return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return poll({snapshot,head,health,apply,record:saveStamp,saved:async()=>JSON.parse(await privateBytes(STAMP,4096))});
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('cPanel poll stopped; inspect the private release status.');process.exitCode=1;});
}
