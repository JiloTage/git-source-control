import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GitControl, git, parseGraph } from '../git.mjs';

const scratch = fileURLToPath(new URL('../../.test-work/workflow-tests/', import.meta.url));
mkdirSync(scratch, { recursive: true });
function setup() {
  const base = mkdtempSync(path.join(scratch, 'workflow-'));
  const origin = path.join(base, 'remote.git'), root = path.join(base, 'local'), peer = path.join(base, 'peer');
  git(base, 'init', '--bare', '-b', 'main', origin);
  mkdirSync(root); git(root, 'init', '-b', 'main');
  function configure(repo) {
    git(repo, 'config', 'user.name', 'Workflow Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'core.autocrlf', 'false'); git(repo, 'config', 'commit.gpgsign', 'false');
  }
  configure(root);
  function commit(repo, file, text, message) {
    writeFileSync(path.join(repo, file), text); git(repo, 'add', '--', file); git(repo, 'commit', '-m', message);
    return git(repo, 'rev-parse', 'HEAD').trim();
  }
  commit(root, 'tracked.txt', 'base\n', 'initial');
  git(root, 'remote', 'add', 'origin', origin); git(root, 'push', '-u', 'origin', 'main');
  git(base, 'clone', origin, peer); configure(peer);
  const control = new GitControl([{ id: 'test', label: 'Test', path: root }]);
  const status = limit => control.status('test', limit);
  const mutate = (action, args = {}) => control.mutate(action, { repo: 'test', revision: status().revision, ...args });
  const peerCommit = (file, text, message) => { const hash = commit(peer, file, text, message); git(peer, 'push', 'origin', 'HEAD'); return hash; };
  return { base, origin, root, peer, control, status, mutate, commit, peerCommit };
}

test('branch creation, switching, remote tracking, worktrees, and dirty work protection', () => {
  const { base, root, peer, status, mutate, commit, peerCommit } = setup();
  assert.equal(mutate('create_branch', { branch: 'feature/local' }).localBranch, 'feature/local');
  commit(root, 'tracked.txt', 'feature\n', 'feature commit');
  assert.equal(mutate('switch', { branch: 'refs/heads/main' }).localBranch, 'main');
  writeFileSync(path.join(root, 'tracked.txt'), 'valuable dirty work\n');
  assert.throws(() => mutate('switch', { branch: 'refs/heads/feature/local' }));
  assert.equal(status().localBranch, 'main');
  assert.equal(readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'valuable dirty work\n');
  mutate('discard', { file: 'tracked.txt', confirmed: true });
  assert.throws(() => mutate('create_branch', { branch: '-bad' }), /不正/);
  assert.throws(() => mutate('switch', { branch: '--detach' }), /一覧/);
  git(root, 'worktree', 'add', path.join(base, 'worktree'), 'feature/local');
  assert.equal(status().branches.find(branch => branch.name === 'feature/local').checkedOut, true);
  assert.throws(() => mutate('switch', { branch: 'refs/heads/feature/local' }), /worktree|checked out|already used/i);
  git(peer, 'switch', '-c', 'feature/remote');
  peerCommit('remote.txt', 'remote\n', 'remote branch commit');
  mutate('fetch', { remote: 'origin' });
  const switched = mutate('switch', { branch: 'refs/remotes/origin/feature/remote' });
  assert.equal(switched.localBranch, 'feature/remote');
  assert.equal(switched.upstream, 'refs/remotes/origin/feature/remote');
  assert.equal(switched.upstreamRemote, 'origin');
  assert.equal(readFileSync(path.join(root, 'remote.txt'), 'utf8'), 'remote\n');
});

test('fetch updates remote graph and behind count; pull fast-forwards; push publishes explicitly', () => {
  const { origin, root, status, mutate, peerCommit, commit } = setup();
  const remoteHead = peerCommit('tracked.txt', 'from remote\n', 'remote update');
  const fetched = mutate('fetch', { remote: 'origin' });
  assert.equal(fetched.behind, 1); assert.equal(fetched.ahead, 0);
  assert.equal(readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'base\n');
  assert.ok(fetched.history.some(row => row.hash === remoteHead && row.refs.includes('origin/main')));
  const pulled = mutate('pull', { remote: 'origin', strategy: 'ff-only' });
  assert.equal(pulled.head, remoteHead); assert.equal(pulled.behind, 0);
  assert.equal(readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'from remote\n');
  mutate('create_branch', { branch: 'feature/published' });
  const localHead = commit(root, 'publish.txt', 'published\n', 'publish me');
  assert.throws(() => mutate('push', { remote: 'origin' }), /確認/);
  const pushed = mutate('push', { remote: 'origin', confirmed: true });
  assert.equal(git(origin, 'rev-parse', 'refs/heads/feature/published').trim(), localHead);
  assert.equal(pushed.upstream, 'refs/remotes/origin/feature/published');
  assert.equal(pushed.ahead, 0);
  assert.throws(() => mutate('fetch', { remote: '--all' }), /一覧/);
  writeFileSync(path.join(root, 'publish.txt'), 'dirty\n');
  assert.throws(() => mutate('pull', { remote: 'origin' }), /退避/);
  assert.equal(status().localBranch, 'feature/published');
});

test('divergence: ff-only fails, merge and rebase honor the selected mode', () => {
  for (const strategy of ['merge', 'rebase']) {
    const { root, peerCommit, commit, status, mutate } = setup();
    const localHead = commit(root, 'local.txt', 'local\n', 'local change');
    const remoteHead = peerCommit('remote.txt', 'remote\n', 'remote change');
    git(root, 'config', 'pull.ff', 'only');
    assert.throws(() => mutate('pull', { remote: 'origin', strategy: 'ff-only' }), /fast-forward|diverg/i);
    assert.equal(status().head, localHead);
    assert.equal(status().behind, 1); assert.equal(status().ahead, 1);
    assert.throws(() => mutate('push', { remote: 'origin', confirmed: true }), /rejected|fetch first|non-fast-forward/i);
    const integrated = mutate('pull', { remote: 'origin', strategy });
    assert.equal(integrated.operation, '');
    assert.equal(readFileSync(path.join(root, 'local.txt'), 'utf8'), 'local\n');
    assert.equal(readFileSync(path.join(root, 'remote.txt'), 'utf8'), 'remote\n');
    const parents = integrated.history.find(row => row.hash === integrated.head).parents;
    assert.equal(parents.length, strategy === 'merge' ? 2 : 1);
    assert.ok(integrated.history.some(row => row.hash === remoteHead));
    assert.notEqual(integrated.head, localHead);
  }
});

test('merge/rebase conflicts: explicit abort preserves the starting commit; resolve, stage, continue', () => {
  for (const strategy of ['merge', 'rebase']) {
    const { root, peerCommit, commit, status, mutate } = setup();
    const localHead = commit(root, 'tracked.txt', 'local\n', 'local change');
    peerCommit('tracked.txt', 'remote\n', 'remote change');
    let failure;
    try { mutate('pull', { remote: 'origin', strategy }); } catch (error) { failure = error; }
    assert.ok(failure);
    assert.equal(failure.state.operation, strategy);
    assert.ok(failure.state.staged.some(file => file.conflict));
    assert.throws(() => mutate('switch', { branch: 'refs/heads/main' }), /進行中/);
    assert.throws(() => mutate('abort'), /確認/);
    assert.equal(mutate('abort', { confirmed: true }).head, localHead);
    assert.equal(readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'local\n');
    assert.throws(() => mutate('pull', { remote: 'origin', strategy }));
    writeFileSync(path.join(root, 'tracked.txt'), 'resolved\n');
    const staged = mutate('stage', { file: 'tracked.txt' });
    assert.equal(staged.staged.some(file => file.conflict), false);
    const continued = mutate('continue');
    assert.equal(continued.operation, '');
    assert.equal(readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'resolved\n');
    assert.throws(() => mutate('continue'), /ありません/);
  }
});

test('graph retains real parent links, merge rails, refs, pagination and metadata', () => {
  const { root, status, mutate, commit } = setup();
  mutate('create_branch', { branch: 'feature/graph' });
  commit(root, 'feature.txt', 'feature\n', '<img src=x onerror=alert(1)>');
  mutate('switch', { branch: 'refs/heads/main' });
  commit(root, 'main.txt', 'main\n', 'main change');
  git(root, 'merge', '--no-ff', '--no-edit', 'feature/graph');
  const state = status();
  const merge = state.history.find(row => row.hash === state.head);
  assert.equal(merge.parents.length, 2);
  assert.match(merge.refs, /HEAD -> main/);
  assert.ok(state.history.some(row => /[\\/]/.test(row.graph)));
  assert.ok(state.history.some(row => row.refs?.includes('feature/graph')));
  assert.equal(status(2).history.filter(row => row.hash).length, 2);
  assert.equal(status(2).hasMore, true);
  assert.equal(status(500).hasMore, false);
  const firstPage = controlPage(0), secondPage = controlPage(2);
  function controlPage(offset) { return new GitControl([{id:'page',label:'Page',path:root}]).status('page',2,offset); }
  assert.equal(secondPage.historyOffset, 2);
  assert.equal(secondPage.history.filter(row => row.hash).length, 2);
  assert.ok(secondPage.history.filter(row => row.hash).every(row => !firstPage.history.some(first => first.hash === row.hash)));
  assert.throws(() => status(501), /履歴/);
  const parsed = parseGraph(['* ', 'a'.repeat(40), '', 'aaaaaaa', '作者', '2026-10-02T00:00:00+09:00', 'HEAD -> main', 'subject', '\n|/\n'].join('\0'));
  assert.equal(parsed[0].subject, 'subject'); assert.equal(parsed[1].graph, '|/');
});

test('diff and commit inspection, stale refs/config, missing remotes and transport errors', () => {
  const { root, control, status, mutate } = setup();
  writeFileSync(path.join(root, 'tracked.txt'), 'staged value\n');
  mutate('stage', { file: 'tracked.txt' });
  writeFileSync(path.join(root, 'tracked.txt'), 'unstaged value\n');
  const revision = status().revision;
  const staged = control.diff({ repo: 'test', revision, file: 'tracked.txt', staged: true }).patch;
  assert.match(staged, /\+staged value/); assert.doesNotMatch(staged, /unstaged value/);
  assert.match(control.diff({ repo: 'test', revision, file: 'tracked.txt' }).patch, /\+unstaged value/);
  assert.match(control.inspect({ repo: 'test', hash: status().head }).patch, /\+base/);
  assert.throws(() => control.inspect({ repo: 'test', hash: '--all' }), /グラフ/);
  writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
  assert.match(control.diff({ repo: 'test', revision: status().revision, file: 'binary.bin' }).patch, /バイナリ/);
  const before = status();
  git(root, 'config', 'remote.origin.url', path.join(root, 'missing-remote.git'));
  assert.throws(() => control.mutate('fetch', { repo: 'test', revision: before.revision, remote: 'origin' }), /再読み込み/);
  let failed;
  try { mutate('fetch', { remote: 'origin' }); } catch (error) { failed = error; }
  assert.ok(failed); assert.equal(failed.state.head, before.head);
  assert.equal(readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'unstaged value\n');
  git(root, 'remote', 'remove', 'origin');
  assert.deepEqual(status().remotes, []);
  assert.throws(() => mutate('pull', { remote: 'origin' }), /リモート/);
});
