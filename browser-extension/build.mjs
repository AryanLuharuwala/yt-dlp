/**
 * Build script: bundles meriyah + astring + yt.solver.core.js
 * into a single IIFE file usable in a browser extension content script.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));

const solverCorePath = join(__dirname, '../yt_dlp/extractor/youtube/jsc/_builtin/vendor/yt.solver.core.js');
const solverCore = readFileSync(solverCorePath, 'utf8');

// Create a virtual ESM entry that imports meriyah+astring and runs the solver core
// The solver core ends with: var jsc = (function (meriyah, astring) { ... })(meriyah, astring);
// By importing meriyah and astring first, those identifiers are in scope when
// the solver core references them in its IIFE invocation.
const virtualEntry = `
import * as meriyah from 'meriyah';
import { generate } from 'astring';

// astring is expected as { generate: fn } by the solver core
const astring = { generate };

// Execute the solver core. It references 'meriyah' and 'astring' from this scope.
${solverCore}

// Expose on globalThis so content scripts and injected scripts can call it
globalThis.ytdlpJsc = jsc;
`;

const tmpPath = join(__dirname, '.solver-entry.mjs');
writeFileSync(tmpPath, virtualEntry);

mkdirSync(join(__dirname, 'solver'), { recursive: true });

await build({
  entryPoints: [tmpPath],
  bundle: true,
  format: 'iife',
  outfile: join(__dirname, 'solver/solver.bundle.js'),
  platform: 'browser',
  target: 'es2020',
  minify: false,
});

import { unlinkSync } from 'fs';
unlinkSync(tmpPath);

console.log('solver/solver.bundle.js built successfully');
