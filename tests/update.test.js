/**
 * New versions reaching the installed apps: the build id the build writes into the page and into
 * version.json, the comparison of the two, and the guard that keeps a reload from looping.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareBuild, mayReload, parseVersion, LOOP_GUARD_MS } from '../js/update.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('compareBuild: unknown without both ids, same when equal, newer when they differ', () => {
  assert.equal(compareBuild('', 'abc123abc123'), 'unknown'); // development: no build id in the page
  assert.equal(compareBuild('abc123abc123', ''), 'unknown'); // offline, a 404, a broken answer
  assert.equal(compareBuild('', ''), 'unknown');
  assert.equal(compareBuild('abc123abc123', 'abc123abc123'), 'same');
  assert.equal(compareBuild('abc123abc123', 'def456def456'), 'newer');
});

test('parseVersion: only a hex build id in a JSON object counts', () => {
  assert.equal(parseVersion('{"build":"dbb7de36d449"}'), 'dbb7de36d449');
  assert.equal(parseVersion('<!doctype html><title>404</title>'), '');
  assert.equal(parseVersion('{"build":42}'), '');
  assert.equal(parseVersion('{"build":"<script>"}'), '');
  assert.equal(parseVersion('null'), '');
  assert.equal(parseVersion(''), '');
});

test('mayReload: never twice toward the same deployed build within 30 minutes', () => {
  const t = Date.parse('2026-11-13T14:00:00Z');
  assert.equal(mayReload(null, 'aaa111aaa111', t), true);
  assert.equal(mayReload(null, '', t), false);
  const last = { build: 'aaa111aaa111', at: t };
  assert.equal(mayReload(last, 'aaa111aaa111', t + 1000), false);
  assert.equal(mayReload(last, 'aaa111aaa111', t + LOOP_GUARD_MS - 1), false);
  assert.equal(mayReload(last, 'aaa111aaa111', t + LOOP_GUARD_MS), true);
  // another deploy is another build: it may be loaded at once
  assert.equal(mayReload(last, 'bbb222bbb222', t + 1000), true);
  // a clock set back does not hold the reload forever
  assert.equal(mayReload(last, 'aaa111aaa111', t - 60000), true);
  assert.equal(mayReload({ build: 'aaa111aaa111', at: NaN }, 'aaa111aaa111', t), true);
});

test('the build writes the same id into the page and into version.json, and the same source gives the same id', () => {
  const out = mkdtempSync(join(tmpdir(), 'networth-build-'));
  try {
    execFileSync(process.execPath, [join(root, 'tools', 'build.mjs'), out], { cwd: root, stdio: 'pipe' });
    const page = readFileSync(join(out, 'index.html'), 'utf8');
    const version = JSON.parse(readFileSync(join(out, 'version.json'), 'utf8'));
    const m = /<meta name="networth-build" content="([0-9a-f]+)">/.exec(page);
    assert.ok(m, 'the page carries its build id');
    assert.equal(version.build, m[1]);
    assert.equal(parseVersion(JSON.stringify(version)), m[1]);
    // the page may read version.json, and nothing else changed in the policy
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(page)[1];
    assert.match(csp, /connect-src 'self' https:\/\/beta-bridge\.simplefin\.org https:\/\/bridge\.simplefin\.org https:\/\/api\.github\.com;/);
    execFileSync(process.execPath, [join(root, 'tools', 'build.mjs'), out], { cwd: root, stdio: 'pipe' });
    assert.equal(JSON.parse(readFileSync(join(out, 'version.json'), 'utf8')).build, m[1]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the source page carries an empty build id: in development every check answers unknown', () => {
  const page = readFileSync(join(root, 'index.html'), 'utf8');
  assert.match(page, /<meta name="networth-build" content="">/);
});
