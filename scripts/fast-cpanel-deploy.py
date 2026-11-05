#!/usr/bin/env python3
"""Private stable-root deployment. Keep one rollback; never touch DB or media."""
import os, sys, json, hashlib, datetime, signal, select, urllib.request, urllib.parse, time, pathlib, tarfile, zipfile, io, shutil, stat, subprocess, ctypes, uuid, re
HOME=pathlib.Path('/home/yoterber/heichal-cms')
PUBLIC=pathlib.Path('/home/yoterber/hichal.yoterberama.com')
STATE=HOME/'fast-deploy'
BRANCH='claude/greeting-2i183o'
REPO='148-gif/Web'
ORIGIN='https://hichal.yoterberama.com'
SHA=re.compile(r'^[0-9a-f]{40}$')
NODE='/opt/alt/alt-nodejs24/root/usr/bin/node'
def digest(b): return hashlib.sha256(b).hexdigest()
def read_json(p): return json.loads(p.read_text())
def atomic_json(p,value):
    temp=p.with_name(p.name+'.'+uuid.uuid4().hex)
    with open(temp,'x',encoding='utf8') as f: os.chmod(temp,0o600);json.dump(value,f,separators=(',',':'));f.flush();os.fsync(f.fileno())
    os.replace(temp,p)
    fd=os.open(str(p.parent),os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)
def canonical(p):
    if p.resolve()!=p or p.is_symlink(): raise RuntimeError('Noncanonical deployment path')
    return p
def private(p):
    canonical(p);s=p.stat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode&0o077 or s.st_nlink!=1: raise RuntimeError('Private file contract')
    return p.read_bytes()
def exchange(a,b):
    libc=ctypes.CDLL(None,use_errno=True)
    fn=libc.renameat2;fn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    if fn(-100,os.fsencode(a),-100,os.fsencode(b),2): raise OSError(ctypes.get_errno(),'Atomic directory exchange failed')
def under(p,root):
    if p==root or root not in p.parents: raise RuntimeError('Path scope')
def remove_private(p):
    under(p,STATE)
    if p.exists():
        canonical(p)
        if not p.is_dir(): raise RuntimeError('Unexpected cleanup type')
        shutil.rmtree(p)
def current_marker(root):
    return read_json(root/'admin/build.json').get('sha')
