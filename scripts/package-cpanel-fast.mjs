// A compressed text/runtime release. Large unchanged assets stay in place;
// changed large assets are read from immutable Git blob IDs and SHA-256 checked.
import { readFile,writeFile,mkdir,copyFile,rm,stat } from 'node:fs/promises';
import { resolve,join,dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const [releaseArg,outArg]=process.argv.slice(2);if(!releaseArg||!outArg)throw Error('Expected release directory and output directory');
const root=resolve(releaseArg),out=resolve(outArg),manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
await mkdir(out,{recursive:true});const stage=join(out,'payload');await mkdir(stage);
const sha=b=>createHash('sha256').update(b).digest('hex');
const sources=new Map(),rows=execFileSync('git',['ls-tree','-rz','--format=%(objectname) %(path)',manifest.commit],{encoding:'utf8',maxBuffer:8*1024**2}).split('\0').filter(Boolean);
for(const row of rows){const split=row.indexOf(' '),id=row.slice(0,split),path=row.slice(split+1);if(!/^(site\/|data\/img\/)/.test(path))continue;const f=resolve(path);try{const info=await stat(f);if(info.isFile()&&info.size>65536)sources.set(sha(await readFile(f)),{blob:id,source:path});}catch{/* An unneeded source cannot qualify as a remote asset. */}}
const files=[];
for(const entry of manifest.files){
 if(!/^(app|public)\//.test(entry.path)||entry.path.split('/').some(x=>!x||x==='.'||x==='..'))throw Error('Invalid manifest member');
 const remote=entry.path.startsWith('public/')&&entry.bytes>65536&&!/\.(?:html|js|mjs|css|json|txt|xml|webmanifest|svg)$/.test(entry.path)&&sources.get(entry.sha256);
 if(remote){files.push({...entry,...remote});continue;}
 const target=join(stage,entry.path);await mkdir(dirname(target),{recursive:true});await copyFile(join(root,entry.path),target);files.push({...entry,packed:true});
}
const document={format:'heichal-fast-release',version:1,commit:manifest.commit,branch:manifest.branch,siteOrigin:manifest.siteOrigin,manifest,files};
const description=JSON.stringify(document)+'\n',descriptionBytes=Buffer.byteLength(description);
const expandedBytes=files.filter(f=>f.packed).reduce((sum,f)=>sum+f.bytes,descriptionBytes);
if(descriptionBytes>8*1024**2)throw Error('Fast release description exceeds the runner limit of 8 MiB');
if(expandedBytes>512*1024**2)throw Error('Fast release expanded size exceeds the runner limit of 512 MiB: '+expandedBytes+' bytes');
await writeFile(join(stage,'release.json'),description);
execFileSync('tar',['-czf',join(out,'fast.tar.gz'),'-C',stage,'.'],{env:{...process.env,GZIP:'-6'},stdio:['ignore','ignore','pipe']});
const size=(await stat(join(out,'fast.tar.gz'))).size;
// Reserve ZIP metadata overhead within the runner's 128 MiB download budget.
if(size>128*1024**2-65536)throw Error('Fast release archive exceeds the runner download budget');
await rm(stage,{recursive:true});console.log(JSON.stringify({commit:manifest.commit,compressedBytes:size,expandedBytes,descriptionBytes,remoteAssets:files.filter(f=>f.blob).length}));
