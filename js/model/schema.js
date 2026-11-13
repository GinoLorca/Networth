/**
 * The Networth document: every persisted field, its meaning and its defaults.
 * This file is the contract between the bank feed, the engine and the views.
 *
 * Where data comes from
 *  - BANK: balances and transactions arrive automatically from the linked bank feed
 *    (see model/feed.js). The owner never types or imports them.
 *  - OWNER: a handful of things no bank can see (the value of equipment, a loan's terms)
 *    and optional notes on moves (a category correction, a morning plan, a bye).
 *  - DERIVED: everything else (recurring bills, pay schedule, the habit baseline, rounds,
 *    net worth) is computed and never stored unless noted.
 *
 * Conventions
 *  - Money: INTEGER CENTS. Balances are SIGNED in the owner's favour: positive = you have it,
 *    negative = you owe it (a card you owe $4,200 on has balance -420000). Net worth is the
 *    plain sum of balances. Transaction amounts are magnitudes > 0 with a `flow`.
 *  - Day: 'YYYY-MM-DD' — the GAME day (settings.rolloverHour): a 1 a.m. purchase after a
 *    late session belongs to the day that started the evening before.
 *  - Timestamp: epoch milliseconds.
 *  - Ids: short random strings with a prefix ('acc_', 'tx_', 'rec_', 'str_').
 *  - Nothing in this repository may contain a real person's financial data.
 */

export const SCHEMA_VERSION = 2;

/* ------------------------------------------------------------ enumerations */

/**
 * Account types.
 *  group: cash (spendable now) | card (revolving debt) | asset | debt
 *  tier:  how quickly it turns into money — 'now' | 'days' | 'slow' (assets only)
 *  fast:  true for the accounts daily behaviour moves (cash and cards)
 */
export const ACCOUNT_TYPES = {
  checking: { group: 'cash', label: 'Checking', tier: 'now', fast: true },
  savings: { group: 'cash', label: 'Savings', tier: 'now', fast: true },
  cash: { group: 'cash', label: 'Cash in hand', tier: 'now', fast: true },
  credit_card: { group: 'card', label: 'Credit card', fast: true },
  investment: { group: 'asset', label: 'Investments', tier: 'days' },
  equipment: { group: 'asset', label: 'Equipment', tier: 'slow' },
  vehicle: { group: 'asset', label: 'Vehicle', tier: 'slow' },
  receivable: { group: 'asset', label: 'Owed to you', tier: 'days' },
  other_asset: { group: 'asset', label: 'Other asset', tier: 'slow' },
  loan: { group: 'debt', label: 'Loan' },
  other_debt: { group: 'debt', label: 'Other debt' },
};

/**
 * Provenance of a figure. The UI must never present an estimate as bank-verified.
 *  bank      — reported by the bank feed at `asOf`
 *  statement — typed by the owner from a statement
 *  estimate  — the owner's own valuation, or a figure Networth computed (amortised loan, accrued pay)
 */
export const BASES = {
  bank: { label: 'From the bank', rank: 3 },
  statement: { label: 'From a statement', rank: 2 },
  estimate: { label: 'Estimate', rank: 1 },
};

/** Transaction kinds. */
export const TX_KINDS = {
  spend: { label: 'Spend' },          // money leaves for goods or services (cash falls, or card debt rises)
  income: { label: 'Income' },        // money arrives from outside
  transfer: { label: 'Transfer' },    // between the owner's own accounts — never income or spending
  payment: { label: 'Debt payment' }, // toward a card or loan — never spending (interest is its own spend)
  refund: { label: 'Refund' },        // reverses a spend
  decline: { label: 'Declined' },     // a purchase considered and not made: no monetary effect at all
};

/**
 * Spending classes — how a spend is judged.
 *  game   — convenience food and drink bought on the go (cafes, delis, restaurants, delivery,
 *           snacks). The ONLY class judged in the daily round against Habit.
 *  need   — necessary variable spending (groceries, transit, tolls, health, work supplies).
 *  want   — extras (entertainment, personal shopping, rideshare). Judged monthly, never daily.
 *  book   — a recurring bill (The Book). A forced move.
 *  oneoff — an exceptional item outside the usual pattern (equipment, a tax bill).
 */
