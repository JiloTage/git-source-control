import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const conflicts = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));

export function git(root, ...args) {
  try {
    return execFileSync('git', ['--literal-pathspecs', '-C', root, '-c', 'core.fsmonitor=false', ...args], {
      encoding: 'utf8', windowsHide: true, timeout: args.some(arg => ['fetch', 'pull', 'push'].includes(arg)) ? 120000 : 30000, maxBuffer: 32 * 1024 * 1024,
      env: { ...environment, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(String(error.stderr || error.message).trim().slice(0, 2000));
  }
}

export function parseGraph(raw) {
  return raw.split('\n').filter(line => line.trim()).map(line => {
    const [graph, hash, parents, short, author, date, refs, subject] = line.split('\0');
    return hash && /^[a-f0-9]{40,64}$/.test(hash)
      ? { graph, hash, parents: parents ? parents.split(' ') : [], short, author, date, refs, subject }
      : { graph: graph.trimEnd() };
  });
}

function config(root, key) {
  try { return git(root, 'config', '--get', key).trim(); } catch { return ''; }
}
function configGroup(root, pattern) {
  try { return git(root, 'config', '--get-regexp', pattern); } catch { return ''; }
}
function validBranch(root, name) {
  if (typeof name !== 'string' || !name || name.startsWith('-') || name.includes('\0')) throw new Error('ブランチ名が不正です。');
  git(root, 'check-ref-format', `refs/heads/${name}`);
}

export function parseStatus(raw) {
  const entries = raw.split('\0');
  const files = [];
  for (let i = 0; i < entries.length && entries[i]; i++) {
    const entry = entries[i];
    const x = entry[0], y = entry[1];
    const file = { path: entry.slice(3), x, y, conflict: conflicts.has(x + y) };
    if ('RC'.includes(x) || 'RC'.includes(y)) file.originalPath = entries[++i];
    files.push(file);
  }
  return files;
}

function safePath(root, file) {
  if (!file || file.includes('\0') || file.includes('\\') || path.isAbsolute(file)
    || file.split('/').some(part => !part || part === '..' || part === '.' || part.toLowerCase() === '.git')) {
    throw new Error('リポジトリ内のファイルを選択してください。');
  }
  const target = path.resolve(root, file);
  let parent = path.dirname(target);
  while (parent !== root) {
    try {
      const real = realpathSync(parent);
      const relative = path.relative(root, real);
      if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
        throw new Error('リポジトリ外を参照するフォルダーは操作できません。');
      }
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      parent = path.dirname(parent);
    }
  }
  return target;
}

export class GitControl {
  constructor(repositories) {
    if (!Array.isArray(repositories) || !repositories.length) throw new Error('repositories.json にリポジトリを登録してください。');
    if (new Set(repositories.map(repo => repo.id)).size !== repositories.length) throw new Error('リポジトリ ID が重複しています。');
    this.repositories = repositories.map(repo => {
      if (typeof repo.id !== 'string' || !repo.id || typeof repo.label !== 'string' || typeof repo.path !== 'string') throw new Error('リポジトリ設定が不正です。');
      return { ...repo, path: path.resolve(repo.path) };
    });
  }

  root(id) {
    const repo = this.repositories.find(item => item.id === id);
    if (!repo) throw new Error('未登録のリポジトリです。');
    const root = realpathSync(repo.path);
    if (realpathSync(git(root, 'rev-parse', '--show-toplevel').trim()) !== root) throw new Error('設定にはリポジトリのルートを指定してください。');
    return root;
  }

  status(id, limit = 50, offset = 0) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('履歴は 1〜500 件で指定してください。');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('履歴の開始位置が不正です。');
    const root = this.root(id);
    const raw = git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
    const files = parseStatus(raw);
    let branch;
    try { branch = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD').trim(); }
    catch { branch = `detached · ${git(root, 'rev-parse', '--short', 'HEAD').trim()}`; }
    let head = '';
    try { head = git(root, 'rev-parse', '--verify', 'HEAD').trim(); } catch { /* First commit. */ }
    const remotes = git(root, 'remote').trim().split('\n').filter(Boolean);
    const refData = git(root, 'for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)%00%(upstream)%00%(symref)%00%(worktreepath)', 'refs/heads/', 'refs/remotes/');
    const branches = refData.trim().split('\n').filter(Boolean).map(line => {
      const [ref, hash, upstream, symref, worktree] = line.split('\0');
      const remote = ref.startsWith('refs/remotes/') ? [...remotes].sort((a,b) => b.length - a.length).find(name => ref.startsWith(`refs/remotes/${name}/`)) : undefined;
      return { ref, hash, name: ref.replace(/^refs\/(heads|remotes)\//, ''), remote, upstream, symref, checkedOut: !!worktree };
    }).filter(item => !item.symref);
    const localBranch = branch.startsWith('detached · ') ? '' : branch;
    const current = branches.find(item => item.ref === `refs/heads/${localBranch}`);
    const upstream = current?.upstream || '';
    const upstreamRemote = localBranch ? config(root, `branch.${localBranch}.remote`) : '';
    const upstreamMerge = localBranch ? config(root, `branch.${localBranch}.merge`) : '';
    let ahead = 0, behind = 0, upstreamGone = false;
    if (upstream && head) {
      try { [ahead, behind] = git(root, 'rev-list', '--left-right', '--count', `HEAD...${upstream}`, '--').trim().split(/\s+/).map(Number); }
      catch { upstreamGone = true; }
    }
    let operation = '';
    for (const [marker, name] of [['rebase-merge','rebase'],['rebase-apply','rebase'],['MERGE_HEAD','merge']]) {
      if (existsSync(path.resolve(root, git(root, 'rev-parse', '--git-path', marker).trim()))) { operation = name; break; }
    }
    const hash = createHash('sha256').update(raw).update(head).update(branch).update(refData).update(operation)
      .update(configGroup(root, '^remote\\.')).update(configGroup(root, '^branch\\.'));
    // ponytail: hash full diffs and changed files; use a watcher/cache if large repos make refresh slow.
    hash.update(git(root, 'diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv'));
    hash.update(git(root, 'diff', '--binary', '--no-ext-diff', '--no-textconv'));
    for (const file of files) {
      const target = safePath(root, file.path);
      try {
        const stat = lstatSync(target);
        hash.update(String(stat.mode));
        if (stat.isSymbolicLink()) hash.update(readlinkSync(target));
        else if (stat.isFile()) hash.update(readFileSync(target));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const history = head || branches.length ? parseGraph(git(root, 'log', '--all', ...(head ? ['HEAD'] : []), '--topo-order', '--graph', '--decorate=short', '--color=never', '--no-show-signature', `--skip=${offset}`, `--max-count=${limit + 1}`, '--format=%x00%H%x00%P%x00%h%x00%an%x00%aI%x00%D%x00%s%x00', '--')) : [];
    const commitRows = history.filter(row => row.hash);
    const extra = commitRows.length > limit ? history.indexOf(commitRows[limit]) : -1;
    return {
      repo: id, branch, head, revision: hash.digest('hex'),
      localBranch, branches, remotes, upstream, upstreamRemote, upstreamMerge, upstreamGone, ahead, behind, operation,
      history: extra >= 0 ? history.slice(0, extra) : history, historyLimit: limit, historyOffset: offset, hasMore: extra >= 0,
      repositories: this.repositories.map(({ id, label }) => ({ id, label })),
      staged: files.filter(file => file.x !== ' ' && file.x !== '?'),
      unstaged: files.filter(file => file.y !== ' ' || file.x === '?'),
    };
  }

  mutate(action, { repo, revision, file, message, confirmed, branch: targetBranch, remote, strategy = 'ff-only', limit = 50, offset = 0 }) {
    // ponytail: synchronous Git serializes plugin operations; use async per-repo queues if concurrency matters.
    const state = this.status(repo, limit, offset);
    if (revision !== state.revision) throw new Error('変更が更新されています。再読み込みしてから操作してください。');
    const root = this.root(repo);
    try {
    if (['switch', 'create_branch'].includes(action)) {
      if (state.operation) throw new Error('進行中の merge / rebase を完了するか中止してください。');
      if (action === 'create_branch') {
        validBranch(root, targetBranch);
        git(root, 'switch', '-c', targetBranch);
      } else {
        const target = state.branches.find(item => item.ref === targetBranch);
        if (!target) throw new Error('一覧からブランチを選択してください。');
        if (target.remote) {
          const name = target.name.slice(target.remote.length + 1);
          validBranch(root, name);
          if (state.branches.some(item => item.ref === `refs/heads/${name}`)) throw new Error('同名のローカルブランチがあります。ローカル側を選択してください。');
          git(root, 'switch', '--track', '-c', name, target.ref);
        } else git(root, 'switch', '--no-guess', '--', target.name);
      }
    } else if (['fetch', 'pull', 'push'].includes(action)) {
      if (!state.remotes.includes(remote)) throw new Error('一覧からリモートを選択してください。');
      if (action === 'fetch') git(root, 'fetch', '--prune', '--', remote);
      else {
        if (!state.localBranch || !state.head) throw new Error('コミットのあるローカルブランチを選択してください。');
        if (state.operation) throw new Error('進行中の merge / rebase を完了するか中止してください。');
        const destination = state.upstreamRemote === remote && state.upstreamMerge ? state.upstreamMerge : `refs/heads/${state.localBranch}`;
        if (!destination.startsWith('refs/heads/')) throw new Error('追跡先にはブランチを指定してください。');
        git(root, 'check-ref-format', destination);
        if (action === 'pull') {
          if (state.staged.length || state.unstaged.length) throw new Error('変更をコミットまたは退避してから pull してください。');
          const modes = { 'ff-only': ['--ff-only'], merge: ['--no-rebase', '--ff', '--no-edit'], rebase: ['--rebase', '--ff'] };
          if (!modes[strategy]) throw new Error('pull の方法を選択してください。');
          git(root, '-c', 'core.editor=true', '-c', 'merge.autoStash=false', '-c', 'rebase.autoStash=false', 'pull', ...modes[strategy], '--', remote, destination);
        } else {
          if (confirmed !== true) throw new Error('push 先を確認してください。');
          git(root, 'push', '--porcelain', '--set-upstream', '--', remote, `HEAD:${destination}`);
        }
      }
    } else if (['continue', 'abort'].includes(action)) {
      if (!state.operation) throw new Error('進行中の merge / rebase はありません。');
      if (action === 'abort' && confirmed !== true) throw new Error('中止する前に確認してください。');
      git(root, '-c', 'core.editor=true', '-c', 'sequence.editor=true', state.operation, action === 'abort' ? '--abort' : '--continue');
    } else if (action === 'commit') {
      if (typeof message !== 'string' || !message.trim() || message.includes('\0') || message.length > 10000) throw new Error('コミットメッセージを入力してください（10,000 文字まで）。');
      if (!state.staged.length) throw new Error('先に変更をステージしてください。');
      if (state.staged.some(item => item.conflict)) throw new Error('競合を解決してからコミットしてください。');
      git(root, 'commit', '-m', message.trim());
    } else {
      if (!['stage', 'unstage', 'discard'].includes(action)) throw new Error('未対応の操作です。');
      const list = action === 'unstage' ? state.staged : state.unstaged;
      const entry = list.find(item => item.path === file);
      if (!entry) throw new Error('表示されている変更ファイルを選択してください。');
      const target = safePath(root, file);
      if (entry.conflict && action !== 'stage') throw new Error('競合ファイルはエディターで解決してからステージしてください。');
      if (git(root, 'ls-files', '--stage', '--', file).startsWith('160000 ')) throw new Error('サブモジュールはそのリポジトリ内で操作してください。');
      const paths = entry.originalPath ? [file, entry.originalPath] : [file];
      paths.forEach(value => safePath(root, value));
      if (action === 'stage') git(root, 'add', '--', file);
      if (action === 'unstage') {
        if (state.head) git(root, 'restore', '--staged', '--', ...paths);
        else git(root, 'rm', '--cached', '--', ...paths);
      }
      if (action === 'discard') {
        if (confirmed !== true) throw new Error('変更を破棄する前に確認してください。');
        if (entry.x === '?') unlinkSync(target);
        else git(root, 'restore', '--worktree', '--', file);
      }
    }
    } catch (error) {
      try { error.state = this.status(repo, limit, offset); } catch { /* Keep the original failure. */ }
      throw error;
    }
    try { return this.status(repo, limit, offset); }
    catch (error) { throw new Error(`操作は完了しましたが、一覧を更新できませんでした。再読み込みしてください：${error.message}`); }
  }

  diff({ repo, revision, file, staged = false }) {
    const state = this.status(repo);
    if (state.revision !== revision) throw new Error('変更が更新されています。再読み込みしてください。');
    const entry = (staged ? state.staged : state.unstaged).find(item => item.path === file);
    if (!entry) throw new Error('変更ファイルを選択してください。');
    const root = this.root(repo), target = safePath(root, file);
    let patch;
    if (entry.x === '?') {
      if (!lstatSync(target).isFile()) patch = 'リンクまたはフォルダーです。';
      else {
        const bytes = readFileSync(target);
        patch = bytes.includes(0) ? 'バイナリファイルです。' : `--- /dev/null\n+++ ${file}\n${bytes.toString('utf8').split('\n').map(line => '+' + line).join('\n')}`;
      }
    } else patch = git(root, 'diff', ...(staged ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--no-color', '--', file, ...(entry.originalPath ? [entry.originalPath] : []));
    return { title: file, patch: patch.slice(0, 200000), truncated: patch.length > 200000 };
  }

  inspect({ repo, hash }) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{40,64}$/.test(hash)) throw new Error('グラフからコミットを選択してください。');
    const root = this.root(repo);
    if (git(root, 'cat-file', '-t', hash).trim() !== 'commit') throw new Error('コミットを選択してください。');
    const patch = git(root, 'show', '--format=fuller', '--stat', '--patch', '--diff-merges=first-parent', '--no-ext-diff', '--no-textconv', '--no-color', '--no-show-signature', hash, '--');
    return { title: hash.slice(0, 12), patch: patch.slice(0, 200000), truncated: patch.length > 200000 };
  }
}
