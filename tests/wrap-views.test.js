/**
 * The nightly wrap in the interface (ARCHITECTURE 3.10): Settings → Nightly wrap in each of its states and the day
 * sheet's Money in and out, in both word modes, rendered under node from the sample record (tests/helpers/render-wrap.mjs,
 * each in a process of its own). Every owner and key here is invented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELPER = fileURLToPath(new URL('./helpers/render-wrap.mjs', import.meta.url));
const cache = new Map();
function render(words, state, ...more) {
  const key = [words, state, ...more].join(' ');
  if (!cache.has(key)) cache.set(key, JSON.parse(execFileSync(process.execPath, [HELPER, words, state, ...more], { encoding: 'utf8' })));
  return cache.get(key);
}
const flat = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, '’').replace(/\s+/g, ' ');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, '’').replace(/\s+/g, ' ');
const section = (html) => {
  const at = html.indexOf('aria-label="Nightly wrap"');
  assert.ok(at > 0, 'the section is there');
  return html.slice(at, html.indexOf('</div>\n  </div>', at) > 0 ? undefined : undefined);
};

for (const words of ['chess', 'finance']) {
  test('Settings → Nightly wrap, ' + words + ' words: no night key yet offers to make one', () => {
    const { settings } = render(words, 'nokey');
    assert.ok(!settings.startsWith('ERROR'), settings);
    const t = text(section(settings));
    assert.match(t, /Nightly wrap/);
    assert.match(settings, /data-action="settings\.wrap-key"[^>]*>Make the night key</);
    assert.match(t, /VAPID_PRIVATE_KEY/);
    assert.match(t, words === 'chess' ? /the round’s money in and out/ : /the day’s money in and out/);
  });

  test('Settings → Nightly wrap, ' + words + ' words: the key just made is shown once, with Copy, the secret page and the name to type', () => {
    const { settings } = render(words, 'made');
    assert.match(settings, /data-action="settings\.wrap-copy"[^>]*>Copy private key</);
    assert.ok(settings.includes('k'.repeat(43)), 'the private key, shown once');
    assert.match(settings, /href="https:\/\/github\.com\/example-owner\/networth-data\/settings\/secrets\/actions\/new"[^>]*target="_blank"/);
    assert.match(text(settings), /Open GitHub’s secret page/);
    assert.match(settings, /<code[^>]*>VAPID_PRIVATE_KEY<\/code>/);
    assert.match(settings, /data-action="settings\.wrap-done"/);
  });

  test('Settings → Nightly wrap, ' + words + ' words: a key that exists says when it was made and warns before a new one', () => {
    const { settings } = render(words, 'key');
    const t = text(settings);
    assert.match(t, /Night key made/);
    assert.match(settings, /data-action="settings\.ask" data-what="wrap-key"/);
    assert.ok(!/data-action="settings\.wrap-on"/.test(settings), 'Turn on only in the installed app');
    assert.match(t, /installed app/);
  });

  test('Settings → Nightly wrap, ' + words + ' words: in the installed app, Turn on; when on, Turn off, the lock screen and the last wrap', () => {
    assert.match(render(words, 'standalone').settings, /data-action="settings\.wrap-on"[^>]*>Turn on the nightly wrap</);
    const { settings } = render(words, 'on');
    const t = text(settings);
    assert.match(settings, /data-action="settings\.wrap-off"/);
    assert.match(settings, /name="wrapLock"/);
    for (const label of ['Follow cover', 'Show', 'Hide']) assert.match(t, new RegExp(label));
    assert.match(settings, /name="wrapLock" value="show"[^>]*checked/);
    assert.match(t, words === 'chess' ? /Last wrap: Round 17, sent/ : /Last wrap: Day 17, sent/);
  });

  test('Settings → Nightly wrap, ' + words + ' words: turned off by the push service, a key that does not match, a lost subscription', () => {
    const dead = render(words, 'dead').settings;
    assert.match(text(dead), /turned off by the push service/i);
    assert.match(dead, /data-action="settings\.wrap-on"[^>]*>Turn back on</);
    assert.match(text(render(words, 'keyproblem').settings), /is not the one your repository publishes/);
    assert.match(render(words, 'gone').settings, /data-action="settings\.wrap-on"[^>]*>Turn back on</);
    assert.match(text(render(words, 'problem').settings), /429/);
    assert.match(text(render(words, 'nokey', 'share=off').settings), /Start sharing/);
    assert.match(text(render(words, 'reading').settings), /Reading the night key/);
    assert.match(text(render(words, 'failed').settings), /could not be read/);
  });

  test('the day sheet, ' + words + ' words: Money in and out, what counted, what did not and why, and what may be missing', () => {
    const { days } = render(words, 'nokey');
    const [today, yesterday, older, ahead] = Object.keys(days);
    for (const day of [today, yesterday, older]) {
      assert.ok(!days[day].startsWith('ERROR'), days[day]);
      assert.match(days[day], /<p class="lab"><b>Money in and out<\/b><\/p>/, day);
    }
    assert.ok(!/Money in and out/.test(days[ahead]), 'a day ahead has none');
    const t = text(days[today]);
    assert.match(t, /So far: spending on checking and debit/);
    assert.match(t, words === 'chess' ? /until the round ends/ : /until the day ends/);
    assert.match(text(days[yesterday]), words === 'chess' ? /In pencil: the bank may still/ : /Provisional: the bank may still/);
    const all = Object.values(days).map(text).join(' ');
    assert.match(all, /Counted/);
  });
}

test('Settings → Nightly wrap says what the files hold: totals, ids and the amounts a late item could match, no names', () => {
  for (const words of ['chess', 'finance']) {
    const t = text(render(words, 'key').settings.split('aria-label="What the wrap holds"')[1]);
    assert.match(t, /money in and out per (round|day)/);
    assert.match(t, /the amounts and days of recent bank rows, so that a late card alert or payment is not counted twice/);
    assert.match(t, /No merchant, account or balance/);
  }
});

test('the Nightly wrap section and the day sheet block say nothing of the other mode in Finance words', () => {
  const pencil = /\bpencil\b|\bink\b|\brounds?\b|\bmoves?\b|\bgame\b|\bboard\b/i;
  for (const state of ['nokey', 'made', 'key', 'on', 'dead', 'keyproblem']) {
    const t = text(section(render('finance', state).settings).split('aria-label="What the wrap holds"')[0]);
    assert.ok(!pencil.test(t.replace(/Nightly wrap/g, '')), state + ': ' + t.match(pencil));
  }
});

/* ----------------------------------------------------------------------------------- part 2: the fix round */

