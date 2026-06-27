/* Regenerate the PNG favicons / PWA icons from the source SVGs.
   The SVGs in public/ are the source of truth (favicon.svg = the rounded tile,
   icon-maskable.svg = full-bleed for Apple + maskable PWA icons). Run after
   changing the mark:  npm run icons:gen   (needs `sharp`). */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

let sharp;
try {
  ({ default: sharp } = await import('sharp'));
} catch {
  console.error('\n[icons] This script needs `sharp` to rasterize SVG → PNG.');
  console.error('        Install once:  npm i -D sharp');
  console.error('        Then re-run:   npm run icons:gen\n');
  process.exit(1);
}

// [source SVG, output PNG, size]
const jobs = [
  ['favicon.svg', 'favicon.png', 32],
  ['favicon.svg', 'favicon-192.png', 192],
  ['icon-maskable.svg', 'apple-touch-icon.png', 180], // full-bleed: iOS adds its own mask
  ['icon-maskable.svg', 'icon-512.png', 512],         // PWA "any" + "maskable"
];

for (const [src, out, size] of jobs) {
  const svg = await readFile(path.join(pub, src));
  const png = await sharp(svg, { density: 512 }).resize(size, size).png().toBuffer();
  await writeFile(path.join(pub, out), png);
  console.log(`[icons] ${src} → ${out}  (${size}×${size})`);
}
console.log('[icons] done.');
