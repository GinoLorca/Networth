/**
 * The words of the interface, in its two modes. See ARCHITECTURE.md section 11.
 *
 *   'chess'    Chess words, the default: the app's own metaphors (Board, round, Habit, the Book …).
 *   'finance'  Finance words: the standard finance and accounting name of each (Overview, day, baseline, Recurring …).
 *
 * Only words change between the modes: never a figure, a rule or the layout. Every term and every sentence that
 * changes is defined here, once, in both modes; nothing else spells a term that changes. Model functions take the
 * mode as an option (`opts.words`, Chess words when absent), and views read it from the render context
 * (`ctx.words`, which app.js takes from the document with `wordsOf`).
 *
 * PUBLIC CONTRACT
 *   WORDS, DEFAULT_WORDS         the two modes, and the default ('chess')
 *   wordsMode(value)             a mode: 'finance' stays 'finance', anything else is 'chess'
 *   wordsOf(state)               the document's mode (settings.words)
 *   say(key, mode, vars?)        a sentence or label of PHRASES in that mode, its {placeholders} filled from vars
 *   phrase(key, mode)            the same, unfilled
 *   term(key, mode)              a glossary term's name in that mode (TERMS)
 *   glyphName(glyph, mode)       the name of an annotation sign: '!!' '!' '!?' '?!' '?' '??' '□'
 *   evalName(symbol, mode)       the name of an evaluation step: 'winning' … 'losing', 'unclear'
 *   resultText(result, mode)     the one-character mark of a result 1 | 0.5 | 0
 *   resultName(result, mode)     its name ('Win' / 'Under budget'), resultWords(result, mode) its words in a sentence
 *   lowerFirst(text)             a name as it reads inside a sentence ('Good move' -> 'good move', 'ROI pending' stays)
 *   TERM_GROUPS, TERMS           the glossary: every term by group, both names and a one-line meaning
 *   termsByGroup()               [{ group, terms }] in the glossary's order
 *
 * Pure and importable under node: no imports, no DOM, no storage, no clock.
 */

/** The two modes, the default first. */
export const WORDS = Object.freeze(['chess', 'finance']);
export const DEFAULT_WORDS = 'chess';

/**
 * A mode from anything: 'finance' is Finance words, everything else (absent, unknown) Chess words.
 * @param {*} value
 * @returns {'chess'|'finance'}
 */
export function wordsMode(value) {
  return value === 'finance' ? 'finance' : DEFAULT_WORDS;
}

/**
 * The mode a document is set to (`settings.words`); Chess words for a document that has none.
 * @param {object} state
 * @returns {'chess'|'finance'}
 */
export function wordsOf(state) {
  const settings = state && typeof state === 'object' && state.settings && typeof state.settings === 'object' ? state.settings : null;
  return wordsMode(settings ? settings.words : undefined);
}

/* -------------------------------------------------------------- signs and marks */

/** The annotation signs, in the order they are listed, and their names. */
export const GLYPH_NAMES = Object.freeze({
  '!!': Object.freeze({ chess: 'Brilliant', finance: 'No-spend day' }),
  '!': Object.freeze({ chess: 'Good move', finance: 'Good decision' }),
  '!?': Object.freeze({ chess: 'Interesting', finance: 'ROI pending' }),
  '?!': Object.freeze({ chess: 'Dubious', finance: 'Unplanned purchase' }),
  '?': Object.freeze({ chess: 'Mistake', finance: 'Poor decision' }),
  '??': Object.freeze({ chess: 'Blunder', finance: 'Penalty fee' }),
  '□': Object.freeze({ chess: 'Only move', finance: 'Fixed obligation' }),
});

/** The evaluation steps, best to worst, then 'unclear', and their names. */
export const EVAL_NAMES = Object.freeze({
  winning: Object.freeze({ chess: 'Winning', finance: 'Strong' }),
  clear_plus: Object.freeze({ chess: 'Clear advantage', finance: 'Favorable' }),
  slight_plus: Object.freeze({ chess: 'Slight advantage', finance: 'Slightly favorable' }),
  equal: Object.freeze({ chess: 'Equal', finance: 'Neutral' }),
  slight_minus: Object.freeze({ chess: 'Slightly worse', finance: 'Slightly unfavorable' }),
  clear_minus: Object.freeze({ chess: 'Clearly worse', finance: 'Unfavorable' }),
  losing: Object.freeze({ chess: 'Losing', finance: 'Critical' }),
  unclear: Object.freeze({ chess: 'Unclear', finance: 'Not enough data' }),
});

/** A day's result: its mark, its name, and its words inside a sentence. */
const RESULTS = Object.freeze({
  1: Object.freeze({ text: { chess: '1', finance: '✓' }, name: { chess: 'Win', finance: 'Under budget' }, words: { chess: 'a win', finance: 'under budget' } }),
  0.5: Object.freeze({ text: { chess: '½', finance: '=' }, name: { chess: 'Draw', finance: 'On budget' }, words: { chess: 'a draw', finance: 'on budget' } }),
  0: Object.freeze({ text: { chess: '0', finance: '✗' }, name: { chess: 'Loss', finance: 'Over budget' }, words: { chess: 'a loss', finance: 'over budget' } }),
});

/** The name of an annotation sign ('□' also as 'box' or 'only'); '' for anything else. */
export function glyphName(glyph, mode) {
  const key = glyph === 'box' || glyph === 'only' ? '□' : glyph;
  return typeof key === 'string' && Object.hasOwn(GLYPH_NAMES, key) ? GLYPH_NAMES[key][wordsMode(mode)] : '';
}

/** The name of an evaluation step; '' for anything else. */
export function evalName(symbol, mode) {
  return typeof symbol === 'string' && Object.hasOwn(EVAL_NAMES, symbol) ? EVAL_NAMES[symbol][wordsMode(mode)] : '';
}

/** The mark of a result (1, 0.5 or 0); '' for anything else. */
export function resultText(result, mode) {
  return resultOf(result) ? resultOf(result).text[wordsMode(mode)] : '';
}

/** The name of a result: 'Win' / 'Under budget'; '' for anything else. */
export function resultName(result, mode) {
  return resultOf(result) ? resultOf(result).name[wordsMode(mode)] : '';
}

/** A result inside a sentence: 'a win' / 'under budget'; '' for anything else. */
export function resultWords(result, mode) {
  return resultOf(result) ? resultOf(result).words[wordsMode(mode)] : '';
}

function resultOf(result) {
  return result === 1 || result === 0.5 || result === 0 ? RESULTS[result] : null;
}

/** A name as it reads inside a sentence: its first letter in lower case, unless the name opens with an acronym. */
export function lowerFirst(text) {
  if (typeof text !== 'string' || !text) return '';
  if (text.length > 1 && text[1] >= 'A' && text[1] <= 'Z') return text;
  return text[0].toLowerCase() + text.slice(1);
}

/* -------------------------------------------------------------------- phrases */

/**
 * Every label and sentence that changes with the mode, as templates: `{name}` is filled by `say` from its vars
 * (an amount, a date or a count already formatted by the caller). Both versions of a phrase take the same
 * placeholders (tested). Keys are grouped by the module that says them: page.*, assess.*, annotate.*,
 * forecast.*, schema.*, words.* (the switch and the glossary). Views add theirs as view.* (one prefix per view).
 */
