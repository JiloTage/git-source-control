import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, symlinkSync, rmdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GitControl, git, parseStatus } from '../git.mjs';

const scratch = fileURLToPath(new URL('../../.test-work/git-tests/', import.meta.url));
mkdirSync(scratch, { recursive: true });
function fixture(initial = true) {
  const root = mkdtempSync(path.join(scratch, 'repo-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Source Control Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  const write = (file, content) => writeFileSync(path.join(root, file), content);
  if (initial) { write('tracked.txt', 'base\n'); git(root, 'add', '--', 'tracked.txt'); git(root, 'commit', '-m', 'initial'); }
  const control = new GitControl([{ id: 'test', label: 'Test', path: root }]);
  const status = () => control.status('test');
  const mutate = (action, args = {}) => control.mutate(action, { repo: 'test', revision: status().revision, ...args });
  return { root, write, control, status, mutate };
}

test('NUL status parser preserves names, rename source, and conflicts', () => {
  const files = parseStatus('MM 日本語 file.txt\0R  new\nname.txt\0old name.txt\0?? [literal].txt\0UU conflict.txt\0');
  assert.equal(files[0].path, '日本語 file.txt');
  assert.equal(files[1].path, 'new\nname.txt');
  assert.equal(files[1].originalPath, 'old name.txt');
  assert.equal(files[2].x, '?');
  assert.equal(files[3].conflict, true);
});

test('stage, partial modification, discard, unstage, commit only the index', () => {
  const { root, write, status, mutate } = fixture();
  write('tracked.txt', 'staged\n');
  assert.equal(mutate('stage', { file: 'tracked.txt' }).staged.length, 1);
  write('tracked.txt', 'unstaged\n');
  assert.equal(status().unstaged[0].path, 'tracked.txt');
  mutate('discard', { file: 'tracked.txt', confirmed: true });
  assert.equal(readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'staged\n');
  assert.equal(status().staged.length, 1);
  mutate('unstage', { file: 'tracked.txt' });
  assert.equal(status().staged.length, 0);
  assert.equal(readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'staged\n');
  mutate('stage', { file: 'tracked.txt' });
  write('tracked.txt', 'keep unstaged\n');
  const state = mutate('commit', { message: '  first line\n\nbody  ' });
  assert.equal(state.staged.length, 0);
  assert.equal(state.unstaged.length, 1);
  assert.equal(git(root, 'show', 'HEAD:tracked.txt'), 'staged\n');
  assert.equal(git(root, 'log', '-1', '--format=%B').trim(), 'first line\n\nbody');
});

test('new repo: unstage preserves new files, then first commit succeeds', () => {
  const { root, write, status, mutate } = fixture(false);
  assert.equal(status().branch, 'main');
  assert.equal(status().head, '');
  write('new.txt', 'new\n');
  mutate('stage', { file: 'new.txt' });
  mutate('unstage', { file: 'new.txt' });
  assert.equal(status().unstaged[0].x, '?');
  assert.equal(readFileSync(path.join(root, 'new.txt'), 'utf8'), 'new\n');
  mutate('stage', { file: 'new.txt' });
  assert.ok(mutate('commit', { message: 'initial' }).head);
});

test('rename unstage includes both paths; deletion discard restores the index', () => {
  const { root, status, mutate } = fixture();
  renameSync(path.join(root, 'tracked.txt'), path.join(root, 'renamed.txt'));
  git(root, 'add', '-A');
  assert.equal(status().staged[0].originalPath, 'tracked.txt');
  mutate('unstage', { file: 'renamed.txt' });
  assert.equal(status().staged.length, 0);
  assert.equal(git(root, 'ls-files').trim(), 'tracked.txt');
  mutate('discard', { file: 'tracked.txt', confirmed: true });
  assert.ok(existsSync(path.join(root, 'tracked.txt')));
  unlinkSync(path.join(root, 'tracked.txt'));
  mutate('stage', { file: 'tracked.txt' });
  assert.equal(status().staged[0].x, 'D');
  mutate('unstage', { file: 'tracked.txt' });
  mutate('discard', { file: 'tracked.txt', confirmed: true });
  assert.ok(existsSync(path.join(root, 'tracked.txt')));
});

test('literal file paths and confirmed untracked discard affect only the selected file', () => {
  const { root, write, status, mutate } = fixture();
  const unusual = "--[日本語] 'file'.txt";
  write(unusual, 'one'); write('keep.txt', 'two');
  mutate('stage', { file: unusual });
  assert.deepEqual(status().staged.map(file => file.path), [unusual]);
  assert.throws(() => mutate('discard', { file: 'keep.txt' }), /確認/);
  mutate('discard', { file: 'keep.txt', confirmed: true });
  assert.ok(!existsSync(path.join(root, 'keep.txt')));
  assert.ok(existsSync(path.join(root, unusual)));
  assert.equal(status().staged.length, 1);
});

test('stale content is rejected even when status letters are unchanged', () => {
  const { root, write, control, status } = fixture();
  write('tracked.txt', 'changed one\n');
  const before = status();
  write('tracked.txt', 'changed two\n');
  assert.throws(() => control.mutate('discard', { repo: 'test', revision: before.revision, file: 'tracked.txt', confirmed: true }), /再読み込み/);
  assert.equal(readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'changed two\n');
  write('untracked.txt', 'one');
  const revision = status().revision;
  write('untracked.txt', 'two');
  assert.notEqual(status().revision, revision);
});

test('unknown repos and files, traversal, blank messages, and empty commits are rejected', () => {
  const { write, control, status, mutate } = fixture();
  assert.throws(() => control.status('outside'), /未登録/);
  for (const file of ['../outside', '.git/config', '/absolute', 'tracked.txt\0more']) assert.throws(() => mutate('discard', { file, confirmed: true }));
  assert.throws(() => mutate('commit', { message: 'no changes' }), /ステージ/);
  write('tracked.txt', 'changed\n');
  mutate('stage', { file: 'tracked.txt' });
  assert.throws(() => mutate('commit', { message: ' \n ' }), /メッセージ/);
  assert.throws(() => mutate('commit', { message: 'bad\0message' }), /メッセージ/);
  assert.equal(status().staged.length, 1);
});

test('index lock and commit failure preserve work and staging', () => {
  const { root, write, status, mutate } = fixture();
  write('tracked.txt', 'valuable\n');
  write('.git/index.lock', 'locked');
  assert.throws(() => mutate('stage', { file: 'tracked.txt' }), /index.lock/);
  assert.equal(status().staged.length, 0);
  unlinkSync(path.join(root, '.git/index.lock'));
  mutate('stage', { file: 'tracked.txt' });
  git(root, 'config', 'user.name', ''); git(root, 'config', 'user.email', '');
  assert.throws(() => mutate('commit', { message: 'should fail' }));
  assert.equal(status().staged.length, 1);
  assert.equal(readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'valuable\n');
});

test('conflicts are visible and guarded; detached HEAD is displayed', () => {
  const { root, write, status, mutate } = fixture();
  git(root, 'checkout', '-b', 'other');
  write('tracked.txt', 'other\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'other');
  git(root, 'checkout', 'main');
  write('tracked.txt', 'main\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'main');
  assert.throws(() => git(root, 'merge', 'other'));
  assert.equal(status().staged[0].conflict, true);
  for (const action of ['unstage', 'discard']) assert.throws(() => mutate(action, { file: 'tracked.txt', confirmed: true }), /競合/);
  assert.throws(() => mutate('commit', { message: 'conflicted' }), /競合/);
  git(root, 'merge', '--abort'); git(root, 'checkout', '--detach');
  assert.match(status().branch, /^detached · [a-f0-9]+$/);
});

test('external directory junctions and submodules cannot be discarded', () => {
  const { root, status, mutate } = fixture();
  const outside = mkdtempSync(path.join(scratch, 'outside-'));
  writeFileSync(path.join(outside, 'valuable.txt'), 'valuable');
  symlinkSync(outside, path.join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  // A junction is either listed as a directory traversal or as a link. Both must leave its target intact.
  try {
    const file = status().unstaged.find(item => item.path.startsWith('external'));
    if (file) {
      try { mutate('discard', { file: file.path, confirmed: true }); }
      catch (error) { assert.match(error.message, /リポジトリ外|directory|operation not permitted|EPERM|EISDIR/i); }
    }
  } catch (error) { assert.match(error.message, /リポジトリ外|directory|operation not permitted/i); }
  assert.equal(readFileSync(path.join(outside, 'valuable.txt'), 'utf8'), 'valuable');
  if (existsSync(path.join(root, 'external'))) {
    if (process.platform === 'win32') rmdirSync(path.join(root, 'external'));
    else unlinkSync(path.join(root, 'external'));
  }
  mkdirSync(path.join(root, 'module'));
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${status().head},module`);
  assert.throws(() => mutate('unstage', { file: 'module' }), /サブモジュール/);
});
