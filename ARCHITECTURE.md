# Networth — architecture and rules

Networth is a private net-worth board for one person. It links to the owner's bank once
(read-only, through SimpleFIN Bridge) and from then on **everything is automatic**: balances
and transactions arrive from the bank feed; recurring bills, the pay schedule, the spending
baseline, the daily rounds and net worth are all derived. Nothing is ever imported by hand.

It is a static web app: no server, no build step in development, no dependencies. The bank
feed is called straight from the browser; the data stays in the browser's own storage.

## 1. The idea

Personal finance as a chess game in progress — the owner against their own habits — told
with chess's own information design (typographic and structural, never clip-art).

| Money | Chess | What it shows |
|---|---|---|
| Net worth | the evaluation / rating | one enormous number, moving a little every day |
| Cash on hand | the clock | material does not matter if you lose on time |
| A day | a round | you against **Habit**, your own frozen baseline of convenience spending |
| A transaction | a move | annotated sparingly with !!, !, !?, ?!, ?, ??, and the "only move" box |
| A month | a tournament | a crosstable of 1 · ½ · 0 with a score |
| Recurring bills | the Book | known theory; renewals are prepared lines |
| Projections | analysis | variations — always scenarios, never predictions |
| Income goal | title norms | a ladder tracked apart from net worth |

Financial words come first on every label (NET WORTH, CASH, CARD); chess supplies structure
and flavour. The voice is a calm, exact annotator: it annotates the move, never the player.

## 2. Files

```
index.html               development entry (ES modules); tools/build.mjs bundles it into one file
css/tokens.css           design tokens (colour, type, space); light = "paper", dark = "night"
css/base.css             reset, typography, layout primitives
css/components.css       shared components
css/views/*.css          one stylesheet per view
js/app.js                boot, shell, render loop
js/store.js              the document + ephemeral UI state, persistence, undo
js/db.js                 IndexedDB / localStorage persistence, device-only secret storage
js/router.js             hash router; every view and sheet has an address
js/sync.js               links the bank feed, schedules and runs syncs
js/derive.js             lazily computed, memoised view of the engine for one render
js/model/schema.js       the document: every field, enumerations, factories   <- the contract
js/model/money.js        integer-cent helpers and formatting
js/model/dates.js        calendar-day and game-day helpers, the app clock
js/model/feed.js         the provider-neutral bank feed shape + SimpleFIN adapter
js/model/classify.js     merchant clean-up and classification rules
js/model/rules-data.js   built-in merchant rules (data only)
js/model/merge.js        folds a feed into the document (dedupe, pending, transfers)
js/model/detect.js       recurring bills, income streams, habit baseline, account types
js/model/ledger.js       positions, accruals, daily closes, rounds, edge, clock   <- the engine
js/model/cards.js        card cycle, loan amortisation, payoff maths
js/model/book.js         schedules of the Book: occurrences, upcoming, costs
js/model/annotate.js     annotation symbols for moves and rounds
js/model/assess.js       four-factor position assessment and coach's notes
js/model/forecast.js     scenarios, reserve ETA, income ladder
js/model/recent.js       the latest transactions on every account, newest first (the Board's plain list)
js/model/demo.js         a deterministic sample feed (fictional) for the demo and for tests
js/ui/dom.js             html`` templates (escaped), morph(), declarative actions
js/ui/*.js               custom elements (ticker, split bar, charts, glyphs, sheets)
js/views/*.js            one module per view / sheet
tests/*.test.js          node --test
tools/serve.mjs          dev server (no cache)     tools/build.mjs   single-file bundle
```

### Module rules (the bundler depends on them)
- Imports: `import { a, b as c } from './relative/path.js';` — named, relative, with `.js`.
- Exports: `export function`, `export async function`, `export const`, `export class`, or `export { a, b };`
  at the start of a line. No default exports, no `export *`, no re-exports, no dynamic `import()`,
  no top-level `await`, no exported `let` that is reassigned, no import cycles.
- `js/model/**` is pure: no DOM, no storage, no network (except the three fetch functions in
  `feed.js`), and it never reads the real clock — every function that needs "now" takes `nowMs`.
- Money is integer cents; days are `'YYYY-MM-DD'` game days; see `schema.js` for every convention.
- Bank strings are untrusted. They reach the screen only through `html`` ` interpolation.
- The build removes JSDoc blocks that have their lines to themselves (indent, `/**`, `*/` at the end of a line) from the bundled script; other comments, strings and regex literals are left as written.
- Nothing in the repository may contain a real person's financial data. Sample data is fictional.

## 3. Data flow

```
SimpleFIN Bridge --fetch--> feed.js (normalise) --> merge.js (dedupe, pair) --> document
                                                         |
                             classify.js  <--------------+--> detect.js (Book, pay, habit)
document --> ledger.js / cards.js / book.js / assess.js / forecast.js --> derive.js --> views
```

