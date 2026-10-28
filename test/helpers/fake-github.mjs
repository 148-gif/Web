// A small in-memory GitHub (one repo, one branch) that answers the API calls the editor server makes.
import { createHash } from 'node:crypto';

const gitSha = (buf) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
const sha1 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function makeGithub({ repo = 'o/r', branch = 'live', files = {} } = {}) {
  const blobs = new Map(), trees = new Map(), commits = new Map();
  let n = 0, head = null;
  const log = [];
  const snapshot = async (map) => { const id = await sha1(`tree${++n}`); trees.set(id, map); return id; };
  const addCommit = async (map, parent, message, author = { name: 'x', date: new Date(1e12 + n * 1e6).toISOString() }) => {
    const sha = await sha1(`commit${++n}`);
    commits.set(sha, { sha, tree: await snapshot(map), parent, message, author });
    return sha;
  };
  // Blobs are kept as bytes, so binary files (media) survive; text files read back as UTF-8.
  const put = async (data) => { const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'); const s = gitSha(buf); blobs.set(s, buf); return s; };
  const first = new Map();
  for (const [p, t] of Object.entries(files)) first.set(p, await put(t));
  head = await addCommit(first, null, 'start');

  const file = (path, treeMap) => {
    const sha = treeMap.get(path);
    if (sha) return { type: 'file', name: path.split('/').pop(), path, sha, content: blobs.get(sha).toString('base64') };
    const kids = [...treeMap].filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'));
    return kids.length ? kids.map(([p, s]) => ({ type: 'file', name: p.split('/').pop(), path: p, sha: s })) : null;
  };
  const res = (j, status = 200) => new Response(j === null ? '{"message":"Not Found"}' : JSON.stringify(j), { status: j === null ? 404 : status });

  const api = {
    repo, branch, log,
    get head() { return head; },
    // what the live site has now
    read: (p) => { const s = trees.get(commits.get(head).tree).get(p); return s ? blobs.get(s).toString('utf8') : null; },
    readBytes: (p) => { const s = trees.get(commits.get(head).tree).get(p); return s ? blobs.get(s) : null; },
    // someone changes the live branch directly (null deletes a file)
    async commit(changes, message = 'direct') {
      const map = new Map(trees.get(commits.get(head).tree));
      for (const [p, t] of Object.entries(changes)) { if (t === null) map.delete(p); else map.set(p, await put(t)); }
      head = await addCommit(map, head, message);
      return head;
    },
    commits: () => [...commits.values()],
    async fetch(url, opt = {}) {
      const u = new URL(url), method = opt.method || 'GET', body = opt.body ? JSON.parse(opt.body) : null;
      const prefix = `/repos/${repo}`;
      if (u.hostname !== 'api.github.com' || !u.pathname.startsWith(prefix)) return null;
      const rest = u.pathname.slice(prefix.length + 1), q = u.searchParams;
      log.push(`${method} ${rest}`);
      const treeAt = (ref) => (ref === branch ? trees.get(commits.get(head).tree) : commits.has(ref) ? trees.get(commits.get(ref).tree) : null);
      let m;
      if (rest === '') return res({ full_name: repo, permissions: { push: true } });
      if (rest.startsWith('contents/')) {
        const t = treeAt(q.get('ref') || branch);
        return res(t ? file(decodeURIComponent(rest.slice(9)), t) : null);
      }
      if (rest === `git/ref/heads/${branch}`) return res({ object: { sha: head } });
      if ((m = /^git\/commits\/(\w+)$/.exec(rest)) && method === 'GET') return res(commits.has(m[1]) ? { sha: m[1], tree: { sha: commits.get(m[1]).tree } } : null);
      if (rest === 'git/blobs') return res({ sha: await put(Buffer.from(body.content, 'base64')) }, 201);
      if (rest === 'git/trees') {
        const map = new Map(trees.get(body.base_tree));
        for (const e of body.tree) { if (e.sha === null) map.delete(e.path); else map.set(e.path, e.sha); }
        return res({ sha: await snapshot(map) }, 201);
      }
      if (rest === 'git/commits' && method === 'POST') {
        const sha = await sha1(`commit${++n}`);
        commits.set(sha, { sha, tree: body.tree, parent: body.parents[0], message: body.message, author: body.author });
        return res({ sha }, 201);
      }
      if (rest === `git/refs/heads/${branch}` && method === 'PATCH') {
        if (commits.get(body.sha).parent !== head) return res({ message: 'Update is not a fast forward' }, 422);
        head = body.sha;
        return res({ object: { sha: head } });
      }
      if (rest === 'commits') {
        const path = q.get('path'), out = [];
        for (let c = commits.get(head); c; c = commits.get(c.parent)) {
          const mine = trees.get(c.tree).get(path), before = c.parent ? trees.get(commits.get(c.parent).tree).get(path) : undefined;
          if (mine !== before) out.push({ sha: c.sha, commit: { message: c.message, author: c.author } });
        }
        return res(out);
      }
      if (rest === 'actions/runs') return res({ workflow_runs: [] });
      return res({ message: `unhandled ${rest}` }, 500);
    },
  };
  return api;
}
