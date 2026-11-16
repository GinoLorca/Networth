/**
 * The words of the interface reach every device (model/prefs.js, model/share.js): the shared file's `prefs`
 * section, read as untrusted input, merged field by field by stamp, stamped on a choice above the stamp it
 * replaces, and carried by a round from one device to another. The repository is an in-memory fake and no
 * request leaves this process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultState } from '../js/model/schema.js';
import { applyPrefs, chooseWords, exportPrefs, isBlankPrefs, mergePrefs, noteSeenPrefs, prefsDiffer, readPrefs } from '../js/model/prefs.js';
import { applyShared, exportShared, mergeShared, readSharedFile, roundShared } from '../js/model/share.js';
import { wordsOf } from '../js/model/words.js';

const NOW = new Date(2026, 10, 10, 12).getTime();
const MIN_MS = 60000;

function file(prefs) {
  return JSON.stringify({ v: 1, app: 'networth', savedAt: 0, byHand: {}, prefs });
}

/* ------------------------------------------------------------------ reading */

test('the section reads a known field with a known value and its stamp', () => {
  assert.deepEqual(readPrefs({ words: { v: 'finance', at: 5 } }), { words: { v: 'finance', at: 5 } });
  assert.deepEqual(readPrefs({}), {});
  assert.ok(isBlankPrefs(readPrefs({})));
  // a fresh copy
  const raw = { words: { v: 'chess', at: 7 } };
  const read = readPrefs(raw);
  raw.words.v = 'finance';
  assert.equal(read.words.v, 'chess');
});

test('anything else in the section refuses it, and with it the file', () => {
  for (const bad of [
    null, [], 'finance', { words: null }, { words: { v: { mode: 'plain' }, at: 5 } }, { words: { v: 'finance' } },
    { words: { v: 'finance', at: -1 } }, { words: { v: 'finance', at: 1e15 } }, { words: { v: 'finance', at: 5, extra: 1 } },
    { words: ['finance', 5] }, { 'Not a name': { v: 1, at: 1 } }, { later: { v: { deep: true }, at: 1 } },
    { later: { v: 'x'.repeat(65), at: 1 } }, JSON.parse('{"__proto__": {"v": 1, "at": 1}}'),
    Object.fromEntries(Array.from({ length: 21 }, (_, i) => ['f' + i, { v: true, at: 1 }])),
  ]) {
    assert.equal(readPrefs(bad), null, JSON.stringify(bad));
  }
  assert.equal(readSharedFile(file({ words: { v: 'x'.repeat(65), at: 5 } })), null);
  assert.deepEqual(readSharedFile(file({ words: { v: 'finance', at: 5 } })).prefs, { words: { v: 'finance', at: 5 } });
  // an empty section is left out
  assert.equal(readSharedFile(file({})).prefs, undefined);
});

test('a field a later version adds travels as it is, checked for its shape', () => {
  const read = readPrefs({ words: { v: 'chess', at: 3 }, later: { v: true, at: 4 } });
  assert.deepEqual(read, { words: { v: 'chess', at: 3 }, later: { v: true, at: 4 } });
  const merged = mergePrefs(read, { words: { v: 'finance', at: 9 } });
  assert.deepEqual(merged, { later: { v: true, at: 4 }, words: { v: 'finance', at: 9 } });
});

/* ------------------------------------------------------------------ merging */

test('per field the later stamp wins; an equal stamp goes to the smaller canonical cell', () => {
  const a = { words: { v: 'finance', at: 10 } };
  const b = { words: { v: 'chess', at: 12 } };
  assert.deepEqual(mergePrefs(a, b), b);
  assert.deepEqual(mergePrefs(b, a), b);
  const tieA = { words: { v: 'finance', at: 10 } };
  const tieB = { words: { v: 'chess', at: 10 } };
  assert.deepEqual(mergePrefs(tieA, tieB), tieB);
  assert.deepEqual(mergePrefs(tieB, tieA), tieB);
  assert.deepEqual(mergePrefs(undefined, a), a);
  assert.deepEqual(mergePrefs(a, null), a);
  assert.deepEqual(mergePrefs(undefined, undefined), {});
});