def request(url,token=None,limit=128*1024*1024):
    if not url.startswith('https://'): raise RuntimeError('HTTPS required')
    headers={'User-Agent':'heichal-fast-release','Cache-Control':'no-cache'}
    if token: headers.update({'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
    class Redirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,req,fp,code,msg,h,newurl):
            u=urllib.parse.urlparse(newurl)
            if u.scheme!='https' or u.username or u.password or not (u.hostname=='api.github.com' or u.hostname.endswith('.githubusercontent.com') or u.hostname.endswith('.blob.core.windows.net') or u.hostname.endswith('.actions.githubusercontent.com')): raise RuntimeError('Artifact redirect rejected')
            r=super().redirect_request(req,fp,code,msg,h,newurl)
            if u.hostname!='api.github.com': r.remove_header('Authorization')
            return r
    opener=urllib.request.build_opener(Redirect())
    with opener.open(urllib.request.Request(url,headers=headers),timeout=40) as r:
        b=r.read(limit+1)
        if len(b)>limit: raise RuntimeError('Response too large')
        return b
def api(path,token): return json.loads(request('https://api.github.com/repos/'+REPO+'/'+path,token,8*1024*1024))
def head(token):
    value=api('git/ref/heads/'+BRANCH,token)['object']
    if value['type']!='commit' or not SHA.fullmatch(value['sha']): raise RuntimeError('Invalid source ref')
    return value['sha']
def health(commit):
    cmd=['/usr/bin/curl','--silent','--show-error','--fail','--noproxy','*','--max-time','15','--resolve','hichal.yoterberama.com:443:64.204.250.80',ORIGIN+'/cms-api/version','-H','Origin: '+ORIGIN,'-H','Cache-Control: no-cache']
    value=json.loads(subprocess.check_output(cmd,stderr=subprocess.DEVNULL))
    if value.get('commit')!=commit or not value.get('verified') or not value.get('schemaVerified') or value.get('deploymentCandidate'): raise RuntimeError('Canonical runtime health mismatch: '+str(value.get('commit')))
def restart(app,stale=None):
    relative=str(app.relative_to(HOME.parent))
    if not re.fullmatch(r'heichal-cms/releases/[a-f0-9]{40}/app',relative): raise RuntimeError('Restart target rejected')
    allowed={str(app)}
    if stale is not None:
        under(stale,STATE);allowed.add(str(stale))
    def selector(action):
        args=['/usr/sbin/cloudlinux-selector',action,'--json','--interpreter','nodejs','--user','yoterber','--app-root',relative]
        result=json.loads(subprocess.check_output(args,stderr=subprocess.DEVNULL,timeout=60))
        if result.get('result')!='success': raise RuntimeError('Native application control failed')
    selector('stop')
    handles=[]
    try:
        for item in pathlib.Path('/proc').iterdir():
            if not item.name.isdigit(): continue
            fd=None
            try:
                before=(item/'stat').read_text().rsplit(')',1)[1].split()[19]
                if item.stat().st_uid!=os.getuid() or os.readlink(item/'exe')!=NODE or os.readlink(item/'cwd') not in allowed: continue
                fd=os.pidfd_open(int(item.name))
                after=(item/'stat').read_text().rsplit(')',1)[1].split()[19]
                if before!=after or item.stat().st_uid!=os.getuid() or os.readlink(item/'exe')!=NODE or os.readlink(item/'cwd') not in allowed:
                    os.close(fd);continue
                handles.append(fd);fd=None
            except (FileNotFoundError,ProcessLookupError,PermissionError):
                if fd is not None: os.close(fd)
        for fd in handles:
            try: signal.pidfd_send_signal(fd,signal.SIGTERM)
            except ProcessLookupError: pass
        deadline=time.monotonic()+20
        for fd in handles:
            poll=select.poll();poll.register(fd,select.POLLIN)
            if not poll.poll(max(0,int((deadline-time.monotonic())*1000))):
                try: signal.pidfd_send_signal(fd,signal.SIGKILL)
                except ProcessLookupError: pass
                if not poll.poll(2000): raise RuntimeError('Managed Node process did not stop')
    finally:
        for fd in handles: os.close(fd)
        selector('start')
def durable_journal(j): atomic_json(STATE/'journal.json',j)
def recover(config):
    path=STATE/'journal.json'
    if not path.exists(): return
    j=read_json(path)
    if j.get('phase') in ['complete','rolled-back']:
        if (PUBLIC/'.cpanel-maintenance').exists():
            health(current_marker(PUBLIC));(PUBLIC/'.cpanel-maintenance').unlink()
        return
    app=canonical(pathlib.Path(config['appRoot']))
    for key,root,marker in [('appStage',app,'app'),('publicStage',PUBLIC,'public')]:
        stage=pathlib.Path(j[key]);under(stage,STATE);canonical(stage)
        installed=read_json(root/'app-release.json').get('commit') if marker=='app' else current_marker(root)
        if installed==j['commit']:
            exchange(root,stage)
    restart(app,pathlib.Path(j['appStage']))
    saved=read_json(pathlib.Path(j['publicStage']).parent/'before.json')
    atomic_json(STATE/'manifest.json',saved['manifest']);atomic_json(STATE/'current.json',saved['current'])
    health(j['previousCommit'])
    for root in [PUBLIC,pathlib.Path(j['publicStage'])]:
        try: (root/'.cpanel-maintenance').unlink()
        except FileNotFoundError: pass
    j['phase']='rolled-back';durable_journal(j)
def check_entry(raw,entry):
    if len(raw)!=entry['bytes'] or digest(raw)!=entry['sha256']: raise RuntimeError('Release member checksum mismatch')
def protected_public(rel):
    parts=pathlib.PurePosixPath(rel).parts
    return '.htaccess' in parts or parts[0] in ['.well-known','cgi-bin','php.ini','.user.ini'] or parts[0].startswith('cms-api') or rel=='admin/deployment.json'
def clone_public(source,dest):
    dest.mkdir(mode=0o755)
    # Existing provider-owned routes are copied independently from rollback.
    for current,dirs,files in os.walk(source,followlinks=False):
        rel=pathlib.Path(current).relative_to(source)
        for name in dirs:
            p=pathlib.Path(current)/name
            if p.is_symlink(): raise RuntimeError('Unexpected public directory symlink')
            (dest/rel/name).mkdir(mode=0o755)
        for name in files:
            p=pathlib.Path(current)/name;t=dest/rel/name
            if p.is_symlink() or not p.is_file(): raise RuntimeError('Unexpected public file type')
            if name.startswith('.') or name.endswith('.php') or rel.parts and rel.parts[0].startswith('cms-api'):
                shutil.copy2(p,t)
            else: os.link(p,t)
def deploy(config,token,commit):
    started=time.monotonic()
    runs=api('actions/workflows/cpanel-release.yml/runs?head_sha='+commit+'&status=success&per_page=5',token)['workflow_runs']
    runs=[r for r in runs if r['head_sha']==commit and r['head_branch']==BRANCH and r['event'] in ['push','workflow_dispatch'] and r['conclusion']=='success']
    if not runs: return {'outcome':'pending','commit':commit}
    artifacts=api('actions/runs/'+str(runs[0]['id'])+'/artifacts?per_page=100',token)['artifacts']
    matches=[a for a in artifacts if a['name']=='cpanel-fast-'+commit and not a['expired']]
    if len(matches)!=1: raise RuntimeError('Missing unique fast artifact')
    artifact=matches[0]
    atomic_json(STATE/'status.json',{'outcome':'downloading','commit':commit,'checkedAt':int(time.time()*1000)})
    zipbytes=request('https://api.github.com/repos/'+REPO+'/actions/artifacts/'+str(artifact['id'])+'/zip',token)
    if artifact.get('digest')!='sha256:'+digest(zipbytes): raise RuntimeError('Artifact digest mismatch')
    with zipfile.ZipFile(io.BytesIO(zipbytes)) as z:
        names=z.namelist()
        if names!=['fast.tar.gz']: raise RuntimeError('Unexpected artifact members')
        payload=z.read('fast.tar.gz')
    with tarfile.open(fileobj=io.BytesIO(payload),mode='r:gz') as tar:
        members={}
        total=0
        for m in tar.getmembers():
            name=m.name.removeprefix('./')
            if not name or name=='.': continue
            if m.isdir(): continue
            if not m.isfile() or name.startswith('/') or any(p in ['','.','..'] for p in name.split('/')) or name in members: raise RuntimeError('Invalid archive member')
            total+=m.size
            if total>256*1024*1024: raise RuntimeError('Fast release expanded size limit')
            members[name]=m
        if 'release.json' not in members or members['release.json'].size>8*1024*1024: raise RuntimeError('Missing release description')
        release=json.load(tar.extractfile(members['release.json']))
        if release.get('format')!='heichal-fast-release' or release.get('version')!=1 or release['commit']!=commit or release['branch']!=BRANCH or release['siteOrigin']!=ORIGIN: raise RuntimeError('Release scope mismatch')
        # Read members in archive order once. Repeated random seeks through gzip
        # otherwise re-inflate the entire site thousands of times.
        packed={}
        for name,member in sorted(members.items(),key=lambda pair:pair[1].offset_data):
            if name!='release.json': packed[name]=tar.extractfile(member).read()
        files=release['files'];manifest=release['manifest']
        catalog={f['path']:f for f in manifest['files']}
        if len(catalog)!=len(files) or len(catalog)!=len(manifest['files']): raise RuntimeError('Release catalog mismatch')
        for f in files:
            path=f['path']
            if not re.fullmatch(r'(app|public)/[^\\\x00]+',path) or any(p in ['','.','..'] for p in path.split('/')): raise RuntimeError('Release path rejected')
            base=catalog.get(path)
            if not base or any(f[k]!=base[k] for k in ['bytes','sha256']) or not re.fullmatch(r'[a-f0-9]{64}',f['sha256']) or not isinstance(f['bytes'],int) or f['bytes']<0: raise RuntimeError('Catalog entry mismatch')
            if f.get('packed'):
                if path not in members: raise RuntimeError('Missing packed member')
            elif not SHA.fullmatch(f.get('blob','')) or not re.fullmatch(r'(site|data/img)/[^\\\x00]+',f.get('source','')): raise RuntimeError('Immutable asset source required')
        expected={'release.json'}|{f['path'] for f in files if f.get('packed')}
        if set(members)!=expected: raise RuntimeError('Uncatalogued members')
        atomic_json(STATE/'status.json',{'outcome':'staging','commit':commit,'checkedAt':int(time.time()*1000)})
        old=read_json(STATE/'current.json')
        old_manifest=read_json(STATE/'manifest.json')
        oldfiles={f['path']:f for f in old_manifest['files']}
        app=canonical(pathlib.Path(config['appRoot']))
        if current_marker(PUBLIC)!=old['commit'] or read_json(app/'app-release.json').get('commit')!=old['commit']: raise RuntimeError('Active roots changed outside deployer')
        run=STATE/('release-'+commit)
        if run.exists():
            legacy=run/'account-backup'
            if legacy.is_dir() and not (STATE/('legacy-account-backup-'+commit)).exists():
                os.rename(legacy,STATE/('legacy-account-backup-'+commit))
            remove_private(run)
        run.mkdir(mode=0o700)
        ps=run/'public';aps=run/'app';clone_public(PUBLIC,ps);aps.mkdir(mode=0o700)
        changed=0
        for f in files:
            is_public=f['path'].startswith('public/')
            rel=f['path'].split('/',1)[1]
            target=(ps if is_public else aps)/rel
            if is_public and protected_public(rel):
                if not target.exists(): raise RuntimeError('Protected hosting path missing')
                continue
            prior=oldfiles.get(f['path'])
            if is_public and prior and prior['sha256']==f['sha256'] and prior['bytes']==f['bytes']:
                if not target.is_file() or target.stat().st_size!=f['bytes']: raise RuntimeError('Unchanged asset missing')
                continue
            raw=packed[f['path']] if f.get('packed') else __import__('base64').b64decode(json.loads(request('https://api.github.com/repos/'+REPO+'/git/blobs/'+f['blob'],token,140*1024*1024))['content'])
            check_entry(raw,f)
            target.parent.mkdir(mode=0o755 if is_public else 0o700,parents=True,exist_ok=True)
            if target.exists():
                if not target.is_file() or target.is_symlink(): raise RuntimeError('Changed path collision')
                target.unlink()
            with open(target,'xb') as out: os.chmod(target,0o644 if is_public else 0o600);out.write(raw)
            changed+=1
        for path in oldfiles:
            if path.startswith('public/') and path not in catalog and not protected_public(path[len('public/'):]):
                target=ps/path[len('public/'):]
                if target.exists():
                    if not target.is_file() or target.is_symlink(): raise RuntimeError('Deleted path collision')
                    target.unlink()
        # Production dependencies are pinned by package-lock. A dependency change
        # uses the normal full installer rather than executing arbitrary scripts.
        if catalog['app/package-lock.json']['sha256']!=oldfiles['app/package-lock.json']['sha256']: raise RuntimeError('Dependency update requires full installation')
        for directory,_,_ in os.walk(ps): os.chmod(directory,0o755)
        source_modules=app/'node_modules'
        if not source_modules.exists(): raise RuntimeError('Production dependencies unavailable')
        shutil.copytree(source_modules,aps/'node_modules',symlinks=True)
        migration=aps/'scripts/setup-accounts.mjs'
        if migration.exists():
            env=dict(os.environ);env.update({'CMS_ENV_FILE':config['envFile'],'CMS_APP_ROOT':str(app),'CMS_ACCOUNT_BACKUP':str(STATE/'account-schema-backup'),'CMS_ACCOUNT_OWNER_EMAIL':config.get('legacyOwnerEmail','')})
            subprocess.run([NODE,str(migration)],env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=60)
        if head(token)!=commit: remove_private(run);return {'outcome':'superseded','commit':commit}
        atomic_json(run/'before.json',{'manifest':old_manifest,'current':old})
        journal={'version':1,'phase':'prepared','commit':commit,'previousCommit':old['commit'],'publicStage':str(ps),'appStage':str(aps)}
        durable_journal(journal)
        try:
            # Maintenance spans both swaps; requests never enter mixed runtime/content.
            (PUBLIC/'.cpanel-maintenance').touch();(ps/'.cpanel-maintenance').touch()
            journal['phase']='swapping';durable_journal(journal)
            exchange(PUBLIC,ps);exchange(app,aps);restart(app,aps)
            journal['phase']='verifying';durable_journal(journal)
            for attempt in range(12):
                try: health(commit);break
                except Exception:
                    if attempt==11: raise
                    time.sleep(1)
            status={'version':1,'target':'cpanel','state':'live','commit':commit,'previousCommit':old['commit'],'updatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')}
            atomic_json(PUBLIC/'admin/deployment.json',status)
            os.chmod(PUBLIC/'admin/deployment.json',0o644)
            atomic_json(STATE/'manifest.json',manifest)
            atomic_json(STATE/'current.json',{'commit':commit,'previousCommit':old['commit'],'run':str(run)})
            journal['phase']='complete';durable_journal(journal)
            (PUBLIC/'.cpanel-maintenance').unlink()
            # Keep the most recent rollback only after successful activation.
            for prior_dir in STATE.glob('release-*'):
                if prior_dir!=run: remove_private(prior_dir)
            return {'outcome':'committed','commit':commit,'changedFiles':changed,'hostSeconds':round(time.monotonic()-started,3),'artifactBytes':len(zipbytes)}
        except BaseException:
            recover(config);raise