export const PHRASES = Object.freeze({
  /* pages: the tab bar, the page titles */
  'page.board': { chess: 'Board', finance: 'Overview' },
  'page.scoresheet': { chess: 'Scoresheet', finance: 'Transactions' },
  'page.material': { chess: 'Material', finance: 'Balance sheet' },
  'page.book': { chess: 'Book', finance: 'Recurring' },
  'page.analysis': { chess: 'Analysis', finance: 'Analysis' },

  /* app.js: the shell around every page (masthead, tab bar, banners, footer) */
  'app.round': { chess: 'Round {d} of {days}', finance: 'Day {d} of {days}' },
  'app.wordmark': { chess: 'Networth, the board', finance: 'Networth, overview' },
  'app.move': { chess: 'Move', finance: 'Purchase' },
  'app.sample': { chess: 'Sample game', finance: 'Sample data' },
  'app.sample.newest': {
    chess: 'Sample game: Networth is the newest version, checked at {at}.',
    finance: 'Sample data: Networth is the newest version, checked at {at}.',
  },
  'app.sample.checked': { chess: 'Sample game: checked at {at}.', finance: 'Sample data: checked at {at}.' },
  'app.sample.short': { chess: 'Sample game · {at}', finance: 'Sample data · {at}' },
  'app.footer.sample': {
    chess: ' You are looking at a sample game with invented figures.',
    finance: ' You are looking at sample data with invented figures.',
  },

  /* assess.js: the assessment's factors */
  'assess.factor.material': { chess: 'Material', finance: 'Net worth trend' },
  'assess.factor.time': { chess: 'Time', finance: 'Liquidity' },
  'assess.factor.structure': { chess: 'Structure', finance: 'Debt trend' },
  'assess.factor.initiative': { chess: 'Initiative', finance: 'Savings rate' },
  'assess.standing.material.ahead': { chess: 'ahead on material', finance: 'net worth rising' },
  'assess.standing.material.level': { chess: 'level on material', finance: 'net worth flat' },
  'assess.standing.material.behind': { chess: 'behind on material', finance: 'net worth falling' },
  'assess.standing.time.ahead': { chess: 'ahead on time', finance: 'runway healthy' },
  'assess.standing.time.level': { chess: 'level on time', finance: 'runway adequate' },
  'assess.standing.time.behind': { chess: 'short on time', finance: 'runway short' },
  'assess.standing.structure.ahead': { chess: 'sound on structure', finance: 'card debt falling' },
  'assess.standing.structure.level': { chess: 'level on structure', finance: 'card debt steady' },
  'assess.standing.structure.behind': { chess: 'weak on structure', finance: 'card debt rising' },
  'assess.standing.initiative.ahead': { chess: 'ahead on initiative', finance: 'savings rate healthy' },
  'assess.standing.initiative.level': { chess: 'level on initiative', finance: 'savings rate low' },
  'assess.standing.initiative.behind': { chess: 'behind on initiative', finance: 'savings rate negative' },
  'assess.material.onArrival': { chess: '; pay is counted when it arrives.', finance: '; pay is on a cash basis.' },
  'assess.time.noBurn': {
    chess: 'Cash on hand is {cash}; the daily outflow is not known yet.',
    finance: 'Cash on hand is {cash}; the burn rate is not known yet.',
  },
  'assess.afterScheduled': {
    chess: ', after {amount} in payments the Book still schedules',
    finance: ', after {amount} in payments Recurring still schedules',
  },
  'assess.initiative.young': {
    chess: '{month} is {age} old; the share kept of what was earned is read from day {day}.',
    finance: '{month} is {age} old; the savings rate is read from day {day}.',
  },
  'assess.initiative.none': {
    chess: 'Nothing was earned in {month} as of {date}, so there is no share kept to read.',
    finance: 'No income came in during {month} as of {date}, so there is no savings rate to read.',
  },
  'assess.initiative.read': {
    chess: '{month} to date: {earned} earned, {kept} kept{share}.',
    finance: '{month} to date: {earned} income, {kept} saved{share}.',
  },

  /* assess.js: the notes (Coach’s notes / Notices) */
  'assess.notes': { chess: 'Coach’s notes', finance: 'Notices' },
  'assess.shortfall': {
    chess: 'Cash: {cash} on the clock, {due} {window}.',
    finance: 'Cash: {cash} on hand, {due} {window}.',
  },
  'assess.overdue.many': {
    chess: '{count} Book charges are past their day with no charge posted, {total} in all, the oldest from {date}.',
    finance: '{count} recurring charges are past due with no charge posted, {total} in all, the oldest from {date}.',
  },
  'assess.sweep.kept': {
    chess: 'Last week you kept {amount} against habit.',
    finance: 'Last week came in {amount} under baseline.',
  },
  'assess.sweep.card': { chess: 'Move it to the card.', finance: 'Transfer it to the card.' },
  'assess.sweep.reserve': { chess: 'Move it to the reserve.', finance: 'Transfer it to the emergency fund.' },
  'assess.book.new': {
    chess: 'New in the Book: {name}, {amount} {cadence} since {date}.',
    finance: 'New in Recurring: {name}, {amount} {cadence} since {date}.',
  },
  'assess.book.out': { chess: '{amount} {cadence} is out of the Book.', finance: '{amount} {cadence} is out of Recurring.' },
  'assess.reserve.goal': {
    chess: 'The reserve reached its goal of {goal}: {reserve} as of {date}.',
    finance: 'The emergency fund reached its goal of {goal}: {reserve} as of {date}.',
  },
  'assess.reserve.covers': {
    chess: 'The reserve of {reserve} now covers {span} of outflow at {burn} a day.',
    finance: 'The emergency fund of {reserve} now covers {span} of spending at {burn} a day.',
  },
  'assess.scale.perfect': {
    chess: 'A perfect month in the daily game is worth {amount}.',
    finance: 'A month with no convenience spending would come in {amount} under baseline.',
  },
  'assess.scale.book': { chess: 'The Book takes {amount} a month.', finance: 'Recurring bills take {amount} a month.' },
  'assess.review.one': {
    chess: '{count} move is waiting for a purpose, the oldest from {date}.',
    finance: '{count} transaction is waiting for a purpose, the oldest from {date}.',
  },
  'assess.review.many': {
    chess: '{count} moves are waiting for a purpose, the oldest from {date}.',
    finance: '{count} transactions are waiting for a purpose, the oldest from {date}.',
  },
  'assess.unnamedEntry': { chess: 'A Book entry', finance: 'A recurring item' },
  'assess.cta.book': { chess: 'The Book', finance: 'Recurring' },
  'assess.cta.scoresheet': { chess: 'Scoresheet', finance: 'Transactions' },
  'assess.cta.sweep': { chess: 'Move it', finance: 'Transfer it' },

  /* annotate.js: why a move or a round carries its sign */
  'annotate.manual': { chess: 'Annotated by hand: {amount}', finance: 'Marked by you: {amount}' },
  'annotate.declined': { chess: 'Declined purchase: {amount} not spent', finance: 'Skipped purchase: {amount} not spent' },
  'annotate.sweep': { chess: 'Sweep of {amount} recorded', finance: 'Transfer of {amount} recorded' },
  'annotate.outsideBook': { chess: '{what} of {amount} outside the Book', finance: '{what} of {amount} outside Recurring' },
  'annotate.forced': { chess: '{what} of {amount}: a forced move', finance: '{what} of {amount}: a fixed obligation' },
  'annotate.clean': {
    chess: 'Clean sheet on a workday: {zero} against habit at {habit}',
    finance: 'No-spend workday: {zero} against a baseline of {habit}',
  },
  'annotate.toPlan': {
    chess: 'Played to the morning plan: {planned} planned, {made} made',
    finance: 'Stuck to the morning plan: {planned} planned, {made} made',
  },
  'annotate.best.clean': { chess: 'Clean sheet on {kind}', finance: 'No convenience spending on {kind}' },
  'annotate.best.kept': { chess: 'Kept {amount} against habit on {kind}', finance: '{amount} under baseline on {kind}' },
  'annotate.best.level': { chess: 'Level with habit at {habit} on {kind}', finance: 'Level with the baseline at {habit} on {kind}' },
  'annotate.best.over': { chess: '{amount} over habit on {kind}', finance: '{amount} over baseline on {kind}' },
  'annotate.preview.outside': {
    chess: 'Outside the daily game ({label}): {amount} leaves the round at {conv} against habit at {habit}.',
    finance: 'Outside the daily budget ({label}): {amount} leaves the day at {conv} against a baseline of {habit}.',
  },
  'annotate.preview.bye': { chess: 'leaves the bye at a draw', finance: 'leaves the exempt day on budget' },
  'annotate.preview.keeps': { chess: 'keeps the round {result}', finance: 'keeps the day {result}' },
  'annotate.preview.takes': { chess: 'takes the round from {before} to {after}', finance: 'takes the day from {before} to {after}' },
  'annotate.preview.inWin': { chess: '{amount} inside the win line', finance: '{amount} below the target' },
  'annotate.preview.inLoss': { chess: '{amount} inside the loss line', finance: '{amount} below the limit' },
  'annotate.preview.pastLoss': { chess: '{amount} past the loss line', finance: '{amount} past the limit' },

  /* glyphs.js: the names a sign or a mark reads out (aria-label, title) */
  'glyph.timeTrouble': { chess: 'Time trouble', finance: 'Cash crunch' },
  'glyph.live': { chess: 'In play', finance: 'In progress' },
  'glyph.future': { chess: 'Not yet played', finance: 'Upcoming' },
  'glyph.prematch': { chess: 'Before the match', finance: 'Baseline period' },
  'glyph.prematch.after': { chess: '{result}, before the match', finance: '{result}, baseline period' },

  /* forecast.js */
  'forecast.atHabit': { chess: 'At habit', finance: 'At baseline' },
  'forecast.fromCash': { chess: '{amount} from cash leaves {cash} on the clock', finance: '{amount} from cash leaves {cash} on hand' },

  /* schema.js: labels of the document's enumerations, and what an unreadable copy says */
  'schema.klass.game.short': { chess: 'Daily game', finance: 'Daily budget' },
  'schema.klass.book': { chess: 'The Book', finance: 'Recurring bills' },
  'schema.klass.book.short': { chess: 'Book', finance: 'Recurring' },
  'schema.account.cash': { chess: 'Cash in hand', finance: 'Physical cash' },
  'schema.kind.decline': { chess: 'Declined', finance: 'Skipped' },
  'schema.noun.tx': { chess: 'move', finance: 'transaction' },
  'schema.noun.recurring': { chess: 'Book entry', finance: 'recurring item' },
  'schema.noun.habit': { chess: 'opponent', finance: 'baseline' },

  /* the switch (Settings → Appearance) and the glossary sheet: the same in both modes, since they name both */
  'words.legend': { chess: 'Words', finance: 'Words' },
  'words.option.chess': { chess: 'Chess', finance: 'Chess' },
  'words.option.finance': { chess: 'Finance', finance: 'Finance' },
  'words.help': {
    chess: 'Chess words is the app’s own way of speaking; Finance words gives each term its standard finance or accounting name. Only words change, never a figure or a rule. With the list shared, your other devices follow.',
    finance: 'Chess words is the app’s own way of speaking; Finance words gives each term its standard finance or accounting name. Only words change, never a figure or a rule. With the list shared, your other devices follow.',
  },
  'words.open': { chess: 'See every term', finance: 'See every term' },
  'words.forced': { chess: 'This visit’s address sets {mode} words; later visits use {saved} words, chosen below.', finance: 'This visit’s address sets {mode} words; later visits use {saved} words, chosen below.' },
  'words.forced.sample': { chess: 'This visit’s address sets {mode} words; the sample keeps no choice.', finance: 'This visit’s address sets {mode} words; the sample keeps no choice.' },
  'words.sheet': { chess: 'Every term', finance: 'Every term' },
  'words.head': { chess: 'Words', finance: 'Words' },
  'words.title': { chess: 'Every term, both ways.', finance: 'Every term, both ways.' },
  'words.lede': {
    chess: 'Each term by its two names, Chess words first and Finance words second, with what it means. The app speaks Chess words now.',
    finance: 'Each term by its two names, Chess words first and Finance words second, with what it means. The app speaks Finance words now.',
  },
  'words.column.chess': { chess: 'Chess words', finance: 'Chess words' },
  'words.column.finance': { chess: 'Finance words', finance: 'Finance words' },
  'words.count': { chess: '{count} terms', finance: '{count} terms' },
  'words.toast.chess': { chess: 'The app speaks Chess words.', finance: 'The app speaks Chess words.' },
  'words.toast.finance': { chess: 'The app speaks Finance words.', finance: 'The app speaks Finance words.' },

  /* views: one prefix per view */

  /* book.js: the Book / Recurring page */
  'book.title': { chess: "The Book", finance: "Recurring" },
  'book.titleNote': { chess: "recurring bills", finance: "bills and pay" },
  'book.empty': { chess: "The Book has no lines yet.", finance: "Recurring has no line items yet." },
  'book.withoutDebts': { chess: "Without {them} the Book costs {amount} a month.", finance: "Without {them} recurring bills cost {amount} a month." },
  'book.upcoming.none': { chess: "No line of the Book falls between today and {date}.", finance: "No recurring item falls between today and {date}." },
  'book.upcoming.empty': { chess: "Nothing is expected through {date}: the Book has no lines yet. Charges that repeat appear here {days} days ahead.", finance: "Nothing is expected through {date}: Recurring has no line items yet. Charges that repeat appear here {days} days ahead." },
  'book.beforePayday.none': { chess: "Nothing in the Book falls before payday, {day}.", finance: "Nothing in Recurring falls before payday, {day}." },
  'book.cash.none': { chess: "Nothing draws on cash {window}.", finance: "Nothing is paid from cash {window}." },
  'book.beyond': { chess: "Counted from cash and not in the Book: {items}.", finance: "Counted from cash and not in Recurring: {items}." },
  'book.noPayday': { chess: "No payday is known yet, so the clock counts {days} days ahead instead.", finance: "No payday is known yet, so the runway check looks {days} days ahead instead." },
  'book.renewal.next': { chess: "; {aside} of it is set aside by time.", finance: "; {aside} of it is accrued to date (sinking fund)." },
  'book.renewal.none': { chess: "The Book holds no quarterly, half-yearly or yearly charge so far. One is entered after its second charge, and is announced here {days} days ahead.", finance: "Recurring holds no quarterly, half-yearly or yearly charge so far. One is entered after its second charge, and is announced here {days} days ahead." },
  'book.aside.aria': { chess: "{share}% of it set aside by time", finance: "{share}% of it accrued to date" },
  'book.aside': { chess: "{aside} of {amount} set aside by time", finance: "{aside} of {amount} accrued to date" },
  'book.aside.foot': { chess: "Set aside by time: the share of each charge that the days since its last one have used up.", finance: "Accrued to date (sinking fund): the share of each charge that the days since its last one have used up." },
  'book.aside.smoothed': { chess: "The smoothed net worth already carries it.", finance: "Net worth on the accrual basis already carries it." },
  'book.essential': { chess: "Essential: an only move", finance: "Essential: a fixed obligation" },
  'book.removed': { chess: "Taken out of the Book by you", finance: "Removed from Recurring by you" },
  'book.sent.some': { chess: "{lines} you send yourself each month; the Board keeps {its} checklist.", finance: "{lines} you send yourself each month; the Overview keeps {its} checklist." },
  'book.sent.none': { chess: "A payment you send yourself each month, by Zelle or bank transfer, gets a checklist on the Board.", finance: "A payment you send yourself each month, by Zelle or bank transfer, gets a checklist on the Overview." },
  'book.lines.aria': { chess: "The lines of the Book, by cost a month", finance: "Recurring line items, by monthly cost" },
  'book.lines.foot': { chess: " marks an essential line, an only move.", finance: " marks an essential line item, a fixed obligation." },
  'book.stream.counted': { chess: "Counted as earned day by day, {amount} a day", finance: "Accrued daily, {amount} a day" },
  'book.stream.set': { chess: "Set to count day by day; counted when it arrives while that is switched off in Settings", finance: "Set to accrue; cash basis while accrual is off in Settings" },
  'book.stream.arrives': { chess: "Counted when it arrives", finance: "Cash basis" },
  'book.count.earned': { chess: "Pay is counted as it is earned.", finance: "Pay is on an accrual basis." },
  'book.count.daily': { chess: " counted day by day: {amount} is added to net worth each day,", finance: " accrued daily: {amount} is added to net worth each day," },
  'book.count.since': { chess: "{amount} has been earned since {since} and not yet received;", finance: "{amount} is accrued income since {since}, not yet received;" },
  'book.count.bills': { chess: "Bills are counted the same way, as they are used:", finance: "Bills are accrued the same way, as they are used:" },
  'book.count.arrives': { chess: "Pay is counted when it arrives.", finance: "Pay is on a cash basis." },
  'book.count.off': { chess: "Counting pay as it is earned is switched off, so nothing accrues: net worth is shown exactly as the bank reports it.", finance: "Accrual accounting is switched off (cash basis), so nothing accrues: net worth is shown exactly as the bank reports it." },
  'book.count.setTo': { chess: ", even for the {streams} set to count day by day", finance: ", even for the {streams} set to accrue" },
  'book.count.none': { chess: "None of the {streams} is counted day by day, so net worth is shown exactly as the bank reports it: it rises on the day a deposit arrives and falls on the day a bill is charged.", finance: "None of the {streams} is accrued daily, so net worth is shown exactly as the bank reports it: it rises on the day a deposit arrives and falls on the day a bill is charged." },
  'book.count.locked': { chess: "Day-by-day counting is switched off by hand on {streams}, {names}; its own sheet switches it back on.", finance: "Accrual is switched off by hand on {streams}, {names}; its own sheet switches it back on." },
  'book.count.regular': { chess: "A regular paycheck is counted day by day once it has been seen 3 times{rest}.", finance: "A regular paycheck is accrued daily once it has been seen 3 times{rest}." },
  'book.lapsed.earned': { chess: "it no longer sets the payday or counts as earned", finance: "it no longer sets the payday or accrues" },
  'book.counting': { chess: "How pay is counted", finance: "Income recognition" },
  'book.counting.note': { chess: "smoothing", finance: "accrual basis" },

  /* material.js: the Material / Balance sheet page */
  'material.smooth.note': { chess: "the bank figure, with pay earned {income}{sep} bills used {bills}{tapped}", finance: "the bank figure, with accrued income {income}{sep} accrued expenses {bills}{tapped}" },
  'material.arrives': { chess: "Pay is counted when it arrives, so nothing accrues and {same}", finance: "Pay is on a cash basis, so nothing accrues and {same}" },
  'material.split.worth': { chess: "Net worth is the white past the center mark.", finance: "Net worth is the light bar past the center mark." },
  'material.split.owed': { chess: "The black runs past the center mark: more is owed than owned.", finance: "The dark bar runs past the center mark: more is owed than owned." },
  'material.split.slow': { chess: " {share} of the assets is slow to sell, at your own estimate.", finance: " {share} of the assets are illiquid, at your own estimate." },
  'material.split.noSlow': { chess: " None of the assets is slow to sell.", finance: " None of the assets is illiquid." },
  'material.smoothed': { chess: "Smoothed", finance: "Accrual basis" },
  'material.title': { chess: "Material", finance: "Balance sheet" },
  'material.title.note': { chess: "owned against owed", finance: "assets vs. liabilities" },
  'material.workedDown': { chess: "worked down from the {day} {basis} at {apr}%", finance: "amortized from the {day} {basis} at {apr}%" },
  'material.pending': { chess: "pending moves counted", finance: "pending transactions counted" },
  'material.reserve': { chess: "reserve", finance: "emergency fund" },
  'material.quickSale': { chess: "a quick sale at {share}: {value}", finance: "a recovery rate of {share}: {value}" },
  'material.noQuickSale': { chess: "no quick-sale share set", finance: "no recovery rate set" },
  'material.smoothedOnly': { chess: "in the smoothed figure only", finance: "in the accrual-basis figure only" },
  'material.worked.both': { chess: "worked down by Networth or at your estimate", finance: "amortized by Networth or at your estimate" },
  'material.worked': { chess: "worked down by Networth", finance: "amortized by Networth" },
  'material.payEarned': { chess: "Pay earned, not yet received", finance: "Accrued income, not yet received" },
  'material.assets.note': { chess: "by how fast they turn into money", finance: "by liquidity" },
  'material.tier.now': { chess: "Now", finance: "Cash & equivalents" },
  'material.tier.days': { chess: "In days", finance: "Near-cash" },
  'material.tier.days.note': { chess: "investments, money owed to you, pay on its way", finance: "investments, receivables, accrued income" },
  'material.tier.days.total': { chess: "In days, on the record", finance: "Near-cash, on the record" },
  'material.tier.days.off': { chess: "Nothing here yet. Investments the bank reports appear by themselves. Pay is counted when it arrives, so no pay earned is listed.", finance: "Nothing here yet. Investments the bank reports appear by themselves. Pay is on a cash basis, so no accrued income is listed." },
  'material.tier.days.later': { chess: "Nothing here yet. Investments the bank reports appear by themselves; pay is counted day by day once a regular deposit has been seen 3 times.", finance: "Nothing here yet. Investments the bank reports appear by themselves; pay is accrued daily once a regular deposit has been seen 3 times." },
  'material.tier.slow': { chess: "Slow", finance: "Illiquid" },
  'material.loans.note': { chess: "italic when worked down by Networth", finance: "italic when amortized by Networth" },
  'material.notCharged': { chess: "Not yet charged", finance: "Accrued expenses" },
  'material.billsUsed': { chess: "Bills used, not yet charged", finance: "Accrued expenses, not yet charged" },
  'material.billsUsed.note': { chess: "{bills}, counted day by day since each was last charged", finance: "{bills}, accrued daily since each was last charged" },
  'material.accrues.off': { chess: "Nothing accrues: pay is counted when it arrives, and each bill on the day it is charged.", finance: "Nothing accrues: pay is on a cash basis, and each bill is counted on the day it is charged." },
  'material.accrues.later': { chess: "Nothing accrues yet. Bills are counted day by day once the Book and a regular pay day have been found.", finance: "Nothing accrues yet. Bills are accrued daily once Recurring and a regular payday have been found." },
  'material.quick.none': { chess: "Nothing slow to sell is on the record, so a fast sale would change nothing: {amount}.", finance: "No illiquid asset is on record, so liquidation value equals net worth: {amount}." },
  'material.quick.unset': { chess: "No quick-sale share is set on {assets}, so a fast sale is counted at full value: {amount}. A share can be set on each asset.", finance: "No recovery rate is set on {assets}, so liquidation counts them at full value: {amount}. A rate can be set on each asset." },
  'material.quick.slowAssets': { chess: "the slow assets", finance: "the illiquid assets" },
  'material.quick.less': { chess: "Net worth at the bank, less {haircut} that a fast sale would not raise: {names}.", finance: "Net worth at the bank, less a {haircut} haircut: {names}." },
  'material.quick.unshared': { chess: " has no share set and is counted in full.", finance: " has no rate set and is counted in full." },
  'material.reckoning': { chess: "The reckoning", finance: "Reconciliation" },
  'material.smoothedWorth': { chess: "Smoothed net worth", finance: "Net worth, accrual basis" },
  'material.unbanked': { chess: "Net worth, moves not yet at the bank counted", finance: "Net worth, transactions not yet at the bank counted" },
  'material.same.off': { chess: "Pay is counted when it arrives, so nothing accrues{same}. Day-by-day counting is switched in Settings or on a stream’s own sheet.", finance: "Pay is on a cash basis, so nothing accrues{same}. Accrual is switched in Settings or on a stream’s own sheet." },
  'material.same.offFigure': { chess: " and the smoothed figure is the same, {amount}", finance: " and the accrual-basis figure is the same, {amount}" },
  'material.same.later': { chess: "The smoothed figure is the same for now{but}: pay is counted as it is earned once a regular deposit has been seen 3 times.", finance: "The accrual-basis figure is the same for now{but}: pay is accrued once a regular deposit has been seen 3 times." },
  'material.same.unbanked': { chess: " but for the moves not yet at the bank", finance: " but for the transactions not yet at the bank" },
  'material.soldFast': { chess: "Sold fast", finance: "Liquidation value" },
  'material.soldFast.note': { chess: "if everything slow had to go", finance: "if every illiquid asset had to go" },
  'material.judged': { chess: " A month is judged when it ends, never move by move.", finance: " A month is judged when it closes, never transaction by transaction." },
  'material.scheduled': { chess: " of payments still scheduled in the Book", finance: " of payments still scheduled in Recurring" },
  'material.cycle.caption': { chess: "Each month: payments, white, against new charges, black, and the change in what is owed.", finance: "Each month: payments, the light bars, against new charges, the dark bars, and the change in what is owed." },
  'material.record.solid': { chess: "Solid: smoothed net worth.", finance: "Solid: net worth, accrual basis." },
  'material.tier.now.note': { chess: "cash · {accounts}", finance: "{accounts}" },

  /* connect.js: the first run */
  'connect.sub': { chess: "A private net-worth board", finance: "A private net-worth dashboard" },
  'connect.readOnly': { chess: "Read-only: it can look, it can never move money.", finance: "Read-only: it can look, it can never transfer money." },
  'connect.keeps': { chess: "The first reading takes about 6 months of history, in 2 requests. After that the board keeps itself.", finance: "The first reading takes about 6 months of history, in 2 requests. After that the dashboard keeps itself up to date." },
  'connect.look.note': { chess: "a sample game", finance: "sample data" },
  'connect.look.text': { chess: "A finished example with invented figures: 13 months of history, a match in progress, a Book of bills, a card and a loan. Nothing in it is saved.", finance: "A finished example with invented figures: 13 months of history, budget tracking in progress, recurring bills, a card and a loan. Nothing in it is saved." },
  'connect.open': { chess: "Open the board", finance: "Open the overview" },
  'connect.steps': { chess: "three moves", finance: "three steps" },
  'connect.title': { chess: "A net-worth board that reads the bank feed itself. Nothing to import, ever.", finance: "A net-worth dashboard that reads the bank feed itself. Nothing to import, ever." },
  'connect.colophon': { chess: "and bills, pay, the daily round and net worth are worked out from them.", finance: "and bills, pay, the daily budget and net worth are worked out from them." },
  'connect.private': { chess: "the bank feed is read straight from this browser, and the record is kept in its own storage.", finance: "the bank feed is read straight from this browser, and the record stays in its own storage." },

  /* analysis.js: the Analysis page */
  'analysis.note': { chess: "goals and variations", finance: "goals and scenarios" },
  'analysis.edge': { chess: "Kept v. Habit", finance: "Under baseline" },
  'analysis.edge.before': { chess: "the match begins on day {day} on record; {days} so far", finance: "tracking begins on day {day} of bank history; {days} so far" },
  'analysis.reserve.none': { chess: "All cash accounts: none is marked as the reserve", finance: "All cash accounts: none is marked as the emergency fund" },
  'analysis.reserve.pace': { chess: "{amount} a month, if all of it reached the reserve: {months}.", finance: "{amount} a month, if all of it reached the emergency fund: {months}." },
  'analysis.reserve': { chess: "Reserve", finance: "Emergency fund" },
  'analysis.reserve.aria': { chess: "{pct} of the reserve goal", finance: "{pct} of the emergency fund goal" },
  'analysis.reserve.over': { chess: "The reserve goal, many times over", finance: "The emergency fund goal, many times over" },
  'analysis.reserve.goal': { chess: "Reserve goal, in dollars", finance: "Emergency fund goal, in dollars" },
  'analysis.milestones': { chess: "measured in time", finance: "in days of spending" },
  'analysis.milestones.aria': { chess: "Reserve milestones", finance: "Emergency fund milestones" },
  'analysis.burn': { chess: "A day is {amount}, the typical outflow over {span}.", finance: "A day is {amount}, the burn rate over {span}." },
  'analysis.burn.later': { chess: "The milestones are sized once 60 days of outflow can be measured.", finance: "The milestones are sized once 60 days of spending can be measured." },
  'analysis.scenario.toSavings': { chess: "Scenario: dollars moved to the reserve each month", finance: "Scenario: dollars moved to the emergency fund each month" },
  'analysis.retention': { chess: "Retention", finance: "Savings rate" },
  'analysis.retention.note': { chess: "kept of earned", finance: "saved of income" },
  'analysis.retention.kept': { chess: "Kept", finance: "Saved" },
  'analysis.retention.earned': { chess: "Earned", finance: "Income" },
  'analysis.retention.other': { chess: " It is in what was kept.", finance: " It is in what was saved." },
  'analysis.retention.colors': { chess: "White is what was kept, black is bills and spending.", finance: "The light bar is what was saved, the dark bar is bills and spending." },
  'analysis.retention.daily': { chess: "Earned and bills are counted day by day, so they are italic.", finance: "Income and bills are accrued daily, so they are italic." },
  'analysis.retention.arrives': { chess: "Pay is counted when it arrives, and each bill on the day it posts.", finance: "Pay is on a cash basis, and each bill is counted on the day it posts." },
  'analysis.projection.habit': { chess: " Dotted: the same pace without what was kept against Habit, {amount} a month.", finance: " Dotted: the same pace without what came in under baseline, {amount} a month." },
  'analysis.projection.later': { chess: " The line at Habit joins once the match has begun.", finance: " The baseline line joins once tracking has begun." },
  'analysis.ladder.next': { chess: "next norm", finance: "next target" },
  'analysis.ladder.nextThere': { chess: "next norm · {pct} there", finance: "next target · {pct} there" },
  'analysis.ladder.target': { chess: "N{n}", finance: "Target {n}" },
  'analysis.ladder.gap': { chess: "{amount} to the next norm", finance: "{amount} to the next income target" },
  'analysis.ladder.all': { chess: "every norm is reached", finance: "every income target is reached" },
  'analysis.ladder.final': { chess: "The final norm, {amount} by {date}, would need growth of about {pct} a year from here.", finance: "The top income target, {amount} by {date}, would need growth of about {pct} a year from here." },
  'analysis.ladder.finalReached': { chess: "The final norm is reached.", finance: "The top income target is reached." },
  'analysis.ladder.finalLater': { chess: "Growth toward the final norm is read once income has been received.", finance: "Growth toward the top income target is read once income has been received." },
  'analysis.klass.game': { chess: "the daily game", finance: "the daily budget" },
  'analysis.klass.book': { chess: "recurring bills", finance: "fixed monthly costs" },
  'analysis.went.later': { chess: "Categories fill in as moves post.", finance: "Categories fill in as transactions post." },
  'analysis.buy.cash': { chess: "Cash on the clock", finance: "Cash runway" },
  'analysis.buy.cashNote': { chess: "; about {days} of typical outflow, from {from}", finance: "; about {days} of runway, from {from}" },
  'analysis.buy.note': { chess: "a candidate move", finance: "purchase check" },
  'analysis.buy.asOf': { chess: "Consequences as of {date}, set out before the move. The choice is the owner’s.", finance: "Consequences as of {date}, set out before the purchase. The choice is the owner’s." },
  'analysis.buy.idle': { chess: "An amount shows what the move would do to the clock and the card.", finance: "An amount shows what the purchase would do to the runway and the card." },
  'analysis.opp': { chess: "The opponent", finance: "Baseline" },
  'analysis.opp.note': { chess: "Habit", finance: "convenience spending" },
  'analysis.opp.unseated': { chess: "not yet seated", finance: "not yet set" },
  'analysis.opp.vs': { chess: "You <i>v.</i> Habit", finance: "Spending <i>vs.</i> baseline" },
  'analysis.opp.young': { chess: "Habit is the average of your own convenience spending. It needs 14 full days of bank history, so the match begins on day {day} on record; {days} so far, as of {date}. Until then no round is scored.", finance: "Your baseline is the average of your own convenience spending. It needs 14 full days of bank history, so tracking begins on day {day} of bank history; {days} so far, as of {date}. Until then no day is scored." },
  'analysis.opp.how': { chess: "How Habit is set", finance: "How the baseline is set" },
  'analysis.opp.win': { chess: "win at {amount} or less", finance: "under budget at {amount} or less" },
  'analysis.opp.noRound': { chess: "no round yet", finance: "no day scored yet" },
  'analysis.opp.never': { chess: "Habit never changes by itself. A new opponent can be seated from the last 60 days; the kept total carries over.", finance: "The baseline never changes by itself. A new baseline can be set from the last 60 days; the running total under baseline carries over." },
  'analysis.opp.sheet': { chess: "The opponent’s sheet", finance: "Baseline details" },

  /* board.js: the Board / Overview page */
  'board.byHand': { chess: ", with the {accounts} kept by hand at your own figures", finance: ", with the {accounts} entered by hand at your own figures" },
  'board.plain.off': { chess: " Pay is counted when it arrives: day-by-day counting is switched off, so pay and bills count on the day they post.", finance: " Pay is on a cash basis: accrual is switched off, so pay and bills count on the day they post." },
  'board.plain.arrives': { chess: " Pay is counted when it arrives: {name} is not counted day by day, so pay and bills count on the day they post.", finance: " Pay is on a cash basis: {name} is not accrued, so pay and bills count on the day they post." },
  'board.payEarned': { chess: "pay earned{since} {amount}", finance: "accrued income{since} {amount}" },
  'board.billsUsed': { chess: "bills used {amount}", finance: "accrued expenses {amount}" },
  'board.lapsed.earned': { chess: "pay is no longer counted as earned", finance: "pay is no longer accrued" },
  'board.yesterday.parts': { chess: "earned {earned}{dot}bills {bills}{dot}spent {spent}", finance: "income {earned}{dot}bills {bills}{dot}spent {spent}" },
  'board.inPencil': { chess: ", in pencil", finance: ", provisional" },
  'board.month.none': { chess: "nothing counted as earned yet this month", finance: "no income recorded yet this month" },
  'board.month.kept': { chess: "kept of {earned} earned", finance: "saved of {earned} income" },
  'board.month.over': { chess: "more went out than the {earned} earned", finance: "more went out than the {earned} of income" },
  'board.slow': { chess: "{pct} of the assets is slow to sell: equipment and the like, at your own estimate.", finance: "{pct} of the assets are illiquid: equipment and the like, at your own estimate." },
  'board.slow.none': { chess: "0% of the assets is slow to sell: all of it is cash and accounts.", finance: "0% of the assets are illiquid: all of it is cash and accounts." },
  'board.clock': { chess: "the clock", finance: "runway" },
  'board.onClock': { chess: "on the clock", finance: "of runway" },
  'board.runway.later': { chess: "Runway is read from 60 days of outflows; too few are on record.", finance: "Runway is read from 60 days of spending; too few are on record." },
  'board.flag': { chess: "Flag", finance: "Out of cash" },
  'board.runway.end': { chess: "7 days · out of time trouble", finance: "7 days · out of a cash crunch" },
  'board.reserve': { chess: "Reserve", finance: "Emergency fund" },
  'board.reserve.aria': { chess: "Reserve milestones, in days of typical outflow", finance: "Emergency fund milestones, in days of spending" },
  'board.title': { chess: "The Board, {date}", finance: "Overview, {date}" },
  'board.reserve.head': { chess: "the reserve", finance: "the emergency fund" },
  'board.reserve.note': { chess: "Measured in time", finance: "In days of spending" },

  /* parts.js: the round helpers, the crosstable and the moves list, shared by the pages */
  'parts.bye': { chess: "bye", finance: "exempt" },
  'parts.kept': { chess: "{amount} kept", finance: "{amount} under baseline" },
  'parts.status.provisional': { chess: "In pencil until the bank finishes reporting the day.", finance: "Provisional until the bank finishes reporting the day." },
  'parts.status.live': { chess: "In progress. The bank reports today’s moves as they post.", finance: "In progress. The bank reports today’s transactions as they post." },
  'parts.status.prematch': { chess: "Before the match began: shown for reference, not counted.", finance: "Before tracking began: shown for reference, not counted." },
  'parts.status.future': { chess: "Not yet played.", finance: "Upcoming." },
  'parts.roundTitle': { chess: "Round {n} · {day}", finance: "Day {n} · {day}" },
  'parts.colour.work': { chess: "Black", finance: "Workday" },
  'parts.colour.off': { chess: "White", finance: "Day off" },
  'parts.week.kept': { chess: ", kept {approx}{amount}", finance: ", {approx}{amount} under baseline" },
  'parts.week.future': { chess: "not yet played", finance: "upcoming" },
  'parts.cell': { chess: "Round {n}, {day}", finance: "Day {n}, {day}" },
  'parts.cell.win': { chess: "win", finance: "under budget" },
  'parts.cell.loss': { chess: "loss", finance: "over budget" },
  'parts.cell.draw': { chess: "draw", finance: "on budget" },
  'parts.crosstable': { chess: "Crosstable", finance: "Budget calendar" },
  'parts.vs': { chess: "You v. Habit", finance: "Spending vs. baseline" },
  'parts.withBlack': { chess: "With Black", finance: "Workdays" },
  'parts.withWhite': { chess: "With White", finance: "Days off" },
  'parts.kept.total': { chess: "Kept", finance: "Under baseline" },
  'parts.byRound': { chess: "{month}, round by round", finance: "{month}, day by day" },
  'parts.legend.rd': { chess: "Rd", finance: "No." },
  'parts.score': { chess: "Score", finance: "Budget score" },
  'parts.legend.score': { chess: "Score", finance: "Budget score" },
  'parts.perfect': { chess: "A perfect {month} is worth {amount}.", finance: "A {month} with no convenience spending would come in {amount} under baseline." },
  'parts.pencilTag': { chess: "In pencil · not at the bank yet", finance: "Provisional · not at the bank yet" },
  'parts.declined': { chess: "Declined: {name}", finance: "Skipped: {name}" },
  'parts.moves': { chess: "Moves", finance: "Transactions" },
  'board.plan': { chess: "Opening preparation", finance: "Morning plan" },
  'board.split.cover': { chess: "Kept against spent, so far", finance: "Under baseline against spent, so far" },
  'board.split': { chess: "Kept {kept} against spent {spent}, so far", finance: "Under baseline {kept} against spent {spent}, so far" },
  'board.premise.habit': { chess: "Habit plays {habit} on a {kind}.", finance: "The baseline is {habit} on a {kind}." },
  'board.premise.lines': { chess: "Win at {win} or less{dot}loss above {loss}.", finance: "Under budget at {win} or less{dot}over budget above {loss}." },
  'board.premise.bye': { chess: " A bye is declared: today scores ½ whatever is spent, and its dollars still count.", finance: " An exempt day is declared: today counts as on budget whatever is spent, and its dollars still count." },
  'board.today.round': { chess: "Round {n}", finance: "Day {n}" },
  'board.vs': { chess: "You <i>v.</i> Habit", finance: "Spending <i>vs.</i> baseline" },
  'board.habit': { chess: "Habit", finance: "Baseline" },
  'board.standing': { chess: "Standing", finance: "Variance" },
  'board.kept': { chess: "Kept", finance: "Under baseline" },
  'board.today.moves': { chess: "Today’s moves", finance: "Today’s transactions" },
  'board.more.others': { chess: "and {others} so far today", finance: "and {others} so far today" },
  'board.more.other.one': { chess: "other move", finance: "other transaction" },
  'board.more.other.many': { chess: "other moves", finance: "other transactions" },
  'board.more.move.one': { chess: "move", finance: "transaction" },
  'board.more.move.many': { chess: "moves", finance: "transactions" },
  'board.more.outside': { chess: ", outside the game with Habit", finance: ", outside the daily budget" },
  'board.today.none': { chess: "No moves on {day} yet. The bank reports them as they post.", finance: "No transactions on {day} yet. The bank reports them as they post." },
  'board.candidate': { chess: "Candidate move", finance: "Purchase check" },
  'board.byes': { chess: "{left} of {byes} for {month} not yet taken.", finance: "{left} of {byes} for {month} not yet taken." },
  'board.bye.one': { chess: "bye", finance: "exempt day" },
  'board.bye.many': { chess: "byes", finance: "exempt days" },
  'board.bye.take': { chess: "Take a bye", finance: "Take an exempt day" },
  'board.last.began': { chess: "The match began {date}: round {n} is its first, and no result is on record yet.", finance: "Tracking began {date}: day {n} is its first, and no result is on record yet." },
  'board.last.bye': { chess: "A declared bye: it scores ½ and its dollars still count. ", finance: "A declared exempt day: it counts as on budget and its dollars still count. " },
  'board.last.annotated': { chess: "The round carries an annotation.", finance: "The day carries a mark." },
  'board.last.late': { chess: "The bank has not reported {day} yet: round {n} is the latest result on record.", finance: "The bank has not reported {day} yet: day {n} is the latest result on record." },
  'board.last.moves': { chess: "Moves of round {n}", finance: "Transactions of day {n}" },
  'board.last.onSheet': { chess: "Round {n} on the Scoresheet", finance: "Day {n} in Transactions" },
  'board.last.none': { chess: ": no move on {date}", finance: ": no transaction on {date}" },
  'board.prematch': { chess: "before the match", finance: "baseline period" },
  'board.prematch.begins': { chess: "The match begins on day {from} on record; {have} so far{begins}.", finance: "Tracking begins on day {from} of bank history; {have} so far{begins}." },
  'board.prematch.first': { chess: ". Round 1 falls around {date}", finance: ". Day 1 falls around {date}" },
  'board.prematch.next': { chess: "The match begins with the next reading of the bank: today is day {have} on record, and Habit is measured over the {days} full days of bank history before it.", finance: "Tracking begins with the next reading of the bank: today is day {have} on record, and the baseline is measured over the {days} full days of bank history before it." },
  'board.prematch.habit': { chess: "Habit is your own usual spending on coffee and food on the go, measured over its first {days} full days of bank history and then frozen. Each day after that is 1 round against it.", finance: "Your baseline is your own usual spending on coffee and food on the go, measured over its first {days} full days of bank history and then frozen. Each day after that is scored against it." },
  'board.prematch.sofar': { chess: "Convenience moves so far today", finance: "Convenience spending so far today" },
  'board.prematch.label': { chess: "Today’s convenience moves", finance: "Today’s convenience purchases" },
  'board.prematch.none': { chess: "No convenience move on {day} yet. The bank reports them as they post.", finance: "No convenience purchase on {day} yet. The bank reports them as they post." },
  'board.xt.none': { chess: "No round of {month} is scored yet: scoring starts with round 1 of the match.", finance: "No day of {month} is scored yet: scoring starts with day 1 of tracking." },
  'board.xt.prematch': { chess: "Rounds before {date} are set back: an exhibition, not counted.", finance: "Days before {date} are set back: the baseline period, not counted." },
  'board.xt.pencil.one': { chess: "Round {n} is in pencil until the bank makes it final.", finance: "Day {n} is provisional until the bank makes it final." },
  'board.xt.pencil.many': { chess: "Rounds {n} are in pencil until the bank makes them final.", finance: "Days {n} are provisional until the bank makes them final." },
  'board.xt.off': { chess: " Shaded rounds are days off, where Habit plays {amount}.", finance: " Shaded days are days off, where the baseline is {amount}." },
  'board.position': { chess: "The position", finance: "Financial health" },
  'board.factor.tt': { chess: " · time trouble", finance: " · cash crunch" },
  'board.sweep.open': { chess: "The week of {date} kept {amount} against habit. It has not been moved to the {target} yet.", finance: "The week of {date} came in {amount} under baseline. It has not been transferred to the {target} yet." },
  'board.sweep.reserve': { chess: "reserve", finance: "emergency fund" },
  'board.notes.none': { chess: "No notes for {day}: nothing on the board asks for attention.", finance: "No notices for {day}: nothing on the overview asks for attention." },
  'board.principles': { chess: "Opening principles", finance: "Spending rules" },
  'board.principles.none': { chess: "0 principles are written down. They are your own rules, kept in {settings}.", finance: "0 spending rules are written down. They are your own rules, stored in {settings}." },
  'board.worth.lead': { chess: "Net worth, the last {days}. Ink: with pay earned and bills used.", finance: "Net worth, the last {days}. Solid: with accrued income and accrued expenses." },
  'board.worth.tail': { chess: " The tail in pencil is not final.", finance: " The provisional tail is not final." },
  'board.edge': { chess: "Kept versus habit {span}.", finance: "Running total under baseline {span}." },
  'board.edge.windowed': { chess: "over the last {n} rounds; the match began {date}", finance: "over the last {n} days; tracking began {date}" },
  'board.edge.since': { chess: "since the match began, {date}", finance: "since tracking began, {date}" },
  'board.edge.parts': { chess: "Hatched: the edge, {kept}. Solid: the part already moved, {moved}.", finance: "Hatched: the running total under baseline, {kept}. Solid: the part already transferred, {moved}." },
  'board.edge.later': { chess: "Kept versus habit, round by round. It starts with round 1{when}.", finance: "Running total under baseline, day by day. It starts with day 1{when}." },
  'board.ladder.none': { chess: "0 norms are set. {amount} was received in the last {days}.", finance: "0 income targets are set. {amount} was received in the last {days}." },
  'board.ladder.next': { chess: "next norm · {pct} there", finance: "next target · {pct} there" },
  'board.ladder.target': { chess: "{n}", finance: "Target {n}" },
  'board.short': { chess: "Short", finance: "Shortfall" },
  'book.cash.spare': { chess: "Cash covers what is due {window}, with {amount} to spare.", finance: "Cash covers what is due {window}, with a surplus of {amount}." },
  'board.spare': { chess: "To spare", finance: "Surplus" },
  'board.ladder.all': { chess: "every norm is reached", finance: "every income target is reached" },
  'board.ladder.apart': { chess: " Kept apart from net worth.", finance: " Not counted in net worth." },
  'board.key.only': { chess: "only move: rent, a loan payment", finance: "fixed obligation: rent, a loan payment" },
  'board.key.clean': { chess: "clean-sheet workday", finance: "no-spend workday" },
  'board.key.good': { chess: "declined, moved, or played to plan", finance: "skipped, transferred, or stuck to plan" },
  'board.due.more': { chess: "and {more} more {until}, in the Book", finance: "and {more} more {until}, in Recurring" },
  'board.card.scheduled': { chess: "The pace takes off {amount} of payments still scheduled in the Book this month.", finance: "The pace takes off {amount} of payments still scheduled in Recurring this month." },

  /* scoresheet.js: the Scoresheet / Transactions page */
  'scoresheet.count.clean': { chess: "clean sheet", finance: "no-spend day" },
  'scoresheet.count.good': { chess: "good", finance: "good decision" },
  'scoresheet.count.return': { chess: "judged by its return", finance: "judged by its return" },
  'scoresheet.count.dubious': { chess: "dubious", finance: "unplanned" },
  'scoresheet.count.mistake': { chess: "mistake", finance: "poor decision" },
  'scoresheet.count.penalty': { chess: "penalty", finance: "penalty" },
  'scoresheet.count.only': { chess: "only move", finance: "fixed obligation" },
  'scoresheet.rounds': { chess: "Rounds", finance: "Days" },
  'scoresheet.title': { chess: "Scoresheet", finance: "Transactions" },
  'scoresheet.title.note': { chess: "rounds and moves", finance: "days and transactions" },
  'scoresheet.head.feed': { chess: "The bank feed begins in {first}: no move is on record for {month}.", finance: "The bank feed begins in {first}: no transaction is on record for {month}." },
  'scoresheet.head.notBegun': { chess: "The match has not begun: it begins on day {day} on record; {days} so far. Until then the days are listed without a result.", finance: "Tracking has not begun: it begins on day {day} of bank history; {days} so far. Until then the days are listed without a result." },
  'scoresheet.head.before': { chess: "Before the match began on {date}: the results of {month} are an exhibition and are not counted.", finance: "Before tracking began on {date}: the results of {month} are the baseline period and are not counted." },
  'scoresheet.head.scored.one': { chess: "1 round scored", finance: "1 day scored" },
  'scoresheet.head.scored.many': { chess: "{n} rounds scored", finance: "{n} days scored" },
  'scoresheet.head.began': { chess: " The match began on {date}.", finance: " Tracking began on {date}." },
  'scoresheet.head.now': { chess: "Round {d} of {days} is in progress; ", finance: "Day {d} of {days} is in progress; " },
  'scoresheet.note.pencil.one': { chess: "Round {n} is in pencil until the bank finishes reporting the day.", finance: "Day {n} is provisional until the bank finishes reporting the day." },
  'scoresheet.note.pencil.many': { chess: "Rounds {list} and {last} are in pencil until the bank finishes reporting them.", finance: "Days {list} and {last} are provisional until the bank finishes reporting them." },
  'scoresheet.note.shaded': { chess: "Shaded rounds are days off, played with White.", finance: "Shaded days are days off." },
  'scoresheet.review.later': { chess: "The review prints once the bank has reported the first moves.", finance: "The review prints once the bank has reported the first transactions." },
  'scoresheet.withBlack': { chess: "With Black {score},", finance: "Workdays {score}," },
  'scoresheet.withWhite': { chess: "with White {score};", finance: "days off {score};" },
  'scoresheet.keptAgainst': { chess: "{amount} kept against habit.", finance: "{amount} under baseline." },
  'scoresheet.annotations': { chess: "Annotations", finance: "Marks" },
  'scoresheet.noSymbol': { chess: "No move or round of {month} carries a symbol.", finance: "No transaction or day of {month} carries a mark." },
  'scoresheet.best': { chess: "Best move", finance: "Best day" },
  'scoresheet.costliest': { chess: "Costliest move", finance: "Costliest purchase" },
  'scoresheet.noResult': { chess: "No round of {month} has a result yet.", finance: "No day of {month} has a result yet." },
  'scoresheet.prepared': { chess: "Preparation", finance: "Morning plan" },
  'scoresheet.score': { chess: "Score", finance: "Budget score" },
  'scoresheet.unprepared': { chess: "No round of {month} had a morning plan; unprepared rounds scored {score}.", finance: "No day of {month} had a morning plan; unplanned days scored {score}." },
  'scoresheet.noScore.notBegun': { chess: "Not scored yet: the match begins on day {day} on record; {days} so far. The score, the symbols and the best and costliest moves print here from then.", finance: "Not scored yet: tracking begins on day {day} of bank history; {days} so far. The budget score, the marks, the best day and the costliest purchase print here from then." },
  'scoresheet.noScore.before': { chess: "{month} was played before the match began on {date}: no score is kept for it.", finance: "{month} came before tracking began on {date}: no budget score is recorded for it." },
  'scoresheet.noScore.none': { chess: "No round of {month} has a result yet; the first prints once the bank has reported a whole day.", finance: "No day of {month} has a result yet; the first prints once the bank has reported a whole day." },
  'scoresheet.filter.aria': { chess: "Class of move", finance: "Class of transaction" },
  'scoresheet.move.one': { chess: "move", finance: "transaction" },
  'scoresheet.move.many': { chess: "moves", finance: "transactions" },
  'scoresheet.empty.match': { chess: "No move of {month} matches.", finance: "No transaction of {month} matches." },
  'scoresheet.empty.hiding.now': { chess: "rounds so far", finance: "days so far" },
  'scoresheet.empty.hiding': { chess: "rounds", finance: "days" },
  'scoresheet.empty.future': { chess: "Rounds print here from the first day of the month.", finance: "Days print here from the first day of the month." },
  'scoresheet.empty.latest': { chess: "The bank feed reaches back to {first}; the latest moves are in {latest}.", finance: "The bank feed reaches back to {first}; the latest transactions are in {latest}." },
  'scoresheet.empty.none': { chess: "Moves print here once the bank reports them.", finance: "Transactions print here once the bank reports them." },
  'scoresheet.round': { chess: "Round {n}", finance: "Day {n}" },
  'scoresheet.review.cardHigher': { chess: "The card ended {month} higher than it began, so the score is printed plainly.", finance: "The card ended {month} higher than it began, so the budget score is printed plainly." },
  'scoresheet.next.bye': { chess: "A half-point bye is declared.", finance: "An exempt day is declared." },
  'scoresheet.next.future': { chess: "Not yet played. The day type or a bye can be set ahead.", finance: "Upcoming. The day type or an exempt day can be set ahead." },
  'scoresheet.margin.habit': { chess: " against habit", finance: " against the baseline" },
  'scoresheet.margin.kept': { chess: " kept", finance: " under baseline" },
  'scoresheet.bye': { chess: "A half-point bye, declared ahead; the dollars still count.", finance: "An exempt day, declared ahead; the dollars still count." },
  'scoresheet.bye.tag': { chess: "bye", finance: "exempt" },
  'scoresheet.moves': { chess: "Moves of {day}", finance: "Transactions of {day}" },
  'scoresheet.none.live': { chess: "No move so far on {day}. The bank reports them as they post.", finance: "No transaction so far on {day}. The bank reports them as they post." },
  'scoresheet.none': { chess: "No move on {day}: nothing left any account.", finance: "No transaction on {day}: nothing left any account." },

  /* sheet-tx.js: a move’s sheet / a transaction’s sheet */
  'tx.kind.spend': { chess: "Move", finance: "Purchase" },
  'tx.kind.decline': { chess: "Declined purchase", finance: "Skipped purchase" },
  'tx.sheet': { chess: "Move: {name}", finance: "Transaction: {name}" },
  'tx.sheet.bare': { chess: "Move", finance: "Transaction" },
  'tx.gone': { chess: "This move is no longer on the sheet.", finance: "This transaction is no longer on the list." },
  'tx.gone.why': { chess: "A pending row can leave the bank feed before it posts, and a tapped-in move is replaced by the bank’s own row within 7 days.", finance: "A pending row can leave the bank feed before it posts, and a tapped-in transaction is replaced by the bank’s own row within 7 days." },
  'tx.round': { chess: "Round {n}", finance: "Day {n}" },
  'tx.replaced': { chess: "The bank has reported this move; its own row replaced the one {from}, which no longer counts.", finance: "The bank has reported this transaction; its own row replaced the one {from}, which no longer counts." },
  'tx.bookMove': { chess: "A stop in the morning plan is a book move: it prints bare, whichever stop of the day it was.", finance: "A stop in the morning plan is planned spending: it prints bare, whichever stop of the day it was." },
  'tx.note.placeholder': { chess: "Printed under the move", finance: "Printed under the transaction" },
  'tx.declined': { chess: "not paid: a declined purchase moves no money", finance: "not paid: a skipped purchase transfers no money" },
  'tx.cashInHand': { chess: "; paid in cash, it counts in Cash in hand", finance: "; paid in cash, it counts in Physical cash" },
  'tx.read': { chess: "How this move is read", finance: "How this transaction is read" },
  'tx.stream.book': { chess: "The stream itself is edited in the Book.", finance: "The stream itself is edited in Recurring." },
  'tx.class.help': { chess: "Only Convenience is played against Habit in the daily round.", finance: "Only Convenience counts against the baseline in the daily budget." },
  'tx.scope.one': { chess: "This move only", finance: "This transaction only" },
  'tx.scope.all': { chess: "All: the {count} moves from {merchant} on record, and every later one, follow. A move corrected on its own keeps its correction.", finance: "All: the {count} transactions from {merchant} on record, and every later one, follow. A transaction corrected on its own keeps its correction." },
  'tx.scope.later': { chess: "All: later moves from {merchant} follow. This is the only one on record so far.", finance: "All: later transactions from {merchant} follow. This is the only one on record so far." },
  'tx.glyph': { chess: "Annotation", finance: "Mark" },
  'tx.glyph.auto': { chess: "The annotator’s", finance: "Automatic" },
  'tx.glyph.help': { chess: "A mark of your own replaces the annotator’s on this move. Most moves carry none.", finance: "A mark of your own replaces the automatic one on this transaction. Most transactions carry none." },
  'tx.asset': { chess: "That part of the {amount} becomes an asset on Material from {date}; the rest is spending. Half the price is the starting estimate.", finance: "That part of the {amount} becomes an asset on the Balance sheet from {date}; the rest is spending. Half the price is the starting estimate." },
  'tx.toast.corrected': { chess: "Move corrected", finance: "Transaction corrected" },
  'tx.toast.updated': { chess: "Move updated", finance: "Transaction updated" },
  'tx.toast.many': { chess: "{count} moves from {merchant} corrected.", finance: "{count} transactions from {merchant} corrected." },
  'tx.toast.removed': { chess: "Move removed", finance: "Transaction removed" },
  'tx.toast.declinedRemoved': { chess: "Declined purchase removed", finance: "Skipped purchase removed" },

  /* sheet-day.js: a round’s sheet / a day’s sheet */
  'day.sheet': { chess: "Round of {date}", finance: "Day of {date}" },
  'day.round': { chess: "Round {n}", finance: "Day {n}" },
  'day.note.placeholder': { chess: "Printed under the round", finance: "Printed under the day" },
  'day.over': { chess: "{amount} over habit", finance: "{amount} over baseline" },
  'day.kept': { chess: "{amount} kept", finance: "{amount} under baseline" },
  'day.title.byeAhead': { chess: "A half-point bye, declared ahead.", finance: "An exempt day, declared ahead." },
  'day.title.future': { chess: "Not yet played.", finance: "Upcoming." },
  'day.title.byeLive': { chess: "A half-point bye, in progress.", finance: "An exempt day, in progress." },
  'day.title.before': { chess: "Before the match began.", finance: "Before tracking began." },
  'day.title.notBegun': { chess: "The match has not begun.", finance: "Tracking has not begun." },
  'day.title.bye': { chess: "A half-point bye", finance: "An exempt day" },
  'day.title.win': { chess: "A win", finance: "Under budget" },
  'day.title.loss': { chess: "A loss", finance: "Over budget" },
  'day.title.draw': { chess: "A draw", finance: "On budget" },
  'day.noHabit': { chess: "No habit is in force on this day, so it is not played.", finance: "No baseline is in force on this day, so it is not scored." },
  'day.notBegun': { chess: "The match begins on day {day} on record; {days} so far. Until then a day has no result.", finance: "Tracking begins on day {day} of bank history; {days} so far. Until then a day has no result." },
  'day.habit': { chess: "Habit", finance: "Baseline" },
  'day.future': { chess: "not yet played", finance: "upcoming" },
  'day.standing': { chess: "Standing", finance: "Variance" },
  'day.keptLabel': { chess: "Kept", finance: "Under baseline" },
  'day.inPencil': { chess: "in pencil", finance: "provisional" },
  'day.lines': { chess: "Win at {win} or less; a loss above {loss}.", finance: "Under budget at {win} or less; over budget above {loss}." },
  'day.playWith': { chess: "Play this day with", finance: "Count this day as" },
  'day.black': { chess: "Black · a workday", finance: "A workday" },
  'day.white': { chess: "White · a day off", finance: "A day off" },
  'day.habitPlays': { chess: "Habit plays {work} on a workday and {off} on a day off.", finance: "The baseline is {work} on a workday and {off} on a day off." },
  'day.byes.remain.one': { chess: "bye remains", finance: "exempt day remains" },
  'day.byes.remain.many': { chess: "byes remain", finance: "exempt days remain" },
  'day.byes.begin': { chess: "Byes begin with the match: {n} a month, each declared ahead.", finance: "Exempt days begin with tracking: {n} a month, each declared ahead." },
  'day.bye.declared': { chess: "A half-point bye is declared: the round scores ½ whatever is spent, and the dollars still count. {count}.", finance: "An exempt day is declared: the day counts as on budget whatever is spent, and the dollars still count. {count}." },
  'day.bye.withdraw': { chess: "Withdraw the bye", finance: "Withdraw the exempt day" },
  'day.bye.played': { chess: "Played as a half-point bye, declared ahead. {count}.", finance: "Counted as an exempt day, declared ahead. {count}." },
  'day.bye.scores': { chess: "A bye scores ½ whatever is spent; the dollars still count. {count}.", finance: "An exempt day counts as on budget whatever is spent; the dollars still count. {count}." },
  'day.bye.take': { chess: "Take a half-point bye", finance: "Take an exempt day" },
  'day.bye.used.one': { chess: "The bye of {month} is used{taken}.", finance: "The exempt day of {month} is used{taken}." },
  'day.bye.used.many': { chess: "The {n} byes of {month} are used{taken}.", finance: "The {n} exempt days of {month} are used{taken}." },
  'day.bye.before': { chess: "A bye is declared before the day’s first convenience purchase; {already} already on today’s sheet. {count}.", finance: "An exempt day is declared before the day’s first convenience purchase; {already} already on today’s list. {count}." },
  'day.bye.ahead': { chess: "A bye is declared ahead, so none can be added to a day already played. {count}.", finance: "An exempt day is declared ahead, so none can be added to a day already under way. {count}." },
  'day.bye.title': { chess: "Half-point bye", finance: "Exempt day" },
  'day.plan.bookMove': { chess: " A planned stop is a book move and prints bare.", finance: " A planned stop is planned spending and prints bare." },
  'day.plan.open': { chess: "Opening preparation", finance: "Morning plan" },
  'day.toast.type.work': { chess: "{day} is played with Black, a workday.", finance: "{day} counts as a workday." },
  'day.toast.type.off': { chess: "{day} is played with White, a day off.", finance: "{day} counts as a day off." },
  'day.undo.byeOn': { chess: "Bye declared", finance: "Exempt day declared" },
  'day.undo.byeOff': { chess: "Bye withdrawn", finance: "Exempt day withdrawn" },
  'day.toast.byeOn': { chess: "A half-point bye is declared for {day}.", finance: "An exempt day is declared for {day}." },
  'day.toast.byeOff': { chess: "The bye of {day} is withdrawn.", finance: "The exempt day of {day} is withdrawn." },

  /* sheet-plan.js: the morning plan */
  'plan.label': { chess: "Opening preparation", finance: "Morning plan" },
  'plan.title': { chess: "Opening preparation.", finance: "Your morning plan." },
  'plan.notBegun': { chess: "The match has not begun, so no round is scored on {day}; the plan is kept with the day all the same.", finance: "Tracking has not begun, so no day is scored on {day}; the plan is stored with the day all the same." },
  'plan.bye': { chess: "Round {n} is a bye and scores a draw; a plan still marks which stops were meant.", finance: "Day {n} is an exempt day and counts as on budget; a plan still marks which stops were meant." },
  'plan.round': { chess: "Round {n}, with {colour}. Habit plays {habit} on a {kind}; win at {win} or less.", finance: "Day {n} · {colour}. The baseline is {habit} on a {kind}; under budget at {win} or less." },
  'plan.bookMove': { chess: "A planned stop is a book move: it prints bare, without ?! or ?. An unanswered line stays blank.", finance: "A planned stop is planned spending: it prints bare, without ?! or ?. An unanswered line stays blank." },

  /* sheet-sweep.js: the weekly sweep / the weekly transfer */
  'sweep.label': { chess: "Move what you kept", finance: "Transfer what came in under baseline" },
  'sweep.ledger': { chess: "Since the match began on {date}: {kept} kept against habit, {moved} of it moved.", finance: "Since tracking began on {date}: {kept} under baseline, {moved} of it transferred." },
  'sweep.reserve': { chess: "the reserve", finance: "the emergency fund" },
  'sweep.reserveOf': { chess: "{name}, the reserve", finance: "{name}, the emergency fund" },
  'sweep.head': { chess: "Sweep", finance: "Transfer" },
  'sweep.title': { chess: "Last week you kept {kept} against habit.", finance: "Last week came in {kept} under baseline." },
  'sweep.ask': { chess: "Move {amount} to {where}. Kept money that is not moved gets absorbed.", finance: "Transfer {amount} to {where}. Money under baseline that is not transferred gets absorbed." },
  'sweep.reserveToday': { chess: "Reserve today", finance: "Emergency fund today" },
  'sweep.after': { chess: "After the sweep", finance: "After the transfer" },
  'sweep.noMove': { chess: "Networth does not move money: make the {what} in the bank’s own app. A {kind} of {amount} or more that posts by {day} is recorded by itself.", finance: "Networth does not transfer money: make the {what} in the bank’s own app. A {kind} of {amount} or more that posts by {day} is recorded by itself." },
  'sweep.toReserve': { chess: "transfer to the reserve", finance: "transfer to the emergency fund" },
  'sweep.moved': { chess: "I moved it", finance: "I transferred it" },
  'sweep.notBegun': { chess: "The match has not begun, so nothing has been kept against habit yet. Once it has, each Monday offers the week before when it kept {amount} or more.", finance: "Tracking has not begun, so nothing has come in under baseline yet. Once it has, each Monday offers the week before when it came in {amount} or more under baseline." },
  'sweep.recorded': { chess: "The week of {week} is recorded: {amount} moved on {day}, {via}. The next week is offered on {next}.", finance: "The week of {week} is recorded: {amount} transferred on {day}, {via}. The next week is offered on {next}." },
  'sweep.week': { chess: "The week of {week} kept {kept} against habit; a sweep is offered from {min}. The next week is offered on {next}.", finance: "The week of {week} came in {kept} under baseline; a transfer is offered from {min}. The next week is offered on {next}." },
  'sweep.none': { chess: "No round of the week of {week} counts yet. A week is offered on the Monday after it when it kept {min} or more: next on {next}.", finance: "No day of the week of {week} counts yet. A week is offered on the Monday after it when it came in {min} or more under baseline: next on {next}." },
  'sweep.nothing': { chess: "Nothing to move this week.", finance: "Nothing to transfer this week." },
  'sweep.history': { chess: "Sweeps so far", finance: "Transfers so far" },
  'sweep.toast.recorded': { chess: "Sweep recorded for the week of {week}.", finance: "Transfer recorded for the week of {week}." },

  /* sheet-move.js: the candidate move / the purchase check */
  'move.label': { chess: "Candidate move", finance: "Purchase check" },
  'move.bye': { chess: "A bye scores a draw whatever is played; the {amount} still counts.", finance: "An exempt day counts as on budget whatever is spent; the {amount} still counts." },
  'move.win.still': { chess: "Still a win", finance: "Still under budget" },
  'move.win': { chess: "A win", finance: "Under budget" },
  'move.win.line': { chess: "{word}: {amount} inside the win line.", finance: "{word}: {amount} below the target." },
  'move.draw.still': { chess: "Still a draw", finance: "Still on budget" },
  'move.draw': { chess: "A draw", finance: "On budget" },
  'move.draw.line': { chess: "{word}: {amount} inside the loss line.", finance: "{word}: {amount} below the limit." },
  'move.lost.already': { chess: "The round was already lost", finance: "The day was already over budget" },
  'move.lost': { chess: "The round is lost", finance: "The day is over budget" },
  'move.lost.line': { chess: "{word} — the margin still counts: {amount} past the loss line.", finance: "{word} — the margin still counts: {amount} past the limit." },
  'move.keptToday': { chess: "Kept today", finance: "Under baseline today" },
  'move.outside': { chess: "Outside the daily game.", finance: "Outside the daily budget." },
  'move.outside.line': { chess: "{name}: {amount} is recorded and is not played against Habit. Today’s round stays at {kept} kept.", finance: "{name}: {amount} is recorded and does not count against the baseline. Today stays at {kept} under baseline." },
  'move.notBegun': { chess: "The match has not begun.", finance: "Tracking has not begun." },
  'move.notBegun.line': { chess: "Habit is measured over {full} full days of bank history: the match begins on day {day} on record; {days} so far. Until then a move or a declined purchase is recorded as played, with no round to weigh it against.", finance: "The baseline is measured over {full} full days of bank history: tracking begins on day {day} of bank history; {days} so far. Until then a purchase or a skipped purchase is recorded as made, with no day to weigh it against." },
  'move.book.due': { chess: "nothing in the Book falls due {until}.", finance: "nothing in Recurring falls due {until}." },
  'move.larger': { chess: "{amount}: a larger move.", finance: "{amount}: a larger purchase." },
  'move.ifPlayed': { chess: "if played today", finance: "if bought today" },
  'move.standing.notBegun': { chess: "The match has not begun: it begins on day {day} on record; {days} so far. A move or a declined purchase is recorded all the same.", finance: "Tracking has not begun: it begins on day {day} of bank history; {days} so far. A purchase or a skipped purchase is recorded all the same." },
  'move.standing.bye': { chess: "Round {n} is a bye: it scores a draw whatever is played. So far {conv} in {stops}.", finance: "Day {n} is an exempt day: it counts as on budget whatever is spent. So far {conv} in {stops}." },
  'move.standing': { chess: "Round {n}: Habit plays {habit}. So far {conv} in {stops}, {kept} kept. Win at {win} or less; loss above {loss}.", finance: "Day {n}: the baseline is {habit}. So far {conv} in {stops}, {kept} under baseline. Under budget at {win} or less; over budget above {loss}." },
  'move.where': { chess: "Round {n}, move {m}", finance: "Day {n}, purchase {m}" },
  'move.title': { chess: "Look before you play it.", finance: "Check before you buy." },
  'move.noPrice': { chess: "Enter the price first: a move is recorded with its amount.", finance: "Enter the price first: a purchase is recorded with its amount." },
  'move.play': { chess: "Play it", finance: "Buy it" },
  'move.adjourn': { chess: "Adjourn 10:00", finance: "Wait 10:00" },
  'move.decline': { chess: "Decline", finance: "Skip" },
  'move.adjourned': { chess: "adjourned", finance: "on hold" },
  'move.sealedUntil': { chess: "Sealed until {time}.", finance: "On hold until {time}." },
  'move.timeUp': { chess: "Time is up: ", finance: "Time is up: " },
  'move.timeLeft': { chess: "Time until play resumes: ", finance: "Time left on hold: " },
  'move.open': { chess: "Sealed at {time}. The move is open: play it or decline it.", finance: "On hold since {time}. The purchase is open: buy it or skip it." },
  'move.waiting': { chess: "until play resumes. Sealed at {time}; nothing is recorded yet.", finance: "left on hold. On hold since {time}; nothing is recorded yet." },
  'move.sealedMove': { chess: "the sealed move", finance: "the purchase on hold" },
  'move.unseal': { chess: "Clears the sealed move without recording it.", finance: "Clears the purchase on hold without recording it." },
  'move.declinedAt': { chess: "declined {time}", finance: "skipped {time}" },
  'move.notPlayed': { chess: "Not played.", finance: "Not bought." },
  'move.declined': { chess: "Declined", finance: "Skipped" },
  'move.yourSide': { chess: "The {amount} stays on your side of the board.", finance: "The {amount} stays in your account." },
  'move.keptHolds': { chess: " Kept today holds at {kept}.", finance: " Under baseline today holds at {kept}." },
  'move.instead': { chess: "One tap adds it to the move and closes. Answering is optional.", finance: "One tap adds it to the purchase and closes. Answering is optional." },
  'move.onSheet': { chess: "The declined purchase is on today’s scoresheet, recorded at {time}.", finance: "The skipped purchase is in today’s transactions, recorded at {time}." },
  'move.toast.declined': { chess: "Declined: {name}", finance: "Skipped: {name}" },
  'move.toast.round': { chess: ", round {n}", finance: ", day {n}" },
  'move.theMove': { chess: "the move", finance: "the purchase" },

  /* sheet-habit.js: the opponent / the baseline */
  'habit.label': { chess: "The opponent", finance: "Baseline" },
  'habit.col.work': { chess: "Workday<span class=\"not-phone\"> · Black</span>", finance: "Workday" },
  'habit.col.off': { chess: "Day off<span class=\"not-phone\"> · White</span>", finance: "Day off" },
  'habit.row.plays': { chess: "Habit plays", finance: "Baseline" },
  'habit.row.win': { chess: "A win at or under", finance: "Target, at or under" },
  'habit.row.loss': { chess: "A loss over", finance: "Limit, over" },
  'habit.workday': { chess: "workday habit", finance: "workday baseline" },
  'habit.head.note': { chess: "Habit", finance: "convenience spending" },
  'habit.none': { chess: "No opponent is seated yet.", finance: "No baseline is set yet." },
  'habit.none.text': { chess: "Habit is your own average convenience spending — cafes, delis, delivery, snacks — over the {days} days before the match, taken apart for workdays and days off.", finance: "Your baseline is your own average convenience spending — cafes, delis, delivery, snacks — over the {days} days before tracking, taken apart for workdays and days off." },
  'habit.none.later': { chess: "Nothing needs doing. The match begins by itself on day {from} on record; {days} so far. Rounds are scored from that day on.", finance: "Nothing needs doing. Tracking begins by itself on day {from} of bank history; {days} so far. Days are scored from that day on." },
  'habit.today': { chess: "Seated today", finance: "Set today" },
  'habit.today.text': { chess: "This opponent was seated today, {date}. It can be removed until the day is over; the one before it then plays again.", finance: "This baseline was set today, {date}. It can be removed until the day is over; the one before it then applies again." },
  'habit.today.remove': { chess: "Remove today’s opponent", finance: "Remove today’s baseline" },
  'habit.stronger': { chess: "A stronger opponent", finance: "A lower baseline" },
  'habit.new': { chess: "A new opponent", finance: "A new baseline" },
  'habit.notEnough': { chess: "A new opponent is computed from the last {days} days and needs {full} full days of bank history in that window. There is not enough as of {date}.", finance: "A new baseline is computed from the last {days} days and needs {full} full days of bank history in that window. There is not enough as of {date}." },
  'habit.noStronger': { chess: "On these figures it would be no stronger than the one in force.", finance: "On these figures it would be no lower than the one in force." },
  'habit.seating': { chess: "Seating it starts a new segment today, {date}. The kept total is never reset: every earlier round keeps its result, and only the lines change from today on.", finance: "Setting it starts a new segment today, {date}. The running total under baseline is never reset: every earlier day keeps its result, and only the lines change from today on." },
  'habit.title': { chess: "Habit, your own frozen baseline.", finance: "Your own frozen baseline." },
  'habit.backtest': { chess: "Under these lines that window would have scored {pct}%. The win line is set where the score comes nearest 40%.", finance: "Under these lines that window would have had a budget score of {pct}%. The target is set where the budget score comes nearest 40%." },
  'habit.offer.scored': { chess: "; that window would have scored {score}", finance: "; that window would have had a budget score of {score}" },
  'habit.edge': { chess: "Kept v. Habit", finance: "Under baseline" },
  'habit.edge.since': { chess: "Since {date}, over every opponent. A counterfactual: never reset, never cash.", finance: "Since {date}, over every baseline. A counterfactual: never reset, never cash." },
  'habit.edge.none': { chess: "No round has been scored yet.", finance: "No day has been scored yet." },
  'habit.earlier': { chess: "Earlier opponents", finance: "Earlier baselines" },
  'habit.earlier.row': { chess: "Habit played {work} on a workday and {off} on a day off; a win at {winWork} and {winOff} or less.", finance: "Baseline {work} on a workday and {off} on a day off; under budget at {winWork} and {winOff} or less." },
  'habit.first': { chess: "None: this is the first, seated {date}. Habit never changes by itself.", finance: "None: this is the first, set {date}. The baseline never changes by itself." },
  'habit.play.stronger': { chess: "Play a stronger opponent", finance: "Set a lower baseline" },
  'habit.play.this': { chess: "Play this opponent from today", finance: "Use this baseline from today" },
  'habit.undo.seat': { chess: "New opponent seated", finance: "New baseline set" },
  'habit.undo.unseat': { chess: "Today’s opponent removed", finance: "Today’s baseline removed" },
  'habit.toast.needs': { chess: "A new opponent needs {full} full days of bank history in the last {days}.", finance: "A new baseline needs {full} full days of bank history in the last {days}." },
  'habit.toast.seated': { chess: "A new opponent plays from {date}. The kept total carries over.", finance: "A new baseline applies from {date}. The running total under baseline carries over." },
  'habit.toast.removed': { chess: "Removed: the opponent seated {date}; the one from {from} plays again.", finance: "Removed: the baseline set {date}; the one from {from} applies again." },
  'habit.matchStart': { chess: "the start of the match", finance: "the start of tracking" },

  /* sheet-recurring.js: a Book entry / a recurring item */
  'recurring.entry': { chess: "Book entry", finance: "Recurring item" },
  'recurring.label': { chess: "Book entry: {name}", finance: "Recurring item: {name}" },
  'recurring.label.new': { chess: "New Book entry", finance: "New recurring item" },
  'recurring.removed': { chess: "taken out of the Book by you", finance: "removed from Recurring by you" },
  'recurring.gone': { chess: "It was removed since this sheet was opened. The Book lists the {lines} there are.", finance: "It was removed since this sheet was opened. Recurring lists the {lines} there are." },
  'recurring.newTitle': { chess: "A line for the Book.", finance: "A line item for Recurring." },
  'recurring.essential': { chess: "Rent, a loan payment, insurance: an only move, marked □ in the Book.", finance: "Rent, a loan payment, insurance: a fixed obligation, marked □ in Recurring." },
  'recurring.verdict': { chess: "A note to yourself. It changes no figure; review and cut are totalled at the top of the Book.", finance: "A note to yourself. It changes no figure; review and cut are totalled at the top of Recurring." },
  'recurring.dismiss': { chess: "Takes it out of the Book and keeps it out.", finance: "Takes it out of Recurring and keeps it out." },
  'recurring.ordinary.one': { chess: "an ordinary move", finance: "an ordinary transaction" },
  'recurring.ordinary.many': { chess: "ordinary moves", finance: "ordinary transactions" },
  'recurring.restore': { chess: "Lists it in the Book again{from}, and keeps it there until you take it out.", finance: "Lists it in Recurring again{from}, and keeps it there until you take it out." },
  'recurring.add': { chess: "Add to the Book", finance: "Add to Recurring" },
  'recurring.pay.new': { chess: "For a payment you send yourself by Zelle or bank transfer. It is on the Board’s list each month and is ticked when the bank shows it or you tick it; until then it is taken off what is liquid. 3 fields; the bank’s own row ticks it from then on.", finance: "For a payment you send yourself by Zelle or bank transfer. It is on the Overview’s list each month and is ticked when the bank shows it or you tick it; until then it is taken off what is liquid. 3 fields; the bank’s own row ticks it from then on." },
  'recurring.pay.off': { chess: "Off: it leaves the Board’s list and is not counted as due; its {ticks} and its name are kept.", finance: "Off: it leaves the Overview’s list and is not counted as due; its {ticks} and its name stay on file." },
  'recurring.undo.added': { chess: "Line added to the Book", finance: "Line item added to Recurring" },
  'recurring.toast.added': { chess: "{name} is in the Book", finance: "{name} is in Recurring" },
  'recurring.toast.addedUndone': { chess: "{name} is taken back out of the Book.", finance: "{name} is taken back out of Recurring." },
  'recurring.undo.changed': { chess: "Book entry changed", finance: "Recurring item changed" },
  'recurring.undo.out': { chess: "Taken out of the Book", finance: "Taken out of Recurring" },
  'recurring.toast.out': { chess: "{name} is out of the Book", finance: "{name} is out of Recurring" },
  'recurring.toast.back': { chess: "{name} is back in the Book.", finance: "{name} is back in Recurring." },
  'recurring.undo.back': { chess: "Brought back into the Book", finance: "Brought back into Recurring" },
  'recurring.toast.backIn': { chess: "{name} is back in the Book", finance: "{name} is back in Recurring" },
  'recurring.toast.outAgain': { chess: "{name} is out of the Book again.", finance: "{name} is out of Recurring again." },

  /* settings.js: Settings */
  'settings.reserve': { chess: "reserve", finance: "emergency fund" },
  'settings.everyday': { chess: "Everyday accounts are the ones the daily round reads.", finance: "Everyday accounts are the ones the daily budget reads." },
  'settings.sample': { chess: "Sample game", finance: "Sample data" },
  'settings.share.keyHelp': { chess: "Kept on this device only, outside the record: it is in no saved copy, and this box is cleared the moment it is used. Each device needs 1 paste.", finance: "Stored on this device only, outside the record: it is in no saved copy, and this box is cleared the moment it is used. Each device needs 1 paste." },
  'settings.share.keptIn': { chess: "Kept in", finance: "Stored in" },
  'settings.unlinked': { chess: "Not linked. The record is kept.", finance: "Not linked. The record stays on this device." },
  'settings.share.offLedeMore': { chess: "what is added or ticked on 1 device shows on the others within seconds of opening them, and nothing is typed twice.", finance: "what is added or ticked on 1 device shows on the others within seconds of launching them, and nothing is typed twice." },
  'settings.alerts.sameKey': { chess: "the same key as pasted here; if it was not kept, make a new one the same way and paste it here on every device too", finance: "the same key as pasted here; if it was not saved, make a new one the same way and paste it here on every device too" },
  'settings.share.offLede': { chess: "The payments you send yourself, and their ticks, are then kept in a private file on your own GitHub ({owner}/networth-data):", finance: "The payments you send yourself, and their ticks, are then stored in a private file on your own GitHub ({owner}/networth-data):" },
  'settings.alerts.lede': { chess: "Each charge on your card lowers the net worth on every device within a minute or two of your card’s bank texting you, shown like a move tapped in.", finance: "Each charge on your card lowers the net worth on every device within a minute or two of your card’s bank texting you, shown like a purchase tapped in." },
  'settings.alerts.only': { chess: "The shortcut sends no text that holds a code word or no dollar figure, and the app turns only a completed purchase into a move: any other text is deleted.", finance: "The shortcut sends no text that holds a code word or no dollar figure, and the app turns only a completed purchase into a transaction: any other text is deleted." },
  'settings.income.cash': { chess: "Cash in hand:", finance: "Physical cash:" },
  'settings.storage.kept': { chess: "Kept on this device only,", finance: "Stored on this device only," },
  'settings.shared.what': { chess: "Apart from the date of a corrected move, nothing the bank reported goes there: no balance, no transaction, no account. Only what you entered, your ticks, and an unreadable fingerprint of who each payment goes to, so every device recognises it the same way.", finance: "Apart from the date of a corrected transaction, nothing the bank reported goes there: no balance, no other transaction, no account. Only what you entered, your ticks, and an unreadable fingerprint of who each payment goes to, so every device recognises it the same way." },
  'settings.shared.corrections': { chess: "Corrections (categories, merchant names, income settings) reach your other devices too, each with an unreadable fingerprint of its merchant or move and, for a corrected move, its bank date, so that every device finds the same move.", finance: "Corrections (categories, merchant names, income settings) reach your other devices too, each with an unreadable fingerprint of its merchant or transaction and, for a corrected transaction, its bank date, so that every device finds the same transaction." },
  'settings.sample.bank': { chess: "Sample game — nothing is linked.", finance: "Sample data — nothing is linked." },
  'settings.sample.share': { chess: "Sample game — nothing is shared.", finance: "Sample data — nothing is shared." },
  'settings.income.pencil': { chess: "A payment by Zelle or transfer counts in pencil until the bank’s row takes its place; a payment in cash counts in Cash in hand.", finance: "A payment by Zelle or transfer counts as provisional until the bank’s row takes its place; a payment in cash counts in Physical cash." },
  'settings.day.note': { chess: "how a round is counted", finance: "how a day is counted" },
  'settings.day.count': { chess: "{work} with Black{sep}{off} with White", finance: "{work} workdays{sep}{off} days off" },
  'settings.day.workday': { chess: "A workday is played with Black against the workday habit; the other days are days off, with White.", finance: "A workday is counted against the workday baseline; the other days are days off, against theirs." },
  'settings.day.notBegun': { chess: " No match is in progress yet: the match begins on day {day} on record; {days} so far. These choices apply from then.", finance: " Tracking has not begun yet: it begins on day {day} of bank history; {days} so far. These choices apply from then." },
  'settings.rollover': { chess: "A purchase at 1:00 AM belongs to the evening before. Applies to moves read from now on.", finance: "A purchase at 1:00 AM belongs to the evening before. Applies to transactions read from now on." },
  'settings.pending': { chess: "Pending charges enter balances and rounds at once. A round stays in pencil until they post, usually within 3 days.", finance: "Pending charges enter balances and days at once. A day stays provisional until they post, usually within 3 days." },
  'settings.byes': { chess: "Byes a month", finance: "Exempt days a month" },
  'settings.byes.help': { chess: "A bye is a day declared ahead: it scores ½, and its dollars still count.", finance: "An exempt day is declared ahead: it counts as on budget, and its dollars still count." },
  'settings.cover': { chess: "Every amount becomes an ink bar, for opening Networth in public. It stays on until switched off; Cover in the masthead does the same.", finance: "Every amount becomes a solid bar, for using Networth in public. It stays on until switched off; Cover in the masthead does the same." },
  'settings.principles': { chess: "Opening principles", finance: "Spending rules" },
  'settings.principles.help': { chess: "Shown on the candidate-move sheet before a purchase. Up to 8; clear a line to remove it.", finance: "Shown on the purchase check before a purchase. Up to 8; clear a line to remove it." },
  'settings.principle.one': { chess: "Principle", finance: "Rule" },
  'settings.principle.add': { chess: "Add a principle", finance: "Add a rule" },
  'settings.insteads.help': { chess: "One tap after a declined purchase records what was done instead. Up to 6; clear a line to remove it.", finance: "One tap after a skipped purchase records what was done instead. Up to 6; clear a line to remove it." },
  'settings.purposes.help': { chess: "The 4 tags a move or an account can carry. A cleared name returns to its default.", finance: "The 4 tags a transaction or an account can carry. A cleared name returns to its default." },
  'settings.sample.kept': { chess: "The sample game is kept nowhere: it is rebuilt each time, and nothing changed in it is saved.", finance: "Sample data is stored nowhere: it is rebuilt each time, and nothing changed in it is saved." },
  'settings.move.one': { chess: "move", finance: "transaction" },
  'settings.move.many': { chess: "moves", finance: "transactions" },
  'settings.sample.nothing': { chess: "In the sample game there is nothing of yours to save, restore or erase.", finance: "In the sample data there is nothing of yours to save, restore or erase." },
  'settings.does': { chess: "Work out the Book of bills, the pay rhythm, the daily round against Habit, and net worth.", finance: "Work out recurring bills, the pay rhythm, the daily budget against your baseline, and net worth." },
  'settings.doesNot': { chess: "Move money, or see a bank password: you sign in on the bank’s own page.", finance: "Transfer money, or see a bank password: you sign in on the bank’s own page." },
  'settings.top.sample': { chess: "In the sample game a change lasts until this page is closed or reloaded, and none is kept", finance: "In the sample data a change lasts until this page is closed or reloaded, and none is stored" },
  'settings.top.complete': { chess: ", and none of the {n} sections needs a visit: the board is complete as it stands.", finance: ", and none of the {n} sections needs a visit: the overview is complete as it stands." },
  'settings.toast.linked': { chess: "Linked. {accounts} on the board", finance: "Linked. {accounts} on the overview" },
  'settings.toast.newMoves.one': { chess: "new move", finance: "new transaction" },
  'settings.toast.newMoves.many': { chess: "new moves", finance: "new transactions" },

  /* sheet-account.js: an account’s sheet */
  'account.cash.title': { chess: "Cash in hand.", finance: "Physical cash." },
  'account.workedDown': { chess: "worked down by Networth from the {amount} entered {day}", finance: "amortized by Networth from the {amount} entered {day}" },
  'account.chooser': { chess: "Material", finance: "Balance sheet" },
  'account.noteKept': { chess: "Optional. Kept beside the figure in the record.", finance: "Optional. Stored beside the figure in the record." },
  'account.noteKept.later': { chess: "Optional. Kept beside the figure in the record. Left as it is, it stays with the {day} figure and a new figure starts without one.", finance: "Optional. Stored beside the figure in the record. Left as it is, it stays with the {day} figure and a new figure starts without one." },
  'account.type.help': { chess: "Decides where it stands on Material: cash now, money in days, slow to sell, or owed.", finance: "Decides where it stands on the Balance sheet: cash, near-cash, illiquid, or owed." },
  'account.soldFast': { chess: "Sold fast", finance: "Liquidation value" },
  'account.quick': { chess: "Quick-sale share", finance: "Recovery rate" },
  'account.quick.help': { chess: "The share of the figure a sale within days would raise. It changes one line only: net worth “if everything slow had to be sold fast”. Empty counts it in full.", finance: "The share of the figure a sale within days would raise. It changes one line only: the liquidation value of net worth. Empty counts it in full." },
  'account.pending': { chess: ", pending moves counted · the bank reported {amount} {age}", finance: ", pending transactions counted · the bank reported {amount} {age}" },
  'account.readAs': { chess: "Read as {type} until you save. Saving moves it on Material and is never guessed again.", finance: "Read as {type} until you save. Saving places it on the Balance sheet and is never guessed again." },
  'account.everyday': { chess: "The oldest report among everyday accounts decides when a round turns from pencil to ink.", finance: "The oldest report among everyday accounts decides when a day turns from provisional to final." },
  'account.reserve': { chess: "Counts toward the reserve", finance: "Counts toward the emergency fund" },
  'account.reserve.help': { chess: "Only flagged cash counts toward the reserve goal. With none flagged, all cash does.", finance: "Only flagged cash counts toward the emergency fund goal. With none flagged, all cash does." },
  'account.hidden.help': { chess: "Dropped from net worth, cash, the rounds and the card cycle. The bank feed keeps it up to date in case it returns.", finance: "Dropped from net worth, cash, the daily budget and the card cycle. The bank feed keeps it up to date in case it returns." },
  'account.apr': { chess: "The APR gives interest per day on Material and the payoff scenario in Analysis. The limit gives utilization.", finance: "The APR gives interest per day on the Balance sheet and the payoff scenario in Analysis. The limit gives utilization." },
  'account.flip': { chess: "On when a debt shows up as money you have: the balance is read as owed, and that reading is kept through every sync.", finance: "On when a debt shows up as money you have: the balance is read as owed, and that reading holds through every sync." },
  'account.toast.removed': { chess: "{name} removed from Material.", finance: "{name} removed from the Balance sheet." },
  'account.readName': { chess: "Read from the account’s name. Correcting it moves the account between cash, cards, assets and debts, and it is never guessed again.", finance: "Read from the account’s name. Correcting it shifts the account between cash, cards, assets and debts, and it is never guessed again." },

  /* sheet-stream.js: an income stream */
  'stream.off': { chess: "The whole deposit is counted on the day it arrives. With no stream counted day by day, net worth is shown exactly as the bank reports it.", finance: "The whole deposit is counted on the day it arrives (cash basis). With no stream accrued, net worth is shown exactly as the bank reports it." },
  'stream.settingOff': { chess: "Counting pay as it is earned is switched off in Settings, so this choice waits until that is on.", finance: "Accrual accounting is switched off in Settings, so this choice waits until that is on." },
  'stream.book': { chess: "Streams are found by the bank feed, after a payer’s second deposit. The Book lists the {streams} there are.", finance: "Streams are found by the bank feed, after a payer’s second deposit. Recurring lists the {streams} there are." },
  'stream.switch': { chess: "Count it as earned day by day", finance: "Accrue it daily" },
  'stream.toast.accrue': { chess: " is now counted as earned day by day.", finance: " is now accrued daily." },
  'stream.toast.arrives': { chess: " is now counted on the day it arrives.", finance: " is now on a cash basis." },

  /* income-words.js: the words of income and of the physical cash */
  'income.boardAsks': { chess: "The board asks whether this is ", finance: "The overview asks whether this is " },
  'income.zelle': { chess: " pays by Zelle or transfer: it counts in pencil until the bank shows it.", finance: " pays by Zelle or transfer: it counts as provisional until the bank shows it." },
  'income.onBoard': { chess: " on the board.", finance: " on the overview." },
  'income.record.pencil': { chess: " The last step, in pencil, counts the moves not yet at the bank; dotted: ", finance: " The last step, provisional, counts the transactions not yet at the bank; dotted: " },

  /* ui/charts.js: the text alternatives of the charts (the words come from the root element) */
  'charts.edge': { chess: "Kept versus habit", finance: "Running total under baseline" },
  'charts.edge.round': { chess: "round", finance: "day" },
  'charts.edge.rounds': { chess: "rounds", finance: "days" },
  'charts.edge.moved': { chess: ", of which {amount} moved", finance: ", of which {amount} transferred" },
  'charts.cover.edge': { chess: "Kept versus habit by round", finance: "Running total under baseline by day" },
  'charts.key.edge': { chess: "KEPT VS HABIT", finance: "UNDER BASELINE" },
  'charts.key.habit': { chess: "HABIT LINE", finance: "BASELINE" },
  'charts.key.round': { chess: "ROUND", finance: "DAY" },
  'app.footer.device': { chess: "Networth is kept on this device only: no server, no account, no tracking.", finance: "Networth is stored on this device only: no server, no account, no tracking." },
  'charts.key.moved': { chess: "MOVED", finance: "TRANSFERRED" },
  'settings.unlink': { chess: "The key is forgotten on this device and nothing new arrives. Every account, move and round already here stays.", finance: "The key is forgotten on this device and nothing new arrives. Every account, transaction and day already here stays." },
  'settings.erase': { chess: "The bank key, the key of the shared list if this device has one, every account, move and round, and the daily snapshots (up to 14) are removed from this device. A saved copy is the only way back.", finance: "The bank key, the key of the shared list if this device has one, every account, transaction and day, and the daily snapshots (up to 14) are removed from this device. A saved copy is the only way back." },
  'settings.share.failed': { chess: "The last round did not go through.", finance: "The last sync did not go through." },
  'settings.share.first': { chess: "Sharing: the first round has not run yet.", finance: "Sharing: the first sync has not run yet." },
  'settings.payOff': { chess: "Switched off, net worth moves only on the day money moves.", finance: "Switched off, net worth changes only on the day money arrives or leaves." },
  'analysis.columns': { chess: "both columns hold the same moves", finance: "both columns hold the same transactions" },
  'tx.undo.confirmed': { chess: "Move confirmed", finance: "Transaction confirmed" },
  'recurring.noDebt': { chess: "No loan or card is known yet. One added under Material can be chosen here; its payment then counts as committed, not as a cost.", finance: "No loan or card is known yet. One added under the Balance sheet can be chosen here; its payment then counts as committed, not as a cost." },
  'account.toast.added': { chess: "{name} added to Material.", finance: "{name} added to the Balance sheet." },
  'account.kind.slow': { chess: "Slow to sell", finance: "Illiquid" },
  'account.kind.days': { chess: "Counted as money in days.", finance: "Counted as near-cash." },
  'account.kind.workedDown': { chess: "works the balance down", finance: "amortizes the balance" },
  'account.count.failed': { chess: "This count could not be kept. Type the cash you have now, for example 120.00.", finance: "This count could not be saved. Type the cash you have now, for example 120.00." },
  'settings.undo.cash': { chess: "Cash in hand added", finance: "Physical cash added" },
});