test('the merge is commutative, associative and idempotent', () => {
  const cells = [undefined, { words: { v: 'chess', at: 1 } }, { words: { v: 'finance', at: 1 } }, { words: { v: 'finance', at: 2 } },
    { words: { v: 'chess', at: 3 }, later: { v: 1, at: 3 } }, { later: { v: 2, at: 3 } }];
  for (const a of cells) {
    assert.deepEqual(mergePrefs(a, a), mergePrefs(a, undefined));
    for (const b of cells) {
      assert.deepEqual(mergePrefs(a, b), mergePrefs(b, a));
      for (const c of cells) assert.deepEqual(mergePrefs(mergePrefs(a, b), c), mergePrefs(a, mergePrefs(b, c)));
    }
  }
});

/* ------------------------------------------------------------------ choosing */

test('a choice is stamped with its moment, and always 2 above the stamp it replaces', () => {
  const state = defaultState(NOW);
  assert.equal(state.settings.words, 'chess');
  assert.equal(state.settings.wordsAt, 0);
  assert.deepEqual(exportPrefs(state), {}, 'nothing travels before a choice');
  assert.equal(chooseWords(state, 'finance', NOW + 0.4), true);
  assert.equal(state.settings.words, 'finance');
  assert.equal(state.settings.wordsAt, NOW);
  assert.deepEqual(exportPrefs(state), { words: { v: 'finance', at: NOW } });
  // a clock put back still writes above the stamp it replaces
  assert.equal(chooseWords(state, 'chess', NOW - 10 * MIN_MS), true);
  assert.equal(state.settings.wordsAt, NOW + 2);
  // choosing what is set changes nothing and stamps nothing
  assert.equal(chooseWords(state, 'chess', NOW + MIN_MS), false);
  assert.equal(state.settings.wordsAt, NOW + 2);
  // anything that is not a mode is Chess words
  assert.equal(chooseWords(state, 'plain', NOW + MIN_MS), false);
  assert.equal(wordsOf(state), 'chess');
});

test('applying a merged section brings the device to it; one it already holds changes nothing', () => {
  const state = defaultState(NOW);
  const section = { words: { v: 'finance', at: NOW } };
  assert.equal(prefsDiffer(state, section), true);
  assert.equal(applyPrefs(state, section), true);
  assert.equal(state.settings.words, 'finance');
  assert.equal(state.settings.wordsAt, NOW);
  assert.equal(prefsDiffer(state, section), false);
  assert.equal(applyPrefs(state, section), false);
  assert.equal(applyPrefs(state, {}), false);
  assert.equal(applyPrefs(state, undefined), false);
});

/* ------------------------------------------------------------------ the shared file */

test('the shared file carries the choice, merges it and applies it', () => {
  const a = defaultState(NOW);
  const b = defaultState(NOW);
  assert.equal(exportShared(a, NOW).prefs, undefined, 'no section before a choice');
  chooseWords(a, 'finance', NOW);
  const fromA = exportShared(a, NOW);
  assert.deepEqual(fromA.prefs, { words: { v: 'finance', at: NOW } });
  const merged = mergeShared(exportShared(b, NOW), fromA);
  assert.deepEqual(merged.prefs, fromA.prefs);
  assert.equal(applyShared(b, merged, NOW).changed, true);
  assert.equal(wordsOf(b), 'finance');
  assert.equal(b.settings.wordsAt, NOW);
  assert.equal(applyShared(b, merged, NOW).changed, false, 'nothing more to do');
  // B chooses again later: its stamp wins wherever the two meet
  chooseWords(b, 'chess', NOW + MIN_MS);
  const back = mergeShared(exportShared(a, NOW), exportShared(b, NOW));
  assert.deepEqual(back.prefs, { words: { v: 'chess', at: NOW + MIN_MS } });
  applyShared(a, back, NOW);
  assert.equal(wordsOf(a), 'chess');
});

/** A transport that holds one file in memory. */
function memory() {
  const t = { text: null, sha: null, writes: 0 };
  t.read = async () => ({ text: t.text, sha: t.sha });
  t.write = async (body) => { t.writes += 1; t.text = body; t.sha = 's' + t.writes; return {}; };
  return t;
}

