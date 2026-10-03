import { build } from 'esbuild';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
const output = new URL('../dist/live-translator-chrome/', import.meta.url);
await mkdir(output, { recursive: true });
const root = new URL('../', import.meta.url);
for (const entry of ['background', 'popup', 'content']) {
  await build({ entryPoints: [new URL(`src/${entry}.js`, root).pathname], outfile: new URL(`${entry}.js`, output).pathname,
    bundle: true, format: entry === 'content' ? 'iife' : 'esm', platform: 'browser', target: 'chrome120' });
}
for (const file of ['popup.html', 'popup.css']) await cp(new URL(`src/${file}`, root), new URL(file, output));
const manifest = JSON.parse(await readFile(new URL('src/manifest.json', root), 'utf8'));
manifest.version = JSON.parse(await readFile(new URL('package.json', root), 'utf8')).version;
await writeFile(new URL('manifest.json', output), JSON.stringify(manifest, null, 2) + '\n');
await cp(new URL('icons/', root), new URL('icons/', output), { recursive: true });
for (const file of ['README.md', 'DEVELOPMENT.md']) await cp(new URL(file, root), new URL(file, output));
await cp(new URL('../LICENSE', root), new URL('LICENSE', output));
console.log(`Built ${output.pathname}`);
