#!/usr/bin/env node
// Build the site that GitHub Pages serves: docs/index.html with all CSS and JavaScript inlined
// (one request, one atomic version), next to the manifest, icons and service worker.
//
//   node tools/build.mjs            -> ./docs/
//   node tools/build.mjs out        -> custom output directory
//
// It is a deliberately tiny bundler, so the source must follow these MODULE RULES:
//   - imports:  import { a, b as c } from './relative/path.js';   (named, relative, with .js; side-effect imports allowed)
//   - exports:  export function f() {}  |  export async function f() {}  |  export const X = ...  |  export class C {}
//               |  export { a, b };
//   - no default exports, no `export *`, no re-exports, no dynamic import(), no top-level await,
//     no exported `let` that is reassigned later (importers would not see the change), no import cycles.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if ((process.argv[2] || '').startsWith('-')) {
  // an option is not an output directory: without this, "build.mjs --help" would write a folder named --help
  console.log('usage: node tools/build.mjs [output directory]   (default: docs)');
  process.exit(process.argv[2] === '--help' || process.argv[2] === '-h' ? 0 : 2);
}
const outDir = resolve(root, process.argv[2] || 'docs');
const outFile = join(outDir, 'index.html');
const STATIC = ['manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'sw.js'];

const IMPORT_RE = /^[ \t]*import\s*(?:\{([^}]*)\}\s*from\s*)?['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
const EXPORT_DECL_RE = /^export\s+(async\s+function\*?|function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}\s*;?[ \t]*$/gm;

const modules = new Map(); // id -> { id, code, deps: [id], exports: [name] }

// A JSDoc block that has whole lines to itself: optional indent, then /**, no */ inside, and */ at the end of
// a line. Only those are removed from the bundle, so a string, a regex or a comment that shares its line with
// code is never touched.
const JSDOC_LINE_RE = /^[ \t]*\/\*\*(?:(?!\*\/)[\s\S])*\*\/[ \t]*\r?\n/gm;

function toId(absPath) { return relative(root, absPath).split('\\').join('/'); }

async function load(absPath, trail = []) {
  const id = toId(absPath);
  if (trail.includes(id)) throw new Error('Import cycle: ' + [...trail, id].join(' -> '));
  if (modules.has(id)) return id;
  let src = (await readFile(absPath, 'utf8')).replace(JSDOC_LINE_RE, '');
  const mod = { id, code: '', deps: [], exports: [] };
  modules.set(id, mod);
  const header = [];
  const depPaths = [];

  src = src.replace(IMPORT_RE, (_, names, spec) => {
    if (!spec.startsWith('.')) throw new Error(id + ': only relative imports are supported (' + spec + ')');
    const depAbs = resolve(dirname(absPath), spec);
    const depId = toId(depAbs);
    depPaths.push(depAbs);
    if (names && names.trim()) {
      const parts = names.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
        const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(s);
        if (!m) throw new Error(id + ': cannot parse import specifier "' + s + '"');
        return m[2] ? m[1] + ': ' + m[2] : m[1];
      });
      header.push('const { ' + parts.join(', ') + ' } = __mods[' + JSON.stringify(depId) + '];');
    }
    return '';
  });

  src = src.replace(EXPORT_DECL_RE, (_, kind, name) => { mod.exports.push(name); return kind + ' ' + name; });
  src = src.replace(EXPORT_LIST_RE, (_, names) => {
    for (const s of names.split(',').map((x) => x.trim()).filter(Boolean)) {
      const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(s);
      if (!m) throw new Error(id + ': cannot parse export specifier "' + s + '"');
      mod.exports.push(m[2] ? m[2] + ': ' + m[1] : m[1]);
    }
    return '';
  });

  const leftover = /^[ \t]*(?:import|export)\b(?!\s*[:(,.=?)\]}])[^\n]*/m.exec(src);
  if (leftover) throw new Error(id + ': unsupported module syntax: ' + leftover[0].trim());
  if (/\bimport\s*\(/.test(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''))) throw new Error(id + ': dynamic import() is not supported');

  mod.code = (header.length ? header.join('\n') + '\n' : '') + src.trim() + '\n';
  for (const depAbs of depPaths) mod.deps.push(await load(depAbs, [...trail, id]));
  return id;
}