export const KLASSES = {
  game: { label: 'Convenience', short: 'Daily game' },
  need: { label: 'Necessary', short: 'Necessary' },
  want: { label: 'Extra', short: 'Extras' },
  book: { label: 'The Book', short: 'Book' },
  oneoff: { label: 'One-off', short: 'One-off' },
};

/** What a transaction was for. Labels are the owner's to rename (settings.purposes). */
export const PURPOSES = ['personal', 'work', 'coaching', 'studio'];

/**
 * Spending categories. `klass` is the default class; `stop: true` marks the categories
 * counted as "stops" when looking for stacked cafe/deli visits.
 */
export const CATEGORIES = {
  cafe: { label: 'Coffee & cafes', klass: 'game', stop: true },
  eating_out: { label: 'Delis & restaurants', klass: 'game', stop: true },
  convenience: { label: 'Snacks & corner stores', klass: 'game', stop: true },
  delivery: { label: 'Food delivery', klass: 'game', stop: true },
  groceries: { label: 'Groceries', klass: 'need' },
  transit: { label: 'Transit', klass: 'need' },
  tolls_parking: { label: 'Tolls & parking', klass: 'need' },
  fuel_auto: { label: 'Fuel & car', klass: 'need' },
  health: { label: 'Health', klass: 'need' },
  household: { label: 'Household', klass: 'need' },
  personal_care: { label: 'Personal care', klass: 'need' },
  supplies: { label: 'Work supplies', klass: 'need' },
  cash_withdrawal: { label: 'Cash withdrawal', klass: 'need' },
  fees_interest: { label: 'Interest & fees', klass: 'need' },
  rideshare: { label: 'Rideshare & taxis', klass: 'want' },
  shopping: { label: 'Shopping', klass: 'want' },
  entertainment: { label: 'Entertainment', klass: 'want' },
  travel: { label: 'Travel', klass: 'want' },
  gifts: { label: 'Gifts & giving', klass: 'want' },
  gear: { label: 'Equipment & gear', klass: 'oneoff' },
  software: { label: 'Software & tools', klass: 'oneoff' },
  education: { label: 'Education', klass: 'oneoff' },
  taxes: { label: 'Taxes', klass: 'oneoff' },
  housing: { label: 'Rent & housing', klass: 'book' },
  utilities: { label: 'Utilities', klass: 'book' },
  insurance: { label: 'Insurance', klass: 'book' },
  phone_internet: { label: 'Phone & internet', klass: 'book' },
  subscriptions: { label: 'Subscriptions', klass: 'book' },
  debt_service: { label: 'Loan payments', klass: 'book' },
  other: { label: 'Uncategorized', klass: 'need' },
};

/** Labels for flows that are never spending. */
export const FLOW_CATEGORIES = {
  income: { label: 'Income' },
  transfer: { label: 'Transfer' },
  card_payment: { label: 'Card payment' },
};

/**
 * Annotation symbols (standard chess annotation). Most moves carry none.
 * Negative symbols are only ever applied to unplanned `game` moves.
 */
export const GLYPHS = {
  '!!': { name: 'Brilliant', tone: 'good' },   // a clean-sheet workday
  '!': { name: 'Good move', tone: 'good' },    // a declined purchase, an extra debt payment, a day played to plan
  '!?': { name: 'Interesting', tone: 'open' }, // a business purchase awaiting its return check
  '?!': { name: 'Dubious', tone: 'warn' },     // an unplanned 2nd stop
  '?': { name: 'Mistake', tone: 'bad' },       // an unplanned 3rd stop; a business purchase that did not pay back
  '??': { name: 'Blunder', tone: 'bad' },      // an avoidable penalty only: late fee, over-limit fee, overdraft
  '□': { name: 'Only move', tone: 'forced' }, // rent, a loan payment
};

export const CADENCES = {
  weekly: { label: 'Weekly', perYear: 52, days: 7 },
  biweekly: { label: 'Every 2 weeks', perYear: 26, days: 14 },
  semimonthly: { label: 'Twice a month', perYear: 24, days: 365.25 / 24 },
  monthly: { label: 'Monthly', perYear: 12, days: 365.25 / 12 },
  quarterly: { label: 'Quarterly', perYear: 4, days: 365.25 / 4 },
  semiannual: { label: 'Twice a year', perYear: 2, days: 365.25 / 2 },
  annual: { label: 'Yearly', perYear: 1, days: 365.25 },
};

