/**
 * A deterministic, entirely FICTIONAL sample game: the bank feed of an invented person, used for
 * the "look around first" mode, for tests and for screenshots. It flows through the same
 * merge -> detect -> ledger pipeline as a real feed, so the demo exercises the real code.
 * Pure. Imports: schema, dates, money, merge, detect. No real person's data may appear here.
 *
 * How the sample is put together
 *  - Everything depends on the game day of `nowMs` (rollover at 4 a.m., the default of a new
 *    document) and on the seed, never on the time of day: any instant of one game day gives the
 *    same feed and the same document. Balances are "as of" the start of that game day.
 *  - Days before the match are the invented owner's usual life, drawn from a seeded generator keyed
 *    by the calendar day. The three weeks of the match are scripted by week and weekday, with
 *    amounts set against the habit those earlier days add up to, so the story (wins, draws, losses,
 *    clean sheets, a day of repeat stops, a bye, one kept week moved to the card and another still open)
 *    holds whatever day the sample is opened on.
 *  - A purchase carries the time it was made and posts the next day; bills, pay and transfers carry
 *    a date alone. What was bought today is still pending and has no time of day yet.
 *  - Both legs of a transfer or card payment post on the same day.
 *  - Nothing but the bills is allowed the rhythm of a bill: errands come round at gaps that are
 *    never a week, a fortnight or a month, so the Book holds what was meant for it and no more.
 */

import { defaultState, makeAccount } from './schema.js';
import {
  addDays, addMonths, addMonthsYm, diffDays, dow, eachDay, endOfMonth, gameDay, gameDayStartMs, maxYmd, monthOf, parts,
  weekStart,
} from './dates.js';
import { roundCents } from './money.js';
import { addDecline, mergeFeed } from './merge.js';
import { computeHabit, refresh } from './detect.js';

/** The match of the sample game began this many days before today. */
export const DEMO_MATCH_DAYS = 21;
/** Days of history in the sample document: enough to hold two charges of the yearly renewal, which is what detects it. */
export const DEMO_HISTORY_DAYS = 400;

const EPOCH = '1970-01-01';
const HOUR_MS = 3600000;
const DAY_MINUTES = 1440;
const WEEK_DAYS = 7;
const DOLLAR = 100;
/** The rollover hour of a new document (schema.defaultState). */
const ROLLOVER_HOUR = 4;
const DEFAULT_DAYS = 150;
const LONGEST_DAYS = 1500;
const DEFAULT_SEED = 1;
/**
 * The instants a sample can be built for: late enough that the longest feed begins after 1970 (a
 * bank feed cannot date a row before it) and early enough for a four-digit year.
 */
const EARLIEST_MS = Date.UTC(1975, 0, 1);
const LATEST_MS = Date.UTC(9000, 0, 1);
const HABIT_WINDOW_DAYS = 60;
/** detect.computeHabit reads no habit from fewer days than this. */
const HABIT_MINIMUM_DAYS = 14;
/** Stands in for a habit the feed is too short to hold. */
const FALLBACK_HABIT = { work: 2300, off: 2400 };

/* ------------------------------------------------------------------ the world */

/** Somewhere money is spent: the descriptor the bank prints, its category code and, where prices vary, their range in cents. */
function shop(text, mcc, low = 0, high = 0) {
  return { text, mcc, low, high };
}

const BANK = 'Northlight Bank';
const CONNECTION = 'demo-northlight';
const CARD_EXT_ID = 'demo-card';
const ACCOUNTS = [
  { key: 'checking', extId: 'demo-checking', name: 'Everyday Checking', code: 'chk' },
  { key: 'savings', extId: 'demo-savings', name: 'Rainy Day Savings', code: 'sav' },
  { key: 'card', extId: CARD_EXT_ID, name: 'Northlight Rewards Visa', code: 'crd' },
];

/** The card: its terms (which the owner typed in — no feed carries them) and how it is paid. */
const CARD_APR = 24.99;
const CARD_LIMIT = 600000;
const CARD_DUE_DAY = 14;
const CARD_STATEMENT_DAY = 20;
const CARD_PAYMENT = 46000;
const LATE_FEE = 2900;
/** The one late payment lies before the match: its fee posted at least this many days ago. */
const LATE_FEE_AGE_DAYS = 24;

/** Roughly what the card owes and the savings hold today, and the lowest the checking balance came in the feed. */
const CARD_OWED_NOW = 398000;
const SAVINGS_NOW = 21200;
const CHECKING_FLOOR = 38000;
const SAVINGS_MONTHLY_RATE = 0.0004;

const TEXT = {
  payroll: 'BRIGHTWELL MEDIA PAYROLL PPD ID: 1840277716',
  oneOffClient: 'Zelle payment from SAM ORTEGA 24117730982',
  fromSavings: 'TRANSFER FROM SAVINGS XXXX7731',
  toChecking: 'TRANSFER TO CHECKING XXXX2210',
  savingsInterest: 'INTEREST PAID',
  power: 'CON ED OF NY CECONY PPD ID: 2462467002',
  streaming: 'NETFLIX.COM NETFLIX.COM CA',
  yearly: 'Amazon Prime*',
  order: 'AMZN Mktp US*',
  orderTail: ' Amzn.com/bill WA',
  orderRefund: 'AMZN Mktp US Amzn.com/bill WA',
  scheduledPayment: 'SCHEDULED TRANSFER TO NORTHLIGHT VISA XXXX4417',
  extraPayment: 'ONLINE TRANSFER TO NORTHLIGHT VISA XXXX4417',
  paymentReceived: 'PAYMENT - THANK YOU',
  cardInterest: 'INTEREST CHARGE:PURCHASES',
  lateFee: 'LATE FEE',
};

/** Pay lands every second Friday, counted from this one; the raise came some months back. */
const PAYDAY_ANCHOR = '2026-01-02';
const PAY_PERIOD_DAYS = 14;
const PAY = { before: 185676, now: 191246, raisedDaysAgo: 200 };

/**
 * People who pay for lessons: each at an interval no pay cadence fits and in amounts that never
 * settle, so they stay occasional income and only the salary accrues.
 */
