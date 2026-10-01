import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { OpenAIExtensions } from '@openai/mcp-extensions/server';
import { z } from 'zod';
import { GitControl } from './git.mjs';

const here = new URL('.', import.meta.url);
const URI = 'ui://git-source-control/panel';
const icon = `data:image/svg+xml;base64,${readFileSync(new URL('assets/icon.svg', here)).toString('base64')}`;

export function createServer(repositories) {
  const control = new GitControl(repositories);
  const server = new McpServer({ name: 'git-source-control', version: '1.1.0', icons: [{ src: icon, mimeType: 'image/svg+xml', sizes: ['any'] }] });
  new OpenAIExtensions(server);
  const respond = callback => async args => {
    try {
      const structuredContent = callback(args);
      return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }], ...(error.state ? { structuredContent: error.state } : {}) };
    }
  };
  registerAppResource(server, 'Git Source Control', URI, {}, async () => ({ contents: [{
    uri: URI, mimeType: RESOURCE_MIME_TYPE, text: readFileSync(new URL('dist/panel.html', here), 'utf8'),
    _meta: {
      ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
      'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] },
    },
  }] }));
  registerAppTool(server, 'git.open', {
    title: 'Source Control', description: 'Open local Git Source Control. Select a registered repository to inspect and manage changes.',
    inputSchema: { repo: z.string().optional() }, icons: [{ src: icon, mimeType: 'image/svg+xml', sizes: ['any'] }],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: URI }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } },
  }, respond(({ repo }) => {
    const id = repo || control.repositories[0].id;
    try { return control.status(id); }
    catch (error) {
      return { repo: id, branch: '—', revision: '', staged: [], unstaged: [], error: error.message,
        repositories: control.repositories.map(({ id, label }) => ({ id, label })) };
    }
  }));
  registerAppTool(server, 'git.status', {
    description: 'Refresh branches, remotes, synchronization status, changes and a page of the commit graph.', inputSchema: { repo: z.string(), limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().nonnegative().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: URI, visibility: ['app'] } },
  }, respond(({ repo, limit, offset }) => control.status(repo, limit, offset)));
  for (const action of ['diff', 'inspect']) {
    registerAppTool(server, `git.${action}`, {
      description: action === 'diff' ? 'Inspect a staged or unstaged file diff.' : 'Inspect a commit from the graph, including metadata and file changes.',
      inputSchema: { repo: z.string(), ...(action === 'diff' ? { revision: z.string(), file: z.string(), staged: z.boolean().optional() } : { hash: z.string().regex(/^[a-f0-9]{40,64}$/) }) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: URI, visibility: ['app'] } },
    }, respond(args => control[action](args)));
  }
  for (const action of ['stage', 'unstage', 'commit', 'discard', 'switch', 'create_branch', 'fetch', 'pull', 'push', 'continue', 'abort']) {
    const fileAction = ['stage', 'unstage', 'discard'].includes(action);
    registerAppTool(server, `git.${action}`, {
      description: `${action} in a registered repository. Requires the current revision. Discard, abort and push require explicit user confirmation.`,
      inputSchema: {
        repo: z.string(), revision: z.string(), limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().nonnegative().optional(),
        ...(action === 'commit' ? { message: z.string().min(1).max(10000) } : {}),
        ...(fileAction ? { file: z.string().min(1) } : {}),
        ...(['switch', 'create_branch'].includes(action) ? { branch: z.string().min(1).max(256) } : {}),
        ...(['fetch', 'pull', 'push'].includes(action) ? { remote: z.string().min(1) } : {}),
        ...(action === 'pull' ? { strategy: z.enum(['ff-only', 'merge', 'rebase']).optional() } : {}),
        ...(['discard', 'abort', 'push'].includes(action) ? { confirmed: z.literal(true) } : {}),
      },
      annotations: { readOnlyHint: false, destructiveHint: ['discard', 'abort'].includes(action), openWorldHint: ['fetch', 'pull', 'push'].includes(action) },
      _meta: { ui: { resourceUri: URI, visibility: ['app'] } },
    }, respond(args => control.mutate(action, args)));
  }
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const configIndex = process.argv.indexOf('--config');
  const config = configIndex >= 0 ? process.argv[configIndex + 1] : new URL('repositories.json', here);
  await createServer(JSON.parse(readFileSync(config, 'utf8'))).connect(new StdioServerTransport());
}
