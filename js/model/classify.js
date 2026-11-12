/**
 * Merchant clean-up and classification. See ARCHITECTURE.md section 3.3.
 * Pure. Built-in rules live in rules-data.js (data only).
 *
 * How a row is read
 *  - The description is lower-cased ("light" text) and then stripped of statement noise
 *    ("normalised" text). A built-in rule matches when its pattern is found in either, so rules
 *    may rely on a processor prefix that normalising removes. `payee` and `memo` are consulted
 *    only when the description matches no rule.
 *  - Who the counterparty is (merchant, mkey) never depends on the direction of the money or on
 *    the account, so `classify(...).mkey` always equals `merchantOf(...).mkey` for the same text.
 *  - Bank text is untrusted: it is only ever searched with fixed patterns, never evaluated, and
 *    never turned into a pattern.
 */

import { ACCOUNT_TYPES, CATEGORIES, FLOW_CATEGORIES, KLASSES, PURPOSES, isLive, klassOf, newId } from './schema.js';
import { addDays, isYmd } from './dates.js';
import { roundCents } from './money.js';
import {
  ACCOUNT_TYPE_HINTS, ACRONYMS, MCC, MCC_RANGES, MERCHANT_RULES, NOISE, PENALTY_RE, REFUND_RE,
  STATE_TAIL_RE, STRUCTURED, TAIL_NOISE,
} from './rules-data.js';

/**
 * @typedef {Object} ClassifyInput
 * @property {string} description     the bank's description (untrusted)
 * @property {string} [payee]
 * @property {string} [memo]
 * @property {string|null} [mcc]
 * @property {number} amount          cents > 0
 * @property {'in'|'out'} flow        relative to the account
 * @property {string} accountType     key of schema.ACCOUNT_TYPES
 */

/**
 * @typedef {Object} Classification
 * @property {'spend'|'income'|'transfer'|'payment'|'refund'} kind
 * @property {string} category        key of schema.CATEGORIES, or 'income' | 'transfer' | 'card_payment'
 * @property {'game'|'need'|'want'|'book'|'oneoff'} klass
 * @property {string} purpose         one of schema.PURPOSES
 * @property {string} merchant        display name ("Dunkin'")
 * @property {string} mkey            normalised merchant key ("dunkin")
 * @property {boolean} review         true when the result is a guess the owner may want to look at
 * @property {string|null} ruleId     id of the rule that matched ('learned:…', 'builtin:…', 'mcc:5814', or null)
 * @property {string|null} glyph      '??' for avoidable penalties (late / over-limit / overdraft fees), else null
 */

/** Longest description read; anything longer is cut (keeps every pattern search fast on hostile input). */
const MAX_TEXT = 300;
const MAX_NAME = 48;
const MAX_KEY = 40;
/** A refund is recognised by a spend at the same merchant at most this many days earlier. */
const REFUND_WINDOW_DAYS = 60;
const CACHE_LIMIT = 4000;
const LEARNED_PREFIX = 'learned:';
const UNKNOWN_MERCHANT = 'Unknown';
/**
 * The only kinds of guess worth the owner's attention: a marketplace order that could be anything, a
 * payment the text does not explain, a deposit or transfer that may not be what it looks like. A pharmacy,
 * a utility or a tank of fuel is filed where its rule says and never queued for review.
 */
const REVIEW_CATEGORIES = new Set(['shopping', 'other', 'income', 'transfer']);
const LOCKABLE = ['category', 'klass', 'purpose', 'merchant'];
/** In `locks`: the owner confirmed the move as classified, so re-reading never queues it again. */
const REVIEW_LOCK = 'review';
/** The category a penalty ('??') is filed under. */
const PENALTY_CATEGORY = 'fees_interest';

/* ----------------------------------------------------------- compiled patterns */