### 3.1 Linking and syncing (`sync.js`, `feed.js`)
- The owner pastes a SimpleFIN **setup token** once per device. The app base64-decodes it to a
  claim URL (must be `https://` on a `simplefin.org` host), `POST`s to it and receives the
  **access URL** (`https://user:pass@host/simplefin`). That URL is the credential: it is stored
  only in device storage (`db.js` secret store), never in the document, never in a backup, never
  logged, never placed in a URL the app navigates to. Requests send it as an `Authorization: Basic` header.
- A sync is `GET {base}/accounts?version=2&pending=1&start-date=S&end-date=E` (epoch seconds;
  a window may not exceed 90 days). First sync: two windows of 89 days (a day inside the limit), the older first. Later syncs: from 7 days before the newest stored posted transaction.
- Quota: the provider expects at most 24 requests a day. The app syncs automatically on open when the
  last success is more than 3 hours old, allows a manual refresh at most every 15 minutes, and never
  exceeds 20 requests in any 24 hours (`sync.requests`).
- Failures never lose data. HTTP 403 → status `relink` (the token was revoked: link again).
  HTTP 402 → the Bridge subscription lapsed. Provider-reported connection problems are kept in
  `sync.problems` and shown as a coach's note with the Bridge link.

### 3.2 Folding a feed into the document (`merge.js`)
A feed is `{ src, fetchedAt, from, to, accounts: [{ extId, connId, institution, name, currency,
balance, available, asOf, txs: [{ extId, amount, posted, at, pending, description, payee, memo, mcc }] }], errors }`
with signed cents (negative = money leaving the account) and millisecond timestamps.

1. **Accounts** are matched by `(src, extId)`. A new one is created with `source: 'bank'` and a type
   inferred from its name (`classify.inferAccountType`); the owner can correct the type once
   (`typeLocked`). Balances are stored signed in the owner's favour. Providers normally report debts as
   negative numbers. A loan reported positive, or a card reported positive by more than $50, is read
   as owed from first sight (`flip`), so a debt is never shown as an asset; later syncs confirm or
   correct that reading from the feed's own transactions (the reported figure moving against its rows
   means it is what is owed; moving with them means the card really is in credit). The owner can set
   it by hand (`flipLocked`), and that is never changed automatically.
2. **Transactions.** `day` is the game day of `at` when the bank gives it, else of `posted`
   (`dates.feedDay` handles date-only timestamps); `postedDay` is null while pending.
   The fingerprint is `accountId|day|signedCents|normalisedDescription#k` (k = occurrence index among
   identical rows in the batch). A feed row is matched to a stored row by provider id, else by
   fingerprint (some banks re-issue ids), else — for a row that has just posted — to a stored
   *pending* row on the same account with the same merchant key, an amount within 25% (tips) and a
   day within 5. Otherwise it is inserted and classified. Owner-set fields (`locks`, notes, plans,
   glyphs) always survive an update.
   Stored pending rows of an account that no longer appear in a feed covering their day are removed.
   Posted rows are never deleted by a sync.
3. **Provisional moves.** A move the owner tapped in before the bank reported it (`source: 'manual'`,
   kind `spend`) is matched to a newly arrived bank spend with the same merchant key (or no merchant),
   an amount within 15% and a day within 3; it then gets `matchId` and stops counting. An unmatched
   provisional move stops counting after 7 days and is flagged for review.
4. **Transfers and card payments** between linked accounts are paired (equal amounts, opposite flows,
   within 3 days, at least one leg classified as a transfer or payment): both legs get `pairId`;
   the cash leg is `payment` when the other leg is a card or loan, else `transfer`. Neither is ever
   spending or income.
5. Then `detect.refresh` runs: classify unlocked rows, detect the Book and income streams and link
   their rows (`recurringId`, `streamId`; a linked charge becomes klass `book` unless locked), start
   the match on the first successful sync (`meta.matchStart = today`) and compute the first habit
   segment from the 60 days before it.

### 3.3 Classification (`classify.js`, `rules-data.js`)
Order: owner-learned rules (`settings.rules`, by merchant key) → built-in merchant rules (ordered
patterns) → merchant category code (`mcc`) → fallback (`other`, `review: true`).
Kind: on a cash account an out-flow is `spend` unless it matches a transfer/payment pattern; an
in-flow is `income`, or `refund` when it matches a refund pattern or mirrors a recent spend at the
same merchant, or `transfer`. On a card an out-flow is `spend` (interest and fees are spends in
`fees_interest`); an in-flow is `payment` when it matches a payment pattern, else `refund`.
Marketplaces whose orders can be anything (Amazon and similar) are `shopping` with `review: true`.
When the owner corrects a move, the correction is locked on that move and a rule is learned for the
merchant key, then applied to every unlocked move of that merchant, past and future.
The owner clears "needs a look" by confirming a move (`classify.confirmMove(state, txId)` -> `{ changed }`: `review` false plus a `'review'` lock, nothing else changes, no rule is learned) or by any correction, including "this move only". A `??` set by classification leaves a row when the owner files it out of Interest & fees, unless `glyph` is locked.