export const STREAM_KINDS = {
  salary: { label: 'Salary' },
  lessons: { label: 'Lessons & clients' },
  creative: { label: 'Creative & studio' },
  other: { label: 'Other income' },
};

/* ------------------------------------------------------------------ typedefs */

/**
 * @typedef {Object} Account
 * @property {string} id
 * @property {'bank'|'manual'} source      bank = from the feed (never typed); manual = owner-entered (equipment, a loan)
 * @property {{ src: string, id: string, conn: string }|null} ext   provider identity for bank accounts
 * @property {keyof ACCOUNT_TYPES} type
 * @property {boolean} typeLocked          the owner corrected the type; do not re-infer it
 * @property {boolean} flip                the feed reports this debt as a positive number; it is negated on merge
 * @property {boolean} flipLocked          the owner set `flip` by hand; it is never changed automatically
 * @property {string} name                 the bank's name for it ("360 Checking")
 * @property {string} nick                 the owner's own label ('' = use name)
 * @property {string} institution
 * @property {number} balance              SIGNED cents (see conventions). Bank accounts: ledger balance from the feed.
 * @property {number|null} available       bank accounts: available balance, signed cents
 * @property {number} asOf                 timestamp the balance was true (bank: balance-date; manual: when entered)
 * @property {keyof BASES} basis
 * @property {boolean} everyday            cash/card used for day-to-day spending
 * @property {boolean} reserve             cash that counts toward the reserve goal
 * @property {boolean} hidden              left out of everything (a closed or irrelevant account)
 * @property {number|null} apr             debts/cards: annual percentage rate, e.g. 24.99 (owner-entered, optional)
 * @property {number|null} limit           cards: credit limit, cents
 * @property {number|null} minPayment      cards: minimum monthly payment, cents
 * @property {number|null} dueDay          cards/loans: day of month the payment is due (1-31)
 * @property {number|null} quickSale       assets: fraction (0..1) of value realistically raised in a fast sale
 * @property {{ payment: number, assumeScheduled: boolean }|null} loan   manual loans: monthly payment, cents; when no
 *           payment is seen in the feed, assume it is made on dueDay each month
 * @property {{ day: string, balance: number, note: string }[]} history  manual accounts: every value the owner entered, oldest first
 * @property {string} purpose              one of PURPOSES
 * @property {string} note
 */

/**
 * @typedef {Object} Tx  A move on the scoresheet.
 * @property {string} id
 * @property {'bank'|'manual'|'demo'} source   bank = from the feed; manual = a provisional move the owner tapped in
 *           before the bank reported it (or a declined purchase); demo = sample data
 * @property {{ src: string, id: string }|null} ext   provider transaction id (not stable for every bank — see fp)
 * @property {string} fp                  fingerprint used for de-duplication: account | day | signed amount | normalised description | occurrence
 * @property {string|null} accountId
 * @property {string} day                 game day it happened (transaction date when the bank gives one, else posting date)
 * @property {string|null} postedDay      day the bank posted it; null while pending
 * @property {number|null} at             timestamp it happened, when known
 * @property {boolean} pending            reported by the bank but not yet posted
 * @property {number} amount              cents > 0 (for a decline: the price not paid)
 * @property {'in'|'out'} flow            in = raises the account's signed balance; out = lowers it
 * @property {keyof TX_KINDS} kind
 * @property {string} raw                 the bank's description, untouched (untrusted text)
 * @property {string} merchant            cleaned display name ("Dunkin'")
 * @property {string} mkey                normalised merchant key used for grouping and rules ("dunkin")
 * @property {string|null} mcc            merchant category code when the feed has one
 * @property {string} category            key of CATEGORIES or FLOW_CATEGORIES
 * @property {keyof KLASSES} klass
 * @property {string} purpose             one of PURPOSES
 * @property {string[]} locks             fields the owner set by hand ('category','klass','purpose','merchant','kind','glyph');
 *           automatic re-classification must never overwrite a locked field. 'review' is a lock too: the owner
 *           has seen this move (confirmed it, or corrected "this move only"), so it is never queued for a look again
 * @property {boolean} review             classification is uncertain; shown in the (optional) review queue
 * @property {string|null} ruleId         id of the rule that classified it
 * @property {string|null} recurringId    the Book entry this charge belongs to
 * @property {string|null} streamId       the income stream this deposit belongs to
 * @property {string|null} pairId         the other leg of a transfer / card payment between linked accounts
 * @property {string|null} matchId        manual moves: the bank transaction that confirmed it (the manual one is then hidden)
 * @property {string|null} glyph          manual annotation override; null = let the annotator decide
 * @property {boolean} planned            a stop that was in the morning plan (prints bare; never ?! or ?)
 * @property {string|null} instead        declines: what the owner did instead
 * @property {{ value: number, accountId: string|null }|null} capital   equipment purchase: capitalised value added to an asset
 * @property {{ by: string, via: string, outcome: 'yes'|'notyet'|'no'|null }|null} payback   business purchase return check
 * @property {string} note
 * @property {number} loggedAt            timestamp the row was first stored
 */

