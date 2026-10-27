#!/usr/bin/env node
/*
 * Bundles index.html, styles.css and the scripts into one self-contained
 * dist/index.html that can be opened directly or hosted anywhere.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let html = read('index.html');
html = html.replace(
  '<link rel="stylesheet" href="src/styles.css" />',
  () => `<style>\n${read('src/styles.css')}</style>`
);
// dist/index.html lives one folder down, so point the 3D link back up.
html = html.replace('href="3d/"', 'href="../3d/"');
html = html.replace(/<script src="(src\/[\w.]+)"><\/script>/g, (_, file) => `<script>\n${read(file)}</script>`);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'index.html'), html);
console.log(`Built dist/index.html (${(html.length / 1024).toFixed(1)} KB)`);
