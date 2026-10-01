import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';

const app = new App({ name: 'Git Source Control', version: '1.1.0' });
new OpenAIExtensions(app);
const $ = id => document.getElementById(id);
let state, busy = true, pendingAction;
const drafts = new Map();

function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
  $('notice').setAttribute('role', error ? 'alert' : 'status');
}
function controls() {
  $('panel').setAttribute('aria-busy', String(busy));
  $('repository').disabled = busy || !state;
  $('refresh').disabled = busy || !state;
  $('message').disabled = busy;
  $('commit').disabled = busy || !state?.revision || !state.staged.length || state.staged.some(file => file.conflict) || !$('message').value.trim();
  $('branch-selector').disabled = busy || !state?.revision || !!state.operation;
  $('new-branch').disabled = busy || !state?.head || !!state.operation;
  $('remote-selector').disabled = busy || !state?.remotes?.length;
  $('pull-strategy').disabled = busy;
  $('fetch').disabled = busy || !state?.remotes?.length;
  $('pull').disabled = busy || !state?.remotes?.length || !state.localBranch || !state.head || !!state.operation || !!state.staged.length || !!state.unstaged.length;
  $('pull').title = state?.staged.length || state?.unstaged.length ? '変更をコミットまたは退避してから pull してください' : '選択したリモートから取得して統合';
  $('push').disabled = busy || !state?.remotes?.length || !state.localBranch || !state.head || !!state.operation;
  $('continue-operation').disabled = busy || state?.staged.some(file => file.conflict);
  $('abort-operation').disabled = busy;
  $('more-history').disabled = busy;
  $('previous-history').disabled = busy;
  document.querySelectorAll('[data-operation]').forEach(button => { button.disabled = busy || (button.dataset.conflict === 'true' && !['stage', 'diff'].includes(button.dataset.operation)); });
}
function confirmAction(operation, args, title, file, description, label) {
  pendingAction = { operation, args: { repo: state.repo, revision: state.revision, ...args, confirmed: true } };
  $('discard-title').textContent = title;
  $('discard-file').textContent = file;
  $('discard-description').textContent = description;
  $('confirm-discard').textContent = label;
  $('discard-dialog').showModal();
}
function button(label, symbol, operation, file) {
  const node = document.createElement('button');
  node.className = 'icon-button cursor-interaction';
  node.type = 'button'; node.textContent = symbol;
  node.title = label; node.setAttribute('aria-label', `${label}: ${file.path}`);
  node.dataset.operation = operation; node.dataset.conflict = String(file.conflict);
  node.addEventListener('click', () => {
    if (operation === 'discard') {
      confirmAction('discard', { file: file.path }, '変更を破棄しますか？', file.path,
        file.x === '?' ? '未追跡のファイルを削除します。この操作は元に戻せません。' : '未ステージの変更を破棄します。ステージ済みの内容は保持されます。この操作は元に戻せません。', '変更を破棄');
    } else run(operation, { file: file.path });
  });
  return node;
}
function render(result) {
  const previousRepo = state?.repo;
  state = result;
  if (previousRepo !== state.repo) $('message').value = drafts.get(state.repo) || '';
  const select = $('repository');
  select.replaceChildren(...state.repositories.map(repo => {
    const option = document.createElement('option'); option.value = repo.id; option.textContent = repo.label; return option;
  }));
  select.value = state.repo;
  $('branch').textContent = state.branch;
  const branches = $('branch-selector');
  branches.replaceChildren();
  const currentRef = `refs/heads/${state.localBranch}`;
  if (!state.branches?.some(item => item.ref === currentRef)) {
    const option = document.createElement('option'); option.textContent = state.branch; option.value = ''; branches.append(option);
  }
  for (const [label, remote] of [['ローカル', false], ['リモート', true]]) {
    const group = document.createElement('optgroup'); group.label = label;
    for (const branch of (state.branches || []).filter(item => !!item.remote === remote)) {
      const option = document.createElement('option'); option.value = branch.ref;
      option.textContent = branch.name + (!remote && branch.checkedOut && branch.ref !== currentRef ? ' · 別の worktree' : '');
      option.disabled = !remote && branch.checkedOut && branch.ref !== currentRef;
      group.append(option);
    }
    if (group.children.length) branches.append(group);
  }
  branches.value = state.localBranch && state.branches?.some(item => item.ref === currentRef) ? currentRef : '';
  const remote = $('remote-selector'), previousRemote = remote.value;
  remote.replaceChildren(...(state.remotes?.length ? state.remotes : ['']).map(name => {
    const option = document.createElement('option'); option.value = name; option.textContent = name || 'リモートなし'; return option;
  }));
  remote.value = previousRepo === state.repo && state.remotes?.includes(previousRemote) ? previousRemote : state.remotes?.includes(state.upstreamRemote) ? state.upstreamRemote : state.remotes?.[0] || '';
  $('tracking').textContent = state.upstream ? `${state.upstream.replace('refs/remotes/', '')} · ${state.upstreamGone ? '追跡先なし' : `↑${state.ahead} ↓${state.behind}`}` : state.head ? '追跡先なし' : '初回コミット前';
  $('operation-panel').hidden = !state.operation;
  $('operation-title').textContent = state.operation ? `${state.operation} が進行中 · 競合を解決してステージ後に継続` : '';
  for (const group of ['staged', 'unstaged']) {
    const files = state[group];
    $(group + '-count').textContent = files.length;
    $(group + '-empty').hidden = files.length > 0;
    $(group).replaceChildren(...files.map(file => {
      const row = document.createElement('li'); row.className = 'file';
      const name = document.createElement('button'); name.type = 'button'; name.className = 'file-name cursor-interaction';
      name.dataset.operation = 'diff'; name.setAttribute('aria-label', `${group === 'staged' ? 'ステージ済み差分' : '未ステージ差分'}: ${file.path}`);
      name.addEventListener('click', () => run('diff', { file: file.path, staged: group === 'staged' }));
      const slash = file.path.lastIndexOf('/');
      name.textContent = file.path.slice(slash + 1); name.title = file.path;
      if (slash >= 0 || file.originalPath) {
        const folder = document.createElement('span'); folder.className = 'file-folder';
        folder.textContent = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path.slice(0, slash);
        name.append(folder);
      }
      const code = document.createElement('span');
      const status = file.conflict ? '!' : group === 'staged' ? file.x : file.y;
      code.className = `file-code ${file.conflict ? 'conflict' : 'A?'.includes(status) ? 'added' : status === 'D' ? 'deleted' : ''}`;
      code.textContent = status; code.title = file.conflict ? '競合：エディターで解決してください' : status;
      row.append(name, code);
      if (group === 'staged') row.append(button('アンステージ', '−', 'unstage', file));
      else row.append(button('変更を破棄', '↶', 'discard', file), button('ステージ', '+', 'stage', file));
      return row;
    }));
  }
  const total = new Set([...state.staged, ...state.unstaged].map(file => file.path)).size;
  $('total').textContent = total ? `${total} ファイルに変更` : '変更なし';
  renderHistory();
  controls();
}
function renderHistory() {
  const history = state.history || [];
  const width = Math.max(2, ...history.map(row => row.graph.length)) * 10;
  $('history-empty').hidden = history.length > 0;
  const count = history.filter(row => row.hash).length;
  $('history-count').textContent = `すべてのブランチ · ${count ? `${(state.historyOffset || 0) + 1}–${(state.historyOffset || 0) + count}` : '0'} 件`;
  $('more-history').hidden = !state.hasMore;
  $('previous-history').hidden = !state.historyOffset;
  $('history').replaceChildren(...history.map(row => {
    const line = document.createElement('div'); line.className = 'graph-row'; line.style.gridTemplateColumns = `${width}px minmax(0,1fr)`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', width); svg.setAttribute('height', '24'); svg.setAttribute('aria-hidden', 'true');
    // Git computes graph topology; draw its character cells without maintaining a separate lane algorithm.
    [...row.graph].forEach((character, i) => {
      const x = i * 10 + 5;
      let d = character === '|' ? `M${x} 0V24` : character === '/' ? `M${x + 10} 0L${x - 10} 24` : character === '\\' ? `M${x - 10} 0L${x + 10} 24` : ['-', '_'].includes(character) ? `M${x - 5} 12H${x + 5}` : '';
      if (character === '*') d = `M${x} 0V${row.parents?.length ? 24 : 12}`;
      if (d) {
        const rail = document.createElementNS(svg.namespaceURI, 'path'); rail.setAttribute('d', d); rail.setAttribute('stroke', `var(--graph-${Math.floor(i / 2) % 3})`); rail.setAttribute('stroke-width', '1.5'); rail.setAttribute('fill', 'none'); svg.append(rail);
      }
      if (character === '*' || character === '.') {
        const dot = document.createElementNS(svg.namespaceURI, 'circle'); dot.setAttribute('cx', x); dot.setAttribute('cy', '12'); dot.setAttribute('r', character === '*' ? '3.5' : '1'); dot.setAttribute('fill', `var(--graph-${Math.floor(i / 2) % 3})`); svg.append(dot);
      }
    });
    line.append(svg);
    if (row.hash) {
      const commit = document.createElement('button'); commit.type = 'button'; commit.className = 'graph-commit cursor-interaction'; commit.dataset.operation = 'inspect';
      commit.setAttribute('aria-label', `コミット詳細: ${row.subject}`); commit.title = `${row.short} · ${row.author} · ${row.date}\n${row.subject}`;
      const subject = document.createElement('span'); subject.className = 'graph-subject'; subject.textContent = row.subject;
      const hash = document.createElement('code'); hash.textContent = row.short;
      commit.append(subject, hash);
      if (row.refs) { const refs = document.createElement('span'); refs.className = 'graph-refs'; refs.textContent = row.refs; commit.prepend(refs); }
      commit.addEventListener('click', () => run('inspect', { hash: row.hash })); line.append(commit);
    }
    return line;
  }));
}
function showDiff(result) {
  $('diff-title').textContent = result.title;
  $('diff-truncated').hidden = !result.truncated;
  $('diff-content').replaceChildren(...result.patch.split('\n').map(text => {
    const line = document.createElement('span'); line.textContent = text + '\n';
    line.className = text.startsWith('+') && !text.startsWith('+++') ? 'diff-added' : text.startsWith('-') && !text.startsWith('---') ? 'diff-removed' : text.startsWith('@@') ? 'diff-hunk' : '';
    return line;
  }));
  $('diff-dialog').showModal();
}
async function run(operation, args = {}) {
  if (busy || !state) return;
  busy = true; controls();
  const labels = { stage: 'ステージしました', unstage: 'アンステージしました', discard: '変更を破棄しました', commit: 'コミットしました', switch: 'ブランチを切り替えました', create_branch: 'ブランチを作成しました', fetch: 'Fetch が完了しました', pull: 'Pull が完了しました', push: 'Push が完了しました', continue: '処理を継続しました', abort: '処理を中止しました', diff: '差分を表示しました', inspect: 'コミット詳細を表示しました' };
  notice(['fetch', 'pull', 'push'].includes(operation) ? `${operation} を実行しています…` : '読み込み中…');
  try {
    const result = await app.callServerTool({ name: `git.${operation}`, arguments: { repo: state.repo, revision: state.revision, limit: state.historyLimit || 50, offset: ['switch', 'create_branch'].includes(operation) ? 0 : state.historyOffset || 0, ...args } }, { timeout: 180000 });
    if (result.isError) {
      if (result.structuredContent?.repositories) render(result.structuredContent);
      throw new Error(result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '操作に失敗しました。');
    }
    if (!result.structuredContent) throw new Error('サーバーから変更情報が返されませんでした。');
    if (['diff', 'inspect'].includes(operation)) showDiff(result.structuredContent);
    else render(result.structuredContent);
    if (operation === 'commit') { $('message').value = ''; drafts.delete(state.repo); }
    notice(labels[operation] || '変更を読み込みました');
    return true;
  } catch (error) {
    notice(error.message, true);
    return false;
  } finally { busy = false; controls(); }
}
$('message').addEventListener('input', () => { if (state) drafts.set(state.repo, $('message').value); controls(); });
$('message').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (!$('commit').disabled) $('commit-form').requestSubmit(); } });
$('commit-form').addEventListener('submit', event => { event.preventDefault(); if (!$('commit').disabled) run('commit', { message: $('message').value }); });
$('refresh').addEventListener('click', () => run('status'));
$('branch-selector').addEventListener('change', async () => {
  const branch = $('branch-selector').value;
  if (branch) await run('switch', { branch });
  $('branch-selector').value = state.branches?.some(item => item.ref === `refs/heads/${state.localBranch}`) ? `refs/heads/${state.localBranch}` : '';
});
$('new-branch').addEventListener('click', () => $('branch-dialog').showModal());
$('cancel-branch').addEventListener('click', () => $('branch-dialog').close());
$('branch-form').addEventListener('submit', async event => {
  event.preventDefault(); const branch = $('branch-name').value.trim(); $('branch-dialog').close();
  if (await run('create_branch', { branch })) $('branch-name').value = '';
});
$('fetch').addEventListener('click', () => run('fetch', { remote: $('remote-selector').value }));
$('pull').addEventListener('click', () => run('pull', { remote: $('remote-selector').value, strategy: $('pull-strategy').value }));
$('push').addEventListener('click', () => {
  const remote = $('remote-selector').value;
  const branch = remote === state.upstreamRemote && state.upstreamMerge ? state.upstreamMerge.replace('refs/heads/', '') : state.localBranch;
  confirmAction('push', { remote }, 'コミットを Push しますか？', `${remote}/${branch}`, 'このブランチのコミットを選択したリモートへ送信します。初回は追跡先も設定します。', 'Push');
});
$('continue-operation').addEventListener('click', () => run('continue'));
$('abort-operation').addEventListener('click', () => confirmAction('abort', {}, `${state.operation} を中止しますか？`, state.branch, '処理開始前に戻ります。競合解決のために加えた変更は失われます。', '処理を中止'));
$('more-history').addEventListener('click', () => run('status', { offset: (state.historyOffset || 0) + (state.historyLimit || 50) }));
$('previous-history').addEventListener('click', () => run('status', { offset: Math.max(0, (state.historyOffset || 0) - (state.historyLimit || 50)) }));
function selectTab(name) {
  for (const tab of ['changes', 'history']) {
    $(tab + '-tab').setAttribute('aria-selected', String(tab === name));
    $(tab + '-tab').tabIndex = tab === name ? 0 : -1;
    $(tab + '-view').hidden = tab !== name;
  }
}
for (const tab of ['changes', 'history']) {
  $(tab + '-tab').addEventListener('click', () => selectTab(tab));
  $(tab + '-tab').addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const next = event.key === 'Home' ? 'changes' : event.key === 'End' ? 'history' : tab === 'changes' ? 'history' : 'changes';
      selectTab(next); $(next + '-tab').focus();
    }
  });
}
$('close-diff').addEventListener('click', () => $('diff-dialog').close());
$('repository').addEventListener('change', async () => {
  const repo = $('repository').value;
  await run('status', { repo, offset: 0 });
  $('repository').value = state.repo;
  controls();
});
$('cancel-discard').addEventListener('click', () => $('discard-dialog').close());
$('confirm-discard').addEventListener('click', () => {
  const target = pendingAction;
  $('discard-dialog').close();
  if (target) run(target.operation, target.args);
});
$('discard-dialog').addEventListener('close', () => { pendingAction = undefined; });
function hostContext(context) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}
app.addEventListener('hostcontextchanged', hostContext);
app.addEventListener('toolresult', result => {
  busy = false;
  if (result.structuredContent) {
    render(result.structuredContent);
    notice(state.error || '変更を読み込みました', !!state.error);
  } else notice(result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'リポジトリを読み込めませんでした。', true);
  controls();
});
try { await app.connect(); hostContext(app.getHostContext()); }
catch (error) { busy = false; controls(); notice(`プラグインへ接続できませんでした：${error.message}`, true); }