/**
 * @typedef {Object} DayRecord  Stored only for days the owner touched. All fields optional.
 * @property {'work'|'off'|null} [type]   override of the weekday default (Black = workday, White = day off)
 * @property {{ container: boolean|null, breakfast: boolean|null, stops: number|null, at: number }|null} [plan]  morning preparation
 * @property {boolean} [bye]              half-point bye, declared ahead
 * @property {string} [note]
 */

/**
 * @typedef {Object} HabitSegment  The opponent. Frozen; a change starts a new segment.
 * @property {string} from                first game day this segment applies to
 * @property {number} work                cents of convenience spending on a usual workday
 * @property {number} off                 cents on a usual day off
 * @property {number} winWork             win line, cents (whole dollars): spend this or less on a workday to win
 * @property {number} winOff
 * @property {'computed'|'manual'} basis
 * @property {{ from: string, to: string, workDays: number, offDays: number }|null} window   history it was computed from
 * @property {{ score: number, rounds: number }|null} backtest   how the baseline period would have scored under these lines
 */

/**
 * @typedef {Object} Recurring  An entry in The Book — detected from the feed, editable by the owner.
 * @property {string} id
 * @property {string} name
 * @property {string} mkey                merchant key its charges are matched by
 * @property {string|null} accountId      account it is charged to
 * @property {number} amount              expected cents per occurrence (recent typical)
 * @property {boolean} variable           the amount moves (a utility bill)
 * @property {keyof CADENCES} cadence
 * @property {string} anchor              day of the most recent known charge
 * @property {string} category
 * @property {string} purpose
 * @property {boolean} essential
 * @property {'keep'|'review'|'cut'|null} verdict
 * @property {boolean} active             false = ended, lapsed or dismissed
 * @property {'detected'|'manual'} source
 * @property {number} confidence          0..1 for detected entries
 * @property {string[]} locks             fields the owner set by hand
 * @property {string|null} toAccountId    a debt this pays down (loan payment): principal is not an expense
 * @property {string|null} since          entries added by hand: the day the owner added it (nothing is scheduled or accrued before it)
 * @property {string} note
 */

/**
 * @typedef {Object} Stream  An income stream — detected from deposits.
 * @property {string} id
 * @property {string} name
 * @property {string} mkey                payer key its deposits are matched by
 * @property {keyof STREAM_KINDS} kind
 * @property {string|null} accountId
 * @property {keyof CADENCES|null} cadence   null = irregular
 * @property {string|null} anchor         day of the most recent deposit
 * @property {number} amount              typical net cents per deposit
 * @property {boolean} accrue             true: counted as earned day by day (regular salary). false: counted when it arrives.
 * @property {boolean} active
 * @property {'detected'|'manual'} source
 * @property {number} confidence
 * @property {string[]} locks
 * @property {string} note
 */

/* ------------------------------------------------------------------ factories */

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Short random id: newId('tx') -> 'tx_k3f9a2c1'. */
export function newId(prefix) {
  let s = '';
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
  for (let i = 0; i < 8; i++) s += ID_CHARS[bytes[i] % ID_CHARS.length];
  return prefix + '_' + s;
}

