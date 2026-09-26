import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, transform } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'public');
const output = resolve(root, 'native-web');

async function validatePublicScripts() {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = resolve(source, entry.name);

    if (entry.name.endsWith('.html')) {
      const html = await readFile(file, 'utf8');
      const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
        .map(match => match[1].trim())
        .filter(Boolean);
      for (let index = 0; index < scripts.length; index++) {
        try {
          await transform(scripts[index], { loader: 'js', target: 'es2022' });
        } catch (error) {
          throw new Error(`Inline script validation failed in ${entry.name} script #${index + 1}: ${error.message}`);
        }
      }
    }

    if (entry.name.endsWith('.js')) {
      const js = await readFile(file, 'utf8');
      try {
        await transform(js, { loader: 'js', target: 'es2022' });
      } catch (error) {
        throw new Error(`JavaScript validation failed in ${entry.name}: ${error.message}`);
      }
    }
  }
}

await validatePublicScripts();

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

console.log('Quest Log native web bundle prepared in native-web/ and public scripts validated.');