def main():
    os.umask(0o077);canonical(HOME);canonical(PUBLIC);canonical(STATE)
    fd=os.pidfd_open(os.getpid());os.close(fd)
    if not hasattr(signal,'pidfd_send_signal'): raise RuntimeError('Managed process control unavailable')
    config=read_json(STATE/'config.json')
    if config.get('version')!=1 or config.get('enabled') is not True: raise RuntimeError('Fast deploy disabled')
    token=private(HOME/'config/github-actions.token').decode().strip()
    recover(config)
    stop=time.monotonic()+50
    while True:
        remote=head(token);current=read_json(STATE/'current.json')['commit']
        failure=read_json(STATE/'failure.json') if (STATE/'failure.json').exists() else {}
        if failure.get('commit')==remote and int(time.time()*1000)-failure.get('checkedAt',0)<300000:
            atomic_json(STATE/'status.json',failure);print(json.dumps(failure));return
        result={'outcome':'matched','commit':current} if remote==current else deploy(config,token,remote)
        atomic_json(STATE/'status.json',{**result,'checkedAt':int(time.time()*1000)})
        if time.monotonic()>=stop or result['outcome']=='committed': print(json.dumps(result));return
        time.sleep(5)
if __name__=='__main__':
    try: main()
    except Exception as error:
        if STATE.is_dir():
            old=read_json(STATE/'status.json') if (STATE/'status.json').exists() else {}
            failure={'outcome':'failed','commit':old.get('commit'),'error':str(error)[:200],'checkedAt':int(time.time()*1000)}
            atomic_json(STATE/'failure.json',failure);atomic_json(STATE/'status.json',failure)
        print('Fast deployment stopped; inspect private status.',file=sys.stderr);sys.exit(1)