const FLOW = fileURLToPath(new URL('./helpers/wrap-flow.mjs', import.meta.url));
const flow = (words, which) => JSON.parse(execFileSync(process.execPath, [FLOW, words, which], { encoding: 'utf8' }));
const head = (html) => /aria-label="Nightly wrap">\s*<div class="sec-head">[\s\S]*?<span class="lab">([^<]*)<\/span>/.exec(html)[1];

for (const words of ['chess', 'finance']) {
  test('Settings → Nightly wrap, ' + words + ' words: Make a new night key opens its warning, makes the key and shows it once', () => {
    const f = flow(words, 'newkey');
    assert.equal(f.error, undefined, f.error);
    assert.equal(f.asked, 'wrap-key', 'the confirmation opens');
    const warn = text(f.confirm);
    assert.match(warn, /every device must then turn the wrap on again/);
    assert.match(f.confirm, /data-action="settings\.wrap-key"[^>]*>Make a new key</);
    assert.match(f.confirm, /data-action="settings\.cancel"[^>]*>Cancel</);
    assert.equal(f.closed, null, 'the confirmation closes as the key is made');
    assert.notEqual(f.publicKey, f.oldKey, 'push/vapid.json holds the new public key');
    assert.deepEqual(f.vapidFields, ['format', 'madeAt', 'publicKey'], 'and nothing else');
    assert.equal(f.signs, true, 'the private key shown signs for the published key');
    assert.ok(f.made.includes(f.privateKey), 'the private key is shown once');
    assert.equal(f.unsubscribed, true, 'this device’s old subscription is ended');
    assert.ok(!f.done.includes(f.privateKey), 'gone after Done');
    assert.match(f.done, /data-action="settings\.wrap-on"[^>]*>Turn back on</, 'this device turns the wrap on again');
    assert.match(text(f.confirm), /is not the one your repository publishes/, 'before: the last run’s key problem');
    assert.ok(!/is not the one your repository publishes/.test(text(f.done)), 'after: that problem was about the key just replaced');
    assert.equal(f.stored, false, 'the private key is in no storage');
    assert.ok(!f.requests.some((r) => r.includes(f.privateKey)), 'and in no request');
  });

  test('Settings → Nightly wrap, ' + words + ' words: turned off by the owner after the push service turned it off says Off', () => {
    const f = flow(words, 'offdead');
    assert.equal(f.error, undefined, f.error);
    assert.equal(head(f.dead), 'Turned off');
    assert.match(text(f.dead), /turned off by the push service/);
    assert.equal(head(f.on), 'On');
    assert.equal(head(f.off), 'Off');
    assert.ok(!/push service/.test(text(section(f.off))), text(section(f.off)));
    assert.match(f.off, /data-action="settings\.wrap-on"[^>]*>Turn on the nightly wrap</);
    assert.equal(f.pushFile, false, 'push/<device>.json removed');
  });

  test('Settings → Nightly wrap, ' + words + ' words: a key that does not match says what is true on any device, and the step it can take', () => {
    for (const state of ['keyproblem', 'keytab']) {
      const t = text(render(words, state).settings);
      assert.match(t, /The night key GitHub holds \(VAPID_PRIVATE_KEY\) is not the one your repository publishes, so the last run sent nothing\./, state);
      assert.match(t, /Make a new night key below, and paste it into GitHub\./, state);
      assert.ok(!/made here|Paste the key again/.test(t), state);
      assert.match(render(words, state).settings, /data-action="settings\.ask" data-what="wrap-key"/, state + ': the step is there');
    }
  });

  test('Settings → Nightly wrap, ' + words + ' words: no secret on GitHub names VAPID_PRIVATE_KEY and the page to check', () => {
    const { settings } = render(words, 'nosecret');
    const t = text(settings);
    assert.match(t, /The last run found no secret named VAPID_PRIVATE_KEY on GitHub, so it sent nothing\./);
    assert.match(t, /check that its name is exactly VAPID_PRIVATE_KEY/);
    assert.match(settings, /href="https:\/\/github\.com\/example-owner\/networth-data\/settings\/secrets\/actions"[^>]*target="_blank"/);
    assert.match(t, /make a new night key below/);
  });

  test('Settings → Nightly wrap, ' + words + ' words: turned off by the push service says the one tap once', () => {
    const t = text(section(render(words, 'dead').settings).split('aria-label="What the wrap holds"')[0]);
    assert.equal(t.match(/1 tap/g).length, 1, t);
    assert.match(t, /turned off by the push service/);
  });

  test('Settings → Nightly wrap, ' + words + ' words: the private key is said to go when Done is tapped or the app is closed', () => {
    const t = text(render(words, 'made').settings);
    assert.match(t, /Networth keeps no copy of it: once you tap Done, or close the app, it is gone from this device\./);
    assert.ok(!/leave the app/.test(t));
  });

  test('Settings, ' + words + ' words: the sharing text and the wrap section say the same of what the wrap files hold', () => {
    const { settings } = render(words, 'key');
    const holds = text(settings.split('aria-label="What the wrap holds"')[1]);
    const sharing = text(settings.split('aria-label="Nightly wrap"')[0]);
    for (const t of [holds, sharing]) {
      assert.match(t, words === 'chess' ? /round’s money in and out|money in and out per round/ : /day’s money in and out|money in and out per day/);
      assert.match(t, /the amounts and days of recent bank rows/);
    }
    assert.match(sharing, /no balance, no merchant, no account/);
    assert.match(holds, /No merchant, account or balance/);
    assert.ok(!/no transaction|daily totals/.test(sharing), 'nothing the wrap files contradict');
  });
}