function device(state) {
  return { state: () => state, stale: () => false, update: (now) => { now(state); } };
}

test('a round carries the choice from one device to the others, and the later choice wins', async () => {
  const repo = memory();
  const mac = defaultState(NOW);
  const phone = defaultState(NOW);
  const tablet = defaultState(NOW);
  chooseWords(mac, 'finance', NOW);
  await roundShared(device(mac), repo, () => NOW);
  assert.deepEqual(JSON.parse(repo.text).prefs, { words: { v: 'finance', at: NOW } });
  await roundShared(device(phone), repo, () => NOW + MIN_MS);
  await roundShared(device(tablet), repo, () => NOW + 2 * MIN_MS);
  assert.equal(wordsOf(phone), 'finance');
  assert.equal(wordsOf(tablet), 'finance');
  // the phone's clock runs 5 minutes behind; its later choice still wins (2 above the stamp it saw)
  chooseWords(phone, 'chess', NOW - 5 * MIN_MS);
  assert.equal(phone.settings.wordsAt, NOW + 2);
  await roundShared(device(phone), repo, () => NOW - 5 * MIN_MS);
  for (const [name, one] of [['mac', mac], ['tablet', tablet]]) {
    await roundShared(device(one), repo, () => NOW + 3 * MIN_MS);
    assert.equal(wordsOf(one), 'chess', name);
    assert.equal(one.settings.wordsAt, NOW + 2, name);
  }
  // all agree: a further round writes nothing
  const writes = repo.writes;
  await roundShared(device(mac), repo, () => NOW + 4 * MIN_MS);
  assert.equal(repo.writes, writes);
});

test('the section says nothing the bank reported: a value and a stamp only', () => {
  const state = defaultState(NOW);
  chooseWords(state, 'finance', NOW);
  const text = JSON.stringify(exportShared(state, NOW).prefs);
  assert.equal(text, '{"words":{"v":"finance","at":' + NOW + '}}');
});

test('a words value this version does not know is carried and merged, never applied, and never refuses the file', async () => {
  // a later version might add a mode: the section and the file are read, the value travels as it is
  assert.deepEqual(readPrefs({ words: { v: 'plain', at: 5 } }), { words: { v: 'plain', at: 5 } });
  assert.deepEqual(readSharedFile(file({ words: { v: 'plain', at: 5 } })).prefs, { words: { v: 'plain', at: 5 } });
  assert.deepEqual(mergePrefs({ words: { v: 'plain', at: 9 } }, { words: { v: 'finance', at: 5 } }), { words: { v: 'plain', at: 9 } });
  assert.deepEqual(mergePrefs({ words: { v: 'plain', at: 5 } }, { words: { v: 'finance', at: 9 } }), { words: { v: 'finance', at: 9 } });
  // the device keeps its words and its stamp
  const state = defaultState(NOW);
  chooseWords(state, 'finance', NOW);
  assert.equal(prefsDiffer(state, { words: { v: 'plain', at: NOW + 5 } }), false);
  assert.equal(applyPrefs(state, { words: { v: 'plain', at: NOW + 5 } }), false);
  assert.equal(state.settings.words, 'finance');
  assert.equal(state.settings.wordsAt, NOW);
  // through a round: the file is not refused, the later unknown value stays in it, the device keeps its words,
  // and the file then goes quiet: the next rounds write nothing and change nothing
  const repo = memory();
  repo.text = file({ words: { v: 'plain', at: NOW + 5 } });
  repo.sha = 's0';
  const res = await roundShared(device(state), repo, () => NOW + MIN_MS);
  assert.ok(res && !res.error, 'the round runs');
  assert.equal(wordsOf(state), 'finance');
  assert.equal(state.settings.wordsAt, NOW);
  const after = repo.text;
  assert.deepEqual(JSON.parse(after).prefs, { words: { v: 'plain', at: NOW + 5 } });
  const writes = repo.writes;
  for (let i = 2; i < 5; i++) {
    const again = await roundShared(device(state), repo, () => NOW + i * MIN_MS);
    assert.ok(!again.changed, 'round ' + i + ' changes nothing');
  }
  assert.equal(repo.writes, writes, 'nothing more is written');
  assert.equal(repo.text, after);
  assert.equal(wordsOf(state), 'finance');
  // a later choice on this device wins the field back, and every device of this version applies it
  chooseWords(state, 'chess', NOW + 10 * MIN_MS);
  await roundShared(device(state), repo, () => NOW + 10 * MIN_MS);
  assert.deepEqual(JSON.parse(repo.text).prefs, { words: { v: 'chess', at: NOW + 10 * MIN_MS } });
});