const CLIENTS = [
  { text: 'Zelle payment from JORDAN ELLIS 23841907215', every: 23, phase: 5, amounts: [12000, 18000, 9000, 24000, 15000, 30000] },
  { text: 'Zelle payment from PRIYA RAMAN 23990417733', every: 37, phase: 11, amounts: [16000, 8000, 22000, 11000, 28000, 13000] },
];
const ONE_OFF_CLIENT = { daysAgo: 47, cents: 8500 };

/** Savings drawn down to cover the months that ran short: [days ago, cents]. */
const SAVINGS_DRAWS = [[310, 50000], [205, 40000], [95, 30000]];

/** Bills that come on the same day of every month at the same price. */
const MONTHLY_BILLS = [
  { onDay: 1, account: 'checking', cents: 196000, text: 'KESTREL REALTY LLC RENT WEB ID: 1730042281' },
  { onDay: 3, account: 'checking', cents: 47500, text: 'FOUNDRY ROW WORKSPACE RENT WEB ID: 1730077154' },
  { onDay: 5, account: 'checking', cents: 24000, text: 'ALDERLINE EQUIP FINANCE LOAN PYMT PPD ID: 4410098213' },
  { onDay: 9, account: 'checking', cents: 6499, text: 'SPECTRUM 855-707-7328 NY' },
  { onDay: 12, account: 'checking', cents: 1425, text: 'LEMONADE INSURANCE CO' },
  { onDay: 16, account: 'card', cents: 1199, text: 'SPOTIFY USA 877-778-1161 NY' },
  { onDay: 22, account: 'checking', cents: 7000, text: 'VZWRLSS*APOCC VISB 800-922-0204 FL' },
  { onDay: 24, account: 'card', cents: 299, text: 'APPLE.COM/BILL 866-712-7753 CA' },
];
const POWER_DAY = 20;
const POWER_BASE = 9400;
/** The streaming price went up with the latest charge. */
const STREAMING_DAY = 7;
const STREAMING_PRICE = { before: 1549, now: 1799 };
const YEARLY = { daysAgo: 9, cents: 13900 };

/** One small online order a month, on days that never fall a month apart; one in six is sent back. */
const ORDER = { low: 1800, high: 4200, refundAfterDays: 9, refundEvery: 6 };
/** Every third month something for the studio goes on the card: those are the months its balance rises. */
const GEAR_EVERY_MONTHS = 3;
const GEAR_PRICES = [44900, 47999, 49900, 52995];
const GEAR_SHOPS = [
  shop('SWEETWATER SOUND 800-222-4700 IN', '5733'),
  shop('GUITAR CENTER #612 NEW YORK NY', '5733'),
  shop('VINTAGE KING AUDIO 248-591-9276 MI', '5733'),
];

const FARE = 290;
const SUBWAY = shop('MTA*NYCT PAYGO NEW YORK NY', '4111');
const TRADER_JOES = shop('TRADER JOE S #558 NEW YORK NY', '5411');
const KEY_FOOD = shop('KEY FOOD 1432 ASTORIA NY', '5411');
/** Three grocery runs in five go to the first store. */
const GROCERS = [TRADER_JOES, TRADER_JOES, TRADER_JOES, KEY_FOOD, KEY_FOOD];
/**
 * A grocery run comes in one of seven sizes, each a quarter larger than the one below, and the
 * size changes with every run: two runs of like size are always seven runs apart, which is too
 * long for like amounts at one store to look like a monthly bill.
 */
const GROCERY = { smallest: 3200, sizes: 7, sizeStep: 1.25, sizeJump: 3, spread: 0.08 };
const PHARMACY = shop('CVS/PHARMACY #02581 ASTORIA NY', '5912', 650, 3400);
const RIDE = shop('UBER *TRIP HELP.UBER.COM CA', '4121', 1400, 3200);
const LAUNDRY = shop('SPIN CYCLE LAUNDROMAT ASTORIA NY', '7211');
const LAUNDRY_PRICE = 1175;
const CASH_MACHINE = shop('ATM WITHDRAWAL 004417 31-12 BROADWAY ASTORIA NY', '6011');
const CASH_AMOUNTS = [4000, 6000, 8000, 10000];
const CINEMA = shop('AMC 9640 ONLINE 888-562-4262 KS', '7832', 1749, 3698);
const CLOTHES = shop('UNIQLO USA 5TH AVE NEW YORK NY', '5651', 2990, 7990);

/**
 * Errands that come round every few days. The gaps (in days) are chosen so that no run of visits to
 * one place, and no run of like amounts among them, can fall into the rhythm of a bill.
 */
const ROUNDS = {
  groceries: { salt: 21, shortest: 5, longest: 9 },
  laundry: { salt: 22, shortest: 9, longest: 11 },
  cash: { salt: 23, shortest: 18, longest: 25 },
  cinema: { salt: 24, shortest: 19, longest: 26 },
  clothes: { salt: 25, shortest: 34, longest: 55 },
  pharmacy: { salt: 26, shortest: 19, longest: 26 },
  rides: { salt: 27, shortest: 18, longest: 24 },
};
/** Rounds are counted from the start of a block of days, so the same days come out whatever today is. */
const ROUND_BLOCK_DAYS = 4096;

/** What tells one use of the generator from another. */
const SALT = { game: 1, errands: 2, month: 3, script: 4, ids: 5, power: 6, balances: 7 };

const RESTAURANTS = [
  shop('TST* LA CASITA TAQUERIA ASTORIA NY', '5812', 1850, 4400),
  shop('RAMEN KOKORO NEW YORK NY', '5812', 1700, 3600),
  shop('BAREBURGER ASTORIA NY', '5812', 1900, 3900),
  shop('SQ *THE LOCAL DINER ASTORIA NY', '5812', 1600, 3400),
];
const DELI = shop('SUNRISE GOURMET DELI NEW YORK NY', '5499', 925, 1450);