/** @returns {Account} */
export function makeAccount(fields = {}) {
  const type = fields.type || 'checking';
  return {
    id: newId('acc'), source: 'manual', ext: null, type, typeLocked: false, flip: false, flipLocked: false,
    name: '', nick: '', institution: '',
    balance: 0, available: null, asOf: 0, basis: 'estimate',
    everyday: type === 'checking' || type === 'credit_card',
    reserve: type === 'savings', hidden: false,
    apr: null, limit: null, minPayment: null, dueDay: null,
    quickSale: type === 'equipment' ? 0.5 : null,
    loan: null, history: [], purpose: 'personal', note: '',
    ...fields,
  };
}

/** @returns {Tx} */
export function makeTx(fields = {}) {
  const category = fields.category || 'other';
  const def = CATEGORIES[category];
  return {
    id: newId('tx'), source: 'bank', ext: null, fp: '',
    accountId: null, day: '', postedDay: null, at: null, pending: false,
    amount: 0, flow: 'out', kind: 'spend',
    raw: '', merchant: '', mkey: '', mcc: null,
    category, klass: def ? def.klass : 'need', purpose: 'personal',
    locks: [], review: false, ruleId: null,
    recurringId: null, streamId: null, pairId: null, matchId: null,
    glyph: null, planned: false, instead: null, capital: null, payback: null,
    note: '', loggedAt: 0,
    ...fields,
  };
}

/** @returns {Recurring} */
export function makeRecurring(fields = {}) {
  return {
    id: newId('rec'), name: '', mkey: '', accountId: null, amount: 0, variable: false,
    cadence: 'monthly', anchor: '', category: 'subscriptions', purpose: 'personal',
    essential: false, verdict: null, active: true, source: 'detected', confidence: 0,
    locks: [], toAccountId: null, since: null, note: '',
    ...fields,
  };
}

/** @returns {Stream} */
export function makeStream(fields = {}) {
  return {
    id: newId('str'), name: '', mkey: '', kind: 'other', accountId: null,
    cadence: null, anchor: null, amount: 0, accrue: false, active: true,
    source: 'detected', confidence: 0, locks: [], note: '',
    ...fields,
  };
}

/**
 * An empty document with every default in place.
 * @param {number} now timestamp
 */
export function defaultState(now) {
  return {
    meta: {
      v: SCHEMA_VERSION,
      createdAt: now,
      savedAt: 0,
      /** bumped by the store on every change; lets the engine reuse its indexes within one render */
      rev: 0,
      /** 'bank' once a bank feed is linked, 'demo' for the sample game, null before either */
      origin: null,
      /** first game day of the match (set at the first successful sync): rounds count from here */
      matchStart: null,
      /** where the hero number stood when the owner last looked: { at, cents } */
      lastSeen: null,
      /** coach's notes already shown: { [noteKey]: day last shown } */
      notesSeen: {},
      /** one-time prompts the owner has answered or dismissed: { [key]: true } */
      dismissed: {},
    },
    settings: {
      /** 'auto' follows the device; 'paper' (light) or 'night' (dark) forces it */
      theme: 'auto',
      /** weekdays that are workdays by default (0 = Sunday). A day's own record can override. */
      workdays: [1, 2, 3, 4, 5],
      /** the game day rolls over at this hour (0-6) */
      rolloverHour: 4,
      /** count regular pay as it is earned and bills as they are used, so net worth moves smoothly (needs a detected salary) */
      smoothing: true,
      /** include pending bank transactions in balances and rounds */
      countPending: true,
      /** half-point byes allowed per month */
      byesPerMonth: 2,
      /** monthly category targets, cents: { cafe: 20000 } */
      targets: {},
      /** the owner's own rules, shown on the candidate-move sheet */
      principles: ['Bring your own coffee.', 'Eat before you leave when you can.', 'One small coffee if you need a seat.', 'Never stack stops.'],
      /** choices offered after declining a purchase */
      insteads: ['Refilled my own', 'Ate what I brought', 'Sat somewhere free', 'Waited it out'],
      /** hide figures (bars and symbols only) — for opening the app in public */
      cover: false,
      /** labels for the purpose tags */
      purposes: { personal: 'Personal', work: 'Work', coaching: 'Coaching', studio: 'Studio' },
      /** merchant rules learned from the owner's corrections, applied before the built-in ones:
       *  { id, mkey, category, klass, purpose, merchant } — any of the last four may be absent */
      rules: [],
    },
    /** @type {HabitSegment[]} sorted by `from` */
    habits: [],
    /** @type {Account[]} */
    accounts: [],
    /** @type {Tx[]} */
    txs: [],
    /** @type {Object<string, DayRecord>} */
    days: {},
    /** @type {Recurring[]} */
    recurring: [],
    /** @type {Stream[]} */
    streams: [],
    /** state of the bank link (never holds the access credentials — those live in device storage only) */
    sync: {
      /** provider id: 'simplefin' | 'demo' | null */
      src: null,
      /** timestamp of the last attempt and of the last success */
      lastTry: null,
      lastOk: null,
      /** message from the last failure, or null */
      error: null,
      /** 'ok' | 'relink' (credentials revoked or expired) | 'error' */
      status: null,
      /** connection problems reported by the provider: { connId, name, message } */
      problems: [],
      /** earliest day for which transactions were fetched */
      from: null,
      /** timestamps of recent requests (for the provider's daily quota) */
      requests: [],
    },
    /** kept money actually moved to the card or savings: { weekOf, amount, day, txId, via: 'auto'|'tap' } */
    sweeps: [],
    goals: {
      /** cash reserve target, cents */
      reserve: { target: 1000000 },
      /** annual gross income ladder, cents, and the deadline */
      income: { ladder: [10000000, 20000000, 50000000, 100000000], by: '2029-12-31' },
    },
    /** inputs of the Analysis scenarios (never results) */
    scenario: {
      monthlyImprove: 60000,
      toSavings: 15000,
      horizonMonths: 24,
      incomeGrowthPct: 15,
      cardPayment: 30000,
      /** gross-up factor used to show take-home pay as annual gross on the income ladder (e.g. 0.75 = 25% withheld) */
      takeHomeRatio: 0.75,
    },
  };
}

