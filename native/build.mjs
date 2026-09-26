import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'public');
const output = resolve(root, 'native-web');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });

await build({
  entryPoints: [resolve(root, 'native', 'runtime-entry.js')],
  outfile: resolve(output, 'native-runtime.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: false,
  minify: false
});

console.log('Quest Log native web bundle prepared in native-web/');