### 3.4 Saving and restoring (`store.js`, `db.js`, `schema.js`)
Every successful save is announced on a `BroadcastChannel`; another open copy of the app that hears of a newer save reads the stored record again instead of writing its own older copy over it. If this page had a change that was not saved yet, the newer record still wins and the owner is told with a toast: "A change made here at {time} was replaced by a newer save in another window." The lost change is not replayed. If the stored record turns out not to be newer, this page's pending save goes ahead.
`store.status.mirror` is null when the last-chance localStorage copy was written (nothing is printed), "too large" when the record no longer fits (the older copy is then removed so it is never offered at the next load), "blocked" otherwise. Settings says so among its storage facts: "The backup copy in this browser was not written: the record is larger than the browser keeps. The main copy is unaffected." for "too large", "The backup copy in this browser could not be written." for "blocked".
A restored copy must satisfy `checkDoc`: account types, move kinds and cadences must be the record's own known words; every balance and amount is whole cents no larger than 10^14; a move's amount is 0 or more and its flow is `in` or `out`; `meta.v` is a whole number.

## 4. The engine (`ledger.js`)

One count of history: "days on record" runs from the first transaction's day through today, both included (Jun 1 to Jun 10 is 10 days): `cards.historyDays(state, today)` in the model, `ctx.d.historyDays` in views. No file keeps its own arithmetic or its own threshold constant. A rule that needs M completed days is met from day M + 1 on record, and the sentence says so ("A pace is read from day 15 on record; 10 so far"). `ctx.d.paceMinDays(days)` and `forecast.paceMinDays(state, nowMs, days)` give M for the pace.
The model functions `assess`, `coachNotes`, `monthReview`, `cardsNow`, `allCardsMonths`, `cardMonths`, `cardMonth`, `largestCharges`, `pace`, `paceMinDays`, `projectNetWorth`, `reserveGoal`, `incomeLadder`, `cardPayoff` and `purchaseImpact` take an options object as their last argument; `opts.ledger` (made by `makeLedger` for the same document and time) is used instead of building another. `monthReview().score` carries `estimated: boolean`.

