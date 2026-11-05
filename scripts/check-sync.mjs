// Fails when another editor's branch (or the live branch) has commits this checkout does not contain,
// so a push cannot overwrite what they published. Fix: git merge origin/<branch>, resolve, run npm run check.
// Local: a failed fetch (offline) only warns. CI: set SYNC_STRICT=1 and SYNC_HEAD=<pr head sha>.
import { execFileSync } from 'node:child_process';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function checkSync({ branches, head = 'HEAD', strict = false, cwd = process.cwd(), remote = 'origin' } = {}) {
  const problems = [];
  const notes = [];
  for (const branch of branches) {
    try {
      git(['fetch', '--quiet', remote, branch], cwd);
    } catch (e) {
      const msg = String(e.stderr || e.message);
      if (/couldn't find remote ref/i.test(msg)) { notes.push(`${branch}: no such branch on ${remote}, skipped`); continue; }
      (strict ? problems : notes).push(`${branch}: fetch failed, not checked (${msg.split('\n')[0]})`);
      continue;
    }
    const ref = `${remote}/${branch}`;
    try {
      git(['merge-base', '--is-ancestor', ref, head], cwd);
    } catch {
      let missing = '?';
      try { missing = git(['rev-list', '--count', `${head}..${ref}`], cwd); } catch { /* keep ? */ }
      problems.push(`${ref} has ${missing} commit(s) not in ${head}. Run: git fetch ${remote} ${branch} && git merge ${ref}  (resolve so both sides are kept, then npm run check)`);
    }
  }
  return { ok: problems.length === 0, problems, notes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const branches = (process.env.SYNC_BRANCHES || 'yaakov,claude/greeting-2i183o').split(',').map((s) => s.trim()).filter(Boolean);
  const r = checkSync({ branches, head: process.env.SYNC_HEAD || 'HEAD', strict: process.env.SYNC_STRICT === '1' });
  for (const n of r.notes) console.warn(`check-sync: ${n}`);
  for (const p of r.problems) console.error(`check-sync: ${p}`);
  if (!r.ok) process.exit(1);
  console.log('check-sync: up to date with ' + branches.join(', '));
}