/**
 * A phrase's template in a mode; '' for a key that is not one.
 * @param {string} key
 * @param {*} mode
 * @returns {string}
 */
export function phrase(key, mode) {
  if (typeof key !== 'string' || !Object.hasOwn(PHRASES, key)) return '';
  return PHRASES[key][wordsMode(mode)];
}

/**
 * A phrase in a mode, its `{placeholders}` filled from `vars` (each written as a string). A placeholder `vars` does
 * not name is left as written, so that a missing value shows instead of vanishing; a key that is not one says ''.
 * @param {string} key
 * @param {*} mode
 * @param {Object<string, *>} [vars]
 * @returns {string}
 */
export function say(key, mode, vars) {
  const template = phrase(key, mode);
  if (!vars || typeof vars !== 'object') return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : whole));
}

/** The placeholders a template takes, sorted: 'Kept {amount} on {kind}' -> ['amount', 'kind']. */
export function placeholders(template) {
  const out = new Set();
  for (const match of String(template).matchAll(/\{(\w+)\}/g)) out.add(match[1]);
  return [...out].sort();
}

/* -------------------------------------------------------------------- glossary */

/** The glossary's groups, in order, each named in both modes. */
export const TERM_GROUPS = Object.freeze([
  Object.freeze({ key: 'pages', chess: 'Pages', finance: 'Pages' }),
  Object.freeze({ key: 'networth', chess: 'Net worth', finance: 'Net worth' }),
  Object.freeze({ key: 'cash', chess: 'Cash and the clock', finance: 'Cash and runway' }),
  Object.freeze({ key: 'day', chess: 'The daily game', finance: 'The daily budget' }),
  Object.freeze({ key: 'marks', chess: 'Results and marks', finance: 'Results and marks' }),
  Object.freeze({ key: 'book', chess: 'The Book', finance: 'Recurring' }),
  Object.freeze({ key: 'other', chess: 'Settings and the rest', finance: 'Settings and the rest' }),
]);

