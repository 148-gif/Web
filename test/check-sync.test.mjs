import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSync } from '../scripts/check-sync.mjs';

const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });

function world() {
  const root = mkdtempSync(join(tmpdir(), 'sync-'));
  const origin = join(root, 'origin'), mine = join(root, 'mine'), other = join(root, 'other');
  g(root, 'init', '-q', '-b', 'main', origin);
  writeFileSync(join(origin, 'a.txt'), '1');
  g(origin, 'add', '.'); g(origin, 'commit', '-qm', 'base');
  g(root, 'clone', '-q', origin, mine);
  g(root, 'clone', '-q', origin, other);
  return { origin, mine, other };
}

test('passes when the other branch is already merged', () => {
  const w = world();
  assert.equal(checkSync({ branches: ['main'], cwd: w.mine }).ok, true);
});

test('fails when the other branch has newer commits, passes after merge', () => {
  const w = world();
  writeFileSync(join(w.origin, 'b.txt'), '2');
  g(w.origin, 'add', '.'); g(w.origin, 'commit', '-qm', 'yaakov change');
  const r = checkSync({ branches: ['main'], cwd: w.mine });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /1 commit/);
  g(w.mine, 'merge', '-q', 'origin/main');
  assert.equal(checkSync({ branches: ['main'], cwd: w.mine }).ok, true);
});

test('a missing remote branch is skipped, not an error', () => {
  const w = world();
  const r = checkSync({ branches: ['nope'], cwd: w.mine });
  assert.equal(r.ok, true);
  assert.match(r.notes[0], /skipped/);
});

test('an unreachable remote warns locally but fails in strict mode', () => {
  const w = world();
  g(w.mine, 'remote', 'set-url', 'origin', '/nonexistent/path');
  assert.equal(checkSync({ branches: ['main'], cwd: w.mine }).ok, true);
  assert.equal(checkSync({ branches: ['main'], cwd: w.mine, strict: true }).ok, false);
});