/** Where the owner stops in the daily game, by time of day (minutes after midnight). */
const SLOTS = {
  morning: {
    account: 'checking', from: 455, to: 560,
    shops: [
      shop('STARBUCKS STORE 07421 NEW YORK NY', '5814', 395, 645),
      shop('DUNKIN #345123 Q35 ASTORIA NY', '5814', 289, 489),
      shop('TST* BLANK STREET COFFEE NEW YORK NY', '5814', 425, 575),
      shop('SQ *BIRDSONG COFFEE ASTORIA NY', '5814', 400, 625),
      shop('GREGORYS COFFEE 0127 NEW YORK NY', '5814', 415, 595),
    ],
  },
  lateMorning: {
    account: 'checking', from: 570, to: 680,
    shops: [
      shop('BAGEL PUB ASTORIA NY', '5814', 350, 925),
      shop('SQ *BIRDSONG COFFEE ASTORIA NY', '5814', 400, 625),
      shop('DUNKIN #345123 Q35 ASTORIA NY', '5814', 289, 489),
    ],
  },
  lunch: {
    account: 'checking', from: 725, to: 820,
    shops: [
      shop('CHIPOTLE 2218 NEW YORK NY', '5814', 1135, 1560),
      shop('SWEETGREEN ASTOR PLACE NEW YORK NY', '5812', 1395, 1745),
      DELI,
      shop('THE HALAL GUYS 53RD ST NEW YORK NY', '5814', 1099, 1399),
      shop('TST* CORNER SLICE PIZZA NEW YORK NY', '5812', 700, 1250),
      shop('CHOPT CREATIVE SALAD NEW YORK NY', '5812', 1289, 1649),
    ],
  },
  afternoon: {
    account: 'checking', from: 910, to: 1025,
    shops: [
      shop('STARBUCKS STORE 07421 NEW YORK NY', '5814', 345, 625),
      shop('7-ELEVEN 34412 NEW YORK NY', '5499', 275, 695),
      shop('PRET A MANGER 0238 NEW YORK NY', '5814', 399, 749),
      shop('HUDSON NEWS ST1432 NEW YORK NY', '5994', 329, 679),
    ],
  },
  brunch: { account: 'checking', from: 740, to: 870, shops: RESTAURANTS },
  dinner: { account: 'checking', from: 1140, to: 1260, shops: RESTAURANTS },
  delivery: {
    account: 'card', from: 1160, to: 1270,
    shops: [
      shop('DD *DOORDASH THAIVILLA 855-973-1040 CA', '5812', 2600, 3600),
      shop('UBER *EATS HELP.UBER.COM CA', '5812', 2600, 3600),
      shop('SEAMLSS*PALACEDINER SEAMLESS.COM NY', '5812', 2600, 3600),
    ],
  },
  /** After midnight: still the game day that began the evening before. */
  lateNight: { account: 'checking', from: DAY_MINUTES + 20, to: DAY_MINUTES + 100, shops: [shop(DELI.text, DELI.mcc, 650, 1200)] },
};
/** A day off starts later and its midday stop is a sit-down one. */
const DAY_OFF_SLOTS = { morning: 'lateMorning', lunch: 'brunch' };

/** How the owner played before the match: the chance of each stop on a usual day, and what came besides. */
const USUAL = {
  work: [['morning', 0.88], ['lunch', 0.72], ['afternoon', 0.42]],
  off: [['lateMorning', 0.55], ['brunch', 0.24], ['dinner', 0.22]],
  deliveryEveryDays: 5,
  lateNightChance: 0.12,
};

/**
 * What a scripted day of the match holds, as [slot, cents] against that day's habit. Each is
 * sized so that its result cannot depend on where the lines fall: a small stop is at most a
 * quarter of habit (never above a win line), a draw sits between three quarters of habit and
 * habit, and every loss ends more than a dollar above it.
 */
const PLAYS = {
  clean: () => [],
  small: (habit, rng) => [['morning', smallStop(habit, rng)]],
  draw: (habit, rng) => splitStops(Math.round(habit * (0.8 + 0.16 * rng())), between(rng, 395, 525), 'morning', 'lunch'),
  over: (habit, rng) => splitStops(habit + between(rng, 450, 900), between(rng, 445, 595), 'morning', 'lunch'),
  stacked: (habit, rng) => [
    ['morning', between(rng, 545, 665)], ['lunch', habit + between(rng, 330, 520)], ['afternoon', between(rng, 595, 745)],
  ],
  delivery: (habit, rng) => splitStops(habit + between(rng, 900, 1300), between(rng, 1095, 1495), 'lunch', 'delivery'),
  nightOut: (habit, rng) => splitStops(habit + between(rng, 1200, 1800), between(rng, 475, 625), 'morning', 'dinner'),
  dinnerOut: (habit, rng) => [['dinner', habit + between(rng, 1400, 1900)]],
};

/** One day of the match: what was played, the stops in that morning's plan (null = no plan), and whether a bye was declared. */
function scene(play, plan = null, bye = false) {
  return { play, plan, bye };
}

/**
 * The match, week by week (0 = this week … 3 = the week it began) and day by day from Monday.
 * The first week still shows the old habits; the bye was declared for a dinner out.
 */
const MATCH_WEEKS = [
  [scene('clean', 0), scene('small', 1), scene('draw'), scene('clean'), scene('small'), scene('draw'), scene('clean')],
  [scene('clean', 0), scene('draw'), scene('small', 1), scene('stacked'), scene('clean'), scene('dinnerOut', null, true), scene('clean')],
  [scene('draw'), scene('small', 1), scene('clean'), scene('draw', 1), scene('delivery'), scene('clean'), scene('small')],
  [scene('draw'), scene('over'), scene('draw'), scene('small'), scene('draw'), scene('nightOut'), scene('draw')],
];
const PLAN_MADE_AFTER_MS = 3 * HOUR_MS + 12 * 60000;
const BYE_NOTE = 'Dinner out, declared ahead';
const DECLINE = { merchant: 'Blank Street Coffee', category: 'cafe', cents: 525, minute: 942 };
const CAFE_TARGET = 12000;

/* ------------------------------------------------------------ seeded generator */