const sign = (glyph) => ({ chess: glyph + ' ' + GLYPH_NAMES[glyph].chess, finance: glyph + ' ' + GLYPH_NAMES[glyph].finance });
const step = (symbol) => ({ chess: EVAL_NAMES[symbol].chess, finance: EVAL_NAMES[symbol].finance });
const row = (key, group, names, meaning) => Object.freeze({ key, group, chess: names.chess, finance: names.finance, meaning });

/**
 * Every term, by group: its name in each mode and its meaning in one line (plain words, true in either mode).
 * The glossary sheet lists them in this order.
 */
export const TERMS = Object.freeze([
  row('board', 'pages', { chess: 'Board', finance: 'Overview' },
    'The home page that sums up where you stand today: net worth, cash, today’s spending.'),
  row('board-app', 'pages', { chess: 'Net-worth board', finance: 'Net-worth dashboard' },
    'One screen that tracks your key figures and keeps itself up to date.'),
  row('scoresheet', 'pages', { chess: 'Scoresheet', finance: 'Transactions' },
    'The record of every money movement, listed day by day.'),
  row('material-page', 'pages', { chess: 'Material', finance: 'Balance sheet' },
    'What you own (assets) set against what you owe (liabilities); the difference is net worth.'),
  row('book', 'pages', { chess: 'Book', finance: 'Recurring' },
    'The bills, subscriptions and pay that repeat on a schedule.'),
  row('analysis', 'pages', { chess: 'Analysis', finance: 'Analysis' },
    'Goals, scenarios and projections worked out from your own figures.'),
  row('variations', 'pages', { chess: 'Variations', finance: 'Scenarios' },
    'A what-if projection, such as saving a set amount each month or paying extra on a loan.'),

  row('smoothed', 'networth', { chess: 'Smoothed net worth', finance: 'Net worth, accrual basis' },
    'Income and bills count as they are earned and used, not when cash changes hands, so net worth glides instead of jumping on payday.'),
  row('pay-earned', 'networth', { chess: 'Pay earned', finance: 'Accrued income' },
    'Pay you have earned by working but not yet received; a receivable.'),
  row('bills-used', 'networth', { chess: 'Bills used', finance: 'Accrued expenses' },
    'Bills you have already used up but not yet been charged for; a payable.'),
  row('accrual-switch', 'networth', { chess: 'Count pay as it is earned', finance: 'Accrual accounting' },
    'Records income and costs in the days they belong to, spread day by day, instead of on the day the money lands or leaves.'),
  row('cash-basis', 'networth', { chess: 'Counted when it arrives', finance: 'Cash basis' },
    'Income and costs are recorded only on the day money actually lands or leaves.'),
  row('slow-to-sell', 'networth', { chess: 'Slow to sell', finance: 'Illiquid' },
    'An asset that cannot be turned into cash quickly without giving up some of its value, such as equipment.'),
  row('liquidity-tiers', 'networth', { chess: 'Now · In days · Slow', finance: 'Cash & equivalents · Near-cash · Illiquid' },
    'How fast an asset becomes cash; a balance sheet lists assets from the most to the least liquid.'),
  row('sold-fast', 'networth', { chess: 'Sold fast', finance: 'Liquidation value' },
    'What your assets would raise in a forced quick sale, usually less than their stated value.'),
  row('quick-sale-share', 'networth', { chess: 'Quick-sale share', finance: 'Recovery rate' },
    'The share of an asset’s value that a forced sale would actually raise.'),
  row('haircut', 'networth', { chess: 'What a fast sale would not raise', finance: 'Haircut' },
    'The cut in value taken when an asset must be sold in a hurry: its value times one less the recovery rate.'),
  row('reckoning', 'networth', { chess: 'The reckoning', finance: 'Reconciliation' },
    'A line-by-line walk showing how one figure (net worth at the bank) becomes another (net worth, accrual basis).'),
  row('worked-down', 'networth', { chess: 'Worked down', finance: 'Amortized' },
    'A loan paid down on a schedule, each payment covering the interest and some of the principal.'),
  row('retention', 'networth', { chess: 'Retention', finance: 'Savings rate' },
    'The share of your income left after all spending.'),
  row('position', 'networth', { chess: 'The position', finance: 'Financial health' },
    'One overall reading, built from four factors: net worth trend, liquidity, debt trend and savings rate.'),
  row('factor-material', 'networth', { chess: 'Material', finance: 'Net worth trend' },
    'The 30-day change in net worth against a month of take-home pay: a reading of solvency, whether you are getting further ahead.'),
  row('factor-structure', 'networth', { chess: 'Structure', finance: 'Debt trend' },
    'Whether your credit-card balance fell or rose over the last two full months.'),
  row('factor-initiative', 'networth', { chess: 'Initiative', finance: 'Savings rate' },
    'The share of this month’s income not spent so far.'),
  row('norm', 'networth', { chess: 'Norm', finance: 'Income target' },
    'A yearly gross-income goal; the ladder shows how close you are to each.'),
  row('norm-titles', 'networth', { chess: 'GM · IM · FM · CM · NM', finance: 'Target 5 · 4 · 3 · 2 · 1' },
    'The rungs of the income ladder, highest first; in Finance words a rung shows its amount and, where it needs a name, its number.'),

  row('clock', 'cash', { chess: 'The clock', finance: 'Runway' },
    'How many days your cash lasts at your usual daily spending: cash divided by the burn rate.'),
  row('on-the-clock', 'cash', { chess: 'On the clock', finance: 'Of runway · on hand' },
    'Days of runway, or the cash that funds them.'),
  row('factor-time', 'cash', { chess: 'Time', finance: 'Liquidity' },
    'Whether you have enough cash for what is due soon: read as days of runway and any shortfall before payday.'),
  row('time-trouble', 'cash', { chess: 'Time trouble', finance: 'Cash crunch' },
    'Cash covers under 7 days of spending, or falls short of what is due before payday.'),
  row('flag', 'cash', { chess: 'Flag', finance: 'Out of cash' },
    'The runway has reached zero days.'),
  row('short-spare', 'cash', { chess: 'Short · To spare', finance: 'Shortfall · Surplus' },
    'What cash lacks to cover the bills due before payday, or what is left after them.'),
  row('reserve', 'cash', { chess: 'Reserve', finance: 'Emergency fund' },
    'Cash set aside only for surprises, usually sized in months of spending.'),
  row('measured-in-time', 'cash', { chess: 'Measured in time', finance: 'In days of spending' },
    'Cash sized in days of spending (cash divided by the burn rate) instead of dollars.'),
  row('burn-rate', 'cash', { chess: 'Typical outflow', finance: 'Burn rate' },
    'How fast cash goes out: your average spending per day over 60 days.'),
  row('cash-in-hand', 'cash', { chess: 'Cash in hand', finance: 'Physical cash' },
    'Notes and coins you hold, outside any account.'),

  row('move', 'day', { chess: 'Move', finance: 'Transaction' },
    'Any money movement the bank records, such as a purchase, a deposit or a transfer.'),
  row('candidate-move', 'day', { chess: 'Candidate move', finance: 'Purchase check' },
    'A look at what a purchase would do to today’s budget and your cash before you buy.'),
  row('play-it', 'day', { chess: 'Play it', finance: 'Buy it' },
    'Going ahead with the purchase.'),
  row('adjourn', 'day', { chess: 'Adjourn', finance: 'Wait' },
    'A short wait before buying, so an impulse can pass.'),
  row('declined', 'day', { chess: 'Declined', finance: 'Skipped' },
    'A purchase you chose not to make; nothing was spent.'),
  row('round', 'day', { chess: 'Round', finance: 'Day' },
    'One calendar day of spending, scored against your baseline.'),
  row('match', 'day', { chess: 'The match', finance: 'Tracking' },
    'The stretch, after your baseline is measured, in which every day is scored.'),
  row('exhibition', 'day', { chess: 'Before the match', finance: 'Baseline period' },
    'The early days used to measure your usual spending; shown for reference, never scored.'),
  row('habit', 'day', { chess: 'Habit', finance: 'Baseline' },
    'Your own average convenience spending, measured once and then fixed, that each day is compared with.'),
  row('you-v-habit', 'day', { chess: 'You v. Habit', finance: 'Spending vs. baseline' },
    'Each day’s spending set against your usual spending.'),
  row('seat-opponent', 'day', { chess: 'Seat a stronger opponent', finance: 'Set a lower baseline' },
    'Replacing the baseline with a newer, lower one; past results keep their scores.'),
  row('win-line', 'day', { chess: 'Win line', finance: 'Target' },
    'The daily spending level that counts as under budget, set so you would have met it on about 40% of past days.'),
  row('loss-line', 'day', { chess: 'Loss line', finance: 'Limit' },
    'Your baseline rounded up; spending above it makes the day over budget.'),
  row('kept', 'day', { chess: 'Kept', finance: 'Under baseline' },
    'How much less you spent than your baseline: a comparison, not cash in any account.'),
  row('edge', 'day', { chess: 'The edge', finance: 'Running total under baseline' },
    'Everything that came in under baseline since tracking began, added up.'),
  row('standing', 'day', { chess: 'Standing', finance: 'Variance' },
    'The gap between today’s spending and the baseline so far; positive means under.'),
  row('sweep', 'day', { chess: 'Move it', finance: 'Transfer it' },
    'Moving what came in under baseline to savings or onto the card, so it is not spent.'),
  row('bye', 'day', { chess: 'Bye', finance: 'Exempt day' },
    'A day declared ahead (say, a dinner out) that counts as on budget whatever you spend; its dollars still count in the totals.'),
  row('colour', 'day', { chess: 'Black · White', finance: 'Workday · Day off' },
    'Each day is a workday or a day off, and each has its own baseline.'),
  row('crosstable', 'day', { chess: 'Crosstable', finance: 'Budget calendar' },
    'The month grid showing each day’s result against your baseline.'),
  row('opening-prep', 'day', { chess: 'Opening preparation', finance: 'Morning plan' },
    'A short plan for the day’s small purchases, made before the first one.'),
  row('book-move', 'day', { chess: 'Book move', finance: 'Planned spending' },
    'A purchase you put in the morning plan; it is never marked as unplanned.'),
  row('daily-game', 'day', { chess: 'The daily game', finance: 'The daily budget' },
    'The day-by-day comparison of convenience spending with your baseline.'),
  row('score', 'day', { chess: 'Score', finance: 'Budget score' },
    'One point for each day under budget and half a point for each day on budget or exempt, out of the days scored.'),

  row('win-draw-loss', 'marks', { chess: 'Win · Draw · Loss', finance: 'Under budget · On budget · Over budget' },
    'A day’s result: at or under the target is under budget; up to the limit, on budget; above the limit, over budget.'),
  row('result-mark', 'marks', { chess: '1 · ½ · 0', finance: '✓ · = · ✗' },
    'The one-character mark of a day’s result: under, on or over budget.'),
  row('in-play', 'marks', { chess: 'In play', finance: 'In progress' },
    'Today, still being reported by the bank.'),
  row('not-yet-played', 'marks', { chess: 'Not yet played', finance: 'Upcoming' },
    'A day that has not happened yet.'),
  row('pencil', 'marks', { chess: 'In pencil · in ink', finance: 'Provisional · final' },
    'Figures the bank has not finished reporting can still change; final ones will not.'),
  row('annotation', 'marks', { chess: 'Annotation', finance: 'Mark' },
    'A sign that singles out a notable transaction or day; most carry none.'),
  row('glyph-brilliant', 'marks', sign('!!'), 'A workday with no convenience spending at all.'),
  row('glyph-good', 'marks', sign('!'), 'A skipped purchase, an extra debt payment, a transfer to savings, or a day that went to plan.'),
  row('glyph-interesting', 'marks', sign('!?'), 'A purchase for work, judged later by its return.'),
  row('glyph-dubious', 'marks', sign('?!'), 'A second convenience stop in a day that was not in the plan.'),
  row('glyph-mistake', 'marks', sign('?'), 'A third or later unplanned stop, or a purchase for work that did not pay back.'),
  row('glyph-blunder', 'marks', sign('??'), 'An avoidable charge such as a late fee, an over-limit fee or an overdraft.'),
  row('glyph-only-move', 'marks', sign('□'), 'A payment you cannot skip, such as rent or a loan payment.'),
  row('eval-winning', 'marks', step('winning'), 'The top step of a reading.'),
  row('eval-clear-plus', 'marks', step('clear_plus'), 'Well above neutral.'),
  row('eval-slight-plus', 'marks', step('slight_plus'), 'A little above neutral.'),
  row('eval-equal', 'marks', step('equal'), 'Neither better nor worse.'),
  row('eval-slight-minus', 'marks', step('slight_minus'), 'A little below neutral.'),
  row('eval-clear-minus', 'marks', step('clear_minus'), 'Well below neutral.'),
  row('eval-losing', 'marks', step('losing'), 'The bottom step; liquidity reads it when cash is short of what is due before payday.'),
  row('eval-unclear', 'marks', step('unclear'), 'The reading cannot be made yet, for lack of history.'),
  row('best-move', 'marks', { chess: 'Best move', finance: 'Best day' },
    'The month’s best result against the baseline.'),
  row('costliest-move', 'marks', { chess: 'Costliest move', finance: 'Costliest purchase' },
    'The month’s largest convenience purchase.'),

  row('book-entry', 'book', { chess: 'Book entry', finance: 'Recurring item' },
    'One bill or subscription that repeats on a schedule.'),
  row('book-lines', 'book', { chess: 'Lines', finance: 'Line items' },
    'The rows of a list of costs: here, each recurring bill.'),
  row('book-class', 'book', { chess: 'The Book (a class of spending)', finance: 'Recurring bills' },
    'Scheduled bills, as opposed to everyday spending.'),
  row('set-aside', 'book', { chess: 'Set aside by time', finance: 'Accrued to date (sinking fund)' },
    'A share of a yearly or quarterly bill put aside each day, so it is covered when it arrives.'),

  row('sample-game', 'other', { chess: 'Sample game', finance: 'Sample data' },
    'Invented figures for exploring the app; nothing is saved.'),
  row('coach-notes', 'other', { chess: 'Coach’s notes', finance: 'Notices' },
    'Short notes on what needs attention, such as bills due before payday or a new recurring charge.'),
  row('principles', 'other', { chess: 'Opening principles', finance: 'Spending rules' },
    'Your own written rules, shown before each purchase.'),
  row('round-sync', 'other', { chess: 'Round (of sharing)', finance: 'Sync' },
    'One exchange of data between your devices.'),
  row('three-moves', 'other', { chess: 'Three moves', finance: 'Three steps' },
    'The three steps that link the bank.'),
]);

/**
 * A term's name in a mode; '' for a key that is not one.
 * @param {string} key
 * @param {*} mode
 * @returns {string}
 */
export function term(key, mode) {
  const found = TERMS.find((one) => one.key === key);
  return found ? found[wordsMode(mode)] : '';
}

/**
 * The glossary in its order: each group with its terms.
 * @returns {{ group: { key: string, chess: string, finance: string }, terms: object[] }[]}
 */
export function termsByGroup() {
  return TERM_GROUPS.map((group) => ({ group, terms: TERMS.filter((one) => one.group === group.key) }));
}