### 4.1 Game day and day type
The game day rolls over at `settings.rolloverHour` (default 4 a.m.). A day is a workday ("played
with Black") or a day off ("played with White"): `days[day].type`, else the weekday default.

### 4.2 Balances by day
For a bank account, *now* = reported balance + (when `settings.countPending`) the effect of its pending
rows. The balance at the **end of day d** = now − Σ effects of its live rows with `d < day <= today`. A row dated after today is in no close and no result until its day arrives.
(An effect is `+amount` for flow `in`, `−amount` for `out`. "Live" excludes declines, matched or stale
provisional moves, and — when pending is not counted — pending rows.)
Unmatched provisional moves (not yet in any bank balance) lower every close from their day onward and
the live position, until the bank row arrives and replaces them.
For a manual account the value on day d is the latest entry in `history` with `day <= d` (the first
entry also covers earlier days). Exception: an amortised loan before its first entry is worked backward from that entry over the feed payments made up to the entry's day: owed before a payment = (owed after + payment) / (1 + apr/365 × days since the payment before it; one month when the feed holds none), so every payment is part interest, part principal. A manual **loan** with `apr` and `loan.payment` is amortised from its
latest entry: interest accrues daily at `apr/365` on the outstanding balance; each payment seen in the
feed (a Book entry with `toAccountId`), or — when none is seen and `assumeScheduled` — each due day,
reduces the balance by `payment − accrued interest`.

### 4.3 Net worth, two ways
- **At the bank** (`bank`): the plain sum of all signed balances.
- **Smoothed** (`smooth`) = bank + pay earned and not yet received − bills used and not yet charged.
  It is what makes net worth move with behaviour instead of jumping on payday and falling on rent day.
  It applies only when `settings.smoothing` is on and at least one income stream has `accrue: true`;
  otherwise smooth = bank and nothing accrues.
  - Pay: for each accruing stream, `daily = amount / cadenceDays`. At the end of day d the receivable is
    `daily × (days from the latest pay day P <= d through d, inclusive)`, capped at 1.6 pay periods.
    A stream with no deposit for more than 1.6 pay periods has lapsed: its receivable is released (0), it is listed in `Position.lapsedPay` (`{ id, name, since }`), it no longer supplies the next payday and the rate stops counting it. This is read at the accrual point, so a feed that went quiet does not by itself end a stream. `Position.lapsedPay` lists every pay stream with no deposit for more than 1.6 periods, whether it is counted day by day or on arrival; for a stream counted on arrival `since` is its last deposit day and no receivable is involved. A stream counted on arrival is listed only when it would be pay but for the lapse (at least $200.00 a month): a trickle of interest that misses a month is not pay that stopped. The Book and Material note it as "No deposit from {name} since {date}."; when that leaves no payday, the Book says no payday is expected instead of saying a paycheck is recognised after its third deposit. There is no pre-history: nothing accrues earlier than one period ahead of the stream's first linked deposit; only a stream with no linked deposit at all follows its anchor's schedule.
  - The streams that count as pay (`ledger.payStreams()`, `ctx.d.payStreams` in views) are those scheduled, not lapsed, and either counted day by day or worth at least $200.00 a month. Only these supply a payday, "a month of take-home pay" and "days of pay". With none, `nextPayday` is null, the interface uses its no-pay wording, and a purchase is not expressed in days of pay.
  - Bills: for each active Book entry, `daily = amount / cadenceDays`; the payable at the end of day d
    is `daily × (days from the latest charge day C <= d through d, inclusive)`, capped at 1.25 × amount;
    an entry not seen for 1.5 periods stops accruing and is offered as lapsed.
    Nothing accrues earlier than one period ahead of an entry's first linked charge. An entry added by hand (source `manual`, or a `since` day) with no charge seen counts from its anchor alone, so it lapses 1.5 periods after it; it never accrues before its `since` day, and it has no occurrence, in the schedule, the due list or the accrual, before an anchor that is still ahead.
    For a loan payment (`toAccountId` set and the loan is amortised) only the interest part accrues.
  The difference between a real paycheck or charge and what had accrued lands on the day it posts.

### 4.4 The day's result
`result(d) = smooth(d) − smooth(d−1) − revaluations entered on d`. For display it is broken into
earned (accrued pay + other income received + pay variance), bills (accrued + variance; or the actual
charges when smoothing is off), spent (every non-Book spend net of refunds and of capitalised value),
and a residual "other". **Earned − bills − spent is the day's change: not spending is how the number rises.**

### 4.5 The live number
`live(t) = Σ now-balances + receivable(t) − payable(t) − unmatched provisional spends`, where the
accruals use the fraction of the current game day elapsed. It rises at
`rate = (Σ daily pay − Σ daily bills) / seconds in today's game day` cents per second (86,400; 82,800 or 90,000 on the two days the clocks change). Spending that the bank has not yet
reported is not in it; the next sync subtracts it. `Position.smooth` = bank + receivable − payable does not include unmatched provisional moves; `live` and every close's `smooth` do. Accrual stops 36 hours after the last successful
sync (the number then holds still and says how old the bank data is).
The hero shows `live`, with the approximately sign and small extra digits when it contains pay or bills counted day by day (roman and without the sign when it does not); one tap shows "at the bank"
with its sync time. When the figure at the bank includes an account kept by hand at an estimate (the owner's valuation, or a loan the app works down from its last statement), it is set italic with the approximately sign, like the live figure. A balance typed today from a statement stays roman. Composition is always one line away:
*at the bank · pay earned since {payday} · bills used since last charged*.

### 4.6 Rounds
`conv(d)` = game-class spends on d net of game-class refunds (never below 0).
`kept(d) = habit(d) − conv(d)`, with habit, win line and loss line from the habit segment in force and
the day's type. Loss line = habit rounded up to a whole dollar. Win line = the segment's `winWork`/`winOff`.
Result: `conv <= win` → 1; `conv > loss` → 0; otherwise ½. A declared bye scores ½ (its dollars still count).
Status, with `dataDay` = game day of the oldest balance timestamp among everyday bank accounts:
`prematch` (before the match), `future`, `live` (today), `awaiting` (after dataDay: the bank has not
reported it), `provisional` (dataDay or the day before, or any day with pending rows), `final`.
Provisional results are set in italic ("in pencil"); final ones in roman ("in ink"). Only final and
provisional rounds have a result and count in scores.
A **clean sheet** is a final or provisional round with `conv = 0`.

### 4.7 Habit (`detect.computeHabit`)
Habit needs 14 full days of bank history, so the match is played from day 15 on record (`MATCH_FROM_DAY`, exported by `detect.js`; views read `ctx.d.matchFromDay` and keep no constant of their own). The sentence uses the one count of history: "The match begins on day 15 on record; 10 so far."
From a window of past days (default the 60 before the match): `work` and `off` are the mean daily
`conv` on workdays and days off. The win line starts at half of habit (whole dollars) and is moved,
within 25–75% of habit, to the whole-dollar value whose back-tested score on the window is closest to
40% — the opponent should be beatable and not already beaten. The segment records its window and the
back-test ("under these rules your last 60 days would have scored 9½/41").
Habit never changes by itself. When two full months in a row score above 75%, the app offers a new
segment ("a stronger opponent"), computed from the last 60 days; the old edge is kept.

### 4.8 Edge and the sweep
Edge = Σ kept over final and provisional rounds since the match began ("KEPT VS HABIT" — never
"saved" or "earned"). Each Monday the previous Monday–Sunday's kept, if at least $5, is offered as a
**sweep**: move that amount, in whole dollars, to the card (or to the reserve when no card is owed).
A sweep is recorded when the owner taps "Moved", or automatically when a card payment or a transfer to
a reserve account of at least 90% of the amount, not part of the Book, posts within 7 days.
Edge is shown as *kept* and *moved*; unmoved edge is drawn hatched.

### 4.9 The clock
Cash = Σ now-balances of cash accounts. Next payday = the next occurrence of the main pay stream: among the pay streams (4.3) the one that brings in the most per day, those counted day by day first. No other stream supplies a payday: with no pay stream `nextPayday` is null.
A payday scheduled on or before today with no deposit within half a period of it keeps `nextPayday` at today until the stream lapses.
The due window has four states. Ordinary: `nextPayday` is after today, `Clock.payAwaited` is null and `Clock.dueUntil` is the day before `nextPayday`. The payday itself: pay is not late; `nextPayday` is today, `payAwaited` is null and the window is today alone (`dueUntil` = today). `Clock.payAwaited` (`string|null`) holds the scheduled day only when that day is before today and no deposit is on the record. The two grace days after the scheduled day (`PAY_GRACE_DAYS` = 2: the bank feed runs about a day behind, longer over a weekend): `payAwaited` is set and `dueUntil` stays at today. From the third day: `payAwaited` is set and the window runs through the next scheduled payday after today, included. `Clock.dueUntil` (`string`) is always set and never before today; it is today + 13 when no payday is known.
Wording: with `payAwaited` set the interface says "Pay expected {payAwaited} is not on the bank's record yet."; on the payday with nothing awaited it says "Payday is today."; when the due total is zero a sentence says "nothing is due {window}" and never prints an estimated zero; no sentence calls today the next payday. The list is headed "Due today" when `dueUntil` is today, "Due through {dueUntil}" when pay is awaited and `dueUntil` is after today, otherwise "Due before {nextPayday}". The words "before payday" are used only when `nextPayday` is after today.
Due = Book occurrences from today through `dueUntil` that are charged
to a cash account (or to no known account), plus a card's minimum payment when its due day falls in
the window. Every overdue item is in `due` whatever the length of the window. An occurrence is settled when an outflow linked to its Book entry posted on or after its day minus the early days, `book.earlyDays(entry)` (6); the outflow is a charge, or the payment or transfer that settles the entry (a Book transfer to a card). A settled occurrence is not due again. A Book occurrence drawn on cash whose day has passed unsettled stays in `due` with `overdue: true` until it posts or the entry lapses, 1.5 periods after its last linked outflow. Shortfall = max(0, due − cash).
Burn per day = (non-transfer outflows over the trailing 60 days) / 60. Runway = whole days of
`cash / burn` ("under 1 day" below one; never hours). Time trouble = shortfall > 0 or runway < 7.
Reserve milestones are measured in time: 1 day, 1 week, 2 weeks, 1 month, 3 months of burn, then the
goal amount. The clock never ticks down and is never red.

## 5. Cards and loans (`cards.js`)
Card cycle for calendar month M: start = owed at the end of the last day of M−1; charges = out-flows in M
(purchases, fees, interest); payments = in-flows of kind `payment`; refunds; interest = `fees_interest`
out-flows; now = owed now. Pace, read from day 7 of the month (`PACE_FROM_DAY = 7`, exported by `cards.js`; before it `projected` and `pace` are null and the interface says "A pace is read from day 7 of the month."): `projected = max(0, now + paced/daysElapsed × daysRemaining + bookCharges − scheduled)`. `paced` is the month's charges that are neither linked to a Book entry nor interest or fees; `bookCharges` is the Book occurrences charged to that card this month that no linked row has met, at the entry's amount; `scheduled` is the Book payments to that card still to come this month (occurrences of active entries with `toAccountId` = the card that no linked row has met). A card in credit owes nothing: the credit absorbs the paced charges first, `credit` holds the amount, and its pace line says it is in credit. "Before you buy" on a card puts the price inside the same sum (cards `opts.extraCharge`, on the card named by `opts.extraAccountId` or the first visible card), so a credit absorbs it first. Before day 7 of the month a purchase on a card in credit adds max(0, price − credit) to what is owed ("is covered by the {credit} credit" when that is 0), and the month review reads "Cards are {credit} in credit as of {date}: nothing is owed. A pace is read from day 7 of the month." Whether a Book payment or charge of the month has happened is decided occurrence by occurrence, with the same `earlyDays(entry)` as the clock (6): an occurrence is met when a counted row linked to the entry is dated on or after its day minus the early days, and one row meets one occurrence at most (the two legs of one transfer are one row). So the card pace and the clock always agree on whether a scheduled payment has happened.
`projected` and `pace` are `number|null`: null before day 7 of the current month and for other months. `bookCharges` is set for the current month only: the Book charges to the card still to come this month, in cents. Verdict:
"on pace to end {X} lower/higher than it began". A month's verdict is a month-end fact, never a
per-move annotation. History: one row per month as far back as transactions reach.
Payoff: with monthly rate r = apr/12 and payment p on balance b, months = −ln(1 − r·b/p) / ln(1 + r)
when p > r·b, else never; total interest = months·p − b (last payment prorated).

## 6. The Book (`book.js`, `detect.detectRecurring`)
Charges are grouped by merchant key and account. A group is recurring when its intervals fit a
cadence — weekly 7±1, biweekly 14±2, semimonthly 13–17, monthly 27–33, quarterly 85–97, semiannual
175–190, annual 350–380 — with enough occurrences (weekly/biweekly 4, monthly 3 or 2 with equal
amounts, quarterly and longer 2) and amounts within 10% (or $2); bills within 35% are `variable`.
Game-class stops are never bills. Loan payments get `toAccountId` when the owner has that loan.
`book.js` exports `earlyDays(entry)` = min(5, floor(cadence days / 4)), the number of days before its day that a payment or charge still meets an occurrence; `ledger.js` and `cards.js` both use it, so no file keeps its own copy. It also exports `BILL_LAPSE_PERIODS` (1.5) and `entryLapsed(entry, lastDay, today)`: an entry has lapsed when more than 1.5 cadences have passed since its last linked row, or since its anchor when no row was ever linked. Of the occurrences that have passed, only the last one on or before yesterday is still awaited, and only while the entry has not lapsed; an older one that was skipped is forgotten. The clock's overdue test and the card month's `scheduled` and `bookCharges` both follow this, so they agree on what is still to come.
Next occurrence = anchor + cadence (monthly and longer keep the anchor's day of month, clamped).
A detected schedule runs both ways from its anchor; a line added by hand has no occurrence before its anchor or before the day it was added.
A fixed-price entry's expected amount is its most recent charge (a price change takes effect at once and is reported as repriced); a variable entry's is the median of its last three. A cadence, amount, name or anchor the owner locked is never changed, and such an entry is never ended, by detection.
A Book charge that has not posted on its day stays in what is due, listed under the tally as "Due and not yet charged, still counted from cash: {name} ≈{amount}, due {date}." Every upcoming, due, overdue or renewal amount in the Book has not posted and is italic with ≈, as are the From cash and On a card totals and what is to spare. A line's price in The Lines is roman only where it is labelled "as last charged"; otherwise it reads "expected" and is italic.
A stream's deposit is its typical amount and is printed as an estimate (≈, italic) on the Book, the stream sheet and Settings.
Owner edits are locked. A new entry, a price change and a lapsed entry each produce a coach's note.

## 7. Annotation (`annotate.js`) — most moves carry none
- `!!` a clean-sheet workday (on the round). `!` a declined purchase (at most two a day), a sweep or
  extra card payment, a round played to the morning plan.
- `?!` an unplanned 2nd stop of the day; `?` an unplanned 3rd or later. Stops are game-class spends in
  stop categories; the first `plan.stops` of the day (or any move marked `planned`) are book moves and print bare.
- `??` only avoidable penalties: a late fee, an over-limit fee, an overdraft. Interest is a bare line.
- `!?` a business purchase (purpose not personal, one-off, $50 or more) until its return check resolves
  it to `!` or `?`. The box (only move) for rent and loan payments.
  Counting part of a business purchase as equipment into an existing hand-kept account adds a dated entry on the purchase day and raises the owner's later figures by the same value. Un-ticking it, or making the purchase personal or not one-off, takes that value back and removes an account the sheet created for it when no other move uses it. The value must be from $0.01 up to the price paid, or the sheet stays open and says so.
- Negative symbols never apply to `need`, `book` or work purchases. At most one move in four is annotated.
  A manual `glyph` on a move always wins.

## 8. Assessment (`assess.js`)
Four factors, each `{ key, symbol, label, sentence }` with symbol one of
`winning · clear_plus · slight_plus · equal · slight_minus · clear_minus · losing · unclear`, plus `timeTrouble`:
- **Material** — the 30-day change in smoothed net worth relative to a month of take-home pay. A month of take-home pay is what the pay streams bring in (`ledger.payStreams()`); with none, the sentence says no regular pay is detected. A share whose magnitude is over 999% is not printed: the clause is dropped. The change carries ≈ when the smoothed figure holds an estimate. It is read from day 15 on record (14 completed days).
- **Time** — shortfall of what is due and runway (see 4.9).
- **Structure** — revolving card debt: did the last two completed months end lower, and where is this month's pace?
- **Initiative** — month to date: of what was earned, how much was kept (retention).
  `kept = earned − bills − spent + other`; the share kept is not stated (`null`) when less than $1.00 was earned.
The verdict combines them (time 35%, structure 25%, material 20%, initiative 20%) into one symbol and
one plain sentence. There is no single red/green verdict anywhere.
Coach's notes: one to three at a time, each with a number or a date, under 110 characters, never
repeated within 14 days (`meta.notesSeen`), never judging the player.
Candidates include a Book charge past its day with no charge posted (`clock.due[].overdue`): "{name}: ≈$640.00 was due Fri, Jun 5 and has not posted." and a pay that stopped (`position.lapsedPay`, a stream counted on arrival included): "{n} days on, its pay is no longer counted." (counted day by day) or "{n} days on, its payday is no longer expected." (counted on arrival). A note for no regular pay detected yet is raised only when the document holds no salary-like stream at all. When the owner counts pay on arrival and no stream has lapsed, the interface says "Pay is counted when it arrives" and no note is raised.

## 9. Screens
Board (the daily glance) · Scoresheet (rounds and moves) · Material (what you own and owe; card cycle)
· Book (recurring, renewals) · Analysis (goals, scenarios, income ladder) · Settings (bank link, the
few things the bank cannot see, appearance, data). Phones get a bottom bar with a centre "+ Move".
`pace()` is null until day M + 1 on record, where M is one full pay cycle of the longest regular stream in completed days (30 when no regular pay is known) and never under 14; the "pace" and "habit" projection lines and the reserve ETA at pace are then withheld, and the sentence says "from day {M + 1} on record; {n} so far". A reserve ETA's day is today plus its whole months, so the count and the date agree. `incomeLadder().thin` is true until day 61 on record: the annualized figures are then not offered as a year's income.
`purchaseImpact`: `daysOfPay` = amount / daily take-home of the pay streams, null when there is no pay stream (income received is never used in its place); `cardMonthChange` is null when paid from cash and before day 7 of the month. `projectNetWorth`: `start` is the live figure floored to the cent (`Math.floor`), never rounded.
Board. While `Clock.payAwaited` is set the clock block prints "Pay expected {payAwaited} is not on the bank's record yet."; the list is headed "Due today" when `dueUntil` is today, "Due through {dueUntil}" when pay is awaited and `dueUntil` is after today, otherwise "Due before {nextPayday}". On the payday itself with nothing awaited one line reads "Payday is today." No sentence calls today the next payday. The move sheet says "through {dueUntil}" under the same condition; its "So far" line marks Spent as an estimate while a move in it has not posted and Kept while the round is in progress. The "still scheduled" figure is an estimate. The live breakdown (at the bank, pay earned, bills used, tapped in) adds up to the floored hero, as Material's does. Before day 7 of the month the card block prints "A pace is read from day 7 of the month." under an empty pace. From $1,000,000.00 the cash figure takes the is-huge size so it fits its column at every width. Recent transactions: a band of its own (after today's round on a phone, above the crosstable on a wide screen) lists the latest transactions on every account, newest first (`recent.recentTransactions`: 8 on a phone, 12 in two columns from 900px), each with its account under the name, its day ("Today", "Yesterday", else the date) and its amount; a row opens the move's sheet. A pending or tapped-in amount is an estimate. A declined purchase, a tapped-in move the bank has confirmed, a row of an account left out and the incoming leg of a payment between two of the owner's accounts are not listed. Above the list one sentence counts what is dated today ("Today: 2 transactions, ≈$6.55 out." or "Today: 0 transactions on the record.") and how many rows arrived since the last look (a row's `loggedAt` against the time of the last look); under it the block says when the bank was read and that its feed updates about once a day.
Material. Its live-figure sentence gives pay earned and bills used with the approximately sign. The card months table sits in its own scrolling block (role region, labelled Card months), so the page never scrolls sideways for it; it runs full width under its figure up to 1299px and sits side by side only from 1300px.
Analysis. Fig. 2 marks its starting figure as an estimate only when the hero is one; in the thin sample it is the figure at the bank, roman. The net-worth sparkline floors today's value in its label for screen readers.
Scoresheet. A round's Spent is an estimate only while it holds a move not yet posted (a pending row, or a tapped-in move with no bank match): `parts.spentUnposted(round)`. The day sheet's title states a provisional or live margin with the approximately sign. The crosstable takes cover (`ctx.state.settings.cover`) from every caller; a week cell's aria-label then carries no amount. A week's total and the month's Kept are printed with the approximately sign while any counted round in them is provisional or live, and roman when every one is final; the same rule holds on the sweep sheet. The month is one row of 30 columns when the crosstable is at least 1300px wide; narrower it is a week per row with a weekly total.
Charts. In the net-worth chart `data.est: true` marks the end figure as an estimate (italic, with ≈); without it the end label is roman. The end label and the live point are floored to the cent.
Render loop. The screen under a sheet is redrawn only when what it is drawn from changed: the record (identity and revision), the route without its sheet, the screen-level UI state (`store.ui` without the sheet-only keys `move`, `adjourn`, `txError` and `accountErrors`), the game day, the width, the sync and save status, and the live net worth floored to the cent. Typing in a sheet and a 30-second tick that changes none of these leave the screen as it is. Settings and the first-run screen are always redrawn.
Sizes. Every font size in the stylesheets is in rem (1rem = 16px), never px. `--t-label-s` is .6875rem, the smallest size for text that carries meaning. Under 720px every interactive element has a hit area of at least 44 by 44 CSS px: the crosstable's round links (`.x-a`), chips (`.chip`), the sheet's Close (`.sheet-x`), the day sheet's navigation and the `.btn-link` buttons inside sheets, the tx sheet's glyph chips, segments (`.seg-opt`), the masthead wordmark, and each tab bar column at 320px. It is reached with padding, min-height, min-width or a positioned pseudo-element, never with larger type, and nothing looks different at rest. The chips' hit area reaches 46px with a positioned `::after` (inset -6px -3px). The sheet's Close reaches 44px downward, because the grab line holds the band above it. The wordmark takes 7px of padding that its margin gives back. At 320px the crosstable's seven day columns are 34px wide and their round links keep the full cell as hit area; from 380px each day column is at least 44px and the link's hit area reaches 44px. Under 360px the workday chips of Settings sit in rows of four and three so each reaches 44px. On a phone a day link in the Scoresheet's month review takes a 44px line of its own, and wrapped chips keep a 12px row gap so their hit areas do not overlap.
With the root font size at 20px no screen scrolls sideways and no label is clipped or runs into its neighbour, at 390x844 and at 1440x900: `.split-labs` wraps, tab bar labels never break inside a word, and Material's card months table scrolls inside its own block and stays stacked under its figure up to 1299px wide. The same holds for an eight-digit balance at 320 and 390 (the Board's Habit, Spent, Standing tally wraps as the day sheet's does).
Words. A toast names what happened with a figure or a date ("Recorded: Dunkin' $3.65, round 10." / "Declined: Blank Street Coffee, $5.25 not spent." / "Saved: Netflix, $17.99 monthly."); with cover on, a toast carries no amount. Every toast carries a name, a figure or a date, those of the stream sheet, the habit sheet and Settings included. The category label reads "Uncategorized"; the masthead says "the last check did not go through". The tx sheet's "As the bank wrote it" label is .6875rem. Interface text uses American spelling (annualized, center, favor); identifiers in code keep their names. Times are written one way: 2:36 PM.
Every optional interaction (a candidate move before buying, a declined purchase, a morning plan, a
bye, a correction) is exactly that — optional. The app is complete and correct if the owner only ever looks.

## 10. Honesty rules
- A figure from the bank is set in roman with its age; anything computed or assumed is italic and
  marked with the approximately sign. Stale data says how old it is. One rule holds on every screen:
  - (a) Italic with the approximately sign: any figure that contains pay or bills counted day by day; a tapped-in move not yet at the bank; a round in pencil (provisional) or in progress (live); an account kept by hand at an estimate; a projection or a pace; and any amount that has not posted yet, which means every upcoming, due or overdue Book amount, fixed-price or not, their totals, and what is "to spare".
  - (b) Roman: a figure made only of posted bank rows and reported balances. With nothing of (a) in it, the hero, the net-worth chart's end label, Yesterday, This month and Retention's Kept are roman; the thin sample (`?demo=thin`) has no accrual and shows this.
  - (c) A Book line's price or a stream's deposit is roman only where it is labelled as the last one the bank reported; a typical or median value is an estimate.
  - (d) In a sentence an estimated amount carries the sign directly before it: ≈$1,289.78, ≈+$38.99, ≈−$12.00. In every sentence the engine writes, an amount that has not posted carries ≈ directly before it: the due total, the shortfall ("≈$1,455.71 more than the cash"), an overdue item's amount, a Book payment still scheduled, a renewal's expected amount, the shortfall after a purchase. Cash on hand and posted amounts stay plain.
  - (e) In the crosstable and the weeks, Kept and each week's total are estimates while any counted round in them is in pencil or in progress; a total of final rounds is roman everywhere (crosstable, sweep sheet).
- One live figure: wherever the live net worth is printed as a static figure it is floored to the cent it has reached, `Math.floor(position.live)`, never rounded up, so every screen shows the same cent as the Board's ticking hero. This holds for the live breakdown on the Board and on Material (it adds up to the floored figure) and for the label of the Analysis net-worth sparkline, which floors today's value for screen readers.
- One count of history: days on record, with every threshold stated as "from day M + 1" (see 4).
- Scenarios are labelled scenarios. Income targets are never mixed into net worth.
- Kept-versus-habit is a counterfactual; it is never called saved, earned or available.
- The app never shames: results are recorded exactly as played, with their dollar margin.