function hashOf(...values) {
  let h = 0x811c9dc5;
  for (const value of values) {
    h = Math.imul(h ^ (value | 0), 0x01000193);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

/** A generator of numbers in [0, 1) that depends on nothing but its key (mulberry32). */
function randomOf(...key) {
  let a = hashOf(...key);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function below(rng, count) {
  return Math.floor(rng() * count);
}

function between(rng, low, high) {
  return low + below(rng, high - low + 1);
}

function pick(rng, list) {
  return list[below(rng, list.length)];
}

/** A reference such as banks print after a merchant's name: nine letters and digits, a digit first. */
function reference(rng) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let code = String(below(rng, 10));
  for (let i = 0; i < 8; i++) code += chars[below(rng, chars.length)];
  return code;
}

/* ------------------------------------------------------------------- calendar */

function dayNumber(day) {
  return diffDays(EPOCH, day);
}

function mod(n, m) {
  return ((n % m) + m) % m;
}

function isWorkday(day) {
  const weekday = dow(day);
  return weekday >= 1 && weekday <= 5;
}

function dayOfMonth(ym, day) {
  return ym + '-' + String(day).padStart(2, '0');
}

/** Months since year 0, so that "every third month" means the same months whatever today is. */
function monthIndex(ym) {
  const { y, m } = parts(ym + '-01');
  return y * 12 + m - 1;
}

/** The latest date with this day of the month on or before `day`. */
function latestOn(dayInMonth, day) {
  const thisMonth = dayOfMonth(monthOf(day), dayInMonth);
  return thisMonth <= day ? thisMonth : dayOfMonth(addMonthsYm(monthOf(day), -1), dayInMonth);
}

/** A time of day in seconds after midnight, never on a whole minute (a whole hour would read as a bare date). */
function clockIn(rng, fromMinute, toMinute) {
  return between(rng, fromMinute, toMinute) * 60 + between(rng, 1, 59);
}

/* ------------------------------------------------------------------ the draft */

/** Everything one feed is built from: its days, and the rows of each account as they are thought up. */
function openDraft(today, days, seed) {
  const firstDay = addDays(today, -days);
  const months = [];
  for (let ym = monthOf(firstDay); ym <= monthOf(today); ym = addMonthsYm(ym, 1)) months.push(ym);
  return {
    seed, today, firstDay, months,
    days: eachDay(firstDay, today),
    matchStart: addDays(today, -DEMO_MATCH_DAYS),
    rows: { checking: [], savings: [], card: [] },
    /** convenience spending by day, as the daily game will count it */
    conv: new Map(),
  };
}

function inFeed(draft, day) {
  return day >= draft.firstDay && day <= draft.today;
}

/** A row the bank dates and nothing more (pay, a bill, a transfer): signed cents, posted on its day. */
function post(draft, account, day, cents, text) {
  if (!inFeed(draft, day) || cents === 0) return;
  draft.rows[account].push({ day, clock: null, cents, text, mcc: null, pending: false });
}

/**
 * A purchase made at a time of day. Today's are left out: the feed is the same all day, so it
 * cannot hold a purchase the clock may not have reached (see `pendingToday`).
 * @returns {boolean} true when the purchase is in the feed
 */
function buy(draft, account, day, clock, cents, seller) {
  if (!inFeed(draft, day) || day === draft.today || !(cents > 0)) return false;
  draft.rows[account].push({ day, clock, cents: -cents, text: seller.text, mcc: seller.mcc, pending: false });
  return true;
}

/** A purchase in the daily game. */
function stop(draft, account, day, clock, cents, seller) {
  if (buy(draft, account, day, clock, cents, seller)) draft.conv.set(day, (draft.conv.get(day) || 0) + cents);
}

/** Something bought today: the bank has it as pending, with the day and no time. */
function pendingToday(draft, account, cents, seller) {
  if (!(cents > 0)) return;
  draft.rows[account].push({ day: draft.today, clock: null, cents: -cents, text: seller.text, mcc: seller.mcc, pending: true });
}

function payCard(draft, day, cents, text) {
  post(draft, 'checking', day, -cents, text);
  post(draft, 'card', day, cents, TEXT.paymentReceived);
}

/* --------------------------------------------------------------------- income */

function addIncome(draft) {
  const anchor = dayNumber(PAYDAY_ANCHOR);
  const raised = addDays(draft.today, -PAY.raisedDaysAgo);
  for (const day of draft.days) {
    const n = dayNumber(day);
    if (mod(n - anchor, PAY_PERIOD_DAYS) === 0) post(draft, 'checking', day, day < raised ? PAY.before : PAY.now, TEXT.payroll);
    for (const client of CLIENTS) {
      if (mod(n + client.phase, client.every) !== 0) continue;
      const turn = Math.floor((n + client.phase) / client.every);
      post(draft, 'checking', day, client.amounts[mod(turn, client.amounts.length)], client.text);
    }
  }
  post(draft, 'checking', addDays(draft.today, -ONE_OFF_CLIENT.daysAgo), ONE_OFF_CLIENT.cents, TEXT.oneOffClient);
  for (const [daysAgo, cents] of SAVINGS_DRAWS) {
    const day = addDays(draft.today, -daysAgo);
    post(draft, 'savings', day, -cents, TEXT.toChecking);
    post(draft, 'checking', day, cents, TEXT.fromSavings);
  }
}

/* ---------------------------------------------------------------------- bills */

/**
 * The power bill: it follows the seasons and swings from one month to the next by more than a
 * tenth and less than a third, which is what makes it a variable bill and never a steady one.
 */
function powerBill(seed, ym) {
  const index = monthIndex(ym);
  const season = 1 + 0.12 * Math.cos((2 * Math.PI * (parts(ym + '-01').m - 7.5)) / 12);
  const swing = index % 2 === 0 ? 1.1 : 0.9;
  return Math.round(POWER_BASE * season * swing) + below(randomOf(seed, SALT.power, index), 37);
}

function addBills(draft) {
  const newPriceFrom = latestOn(STREAMING_DAY, draft.today);
  const lateMonth = monthOf(latestOn(CARD_DUE_DAY + 2, addDays(draft.today, -LATE_FEE_AGE_DAYS)));
  for (const ym of draft.months) {
    for (const bill of MONTHLY_BILLS) post(draft, bill.account, dayOfMonth(ym, bill.onDay), -bill.cents, bill.text);
    post(draft, 'checking', dayOfMonth(ym, POWER_DAY), -powerBill(draft.seed, ym), TEXT.power);
    const streamingDay = dayOfMonth(ym, STREAMING_DAY);
    post(draft, 'card', streamingDay, streamingDay < newPriceFrom ? -STREAMING_PRICE.before : -STREAMING_PRICE.now, TEXT.streaming);
    // One payment went out a day late, and the card charged for it.
    const late = ym === lateMonth;
    payCard(draft, dayOfMonth(ym, late ? CARD_DUE_DAY + 1 : CARD_DUE_DAY), CARD_PAYMENT, TEXT.scheduledPayment);
    if (late) post(draft, 'card', dayOfMonth(ym, CARD_DUE_DAY + 2), -LATE_FEE, TEXT.lateFee);
  }
  const renewed = addDays(draft.today, -YEARLY.daysAgo);
  for (const day of [addMonths(renewed, -12), renewed]) {
    const code = reference(randomOf(draft.seed, SALT.month, dayNumber(day)));
    post(draft, 'checking', day, -YEARLY.cents, TEXT.yearly + code + TEXT.orderTail);
  }
}

/** What goes on the card month by month besides the bills: an online order, sometimes sent back, and now and then gear. */
function addCardShopping(draft) {
  for (const ym of draft.months) {
    const index = monthIndex(ym);
    const rng = randomOf(draft.seed, SALT.month, index);
    // Early in even months and late in odd ones: two orders are never a month apart.
    const orderDay = dayOfMonth(ym, index % 2 === 0 ? between(rng, 3, 9) : between(rng, 19, 26));
    const orderPrice = between(rng, ORDER.low, ORDER.high);
    post(draft, 'card', orderDay, -orderPrice, TEXT.order + reference(rng) + TEXT.orderTail);
    if (mod(index, ORDER.refundEvery) === 1) post(draft, 'card', addDays(orderDay, ORDER.refundAfterDays), orderPrice, TEXT.orderRefund);
    if (mod(index, GEAR_EVERY_MONTHS) !== 0) continue;
    // The shops take turns, so the same one comes round every ninth month: no cadence fits that.
    const turn = index / GEAR_EVERY_MONTHS;
    const gearPrice = GEAR_PRICES[mod(turn, GEAR_PRICES.length)];
    post(draft, 'card', dayOfMonth(ym, between(rng, 8, 22)), -gearPrice, GEAR_SHOPS[mod(turn, GEAR_SHOPS.length)].text);
  }
}

/* -------------------------------------------------------------------- errands */

/** The days of an errand that comes round every `shortest`..`longest` days, each with its own generator and its number in the round. */
function roundDays(draft, { salt, shortest, longest }) {
  const first = dayNumber(draft.firstDay);
  const last = dayNumber(draft.today);
  const origin = (Math.floor(first / ROUND_BLOCK_DAYS) - 1) * ROUND_BLOCK_DAYS;
  const visits = [];
  let n = origin;
  for (let turn = 0; n <= last; turn++) {
    const rng = randomOf(draft.seed, salt, origin, turn);
    n += between(rng, shortest, longest);
    if (n >= first && n <= last) visits.push({ day: addDays(EPOCH, n), rng, turn });
  }
  return visits;
}

function priceAt(rng, seller) {
  return between(rng, seller.low, seller.high);
}

function addErrands(draft) {
  for (const day of draft.days) {
    const rng = randomOf(draft.seed, SALT.errands, dayNumber(day));
    const work = isWorkday(day);
    if (rng() < (work ? 0.93 : 0.4)) buy(draft, 'checking', day, clockIn(rng, work ? 425 : 600, work ? 520 : 780), FARE, SUBWAY);
    if (rng() < (work ? 0.9 : 0.35)) buy(draft, 'checking', day, clockIn(rng, 1030, 1170), FARE, SUBWAY);
  }
  for (const { day, rng, turn } of roundDays(draft, ROUNDS.groceries)) {
    const size = mod(turn * GROCERY.sizeJump, GROCERY.sizes);
    const cents = Math.round(GROCERY.smallest * GROCERY.sizeStep ** size * (1 + GROCERY.spread * rng()));
    buy(draft, 'checking', day, clockIn(rng, 1050, 1230), cents, pick(rng, GROCERS));
  }
  const errand = (round, fromMinute, toMinute, seller, priceOf) => {
    for (const { day, rng } of roundDays(draft, round)) buy(draft, 'checking', day, clockIn(rng, fromMinute, toMinute), priceOf(rng), seller);
  };
  errand(ROUNDS.laundry, 600, 1200, LAUNDRY, () => LAUNDRY_PRICE);
  errand(ROUNDS.cash, 700, 1250, CASH_MACHINE, (rng) => pick(rng, CASH_AMOUNTS));
  errand(ROUNDS.cinema, 1080, 1260, CINEMA, (rng) => priceAt(rng, CINEMA));
  errand(ROUNDS.clothes, 780, 1140, CLOTHES, (rng) => priceAt(rng, CLOTHES));
  errand(ROUNDS.pharmacy, 1050, 1200, PHARMACY, (rng) => priceAt(rng, PHARMACY));
  errand(ROUNDS.rides, 1330, 1430, RIDE, (rng) => priceAt(rng, RIDE));
}

/* -------------------------------------------------------------- the daily game */

function smallStop(habit, rng) {
  return Math.min(between(rng, 325, 425), Math.floor(habit / 4));
}

/** Two stops that add up to `total`: the first at its own price, or a third of a total too small for that. */
function splitStops(total, first, firstSlot, secondSlot) {
  const head = Math.min(first, Math.round(total / 3));
  return [[firstSlot, head], [secondSlot, total - head]];
}

function slotOn(name, day) {
  return SLOTS[!isWorkday(day) && DAY_OFF_SLOTS[name] ? DAY_OFF_SLOTS[name] : name];
}

/** One stop in a slot: at a seller of that slot, at a time inside it, for `cents` (or the seller's own price). */
function visit(draft, day, rng, slot, cents) {
  const seller = pick(rng, slot.shops);
  const clock = clockIn(rng, slot.from, slot.to);
  stop(draft, slot.account, day, clock, cents === undefined ? priceAt(rng, seller) : cents, seller);
}

/** A day as the owner used to play it: the stops come and go, and sometimes repeat within a day. */
function playUsualDay(draft, day) {
  const rng = randomOf(draft.seed, SALT.game, dayNumber(day));
  for (const [name, chance] of isWorkday(day) ? USUAL.work : USUAL.off) {
    if (rng() < chance) visit(draft, day, rng, SLOTS[name]);
  }
  if (mod(dayNumber(day), USUAL.deliveryEveryDays) === 2) visit(draft, day, rng, SLOTS.delivery);
  const nightBefore = dow(day) === 5 || dow(day) === 6;
  if (nightBefore && rng() < USUAL.lateNightChance) visit(draft, day, rng, SLOTS.lateNight);
}

/**
 * The habit the days before the match add up to — worked out here exactly as detect.computeHabit
 * will, so that the scripted days can be sized against it.
 */
function habitOf(draft) {
  let firstRow = draft.today;
  for (const rows of Object.values(draft.rows)) {
    for (const row of rows) if (row.day < firstRow) firstRow = row.day;
  }
  const from = maxYmd(addDays(draft.matchStart, -HABIT_WINDOW_DAYS), firstRow);
  const to = addDays(draft.matchStart, -1);
  if (diffDays(from, to) + 1 < HABIT_MINIMUM_DAYS) return FALLBACK_HABIT;
  const spent = { work: [], off: [] };
  for (const day of eachDay(from, to)) spent[isWorkday(day) ? 'work' : 'off'].push(draft.conv.get(day) || 0);
  const mean = (list) => roundCents(list.reduce((total, cents) => total + cents, 0) / list.length);
  const overall = mean(spent.work.concat(spent.off));
  return { work: spent.work.length ? mean(spent.work) : overall, off: spent.off.length ? mean(spent.off) : overall };
}

function habitOn(habit, day) {
  return isWorkday(day) ? habit.work : habit.off;
}

/** The scene of the match played on a day; null outside its four calendar weeks. */
function sceneOn(today, day) {
  const week = MATCH_WEEKS[diffDays(weekStart(day), weekStart(today)) / WEEK_DAYS];
  return week ? week[(dow(day) + 6) % WEEK_DAYS] : null;
}

/** The days of the match that are over, oldest first, each with its scene. */
function matchDays(today) {
  return eachDay(addDays(today, -DEMO_MATCH_DAYS), addDays(today, -1)).map((day) => ({ day, scene: sceneOn(today, day) }));
}

function playMatch(draft, habit) {
  for (const { day, scene: played } of matchDays(draft.today)) {
    const rng = randomOf(draft.seed, SALT.script, dayNumber(day));
    for (const [name, cents] of PLAYS[played.play](habitOn(habit, day), rng)) visit(draft, day, rng, slotOn(name, day), cents);
  }
  // Today so far: one small stop and the ride in. Both are still pending.
  const rng = randomOf(draft.seed, SALT.script, dayNumber(draft.today));
  pendingToday(draft, 'checking', smallStop(habitOn(habit, draft.today), rng), pick(rng, slotOn('morning', draft.today).shops));
  pendingToday(draft, 'checking', FARE, SUBWAY);
}

/**
 * The week before last kept money against habit, and on the Tuesday after it the owner moved it
 * to the card, in whole dollars: the sweep the app records by itself. Last week's is still open.
 */
function addSweep(draft, habit) {
  const monday = addDays(weekStart(draft.today), -2 * WEEK_DAYS);
  let kept = 0;
  for (const day of eachDay(maxYmd(monday, draft.matchStart), addDays(monday, WEEK_DAYS - 1))) {
    kept += habitOn(habit, day) - (draft.conv.get(day) || 0);
  }
  const amount = Math.floor(kept / DOLLAR) * DOLLAR;
  if (amount >= 5 * DOLLAR) payCard(draft, addDays(monday, WEEK_DAYS + 1), amount, TEXT.extraPayment);
}

/* ----------------------------------------------------------- interest, balances */

function effectsByDay(rows) {
  const byDay = new Map();
  for (const row of rows) byDay.set(row.day, (byDay.get(row.day) || 0) + row.cents);
  return byDay;
}

/**
 * Run the card forward from what it owed before the feed: interest is charged on each statement
 * day on what is owed that morning.
 * @returns {{ rows: { day: string, cents: number }[], owed: number }}  the interest charges, and what is owed at the end
 */
function runCard(draft, owedAtStart) {
  const effects = effectsByDay(draft.rows.card);
  const rows = [];
  let owed = owedAtStart;
  for (const day of draft.days) {
    if (parts(day).d === CARD_STATEMENT_DAY && owed > 0) {
      const interest = roundCents((owed * CARD_APR) / 1200);
      rows.push({ day, cents: -interest });
      owed += interest;
    }
    owed -= effects.get(day) || 0;
  }
  return { rows, owed };
}

/**
 * Add the interest charges of the feed, starting from the balance that leaves the card owing
 * about `target` today (what is owed at the end rises in a straight line with what was owed at the start).
 * @returns {number} cents owed today
 */
function addCardInterest(draft, target) {
  const step = 100000;
  const fromTarget = runCard(draft, target).owed;
  const slope = (runCard(draft, target + step).owed - fromTarget) / step;
  const start = slope > 0 ? Math.max(0, Math.round(target + (target - fromTarget) / slope)) : target;
  const { rows, owed } = runCard(draft, start);
  for (const row of rows) post(draft, 'card', row.day, row.cents, TEXT.cardInterest);
  return owed;
}

/** Interest on what the savings held, month by month, worked back from what they hold now. */
function addSavingsInterest(draft, balanceNow) {
  const effects = effectsByDay(draft.rows.savings);
  let balance = balanceNow;
  for (let i = draft.days.length - 1; i >= 0; i--) {
    const day = draft.days[i];
    if (day === endOfMonth(day)) {
      const interest = Math.max(1, Math.round(balance * SAVINGS_MONTHLY_RATE));
      post(draft, 'savings', day, interest, TEXT.savingsInterest);
      balance -= interest;
    }
    balance -= effects.get(day) || 0;
  }
}

/** The balance now that keeps the lowest end-of-day balance in the feed at `floor`. */
function balanceAbove(rows, floor) {
  const newestFirst = [...effectsByDay(rows)].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  let since = 0;
  let most = 0;
  for (const [, cents] of newestFirst) {
    since += cents;
    most = Math.max(most, since);
  }
  return floor + most;
}

function pendingTotal(rows) {
  return rows.reduce((total, row) => total + (row.pending ? row.cents : 0), 0);
}

/* ------------------------------------------------------------------- the feed */

/** Noon UTC of a day, in epoch seconds: how a bank writes a date with no time (dates.feedDay). */
function dateSeconds(day) {
  const { y, m, d } = parts(day);
  return Date.UTC(y, m - 1, d, 12) / 1000;
}

/** The local instant `clock` seconds after midnight of a day, in epoch seconds. */
function clockSeconds(day, clock) {
  const { y, m, d } = parts(day);
  return Math.floor(new Date(y, m - 1, d, 0, 0, clock).getTime() / 1000);
}

function feedRow(row, extId) {
  const base = { extId, amount: row.cents, description: row.text, payee: '', memo: '', mcc: row.mcc };
  if (row.pending) return { ...base, posted: null, at: dateSeconds(row.day), pending: true };
  if (row.clock === null) return { ...base, posted: dateSeconds(row.day), at: null, pending: false };
  const postsAfterDays = row.clock >= DAY_MINUTES * 60 ? 2 : 1;
  return { ...base, posted: dateSeconds(addDays(row.day, postsAfterDays)), at: clockSeconds(row.day, row.clock), pending: false };
}

/** Rows in the order a statement lists them: by day, dated rows before timed ones, then by time. */
function feedRows(rows, code) {
  const ordered = rows
    .map((row, order) => ({ row, order }))
    .sort((a, b) => (a.row.day < b.row.day ? -1 : a.row.day > b.row.day ? 1 : (a.row.clock || 0) - (b.row.clock || 0) || a.order - b.order));
  let day = '';
  let count = 0;
  return ordered.map(({ row }) => {
    count = row.day === day ? count + 1 : 1;
    day = row.day;
    return feedRow(row, code + '-' + dayNumber(day) + '-' + String(count).padStart(2, '0'));
  });
}

function buildFeed(today, days, seed) {
  const draft = openDraft(today, days, seed);
  addIncome(draft);
  addBills(draft);
  addCardShopping(draft);
  addErrands(draft);
  for (const day of draft.days) if (day < draft.matchStart) playUsualDay(draft, day);
  const habit = habitOf(draft);
  playMatch(draft, habit);
  addSweep(draft, habit);

  const cents = (which, range) => below(randomOf(seed, SALT.balances, which), range);
  const cardOwed = addCardInterest(draft, CARD_OWED_NOW + cents(1, 6000));
  const savings = SAVINGS_NOW + cents(2, 90);
  addSavingsInterest(draft, savings);
  const pending = pendingTotal(draft.rows.checking);
  const checking = balanceAbove(draft.rows.checking, CHECKING_FLOOR + cents(3, 9000)) - pending;
  const balances = {
    checking: { balance: checking, available: checking + pending },
    savings: { balance: savings, available: savings },
    card: { balance: -cardOwed, available: CARD_LIMIT - cardOwed },
  };
  const fetchedAt = gameDayStartMs(today, ROLLOVER_HOUR);
  return {
    src: 'demo',
    fetchedAt,
    fromMs: gameDayStartMs(draft.firstDay, ROLLOVER_HOUR),
    toMs: fetchedAt,
    accounts: ACCOUNTS.map((account) => ({
      extId: account.extId,
      connId: CONNECTION,
      institution: BANK,
      name: account.name,
      currency: 'USD',
      ...balances[account.key],
      asOf: fetchedAt,
      txs: feedRows(draft.rows[account.key], account.code),
    })),
    errors: [],
  };
}

/* --------------------------------------------------------------------- public */

/** Today's game day. An instant no sample can be built for reads as the earliest one that can (never as the real clock). */
function todayOf(nowMs) {
  const usable = Number.isFinite(nowMs) && nowMs >= EARLIEST_MS && nowMs <= LATEST_MS;
  return gameDay(usable ? nowMs : EARLIEST_MS, ROLLOVER_HOUR);
}

function seedOf(opts) {
  return opts && Number.isFinite(opts.seed) ? Math.trunc(opts.seed) : DEFAULT_SEED;
}

function daysOf(opts) {
  return opts && Number.isFinite(opts.days) ? Math.min(LONGEST_DAYS, Math.max(1, Math.floor(opts.days))) : DEFAULT_DAYS;
}

/**
 * Build a sample feed ending at `nowMs`, covering the previous `days` days (default 150).
 * The same `nowMs` (to the day) and `seed` always produce the same feed.
 * The invented owner: a salaried worker paid every two weeks (about $1,900 net) with occasional client
 * deposits; a checking account, a savings account near empty, one credit card carrying roughly $4,000;
 * monthly rent for a workspace, a handful of subscriptions, a phone bill, an annual renewal;
 * weekday cafe and deli stops that sometimes repeat (two or three in a day), groceries, transit, a few
 * marketplace orders, card payments from checking, monthly card interest, one late fee, a couple of
 * pending rows on the last day. Descriptions look like real statement descriptors (store numbers,
 * city/state tails, processor prefixes) so the classifier is exercised.
 * The last ~3 weeks should show slightly better behaviour than the earlier baseline so the demo
 * tells a story (a positive edge, some clean sheets, a lost round or two).
 * "The day" is the game day at the default rollover (4 a.m.). `days` is held between 1 and 1500; the
 * annual renewal is charged once a year, so a feed shorter than about 380 days holds one charge of it.
 * A `nowMs` that is not a time between the years 1975 and 9000 reads as the start of 1975.
 * @param {number} nowMs
 * @param {{ days?: number, seed?: number }} [opts]
 * @returns {import('./feed.js').Feed}  src 'demo'
 */
export function demoFeed(nowMs, opts) {
  return buildFeed(todayOf(nowMs), daysOf(opts), seedOf(opts));
}

/**
 * The things a bank cannot see, for the sample owner: equipment worth $18,000 (quickSale 0.5) and an
 * equipment loan of $9,500 at 6.5% with a $240 monthly payment due on the 5th (assumeScheduled true).
 * Both were entered on the day the match began, which is the day their one history entry carries.
 * @param {number} nowMs
 * @returns {object[]}  Account objects (source 'manual') with `history`
 */
export function demoManualAccounts(nowMs) {
  const entered = addDays(todayOf(nowMs), -DEMO_MATCH_DAYS);
  const asOf = gameDayStartMs(entered, ROLLOVER_HOUR) + 5 * HOUR_MS;
  return [
    makeAccount({
      id: 'acc_demoequip', type: 'equipment', name: 'Studio equipment', purpose: 'studio',
      balance: 1800000, asOf, basis: 'estimate', quickSale: 0.5,
      history: [{ day: entered, balance: 1800000, note: 'What it would cost to replace' }],
    }),
    makeAccount({
      id: 'acc_demoloan0', type: 'loan', name: 'Equipment loan', institution: 'Alderline Equipment Finance', purpose: 'studio',
      balance: -950000, asOf, basis: 'statement', apr: 6.5, dueDay: 5, loan: { payment: 24000, assumeScheduled: true },
      history: [{ day: entered, balance: -950000, note: 'From the lender statement' }],
    }),
  ];
}

/** The sample player's own rules (settings.principles): invented. */
const SAMPLE_PRINCIPLES = ['Look at the card balance every Friday.', 'Cancel one subscription before adding another.', 'Groceries on Sunday, with a list.', 'Wait a night before anything over $100.'];
/** What the sample player wants ready before leaving (settings.preps): invented. */
const SAMPLE_PREPS = ['Gym bag packed', 'Shopping list written'];

/**
 * A complete sample document: defaultState + demo manual accounts + mergeFeed(demoFeed) +
 * detect.refresh, with meta.origin 'demo'. The match is started 21 days before `nowMs` (so the
 * crosstable has three weeks of rounds): set meta.matchStart and compute the first habit segment from
 * the 60 days before that. Also adds a morning plan to a few recent workdays, one bye, one declined
 * purchase yesterday and a category target for cafes, so every feature has something to show.
 * The feed behind it covers DEMO_HISTORY_DAYS days, and the owner has entered the card's rate, limit
 * and due day. Like the feed, the document depends on the game day of `nowMs` and the seed alone —
 * its ids and timestamps included.
 * @param {number} nowMs
 * @param {{ seed?: number }} [opts]
 * @returns {object} state
 */
export function buildDemoState(nowMs, opts) {
  const seed = seedOf(opts);
  const today = todayOf(nowMs);
  const asOf = gameDayStartMs(today, ROLLOVER_HOUR);
  const state = defaultState(asOf);
  // The feed draws its days at this hour; the document must read them at the same one.
  state.settings.rolloverHour = ROLLOVER_HOUR;
  // the sample player's own rules: invented, like every figure of the sample game
  state.settings.principles = SAMPLE_PRINCIPLES.slice();
  state.settings.preps = SAMPLE_PREPS.slice();
  state.meta.origin = 'demo';
  state.accounts.push(...demoManualAccounts(asOf));
  mergeFeed(state, buildFeed(today, DEMO_HISTORY_DAYS, seed), asOf);
  state.sync.lastTry = state.sync.lastOk;
  enterCardTerms(state);
  beginMatch(state, addDays(today, -DEMO_MATCH_DAYS));
  addOwnerNotes(state, today, asOf);
  refresh(state, asOf);
  settleIds(state, seed);
  return state;
}

/* --------------------------------------------------------------- the document */

function enterCardTerms(state) {
  const card = state.accounts.find((account) => account.ext && account.ext.id === CARD_EXT_ID);
  if (card) Object.assign(card, { apr: CARD_APR, limit: CARD_LIMIT, dueDay: CARD_DUE_DAY });
}

/** Start the match on a past day, as the first sync would have: the habit comes from the 60 days before it. */
function beginMatch(state, matchStart) {
  const segment = computeHabit(state, addDays(matchStart, -HABIT_WINDOW_DAYS), addDays(matchStart, -1));
  state.meta.matchStart = matchStart;
  if (segment) state.habits.push({ from: matchStart, ...segment });
}

/** The optional things the owner did during the match: morning plans, a bye, a purchase declined yesterday, a target. */
function addOwnerNotes(state, today, asOf) {
  for (const { day, scene: played } of matchDays(today)) {
    if (played.plan !== null) {
      const at = gameDayStartMs(day, ROLLOVER_HOUR) + PLAN_MADE_AFTER_MS;
      state.days[day] = { plan: { ready: [{ label: SAMPLE_PREPS[0], yes: true }, { label: SAMPLE_PREPS[1], yes: played.plan === 0 }], stops: played.plan, at } };
    }
    if (played.bye) state.days[day] = { bye: true, note: BYE_NOTE };
  }
  state.settings.targets.cafe = CAFE_TARGET;

  const yesterday = addDays(today, -1);
  const declined = addDecline(state, {
    amount: DECLINE.cents, merchant: DECLINE.merchant, category: DECLINE.category, day: yesterday, instead: state.settings.insteads[0],
  }, asOf);
  if (declined) {
    declined.at = clockSeconds(yesterday, DECLINE.minute * 60 + 30) * 1000;
    declined.loggedAt = declined.at;
  }
}

/**
 * Give everything the pipeline created an id drawn from the seed in place of a random one, and
 * follow every reference, so that the same day and seed give the same document to the letter.
 */
function settleIds(state, seed) {
  const rng = randomOf(seed, SALT.ids);
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const renamed = new Map();
  const taken = new Set(state.accounts.map((account) => account.id));
  const rename = (item, prefix) => {
    let id;
    do {
      id = prefix + '_';
      for (let i = 0; i < 8; i++) id += chars[below(rng, chars.length)];
    } while (taken.has(id));
    taken.add(id);
    renamed.set(item.id, id);
    item.id = id;
  };
  for (const account of state.accounts) if (account.source === 'bank') rename(account, 'acc');
  for (const tx of state.txs) rename(tx, 'tx');
  for (const entry of state.recurring) rename(entry, 'rec');
  for (const stream of state.streams) rename(stream, 'str');

  const idNow = (id) => (renamed.has(id) ? renamed.get(id) : id);
  for (const tx of state.txs) {
    for (const field of ['accountId', 'recurringId', 'streamId', 'pairId', 'matchId']) tx[field] = idNow(tx[field]);
    // A fingerprint begins with the account's id.
    const cut = tx.fp.indexOf('|');
    if (cut > 0) tx.fp = idNow(tx.fp.slice(0, cut)) + tx.fp.slice(cut);
  }
  for (const entry of state.recurring) {
    entry.accountId = idNow(entry.accountId);
    entry.toAccountId = idNow(entry.toAccountId);
  }
  for (const stream of state.streams) stream.accountId = idNow(stream.accountId);
  for (const sweep of state.sweeps) sweep.txId = idNow(sweep.txId);
}