/* ------------------------------------------------------- validation & migration */

/**
 * Check that an object looks like a Networth document (used when restoring a backup or pairing a device).
 * @returns {string|null} a human-readable problem, or null when it is acceptable
 */
export function checkDoc(doc) {
  const NOT_A_COPY = 'This file is not a copy of a Networth record.';
  if (!isPlain(doc)) return NOT_A_COPY;
  if (!isPlain(doc.meta) || !Number.isInteger(doc.meta.v) || doc.meta.v < 0) return NOT_A_COPY;
  if (doc.meta.v > SCHEMA_VERSION) return 'This copy was made by a newer version of Networth.';
  const unsound = soundness(doc, 0, { nodes: 0 });
  if (unsound) return unsound;

  for (const key of ['accounts', 'txs', 'recurring', 'streams', 'habits']) {
    if (!Array.isArray(doc[key])) return 'This copy is incomplete (missing ' + key + ').';
    if (doc[key].length > (key === 'txs' ? CHECK_LIMITS.txs : CHECK_LIMITS.list)) return 'This copy is too large to be a Networth record (' + doc[key].length + ' ' + key + ').';
  }
  if (!isPlain(doc.settings)) return 'This copy is incomplete (missing settings).';

  // every top-level part has the kind of value the record keeps there
  const base = defaultState(0);
  const mismatch = sameKinds(doc, base, '');
  if (mismatch) return 'This copy has an unreadable part (' + mismatch + ').';

  const templates = { accounts: makeAccount(), txs: makeTx(), recurring: makeRecurring(), streams: makeStream() };
  const words = { accounts: 'account', txs: 'move', recurring: 'Book entry', streams: 'pay stream', habits: 'opponent' };
  for (const key of ['accounts', 'txs', 'recurring', 'streams', 'habits']) {
    for (const item of doc[key]) {
      const bad = 'This copy contains an unreadable ' + words[key] + '.';
      if (!isPlain(item)) return bad;
      if (key === 'habits') {
        if (!isDay(item.from)) return bad;
        continue;
      }
      if (typeof item.id !== 'string' || !item.id) return bad;
      if (sameKinds(item, templates[key], '')) return bad;
    }
  }
  // known words only (an inherited name such as "constructor" is not one), and money as whole cents of a sane size
  for (const a of doc.accounts) {
    if (!Object.hasOwn(ACCOUNT_TYPES, a.type) || !isCents(a.balance)) return 'This copy contains an unreadable account.';
  }
  for (const t of doc.txs) {
    if (!Object.hasOwn(TX_KINDS, t.kind) || !isCents(t.amount) || t.amount < 0 || (t.flow !== 'in' && t.flow !== 'out') || !isDay(t.day)) {
      return 'This copy contains an unreadable move.';
    }
  }
  for (const r of doc.recurring) {
    if (!Object.hasOwn(CADENCES, r.cadence) || !isCents(r.amount)) return 'This copy contains an unreadable Book entry.';
  }
  for (const s of doc.streams) {
    if ((s.cadence != null && !Object.hasOwn(CADENCES, s.cadence)) || !isCents(s.amount)) return 'This copy contains an unreadable pay stream.';
  }
  if (doc.sync != null) {
    const sync = doc.sync;
    if (sync.requests != null && !sync.requests.every((x) => Number.isFinite(x))) return 'This copy has an unreadable part (sync.requests).';
    if (sync.problems != null && !sync.problems.every(isPlain)) return 'This copy has an unreadable part (sync.problems).';
    for (const key of ['lastOk', 'lastTry']) {
      if (sync[key] != null && !Number.isFinite(sync[key])) return 'This copy has an unreadable part (sync.' + key + ').';
    }
  }
  if (doc.sweeps != null && !doc.sweeps.every(isPlain)) return 'This copy has an unreadable part (sweeps).';
  return null;
}