for (const words of ['chess', 'finance']) {
  test('Settings → Nightly wrap, ' + words + ' words: a new key that replaces one goes to the existing secret, a first key to a new one', () => {
    const first = render(words, 'made').settings;
    assert.match(first, /href="https:\/\/github\.com\/example-owner\/networth-data\/settings\/secrets\/actions\/new"/);
    assert.match(flat(first), /Click Name and type VAPID_PRIVATE_KEY\. Click Secret, paste, then Add secret\./);
    const steps = (html) => html.slice(html.indexOf('set-wrap-steps'), html.indexOf('</ol>', html.indexOf('set-wrap-steps')));
    assert.ok(!/Update secret|pencil/.test(text(steps(first))));
    const again = render(words, 'replace').settings;
    assert.match(again, /href="https:\/\/github\.com\/example-owner\/networth-data\/settings\/secrets\/actions"[^>]*target="_blank"/);
    assert.ok(!/secrets\/actions\/new/.test(again), 'not the page for a secret that does not exist yet');
    assert.match(flat(again), /Click VAPID_PRIVATE_KEY’s pencil, paste into Value, then Update secret\./);
    assert.ok(!/Add secret|Name and type/.test(text(steps(again))));
    assert.ok(again.includes('k'.repeat(43)), 'the new private key, shown once');
    // a new key made before any run has checked the current one: GitHub may or may not hold the secret, so both ways
    const unknown = render(words, 'replaceunknown').settings;
    assert.match(unknown, /href="https:\/\/github\.com\/example-owner\/networth-data\/settings\/secrets\/actions"[^>]*target="_blank"/);
    assert.ok(!/secrets\/actions\/new/.test(unknown));
    assert.match(flat(unknown), /If VAPID_PRIVATE_KEY is listed, click its pencil, paste into Value, then Update secret\. If it is not, click New repository secret, type VAPID_PRIVATE_KEY as Name, paste into Secret, then Add secret\./);
  });

  test('Settings → Nightly wrap, ' + words + ' words: the backup run is promised only for a busy push service on the night’s first run', () => {
    const t = (state) => text(section(render(words, state).settings).split('aria-label="What the wrap holds"')[0]);
    assert.match(t('problem'), /The backup run tries again\./);
    assert.match(t('problem'), /429/);
    const late = t('problemlate');
    assert.ok(!/backup run/.test(late), late);
    assert.match(late, /The next wrap tries again\./);
    for (const state of ['refused', 'pushfile', 'subfail', 'oddtoken']) assert.ok(!/backup run tries again/.test(t(state)), state);
    // an earlier night's first run: its backup has passed, so no promise of it
    const prev = t('problemprev');
    assert.ok(!/backup run/.test(prev), prev);
    assert.match(prev, /The next wrap tries again\./);
  });

  test('Settings → Nightly wrap, ' + words + ' words: a refusal says the wrap cannot reach this device, and offers Turn back on', () => {
    const { settings } = render(words, 'refused');
    const t = text(section(settings).split('aria-label="What the wrap holds"')[0]);
    assert.match(t, /The wrap cannot reach this device/);
    assert.match(t, /403/);
    assert.match(settings, /data-action="settings\.wrap-on"[^>]*>Turn back on</);
    assert.ok(!/data-action="settings\.wrap-off"/.test(settings));
  });

  test('Settings → Nightly wrap, ' + words + ' words: a push file that could not be used says so, and never prints a raw token', () => {
    for (const state of ['pushfile', 'subfail', 'oddtoken']) {
      const t = text(section(render(words, state).settings).split('aria-label="What the wrap holds"')[0]);
      assert.ok(!/answered (file|subscription|weird-token)|\bfile\.|\bsubscription\.|weird-token/.test(t), state + ': ' + t);
      if (state !== 'oddtoken') {
        assert.match(t, /this device’s push file could not be used/, state);
        assert.match(t, /turn the wrap off and on again here/, state);
      } else assert.match(t, /The last wrap did not reach this device/);
    }
  });

  test('Settings → Nightly wrap, ' + words + ' words: the missing secret is the last run’s finding, with when the next run checks', () => {
    const t = (state) => text(section(render(words, state).settings).split('aria-label="What the wrap holds"')[0]);
    const late = t('nosecret');
    assert.match(late, /The last run found no secret named VAPID_PRIVATE_KEY on GitHub, so it sent nothing\./);
    assert.ok(!/GitHub holds no secret/.test(late));
    assert.match(late, /The next run checks again at 9:33 PM\./);
    assert.match(t('nosecretfirst'), /The next run checks again at 10:13 PM\./);
    assert.match(t('nosecretstale'), /The next run checks again at 9:33 PM\./, 'a first run of an earlier night: tonight’s comes first');
  });
}