test('a choice made after the device saw a later unknown value travels, even when its clock is behind that stamp', async () => {
  const repo = memory();
  const mac = defaultState(NOW);
  const phone = defaultState(NOW);
  chooseWords(mac, 'chess', NOW);
  chooseWords(mac, 'finance', NOW + 1000);
  await roundShared(device(mac), repo, () => NOW + 2000);
  await roundShared(device(phone), repo, () => NOW + 3000);
  assert.equal(wordsOf(phone), 'finance');
  // a later version on another device writes a value this one does not know, stamped well ahead of this clock
  const ahead = NOW + 500 * 1000;
  const f = JSON.parse(repo.text);
  f.prefs = { words: { v: 'plain', at: ahead } };
  repo.text = JSON.stringify(f);
  repo.sha = 'other';
  await roundShared(device(mac), repo, () => NOW + 4000);
  assert.equal(wordsOf(mac), 'finance', 'the device keeps its words');
  assert.equal(mac.settings.wordsAt, NOW + 1000, 'and its stamp');
  assert.equal(mac.settings.wordsSeenAt, ahead, 'the stamp it saw is kept');
  // the clock is still behind that stamp: the choice is stamped 2 above what was seen, and travels
  chooseWords(mac, 'chess', NOW + 5000);
  assert.equal(mac.settings.wordsAt, ahead + 2);
  await roundShared(device(mac), repo, () => NOW + 6000);
  assert.deepEqual(JSON.parse(repo.text).prefs, { words: { v: 'chess', at: ahead + 2 } });
  await roundShared(device(phone), repo, () => NOW + 7000);
  assert.equal(wordsOf(phone), 'chess', 'the other device takes the new choice');
  assert.equal(phone.settings.wordsAt, ahead + 2);
  // and the file goes quiet: further rounds on either device write and change nothing
  const writes = repo.writes;
  const text = repo.text;
  for (let i = 0; i < 3; i++) {
    for (const one of [mac, phone]) {
      const again = await roundShared(device(one), repo, () => NOW + 8000 + i * 1000);
      assert.ok(!again.changed, 'round ' + i + ' changes nothing');
    }
  }
  assert.equal(repo.writes, writes, 'nothing more is written');
  assert.equal(repo.text, text);
});

test('the stamp seen with an unknown value is noted once and never lowered', () => {
  const state = defaultState(NOW);
  chooseWords(state, 'finance', NOW);
  assert.equal(noteSeenPrefs(state, { words: { v: 'plain', at: NOW + 9 } }), true);
  assert.equal(state.settings.wordsSeenAt, NOW + 9);
  assert.equal(noteSeenPrefs(state, { words: { v: 'plain', at: NOW + 9 } }), false, 'once');
  assert.equal(noteSeenPrefs(state, { words: { v: 'plain', at: NOW + 3 } }), false, 'never lowered');
  assert.equal(state.settings.wordsSeenAt, NOW + 9);
  // a known value is applied, not noted; nothing in the section notes nothing
  assert.equal(noteSeenPrefs(state, { words: { v: 'chess', at: NOW + 20 } }), false);
  assert.equal(noteSeenPrefs(state, {}), false);
  assert.equal(state.settings.words, 'finance');
  assert.equal(state.settings.wordsAt, NOW);
  // a fresh record carries no seen stamp, so a saved copy is unchanged until one is seen
  assert.equal(Object.hasOwn(defaultState(NOW).settings, 'wordsSeenAt'), false);
});