function ordered(entryId) {
  const seen = new Set();
  const out = [];
  (function visit(id) {
    if (seen.has(id)) return;
    seen.add(id);
    for (const d of modules.get(id).deps) visit(d);
    out.push(modules.get(id));
  })(entryId);
  return out;
}

function bundleJs(entryId) {
  let js = '(function () {\n"use strict";\nconst __mods = Object.create(null);\n';
  for (const m of ordered(entryId)) {
    js += '\n// ---- ' + m.id + '\n__mods[' + JSON.stringify(m.id) + '] = (function () {\n' + m.code + 'return { ' + m.exports.join(', ') + ' };\n})();\n';
  }
  js += '})();\n';
  return js.replace(/<\/script/gi, '<\\/script');
}

/** Inline the local stylesheets, in document order. `sheets` receives the exact text of every <style> element. */
async function inlineAssets(htmlText, sheets) {
  let htmlOut = htmlText;
  const linkRe = /<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi;
  const links = htmlOut.match(linkRe) || [];
  for (const tag of links) {
    const href = /href=["']([^"']+)["']/i.exec(tag);
    if (!href || /^(https?:)?\/\//.test(href[1])) continue;
    const css = (await readFile(join(root, href[1]), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*\n+/g, '\n');
    const text = '\n' + css.replace(/<\/style/gi, '<\\/style') + '\n';
    sheets.push(text);
    htmlOut = htmlOut.replace(tag, () => '<style data-src="' + href[1] + '">' + text + '</style>');
  }
  return htmlOut;
}

function sha256(text) {
  return "'sha256-" + createHash('sha256').update(text, 'utf8').digest('base64') + "'";
}

async function main() {
  const indexPath = join(root, 'index.html');
  let page = await readFile(indexPath, 'utf8');
  const scriptRe = /<script\b[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/i;
  const m = scriptRe.exec(page);
  if (!m) throw new Error('index.html: no <script type="module" src="..."> entry found');
  const entryId = await load(resolve(root, m[1]));
  const js = bundleJs(entryId);
  const inlineSheets = [];
  page = await inlineAssets(page, inlineSheets);
  const inlineScripts = [];
  // classic (non-module) local scripts, e.g. the theme bootstrap in <head>
  const classicRe = /<script\b(?![^>]*type=["']module["'])[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi;
  for (const tag of page.match(classicRe) || []) {
    const src = /src=["']([^"']+)["']/i.exec(tag)[1];
    if (/^(https?:)?\/\//.test(src)) continue;
    const code = '\n' + (await readFile(join(root, src), 'utf8')).replace(/<\/script/gi, '<\\/script') + '\n';
    inlineScripts.push(code);
    page = page.replace(tag, () => '<script>' + code + '</script>');
  }
  const mainCode = '\n' + js;
  inlineScripts.push(mainCode);
  page = page.replace(scriptRe, () => '<script>' + mainCode + '</script>');
  // the page allows exactly these inline scripts and nothing else
  const hashes = inlineScripts.map(sha256).join(' ');
  if (!/script-src 'self'/.test(page)) throw new Error("index.html: expected script-src 'self' in the Content-Security-Policy");
  page = page.replace("script-src 'self'", 'script-src ' + hashes);
  // ... and exactly these inlined stylesheets: a <style> element that is not one of them is refused.
  // (style attributes stay allowed through style-src-attr; the plain style-src is the fallback for
  // browsers that know neither of the two finer directives.)
  if (!/style-src-elem 'self'/.test(page)) throw new Error("index.html: expected style-src-elem 'self' in the Content-Security-Policy");
  if (!inlineSheets.length) throw new Error('index.html: no local stylesheet was inlined');
  page = page.replace("style-src-elem 'self'", 'style-src-elem ' + inlineSheets.map(sha256).join(' '));
  const stamp = new Date().toISOString().slice(0, 10);
  page = page.replace('<!--build-stamp-->', '<!-- Networth single-file build ' + stamp + ' -->');
  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, page);
  for (const name of STATIC) await copyFile(join(root, name), join(outDir, name));
  await writeFile(join(outDir, '.nojekyll'), '');
  const kb = (Buffer.byteLength(page) / 1024).toFixed(0);
  console.log('built ' + posix.normalize(relative(root, outFile)) + '  (' + modules.size + ' modules, ' + kb + ' KB)');
}

main().catch((err) => { console.error('BUILD FAILED: ' + err.message); process.exit(1); });
