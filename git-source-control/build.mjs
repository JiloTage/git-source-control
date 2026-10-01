import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('.', import.meta.url)));
const script = await build({ absWorkingDir: process.cwd(), entryPoints: ['ui.mjs'], bundle: true, write: false, format: 'esm', target: 'es2022', minify: true });
const css = await build({ absWorkingDir: process.cwd(), entryPoints: ['style.css'], bundle: true, write: false, minify: true });
const html = readFileSync('ui.html', 'utf8')
  .replace('<!-- STYLES -->', () => `<style>${css.outputFiles[0].text}</style>`)
  .replace('<!-- SCRIPT -->', () => `<script type="module">${script.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/panel.html', html);
// The desktop/CLI compatibility layout is generated from the portable manifests.
const manifest = JSON.parse(readFileSync('plugin.json', 'utf8'));
mkdirSync('.codex-plugin', { recursive: true });
writeFileSync('.codex-plugin/plugin.json', JSON.stringify({ name: manifest.name, version: manifest.version, description: manifest.description, ...manifest.extensions['com.openai'] }, null, 2) + '\n');
const servers = JSON.parse(readFileSync('mcp.json', 'utf8')).mcpServers;
writeFileSync('.mcp.json', JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(servers).map(([name, { type, ...config }]) => [name, config])) }, null, 2) + '\n');