const CHECK_LIMITS = { txs: 250000, list: 5000, text: 20000, depth: 24, nodes: 4000000, cents: 1e14 };
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Whole cents no larger than a trillion dollars either way. */
function isCents(value) {
  return Number.isInteger(value) && Math.abs(value) <= CHECK_LIMITS.cents;
}

/** A real calendar day written YYYY-MM-DD. */
function isDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  if (y < 1970 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** Walk the whole value: only JSON kinds, finite numbers, bounded text, depth and size, and no key that names a prototype. */
function soundness(value, depth, count) {
  if (++count.nodes > CHECK_LIMITS.nodes || depth > CHECK_LIMITS.depth) return 'This copy is too large to be a Networth record.';
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'This copy contains a number that is not a number.';
  if (typeof value === 'string') return value.length <= CHECK_LIMITS.text ? null : 'This copy contains a text of ' + value.length + ' characters, more than a Networth record holds.';
  if (typeof value !== 'object') return 'This file is not a copy of a Networth record.';
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const problem = soundness(value[i], depth + 1, count);
      if (problem) return problem;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return 'This copy contains a field name (' + key + ') that a Networth record never has.';
    const problem = soundness(value[key], depth + 1, count);
    if (problem) return problem;
  }
  return null;
}

function kindOf(value) {
  return value === null || value === undefined ? 'none' : Array.isArray(value) ? 'list' : typeof value;
}

/**
 * Compare a value with the shape the record keeps: wherever the template holds a text, a number, a switch,
 * a list or a group, a value that is present must be of that kind. Missing and empty (null) fields pass:
 * migrate fills them. Returns the path of the first mismatch, or null.
 */
function sameKinds(value, template, path) {
  for (const key of Object.keys(template)) {
    const want = kindOf(template[key]);
    const got = kindOf(value[key]);
    if (want === 'none' || got === 'none') continue;
    const here = path ? path + '.' + key : key;
    if (want !== got) return here;
    if (want === 'object' && !CHECK_FREE_FORM.has(key)) {
      const inner = sameKinds(value[key], template[key], here);
      if (inner) return inner;
    }
  }
  return null;
}

const CHECK_FREE_FORM = new Set(['days', 'targets', 'notesSeen', 'dismissed', 'purposes']);

/**
 * Bring a loaded document up to the current schema: fills any missing field with its default
 * and normalises ordering. Safe to call on an already-current document.
 * @param {object} doc
 * @returns {object} the same object, upgraded in place
 */