/** A pattern that fails to compile is dropped: one bad entry can never stop classification. */
function compile(source, flags = 'i') {
  if (typeof source !== 'string' || !source) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function compileAll(sources, flags) {
  return (Array.isArray(sources) ? sources : []).map((source) => compile(source, flags)).filter(Boolean);
}

function isCategory(key) {
  return typeof key === 'string' && (Object.hasOwn(CATEGORIES, key) || Object.hasOwn(FLOW_CATEGORIES, key));
}

function isSpendCategory(key) {
  return typeof key === 'string' && Object.hasOwn(CATEGORIES, key);
}

function isFlowCategory(key) {
  return typeof key === 'string' && Object.hasOwn(FLOW_CATEGORIES, key);
}

function isKlass(key) {
  return typeof key === 'string' && Object.hasOwn(KLASSES, key);
}

function isPurpose(key) {
  return PURPOSES.includes(key);
}

function compileRule(rule) {
  if (!rule || typeof rule.id !== 'string' || !isCategory(rule.category)) return null;
  const test = compile(rule.re);
  if (!test) return null;
  return {
    id: rule.id,
    test,
    category: rule.category,
    klass: isKlass(rule.klass) ? rule.klass : klassOf(rule.category),
    purpose: isPurpose(rule.purpose) ? rule.purpose : 'personal',
    merchant: typeof rule.merchant === 'string' && rule.merchant ? rule.merchant : null,
    review: !!rule.review && REVIEW_CATEGORIES.has(rule.category),
    glyph: rule.glyph === '??' ? '??' : null,
    flow: rule.flow === 'in' || rule.flow === 'out' ? rule.flow : null,
    cardOnly: rule.side === 'card',
  };
}

const RULES = MERCHANT_RULES.map(compileRule).filter(Boolean);
const NOISE_RES = compileAll(NOISE, 'gi');
const TAIL_RES = (Array.isArray(TAIL_NOISE) ? TAIL_NOISE : [])
  .map((source) => ({ re: compile(source), isState: source === STATE_TAIL_RE }))
  .filter((tail) => tail.re);
const STRUCTURED_RES = STRUCTURED
  .map((entry) => ({ re: compile(entry && entry.re), to: entry && typeof entry.to === 'string' ? entry.to : ' ' }))
  .filter((entry) => entry.re);
const REFUND = compile(REFUND_RE);
const PENALTY = compile(PENALTY_RE);
const ACRONYM_SET = new Set(ACRONYMS);
const ACCOUNT_HINTS = ACCOUNT_TYPE_HINTS
  .map(([type, source]) => ({ type, re: compile(source) }))
  .filter((hint) => hint.re && Object.hasOwn(ACCOUNT_TYPES, hint.type));

function matches(re, source) {
  return !!re && (re.test(source.norm) || re.test(source.light));
}

/* ------------------------------------------------------------- text clean-up */

function squeeze(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** Lower-case, decode the entities banks leave in exports, flatten whitespace, cap the length. */
function lightClean(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  const text = raw.slice(0, MAX_TEXT * 2).normalize('NFKC').toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;|[’‘`]/g, "'")
    .replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return squeeze(text).slice(0, MAX_TEXT).replace(/[\ud800-\udbff]$/, '').trim();
}

function trimPunctuation(text) {
  return text.replace(/^[\s\-–,.:;/]+|[\s\-–,.:;/&]+$/g, '');
}

function wordCount(text) {
  return text ? text.split(' ').length : 0;
}

/**
 * Country, state, locality and legal suffix, peeled off the end in that order. A two-letter state is
 * only trusted when the bank's text had at least three words: "DELI NY" keeps both.
 */
function stripTails(text, mayStripState) {
  let out = trimPunctuation(text);
  for (const { re, isState } of TAIL_RES) {
    if (!isState || mayStripState) out = trimPunctuation(out.replace(re, ''));
  }
  return out;
}

function stripNoise(light) {
  let text = light;
  for (const { re, to } of STRUCTURED_RES) text = text.replace(re, to);
  for (const re of NOISE_RES) text = squeeze(text.replace(re, ' '));
  return stripTails(text, wordCount(light) >= 3);
}

/**
 * Lower-case a bank description and strip statement noise: processor prefixes (SQ *, TST*,
 * PAYPAL *, POS DEBIT, DEBIT CARD PURCHASE…), store numbers, phone numbers, dates, card
 * suffixes, city/state tails, repeated spaces.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeDescription(raw) {
  return stripNoise(lightClean(raw));
}

function clipWords(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\ud800-\udbff]$/, '').trim();
}

/** "86 gourmet deli" -> "86 Gourmet Deli"; known acronyms in capitals; a domain's ".com" left alone. */
function displayName(text) {
  const clipped = clipWords(text, MAX_NAME);
  return clipped.replace(/[\p{L}\p{N}]+(?:'\p{L}+)?/gu, (word, offset) => {
    if (ACRONYM_SET.has(word)) return word.toUpperCase();
    if (offset > 0 && clipped[offset - 1] === '.') return word;
    return word[0].toUpperCase() + word.slice(1);
  });
}

/** Lower-case letters (accents removed), digits and single spaces, at most 40 characters. */
function keyOf(name) {
  return name.normalize('NFKD').toLowerCase()
    .replace(/['’`]|\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim().slice(0, MAX_KEY).replace(/[\ud800-\udbff]$/, '').trim();
}

/** The owner's own name for a merchant, made safe to store: one line, bounded, or '' when unusable. */
function cleanName(value) {
  if (typeof value !== 'string') return '';
  return clipWords(squeeze(value.replace(/[\u0000-\u001f\u007f]+/g, ' ')), MAX_NAME);
}

/* ------------------------------------------------------------ rule matching */

const EMPTY_SOURCE = { light: '', norm: '', first: -1, named: -1 };
const sourceCache = new Map();

function nextRuleIndex(source, from, applies) {
  for (let i = from; i < RULES.length; i++) {
    if (applies && !applies(RULES[i])) continue;
    if (matches(RULES[i].test, source)) return i;
  }
  return -1;
}

function namesAnyAccount(rule) {
  return !rule.cardOnly;
}

/**
 * The cleaned forms of one bank string, the first built-in rule it matches (`first`) and the first
 * one that may name it (`named`: wording that only means something on a card never names a merchant).
 * Memoised: descriptors repeat.
 */
function sourceOf(raw) {
  const light = lightClean(raw);
  if (!light) return EMPTY_SOURCE;
  const cached = sourceCache.get(light);
  if (cached) return cached;
  const source = { light, norm: stripNoise(light), first: -1, named: -1 };
  source.first = nextRuleIndex(source, 0, null);
  source.named = source.first >= 0 && !namesAnyAccount(RULES[source.first]) ? nextRuleIndex(source, source.first + 1, namesAnyAccount) : source.first;
  if (sourceCache.size >= CACHE_LIMIT) sourceCache.clear();
  sourceCache.set(light, source);
  return source;
}

/**
 * Who a row is with. The description decides; payee and memo are read only when the description
 * matches no rule. Independent of flow and account so that the key is stable for a merchant.
 */
function identify(parts) {
  const fields = parts && typeof parts === 'object' ? parts : { description: parts };
  const sources = [fields.description, fields.payee, fields.memo].map(sourceOf).filter((source) => source.light);
  const source = sources.find((s) => s.first >= 0) || sources.find((s) => s.norm) || sources[0] || EMPTY_SOURCE;
  const rule = source.named >= 0 ? RULES[source.named] : null;
  const name = rule && rule.merchant ? rule.merchant : displayName(source.norm || source.light);
  const mkey = keyOf(name);
  return { source, merchant: mkey ? name : UNKNOWN_MERCHANT, mkey };
}

/**
 * A display name and a stable grouping key for a transaction's counterparty.
 * Known chains get their proper name ("DUNKIN #345123 NEW YORK NY" -> { merchant: "Dunkin'", mkey: "dunkin" });
 * anything else is title-cased from the cleaned description. The key is lower-case letters,
 * digits and single spaces only, at most 40 characters, and is the same for every store of a chain.
 * Text with nothing usable in it gives { merchant: 'Unknown', mkey: '' }.
 * @param {{ description: string, payee?: string, memo?: string }} parts
 * @returns {{ merchant: string, mkey: string }}
 */
export function merchantOf(parts) {
  const { merchant, mkey } = identify(parts);
  return { merchant, mkey };
}

/* ------------------------------------------------------------ classification */

function accountGroupOf(accountType) {
  return typeof accountType === 'string' && Object.hasOwn(ACCOUNT_TYPES, accountType) ? ACCOUNT_TYPES[accountType].group : 'cash';
}

/** A purchase on a card or a draw on a loan is never a transfer, a payment or income, whatever its wording. */
function ruleApplies(rule, flow, group) {
  if (rule.flow && rule.flow !== flow) return false;
  if (rule.cardOnly && group !== 'card' && group !== 'debt') return false;
  if (flow === 'out' && isFlowCategory(rule.category)) return rule.category !== 'income' && group !== 'card' && group !== 'debt';
  return true;
}

function mccCategory(mcc) {
  const code = typeof mcc === 'number' ? String(mcc) : typeof mcc === 'string' ? mcc.trim() : '';
  if (!/^\d{4}$/.test(code)) return null;
  let category = Object.hasOwn(MCC, code) ? MCC[code] : null;
  if (!category) {
    const range = MCC_RANGES.find(([first, last]) => Number(code) >= first && Number(code) <= last);
    category = range ? range[2] : null;
  }
  return isSpendCategory(category) ? { category, code } : null;
}

/** The spend recorded earlier that this money-in row gives back: same merchant, at least as large. */
function findMirror(spends, mkey, amount) {
  if (!mkey || !Array.isArray(spends) || !(amount > 0)) return null;
  const candidates = spends.filter((s) => s && s.mkey === mkey && Number.isFinite(s.amount) && s.amount >= amount);
  return candidates.find((s) => s.amount === amount) || candidates[0] || null;
}

/**
 * What a purchase (or the refund of one) is: for a refund, whatever the spend it mirrors was filed
 * under (so the two net out); else the merchant rule when it names a category, else the merchant
 * category code, else "other" for the owner to review.
 */
function spendingProfile(rule, mirror, mcc) {
  const ruleId = rule ? 'builtin:' + rule.id : null;
  const purpose = rule ? rule.purpose : 'personal';
  if (mirror && isSpendCategory(mirror.category)) {
    return {
      category: mirror.category,
      klass: isKlass(mirror.klass) ? mirror.klass : klassOf(mirror.category),
      purpose: isPurpose(mirror.purpose) ? mirror.purpose : purpose,
      review: false,
      ruleId,
    };
  }
  if (rule && rule.category !== 'other') return { category: rule.category, klass: rule.klass, purpose, review: rule.review, ruleId };
  const coded = mccCategory(mcc);
  if (coded) return { category: coded.category, klass: klassOf(coded.category), purpose, review: false, ruleId: 'mcc:' + coded.code };
  return { category: 'other', klass: klassOf('other'), purpose, review: true, ruleId };
}

function flowResult(kind, category, rule, review) {
  return {
    kind, category, klass: klassOf(category),
    purpose: rule ? rule.purpose : 'personal',
    review,
    ruleId: rule ? 'builtin:' + rule.id : null,
  };
}

function isSpendRule(rule) {
  return !!rule && isSpendCategory(rule.category);
}

function classifyCashOut(rule, mcc) {
  if (rule && rule.category === 'card_payment') return flowResult('payment', 'card_payment', rule, rule.review);
  if (rule && rule.category === 'transfer') return flowResult('transfer', 'transfer', rule, rule.review);
  return { kind: 'spend', ...spendingProfile(rule, null, mcc) };
}

/**
 * Money into a cash account is income unless something says otherwise: transfer wording, refund
 * wording, a recent spend at the same merchant, or a named retailer (a shop does not pay its customers).
 */
function classifyCashIn(rule, mirror, mcc, source) {
  if (rule && rule.category === 'income') return flowResult('income', 'income', rule, rule.review);
  if (rule && rule.category === 'transfer') return flowResult('transfer', 'transfer', rule, rule.review);
  if (rule && rule.category === 'card_payment') return flowResult('transfer', 'transfer', rule, true);
  const namedRetailer = isSpendRule(rule) && !!rule.merchant;
  if (namedRetailer || mirror || matches(REFUND, source)) return { kind: 'refund', ...spendingProfile(rule, mirror, mcc) };
  return flowResult('income', 'income', rule, true);
}

function classifyCardIn(rule, mirror, mcc) {
  if (rule && (rule.category === 'card_payment' || rule.category === 'transfer')) return flowResult('payment', 'card_payment', rule, false);
  // a reward or interest credit lowers the balance without being a payment or earned income
  if (rule && rule.category === 'income') return flowResult('refund', 'other', rule, false);
  return { kind: 'refund', ...spendingProfile(rule, mirror, mcc) };
}

/** A loan: money in pays it down; money out is interest or a fee, else a draw (not spending). */
function classifyDebt(flow, rule) {
  if (flow === 'in') return flowResult('payment', 'card_payment', rule, false);
  if (rule && rule.category === 'fees_interest') return { kind: 'spend', ...spendingProfile(rule, null, null) };
  return flowResult('transfer', 'transfer', null, true);
}

/** An investment account: dividends and interest are income, fees are spending, the rest is money moving. */
function classifyAsset(flow, rule) {
  if (flow === 'in' && rule && rule.category === 'income') return flowResult('income', 'income', rule, rule.review);
  if (flow === 'out' && rule && rule.category === 'fees_interest') return { kind: 'spend', ...spendingProfile(rule, null, null) };
  return flowResult('transfer', 'transfer', null, false);
}

function classifyBuiltin(tx, id, mirror) {
  const { source } = id;
  const applies = (rule) => ruleApplies(rule, tx.flow, tx.group);
  let index = source.first;
  if (index >= 0 && !applies(RULES[index])) index = nextRuleIndex(source, index + 1, applies);
  const rule = index >= 0 ? RULES[index] : null;

  let result;
  if (tx.group === 'debt') result = classifyDebt(tx.flow, rule);
  else if (tx.group === 'asset') result = classifyAsset(tx.flow, rule);
  else if (tx.flow === 'out') result = tx.group === 'card' ? { kind: 'spend', ...spendingProfile(rule, null, tx.mcc) } : classifyCashOut(rule, tx.mcc);
  else result = tx.group === 'card' ? classifyCardIn(rule, mirror, tx.mcc) : classifyCashIn(rule, mirror, tx.mcc, source);

  const penalty = result.kind === 'spend' && result.category === 'fees_interest'
    && ((rule && rule.glyph === '??') || matches(PENALTY, source));
  return { ...result, merchant: id.merchant, mkey: id.mkey, glyph: penalty ? '??' : null };
}

/** The kind a category implies for money moving `flow`; null when the pair makes no sense (income going out). */
function kindFor(category, flow) {
  if (category === 'transfer') return 'transfer';
  if (category === 'card_payment') return 'payment';
  if (category === 'income') return flow === 'in' ? 'income' : null;
  if (isSpendCategory(category)) return flow === 'in' ? 'refund' : 'spend';
  return null;
}

/** The category a kind allows, keeping `category` when it already fits. */
function categoryFor(kind, category) {
  if (kind === 'transfer') return 'transfer';
  if (kind === 'payment') return 'card_payment';
  if (kind === 'income') return 'income';
  return isSpendCategory(category) ? category : 'other';
}

function usableCategory(category, flow) {
  return isCategory(category) && kindFor(category, flow) ? category : null;
}

function hasUsableField(rule) {
  return isCategory(rule.category) || isKlass(rule.klass) || isPurpose(rule.purpose) || !!cleanName(rule.merchant);
}

function findLearned(rules, mkey) {
  if (!mkey || !Array.isArray(rules)) return null;
  return rules.find((rule) => rule && typeof rule === 'object' && rule.mkey === mkey && hasUsableField(rule)) || null;
}

function learnedRuleId(rule) {
  const id = typeof rule.id === 'string' && rule.id ? rule.id : String(rule.mkey);
  return id.startsWith(LEARNED_PREFIX) ? id : LEARNED_PREFIX + id;
}

/** The owner's rule wins over everything the built-in rules decided; the merchant key never changes. */
function applyLearned(base, rule, flow) {
  const out = { ...base, review: false, ruleId: learnedRuleId(rule) };
  const name = cleanName(rule.merchant);
  if (name) out.merchant = name;
  if (isPurpose(rule.purpose)) out.purpose = rule.purpose;
  const category = usableCategory(rule.category, flow);
  if (category) {
    out.category = category;
    out.kind = kindFor(category, flow);
    out.klass = klassOf(category);
  }
  if (isKlass(rule.klass)) out.klass = rule.klass;
  if (out.kind !== 'spend') out.glyph = null;
  return out;
}

function readInput(input) {
  const tx = input && typeof input === 'object' ? input : {};
  return {
    description: tx.description,
    payee: tx.payee,
    memo: tx.memo,
    mcc: tx.mcc,
    amount: Number.isFinite(tx.amount) ? Math.abs(tx.amount) : 0,
    flow: tx.flow === 'in' ? 'in' : 'out',
    group: accountGroupOf(tx.accountType),
  };
}

/**
 * @param {object} input        a ClassifyInput (anything malformed is read as empty)
 * @param {object[]} rules      settings.rules
 * @param {(mkey: string) => object[]} spendsOf   recent spends at a merchant, for refund recognition
 */
function classifyCore(input, rules, spendsOf) {
  const tx = readInput(input);
  const id = identify(tx);
  const mirror = tx.flow === 'in' ? findMirror(spendsOf(id.mkey), id.mkey, tx.amount) : null;
  const base = classifyBuiltin(tx, id, mirror);
  const learned = findLearned(rules, id.mkey);
  return learned ? applyLearned(base, learned, tx.flow) : base;
}

/**
 * Classify one transaction.
 * @param {ClassifyInput} input
 * @param {{ rules?: object[], recentSpends?: { mkey: string, amount: number }[] }} [ctx]
 *   rules = settings.rules (owner-learned, win over everything);
 *   recentSpends = spends of the last 60 days, used to recognise an in-flow as a refund of one of them
 *   (an entry may also carry category, klass and purpose: the refund then takes them).
 * @returns {Classification}
 */
export function classify(input, ctx) {
  const context = ctx && typeof ctx === 'object' ? ctx : {};
  const spends = Array.isArray(context.recentSpends) ? context.recentSpends : [];
  return classifyCore(input, context.rules, () => spends);
}

/* ------------------------------------------------------- working on the document */

function lockSet(tx) {
  return new Set(Array.isArray(tx.locks) ? tx.locks : []);
}

/** The owner has been through this move: a field they set by hand, or the guess confirmed as it stands. */
function ownerSaw(locks) {
  return locks.has(REVIEW_LOCK) || LOCKABLE.some((field) => locks.has(field));
}

/** A classification '??' leaves with the category it came with, unless the owner set the mark by hand. */
function dropStaleGlyph(tx, locks, next) {
  if (tx.glyph === '??' && !locks.has('glyph') && next.category && next.category !== tx.category && next.category !== PENALTY_CATEGORY) {
    next.glyph = null;
  }
}

/** Paired transfers / payments and deposits linked to an income stream keep their kind and category. */
function isFlowFrozen(tx) {
  return !!tx.pairId || !!tx.streamId;
}

function assignChanged(tx, next) {
  let changed = false;
  for (const key of Object.keys(next)) {
    if (tx[key] !== next[key]) {
      tx[key] = next[key];
      changed = true;
    }
  }
  return changed;
}

/** Live spends grouped by merchant key, for recognising refunds. */
function spendsByMerchant(txs) {
  const index = new Map();
  for (const tx of txs) {
    if (!tx || tx.kind !== 'spend' || tx.flow !== 'out' || !tx.mkey || !isLive(tx) || !isYmd(tx.day)) continue;
    if (!index.has(tx.mkey)) index.set(tx.mkey, []);
    index.get(tx.mkey).push(tx);
  }
  return index;
}

function recentSpendsFor(index, tx) {
  return (mkey) => {
    const spends = index.get(mkey);
    if (!spends || !isYmd(tx.day)) return [];
    const earliest = addDays(tx.day, -REFUND_WINDOW_DAYS);
    return spends.filter((s) => s.id !== tx.id && s.day <= tx.day && s.day >= earliest).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  };
}

/**
 * Whether a stored row may take `category`, and the kind it then has. Kind follows the category
 * unless it is locked, the row is paired or stream-linked, or it is a decline; a category that
 * would contradict a kind that cannot follow does not fit (a paired transfer is never "gifts").
 */
function categoryFit(tx, locks, category) {
  const kind = kindFor(category, tx.flow);
  const kindFree = tx.kind !== 'decline' && !locks.has('kind') && !isFlowFrozen(tx);
  const fits = kindFree || kind === tx.kind || (tx.kind === 'decline' && isSpendCategory(category));
  return { fits, kind: kindFree ? kind : tx.kind };
}

/** Lay a learned rule over a stored row, field by field, leaving locked fields alone. */
function applyRuleToRow(tx, rule, { ruleId, clearReview }) {
  const locks = lockSet(tx);
  const next = {};
  const name = cleanName(rule.merchant);
  if (name && !locks.has('merchant')) next.merchant = name;
  if (isPurpose(rule.purpose) && !locks.has('purpose')) next.purpose = rule.purpose;
  const klassFree = !locks.has('klass') && !tx.recurringId;
  const category = usableCategory(rule.category, tx.flow);
  if (category && !locks.has('category')) {
    const fit = categoryFit(tx, locks, category);
    if (fit.fits) {
      next.category = category;
      next.kind = fit.kind;
      if (klassFree) next.klass = klassOf(category);
      dropStaleGlyph(tx, locks, next);
    }
  }
  if (isKlass(rule.klass) && klassFree) next.klass = rule.klass;
  if (ruleId) next.ruleId = ruleId;
  if (clearReview) next.review = false;
  return assignChanged(tx, next);
}

/** Re-read one stored bank row. Locked fields, paired legs, stream deposits and Book charges keep what they have. */
function reclassifyRow(tx, cls) {
  const locks = lockSet(tx);
  const frozen = isFlowFrozen(tx);
  const next = { mkey: cls.mkey, ruleId: cls.ruleId };
  if (!locks.has('merchant')) next.merchant = cls.merchant;
  if (!locks.has('purpose')) next.purpose = cls.purpose;

  let kind = tx.kind;
  let category = tx.category;
  if (!frozen) {
    if (locks.has('category')) {
      if (!locks.has('kind')) kind = kindFor(tx.category, tx.flow) || tx.kind;
    } else if (locks.has('kind')) {
      category = categoryFor(tx.kind, cls.category);
    } else {
      kind = cls.kind;
      category = cls.category;
    }
    next.kind = kind;
    next.category = category;
    if (!locks.has('klass') && !tx.recurringId) next.klass = category === cls.category ? cls.klass : klassOf(category);
  }
  // A line of the Book is settled; so is a move the owner corrected or confirmed (any field they locked).
  next.review = frozen || ownerSaw(locks) || tx.recurringId != null ? false : cls.review;
  // A penalty mark belongs to the category the rules found: not to a move the owner filed elsewhere.
  if (tx.glyph == null && cls.glyph && kind === 'spend' && category === cls.category) next.glyph = cls.glyph;
  return assignChanged(tx, next);
}

function learnedRules(state) {
  return state && state.settings && Array.isArray(state.settings.rules) ? state.settings.rules : [];
}

/**
 * Re-run classification over stored transactions, respecting `locks`:
 * a locked field is never changed; `kind` is also left alone on paired transfers/payments
 * (pairId) and on rows linked to a Book entry or income stream keep klass 'book' / their stream.
 * Declines and matched provisional moves are skipped.
 * A row without bank text (a move the owner tapped in) is only touched by a learned rule for its
 * merchant key: there is nothing else to re-read, and what the owner entered must survive.
 * A classification glyph ('??') is written to `glyph` only when the row has none.
 * @param {object} state                the document (mutated)
 * @param {string[]|null} [txIds]       limit to these ids (default: every row, whatever its source)
 * @returns {number} rows changed
 */
export function reclassify(state, txIds) {
  const txs = state && Array.isArray(state.txs) ? state.txs : [];
  const only = Array.isArray(txIds) ? new Set(txIds) : null;
  const rules = learnedRules(state);
  const accountTypes = new Map((Array.isArray(state && state.accounts) ? state.accounts : []).filter(Boolean).map((a) => [a.id, a.type]));
  const rows = txs.filter((tx) => tx && typeof tx === 'object' && tx.kind !== 'decline' && !tx.matchId && (!only || only.has(tx.id)));
  const reread = (tx, spendsOf) => {
    if (typeof tx.raw === 'string' && tx.raw.trim()) {
      const input = { description: tx.raw, mcc: tx.mcc, amount: tx.amount, flow: tx.flow, accountType: accountTypes.get(tx.accountId) };
      return reclassifyRow(tx, classifyCore(input, rules, spendsOf));
    }
    const rule = findLearned(rules, tx.mkey);
    return !!rule && applyRuleToRow(tx, rule, { ruleId: learnedRuleId(rule), clearReview: false });
  };
  // Money out first: a refund is recognised by the spend it mirrors, which has to be classified before it.
  const moneyOut = rows.filter((tx) => tx.flow !== 'in');
  let changed = moneyOut.filter((tx) => reread(tx, () => [])).length;
  const spends = spendsByMerchant(txs);
  for (const tx of rows) {
    if (tx.flow === 'in' && reread(tx, recentSpendsFor(spends, tx))) changed++;
  }
  return changed;
}

function ownerFields(fields, flow) {
  const given = {};
  if (!fields || typeof fields !== 'object') return given;
  const category = usableCategory(fields.category, flow);
  if (category) given.category = category;
  if (isKlass(fields.klass)) given.klass = fields.klass;
  if (isPurpose(fields.purpose)) given.purpose = fields.purpose;
  const name = cleanName(fields.merchant);
  if (name) given.merchant = name;
  return given;
}

/**
 * Write the owner's correction onto the move itself and lock what was taken. The owner outranks a
 * lock on any field they give; a category the move's kind cannot follow (see categoryFit) is left out.
 * @returns {{ accepted: object, changed: boolean }}  accepted = the given fields this move took
 */
function applyCorrection(tx, given) {
  const locks = lockSet(tx);
  const accepted = { ...given };
  const next = { review: false };
  if (given.category) {
    const fit = categoryFit(tx, locks, given.category);
    if (fit.fits) {
      next.category = given.category;
      next.kind = fit.kind;
      if (!given.klass && !locks.has('klass') && !tx.recurringId) next.klass = klassOf(given.category);
      dropStaleGlyph(tx, locks, next);
    } else {
      delete accepted.category;
    }
  }
  if (!Object.keys(accepted).length) return { accepted, changed: false };
  if (accepted.merchant) next.merchant = accepted.merchant;
  if (accepted.purpose) next.purpose = accepted.purpose;
  if (accepted.klass) next.klass = accepted.klass;
  const lockList = LOCKABLE.filter((field) => accepted[field] || locks.has(field));
  for (const field of locks) if (!lockList.includes(field)) lockList.push(field);
  let changed = assignChanged(tx, next);
  if (lockList.length !== locks.size || !Array.isArray(tx.locks)) {
    tx.locks = lockList;
    changed = true;
  }
  return { accepted, changed };
}

function upsertRule(state, mkey, given) {
  if (!state.settings || typeof state.settings !== 'object') state.settings = {};
  if (!Array.isArray(state.settings.rules)) state.settings.rules = [];
  const rules = state.settings.rules;
  let rule = rules.find((r) => r && typeof r === 'object' && r.mkey === mkey);
  if (!rule) {
    rule = { id: LEARNED_PREFIX + newId('r').slice(2), mkey };
    rules.push(rule);
  } else if (typeof rule.id !== 'string' || !rule.id) {
    rule.id = LEARNED_PREFIX + newId('r').slice(2);
  }
  Object.assign(rule, given);
  return rule;
}

/**
 * Record the owner's correction of a move: lock the given fields on that transaction, learn
 * (or update) a rule for its merchant key in settings.rules, and apply the rule to every
 * other row of that merchant whose corresponding fields are not locked.
 * Values that are not a known category, class or purpose are ignored; kind follows a new category
 * (a spending category makes a spend or a refund, 'transfer' a transfer, 'card_payment' a payment).
 * A category that contradicts a kind which cannot follow (a paired leg, a stream deposit, a locked
 * kind) is ignored as well; when nothing usable remains, nothing changes and nothing is learned.
 * A move with no merchant key cannot carry a rule: it is changed alone.
 * @param {object} state                 the document (mutated)
 * @param {string} txId
 * @param {{ category?: string, klass?: string, purpose?: string, merchant?: string }} fields
 * @param {{ onlyThis?: boolean }} [opts] onlyThis = change this move alone; learn nothing
 * @returns {{ changed: number, ruleId: string|null }}  changed = rows changed, this one included;
 *   ruleId = the id of the rule in settings.rules, which is also what `ruleId` holds on the rows it classified
 */
export function learnRule(state, txId, fields, opts) {
  const txs = state && Array.isArray(state.txs) ? state.txs : [];
  const tx = typeof txId === 'string' && txId ? txs.find((t) => t && typeof t === 'object' && t.id === txId) : null;
  if (!tx) return { changed: 0, ruleId: null };
  const correction = applyCorrection(tx, ownerFields(fields, tx.flow));
  if (!Object.keys(correction.accepted).length) return { changed: 0, ruleId: null };

  let changed = correction.changed ? 1 : 0;
  if ((opts && opts.onlyThis) || typeof tx.mkey !== 'string' || !tx.mkey) return { changed, ruleId: null };

  const rule = upsertRule(state, tx.mkey, correction.accepted);
  const ruleId = learnedRuleId(rule);
  if (tx.ruleId !== ruleId) {
    tx.ruleId = ruleId;
    changed = Math.max(changed, 1);
  }
  for (const other of txs) {
    if (!other || typeof other !== 'object' || other === tx || other.mkey !== tx.mkey) continue;
    if (applyRuleToRow(other, rule, { ruleId, clearReview: true })) changed++;
  }
  return { changed, ruleId };
}

/**
 * The owner looked at a move and left it as classified: clear its "needs a look" mark and remember
 * that it was confirmed (a 'review' entry in `locks`), so that re-reading the rules never queues it again.
 * Nothing else about the move changes and no rule is learned.
 * @param {object} state   the document (mutated)
 * @param {string} txId
 * @returns {{ changed: boolean }}  false when the move is unknown or was already confirmed
 */
export function confirmMove(state, txId) {
  const txs = state && Array.isArray(state.txs) ? state.txs : [];
  const tx = typeof txId === 'string' && txId ? txs.find((t) => t && typeof t === 'object' && t.id === txId) : null;
  if (!tx) return { changed: false };
  let changed = false;
  if (tx.review !== false) {
    tx.review = false;
    changed = true;
  }
  const locks = Array.isArray(tx.locks) ? tx.locks : [];
  if (!locks.includes(REVIEW_LOCK)) {
    tx.locks = [...locks, REVIEW_LOCK];
    changed = true;
  }
  return { changed };
}

function median(sortedAmounts) {
  const mid = Math.floor(sortedAmounts.length / 2);
  if (sortedAmounts.length % 2) return sortedAmounts[mid];
  return roundCents((sortedAmounts[mid - 1] + sortedAmounts[mid]) / 2);
}

/**
 * The owner's most frequent convenience purchases, for one-tap chips on the candidate-move sheet.
 * @param {object} state
 * @param {{ limit?: number, sinceDay?: string }} [opts]   limit defaults to 6
 * @returns {{ merchant: string, mkey: string, category: string, typical: number, count: number }[]}
 *   typical = median amount in cents; most frequent first (ties: the more recent); game-class spends only;
 *   merchant and category are those of the most recent visit
 */
export function topMerchants(state, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 6;
  const sinceDay = typeof options.sinceDay === 'string' ? options.sinceDay : '';
  const groups = new Map();
  for (const tx of state && Array.isArray(state.txs) ? state.txs : []) {
    if (!tx || tx.kind !== 'spend' || tx.klass !== 'game' || !isLive(tx)) continue;
    if (typeof tx.mkey !== 'string' || !tx.mkey || typeof tx.day !== 'string' || !(tx.amount > 0)) continue;
    if (sinceDay && tx.day < sinceDay) continue;
    let group = groups.get(tx.mkey);
    if (!group) {
      group = { mkey: tx.mkey, amounts: [], latest: tx };
      groups.set(tx.mkey, group);
    }
    group.amounts.push(tx.amount);
    if (tx.day >= group.latest.day) group.latest = tx;
  }
  return [...groups.values()]
    .sort((a, b) => b.amounts.length - a.amounts.length
      || (a.latest.day < b.latest.day ? 1 : a.latest.day > b.latest.day ? -1 : 0)
      || (a.mkey < b.mkey ? -1 : 1))
    .slice(0, limit)
    .map((group) => ({
      merchant: typeof group.latest.merchant === 'string' && group.latest.merchant ? group.latest.merchant : group.mkey,
      mkey: group.mkey,
      category: group.latest.category,
      typical: median(group.amounts.sort((a, b) => a - b)),
      count: group.amounts.length,
    }));
}

/**
 * Guess an account's type from its name.
 * checking: checking, chk, spending, "360 checking", debit · savings: saving(s), money market, mma, " cd", reserve ·
 * credit_card: card, credit, visa, mastercard, amex, discover, rewards, cash back and well-known card product names ·
 * loan: loan, mortgage, auto, student, line of credit · investment: brokerage, invest, ira, 401, roth, retirement.
 * No keyword: negative balance -> credit_card, else checking.
 * @param {{ name: string, institution?: string, balance: number }} account  balance = signed cents as reported
 * @returns {string} key of schema.ACCOUNT_TYPES
 */
export function inferAccountType(account) {
  const name = lightClean(account && account.name);
  const hint = name ? ACCOUNT_HINTS.find(({ re }) => re.test(name)) : null;
  if (hint) return hint.type;
  return account && Number.isFinite(account.balance) && account.balance < 0 ? 'credit_card' : 'checking';
}