export function migrate(doc) {
  const base = defaultState(doc.meta && doc.meta.createdAt ? doc.meta.createdAt : 0);
  restoreBuiltIns(doc, base);
  fillDefaults(doc, base);
  doc.meta.v = SCHEMA_VERSION;
  doc.accounts = doc.accounts.map((a) => ({ ...makeAccount({ type: a.type }), ...a }));
  doc.txs = doc.txs.map((t) => ({ ...makeTx({ category: t.category }), ...t }));
  doc.recurring = doc.recurring.map((r) => ({ ...makeRecurring(), ...r }));
  doc.streams = doc.streams.map((s) => ({ ...makeStream(), ...s }));
  doc.habits.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return doc;
}

const FREE_FORM = new Set(['days', 'targets', 'notesSeen', 'dismissed', 'purposes']);

/**
 * For a few hours the published app shipped placeholders in place of the built-in rules and goals
 * (no principles, other "instead" choices, a smaller reserve, other norms). A record made or opened
 * by that build carries `settings.preps`, a list only that build wrote. Such a record gets the
 * built-in values back wherever it still holds an untouched placeholder, so that a device set up
 * during those hours needs nothing typed into it. Whatever the owner changed is left as it is. The
 * marker is removed, so this runs once per record.
 */
const PLACEHOLDER_BUILD = {
  insteads: ['Went without', 'Used what I had', 'Made it at home', 'Left it for later'],
  reserve: 500000,
  ladder: [5000000, 7500000, 10000000, 15000000],
};

function restoreBuiltIns(doc, base) {
  const settings = doc && doc.settings;
  if (!isPlain(settings) || !Array.isArray(settings.preps)) return;
  const same = (list, other) => Array.isArray(list) && list.length === other.length && list.every((item, i) => item === other[i]);
  if (Array.isArray(settings.principles) && settings.principles.length === 0) settings.principles = base.settings.principles.slice();
  if (same(settings.insteads, PLACEHOLDER_BUILD.insteads)) settings.insteads = base.settings.insteads.slice();
  const goals = doc.goals;
  if (isPlain(goals)) {
    if (isPlain(goals.reserve) && goals.reserve.target === PLACEHOLDER_BUILD.reserve) goals.reserve.target = base.goals.reserve.target;
    if (isPlain(goals.income)) {
      if (same(goals.income.ladder, PLACEHOLDER_BUILD.ladder)) goals.income.ladder = base.goals.income.ladder.slice();
      // that build set the due day to the end of the fourth year after the record was made
      const madeAt = doc.meta && Number.isFinite(doc.meta.createdAt) ? doc.meta.createdAt : null;
      const placeholderBy = madeAt === null ? null : (new Date(madeAt).getFullYear() + 4) + '-12-31';
      if (placeholderBy !== null && goals.income.by === placeholderBy) goals.income.by = base.goals.income.by;
    }
  }
  delete settings.preps;
}

function fillDefaults(target, defaults) {
  for (const key in defaults) {
    const d = defaults[key];
    if (target[key] === undefined || target[key] === null && d !== null && typeof d === 'object') {
      target[key] = d;
    } else if (d && typeof d === 'object' && !Array.isArray(d) && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      if (FREE_FORM.has(key)) {
        if (key === 'purposes') for (const p in d) if (!(p in target[key])) target[key][p] = d[p];
        continue;
      }
      fillDefaults(target[key], d);
    }
  }
}

/* ------------------------------------------------------------- small lookups */

export function accountGroup(account) {
  return ACCOUNT_TYPES[account.type].group;
}

/** True for cash and card accounts — the ones daily behaviour moves. */
export function isFast(account) {
  return !!ACCOUNT_TYPES[account.type].fast;
}

/** The label to show for an account. */
export function accountLabel(account) {
  return account.nick || account.name || ACCOUNT_TYPES[account.type].label;
}

export function categoryLabel(key) {
  const c = CATEGORIES[key] || FLOW_CATEGORIES[key];
  return c ? c.label : 'Uncategorized';
}

/** Default class for a category key. */
export function klassOf(category) {
  return CATEGORIES[category] ? CATEGORIES[category].klass : 'need';
}

/** Signed effect of a transaction on its account's balance, in cents. Declines have none. */
export function txEffect(tx) {
  if (tx.kind === 'decline') return 0;
  return tx.flow === 'in' ? tx.amount : -tx.amount;
}

/** True when a transaction is real money movement that should be counted (not a decline, not a superseded manual move). */
export function isLive(tx) {
  return tx.kind !== 'decline' && !tx.matchId;
}
