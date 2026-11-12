/**
 * Built-in classification data for classify.js. See ARCHITECTURE.md section 3.3.
 * Data only: no logic and no dependencies. Every pattern is a regular-expression SOURCE; classify.js
 * compiles each one once, case-insensitively, and skips any that fails to compile.
 *
 * Patterns are written for US bank-statement descriptors (strong New York City coverage) and are
 * tested against a lower-cased description, both with its statement noise stripped and as the
 * bank sent it, so a rule may rely on a processor prefix such as "tst*" or "sq *".
 * Descriptors are cut at about 22 characters by the card networks: rules match stems.
 */

const r = String.raw;

/* ------------------------------------------------------------------ wording */

const LATE_FEE = r`late (payment )?fee|past due fee|late charge`;
const OVERDRAFT_FEE = r`overdraft (fee|charge|item|paid)|\bod fee\b|\bnsf\b|non-?sufficient|insufficient funds|returned (item|payment|check|ach) (fee|charge)|return(ed)? payment fee|uncollected funds`;
const OVER_LIMIT_FEE = r`over-? ?limit fee|over the limit fee`;

/** Avoidable penalties: the only charges annotated '??'. Interest is not one of them. */
export const PENALTY_RE = [LATE_FEE, OVERDRAFT_FEE, OVER_LIMIT_FEE].join('|');

const CAPITAL_ONE_PAYMENT = r`capital one (mobile|online|autopay|auto|phone|card)? ?(pymt|pmt|payment)|capital one\s+(crcardpmt|cr ?card ?pmt|card pymt|n\.?a\.? ?pmt)`;
const ISSUER_PAYMENT = r`chase (credit )?(crd|card) (auto|e)?pay|chase card serv|chase epay|jpmorgan chase.*(epay|autopay)|payment to chase card|amex epayment|american express (ach pmt|epayment|payment)|amex (ach|e-?pay)|citi ?(card)? ?(autopay|epay)|citi card online|citibank (cr ?cd|credit card)|discover e-?payment|discover dfs|discover (card|bank) (e-?pay|payment|pymt)|applecard gsbank|apple ?card (gs|payment)|gs bank.*apple|barclaycard|barclays (us|bank).*(pay|crcard)|synchrony|syncb|comenity|credit one bank|(bk of amer|bank of america|boa) (visa|mc|credit card|cc)|wf credit card|wells fargo (card|cc)|td (bank )?(card|cc) pay|us bank (cc|card)|usaa credit card|navy federal (cc|card)|paypal (credit|mastercard)|best buy (cc|card)|amazon (store )?card pmt|macys (cc|card)|nordstrom (card|pymt)`;

/** A card or store-card payment, named by its issuer: a payment on either side (bank account or card). */
export const PAYMENT_RE = [CAPITAL_ONE_PAYMENT, ISSUER_PAYMENT].join('|');

/** Payment wording that is only trustworthy on the card itself ("ONLINE PAYMENT - THANK YOU"). */
export const CARD_SIDE_PAYMENT_RE = r`payment[ ,-]*thank you|thank you[ -]*payment|payment received|pymt[ -]*thank you|directpay (full balance|min|fixed)|ba electronic payment|ach deposit internet transfer from account ending in|\b(autopay|automatic|online|mobile|internet|electronic|phone|web|ach) (payment|pymt|pmt)\b|^payment$|^payment - |\bepay(ment)?\b|e-payment`;

const OWN_TRANSFER = r`(withdrawal|transfer) to (360 )?(performance savings|savings|checking|money market|360 checking)|(deposit|transfer) from (360 )?(performance savings|savings|checking|money market|360 checking)|\b(to|from) (checking|savings|share|money market|brokerage)\b`;
const GENERIC_TRANSFER = r`\b(online|internal|mobile|funds?|account|acct|scheduled|recurring|automatic|external|instant|wire)\s?(transfer|xfer|trnsfr|tfr)\b(?! fee)|\b(transfer|xfer|trnsfr|tfr) (to|from)\b|online banking transfer|keep the change|round ?up transfer|save the change|overdraft (protection )?transfer|\bsweep\b|\bacct_xfer\b`;

/** Money moving between the owner's own accounts. */
export const TRANSFER_RE = [OWN_TRANSFER, GENERIC_TRANSFER].join('|');

const PAYROLL = r`payroll|\bpayrll\b|direct dep(osit)?|\bdir dep\b|\bdirdep\b|\bsalary\b|\bnet pay\b|\badp\b|paychex|\bgusto\b(?! fee)|justworks|trinet|rippling|paylocity|paycom|paycor|zenefits|bamboo ?hr|intuit payroll|quickbooks payroll|square payroll|\bonpay\b|insperity`;
const PAYOUT = r`square inc|\bsq ?\* ?(payout|deposit)|stripe (transfer|payout)|shopify (payout|payments)|clover (deposit|payout)|intuit (deposit|payments)|quickbooks payments|peerspace payout|giggster payout|soundbetter|airgigs`;
const ROYALTIES = r`distrokid (payout|royalt)|tunecore (payout|royalt)|\bascap\b|bmi royalt|soundexchange|cd ?baby (payout|royalt)|bandcamp payout`;
const TAX_REFUND = r`irs treas 310|tax ref(und)?\b|nys dtf.*(refund|rfnd)|state tax refund`;
const REWARD = r`cash ?back (reward|redemption|credit)|rewards? (redemption|credit)|statement credit|awards and rebate|cashback bonus`;
const BENEFITS = r`unemployment|nys dol ui|ssa treas|soc sec|child tax|stimulus|\bfema\b|reimburse|expense reimb|\breimb\b`;
const DEPOSIT = r`mobile (check )?deposit|remote deposit|check deposit|atm (cash |check )?deposit|cash deposit|branch deposit|\bedeposit\b`;

/** Wording that marks money in as income (pay, payouts, royalties, tax refunds, rewards, benefits, deposits). */
export const INCOME_RE = [PAYROLL, PAYOUT, ROYALTIES, TAX_REFUND, REWARD, BENEFITS, DEPOSIT].join('|');

/** Explicit refund wording on money in. */
export const REFUND_RE = r`\b(refund|return|returned|reversal|reversed|credit voucher|merchandise return|purchase return|chargeback|dispute credit|provisional credit|adjustment - credit|credit adj|price adjustment|cancel(l)?ed order)\b|debit card (credit|refund|return)|pos (refund|return|credit)|visa (credit|refund)|purchase return authorized`;

/** Cash leaving an account (ATM, teller, cash advance). */
export const CASH_RE = r`\batm\b.*(withdrawal|withdrwl|w/d|cash|debit)|(withdrawal|cash).*\batm\b|\batm w/?d\b|non-?chase atm withdraw|cash withdrawal|counter withdrawal|teller withdrawal|cardtronics|allpoint|moneypass|cash advance(?! (fee|interest))`;

/* -------------------------------------------------------------------- noise */

/**
 * Rows whose useful part sits inside fixed wording: ACH rows that carry their fields as key:value
 * text (Chase, Bank of America) and Zelle rows. `to` is a String.replace template that keeps the
 * originator and the entry class ("acme corp payroll"), or the direction and the person.
 */
export const STRUCTURED = [
  { re: r`orig co name:\s*(.+?)\s+orig id:.*?co entry descr:\s*(.+?)\s+sec:.*$`, to: '$1 $2' },
  { re: r`^(.+?)\s+des:\s*(.+?)\s+id:.*$`, to: '$1 $2' },
  { re: r`^.*?zelle (?:money |payment )?(?:received from|from)\s+(.+)$`, to: 'zelle from $1' },
  { re: r`^.*?zelle (?:money |payment )?(?:sent to|to)\s+(.+)$`, to: 'zelle to $1' },
];

/** Statement noise, stripped in this order from the lower-cased description (each match becomes a space). */
export const NOISE = [
  // pending marker
  r`^pending\s*[-:]?\s*`,
  // bank verb in front of a card purchase
  r`^(debit card purchase|digital card purchase|recurring debit card purchase|debit card (credit|refund|return)|card purchase( with pin)?|recurring card purchase|pos (debit|purchase|withdrawal|signature|pin|refund)|point of sale (debit|withdrawal|purchase)|debit purchase( -?visa)?|visa (purchase|check card|debit)|check ?card( purchase)?( \d{4})?|dbt crd|purchase authorized on|recurring payment authorized on|purchase return authorized on|purchase|pos)\b\s*[-:]?\s*`,
  // bank verb in front of an ACH counterparty
  r`^(withdrawal from|deposit from|ach (debit|credit|withdrawal|deposit|pmt|payment)|electronic (withdrawal|deposit|pmt)|preauthorized (debit|credit|withdrawal|wd)|web (pmt|pymt|payment)|online (pmt|pymt)|bill ?pay(ment)?( to)?|external (withdrawal|deposit)|direct (debit|withdrawal))\b\s*[-:]?\s*`,
  // wallet prefix
  r`^(aplpay|apl\*? ?pay|apple pay|gpay|google pay|samsung pay)\s+`,
  // payment-facilitator prefix (Square, Toast, PayPal, Shopify, DoorDash, Instacart, Intuit, Braintree, vending…)
  r`^((sq ?\*|gosq\.com ?\*?|tst ?\*|toast ?\*|paypal ?\*|pp ?\*|sp ?\*|sp\+ ?|shopify ?\*|dd ?\*|ic ?\*|fsp ?\*|in ?\*|wpy ?\*|bt ?\*|cko ?\*|ckn ?\*|par ?\*|clover ?\*|cke ?\*|pos ?\*|fh ?\*|ezc ?\*|pmt ?\*|usa ?\*|ctlp ?\*|zsk ?\*|bb ?\*|tm ?\*|evt ?\*|ev ?\*|eb ?\*|py ?\*|ppd ?\*|ach ?\*|web ?\*|sumup ?\*|zettle ?\*|iz ?\*|stripe ?\*|dri ?\*)\s*)+`,
  // ACH and reference key:value fragments
  r`\b(orig co name|orig id|desc date|co entry descr|sec|trace ?#?|eed|ind id|ind name|trn|des|indn|co id|ppd id|web id|ccd id|conf ?#?|ref ?#?|reference ?#?|id|auth ?#?|seq ?#?|inv ?#?|invoice ?#?|order ?#?|trans ?#?|txn ?#?)\s*[:#]\s*\S+`,
  // trailing ACH entry-class code
  r`\b(ppd|ccd|web|tel|arc|pop|boc)\s*$`,
  // transfer reference
  r`\btransaction ?#?:?\s*\d+`,
  // masked account and card numbers
  r`\bx{2,}\d{2,6}\b|\*{2,}\d{2,6}\b|\.{3}\d{2,6}\b|\bending in \d{4}\b|\bcard \d{4}\b|\bacct? ?#? ?\d{4}\b`,
  // embedded dates and times
  r`\b(on )?\d{1,2}/\d{1,2}(/\d{2,4})?\b`,
  r`\b\d{4}-\d{2}-\d{2}\b`,
  r`\b\d{1,2}:\d{2}(:\d{2})?\s?(am|pm)?\b`,
  // phone numbers (card-not-present merchants print one instead of a city)
  r`\b(1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b`,
  // URL prefix (the domain itself is often the merchant and stays)
  r`\b(https?://)?www\.`,
  // order id after an asterisk, only when it holds a digit ("amzn mktp us*2k4xy12z3"; "seamlss*thaivilla" survives)
  r`\*\s?(?=[a-z0-9]*\d)[a-z0-9]{6,}\b`,
  // hyphenated order numbers ("12-34567-89012")
  r`\b\d{2,}(-\d{2,})+\b`,
  // asterisks and other stray punctuation
  r`[*_()]+`,
  // store numbers
  r`#\s?[a-z]?\d+\b`,
  r`\b(store|str|unit|loc|location|shop|site|no\.?|num|branch|restaurant|rest)\s?#?\d{2,}\b`,
  // terminal ids, acquirer reference numbers, short store codes ("st1234", "f12345"), instalment ids ("1234abcd")
  r`\b[a-z]{0,3}\d{5,}[a-z]{0,2}\b|\b[a-z]{1,3}\d{3,4}\b|\b\d{4,}[a-z]{1,8}\b`,
  // three- and four-digit store numbers, never the first word ("787 coffee" keeps its name)
  r`\s\d{3,4}(?=\s|$)`,
];

/** Trailing two-letter state: stripped only from a description of at least three words ("DELI NY" keeps both). */
export const STATE_TAIL_RE = r`\s(al|ak|az|ar|ca|co|ct|de|dc|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)$`;

/** What is peeled off the end, in this order: country, state, locality, legal suffix. */
export const TAIL_NOISE = [
  r`\s(us|usa)$`,
  STATE_TAIL_RE,
  r`\s(new york( city)?|nyc|manhattan|brooklyn|bklyn|bronx|queens|staten island|long island c(ity|it|i)?|long is city|lic|astoria|jackson h(eigh)?ts?|jackson height|flushing|jamaica|forest hills|elmhurst|woodside|sunnyside|ridgewood|corona|bayside|rego park|ozone park|far rockaway|harlem|inwood|washington heights|williamsburg|bushwick|greenpoint|bed-?stuy|crown heights|park slope|flatbush|bay ridge|sunset park|dumbo|jersey city|hoboken|newark|weehawken|union city|yonkers|mount vernon|new rochelle|white plains|hempstead|garden city|boston|cambridge|philadelphia|washington|baltimore|chicago|atlanta|miami|orlando|dallas|houston|austin|denver|phoenix|las vegas|los angeles|san francisco|san jose|san diego|seattle|portland)$`,
  r`\s(inc|llc|l\.l\.c|corp|co|ltd|pllc|pc|dba)\.?$`,
];

/** Words printed in capitals when a name is title-cased from a description. */
export const ACRONYMS = ['nyc', 'mta', 'usa', 'atm', 'llc', 'ny', 'nj', 'bbq', 'usps', 'ups', 'dmv', 'irs', 'sba', 'cvs', 'tv', 'dj', 'ii', 'iii', 'nyu', 'ymca', 'kfc', 'ach', 'pta'];

/* -------------------------------------------------------------- merchant rules */

/**
 * Ordered: the first rule that matches and applies wins.
 *  merchant  a display name when the rule names ONE merchant (it also gives the grouping key);
 *            null when the rule describes a family of places and the cleaned description is the name
 *  category  a key of schema.CATEGORIES, or 'income' | 'transfer' | 'card_payment' for flows
 *  klass     the category's default class, except: a fine and a vehicle rental are 'oneoff'
 *            (exceptional, not routine running costs)
 *  review    the owner may want to look: the purpose or the category is a guess
 *  glyph     '??' for an avoidable penalty, else null
 *  flow      optional 'in' | 'out': the rule applies only to money moving that way
 *  side      optional 'card': the rule applies only on a card or loan account
 * Fees come first so that "wire transfer fee" or "returned payment fee" is never read as a transfer
 * or a payment; flows come before merchants; named merchants before their families; generic words last.
 */
export const MERCHANT_RULES = [
  // fees and interest
  { id: 'fee-reversal', re: r`\bfee (refund|reversal|waiver|rebate|credit|adjustment)|interest (refund|reversal|adjustment)|refund of .*fee|courtesy (credit|adjustment)|atm fee (rebate|refund)|goodwill credit`, category: 'fees_interest', klass: 'need', purpose: 'personal', merchant: 'Fee reversal', review: false, glyph: null, flow: 'in' },
  { id: 'interest-charge', re: r`interest charge|interest charged|purchase interest|finance charge|cash advance interest|balance transfer interest|\binterest - |standard purch(ase)? interest`, category: 'fees_interest', klass: 'need', purpose: 'personal', merchant: 'Interest charge', review: false, glyph: null },
  { id: 'late-fee', re: LATE_FEE, category: 'fees_interest', klass: 'need', purpose: 'personal', merchant: 'Late fee', review: false, glyph: '??' },
  { id: 'overdraft-fee', re: OVERDRAFT_FEE, category: 'fees_interest', klass: 'need', purpose: 'personal', merchant: 'Overdraft or returned-payment fee', review: false, glyph: '??' },
  { id: 'annual-fee', re: r`^(annual (membership )?fee|annual card fee|card membership fee|membership fee)\b`, category: 'fees_interest', klass: 'need', purpose: 'personal', merchant: 'Card annual fee', review: false, glyph: null },
  { id: 'foreign-fee', re: r`foreign (transaction|trans|exchange|currency) fee|intl (transaction|trans) fee|international (transaction|service) (fee|assessment)|currency conversion fee`, category: 'fees_interest', klass: 'need', purpose: 'personal', merchant: 'Foreign transaction fee', review: false, glyph: null },
  { id: 'over-limit-fee', re: OVER_LIMIT_FEE, category: 'fees_interest', klass: 'need', purpose: 'personal', merchant: 'Over-limit fee', review: false, glyph: '??' },
  { id: 'card-fee', re: r`cash advance fee|balance transfer fee|expedited (payment|pay) fee|pay by phone fee`, category: 'fees_interest', klass: 'need', purpose: 'personal', merchant: 'Card fee', review: false, glyph: null },
  { id: 'atm-fee', re: r`\batm\b.*\b(fee|surcharge)|non-?(capital one|chase|network|bank) atm fee|out-of-network atm`, category: 'fees_interest', klass: 'need', purpose: 'personal', merchant: 'ATM fee', review: false, glyph: null },
  { id: 'bank-fee', re: r`(monthly|account) (service|maintenance) (fee|charge)|\bservice charge\b|wire (transfer )?fee|stop payment fee|paper statement fee|low balance fee|inactivity fee`, category: 'fees_interest', klass: 'need', purpose: 'personal', merchant: 'Bank fee', review: false, glyph: null },

  // flows: income, card payments, transfers, cash
  { id: 'interest-earned', re: r`interest paid|interest earned|\bint earned\b|interest credit|monthly interest paid|apy (earned|interest)|interest deposit|dividend (paid|earned)`, category: 'income', klass: 'need', purpose: 'personal', merchant: 'Interest earned', review: false, glyph: null, flow: 'in' },
  { id: 'capital-one-card-payment', re: CAPITAL_ONE_PAYMENT, category: 'card_payment', klass: 'need', purpose: 'personal', merchant: 'Capital One card payment', review: false, glyph: null },
  { id: 'card-payment-received', re: CARD_SIDE_PAYMENT_RE, category: 'card_payment', klass: 'need', purpose: 'personal', merchant: null, review: false, glyph: null, side: 'card' },
  { id: 'card-payment', re: ISSUER_PAYMENT, category: 'card_payment', klass: 'need', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'own-transfer', re: OWN_TRANSFER, category: 'transfer', klass: 'need', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'transfer', re: GENERIC_TRANSFER, category: 'transfer', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'zelle-received', re: r`zelle (money |payment )?(received|from)|zelle (credit|deposit)|quickpay with zelle payment from`, category: 'income', klass: 'need', purpose: 'coaching', merchant: null, review: true, glyph: null, flow: 'in' },
  { id: 'zelle', re: r`zelle (money |payment )?(sent|to)|zelle (debit|payment)|quickpay with zelle payment to|\bzelle\b`, category: 'other', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'wallet-cash-out', re: r`venmo (cashout|cash out)|cash app\*? ?cash ?out|paypal (transfer|payout)|apple cash (transfer|bank xfer)`, category: 'income', klass: 'need', purpose: 'coaching', merchant: null, review: true, glyph: null, flow: 'in' },
  { id: 'wallet-payment', re: r`\bvenmo\b|cash app|apple cash`, category: 'other', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'institution-transfer', re: r`\b(robinhood|fidelity|vanguard|schwab|e\*trade|etrade|webull|wealthfront|betterment|acorns|m1 finance|coinbase|ally bank|sofi (bank|money|invest))\b|marcus (by|goldman)|\bgs bank\b`, category: 'transfer', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'paycheck', re: PAYROLL, category: 'income', klass: 'need', purpose: 'work', merchant: null, review: false, glyph: null, flow: 'in' },
  { id: 'processor-payout', re: PAYOUT, category: 'income', klass: 'need', purpose: 'studio', merchant: null, review: true, glyph: null, flow: 'in' },
  { id: 'lesson-marketplace', re: r`lessonface|wyzant|outschool|takelessons|thumbtack`, category: 'income', klass: 'need', purpose: 'coaching', merchant: null, review: true, glyph: null, flow: 'in' },
  { id: 'royalties', re: ROYALTIES, category: 'income', klass: 'need', purpose: 'studio', merchant: null, review: false, glyph: null, flow: 'in' },
  { id: 'tax-refund', re: TAX_REFUND, category: 'income', klass: 'need', purpose: 'personal', merchant: 'Tax refund', review: false, glyph: null, flow: 'in' },
  { id: 'card-reward', re: REWARD, category: 'income', klass: 'need', purpose: 'personal', merchant: 'Card reward credit', review: false, glyph: null, flow: 'in' },
  { id: 'benefits', re: BENEFITS, category: 'income', klass: 'need', purpose: 'personal', merchant: null, review: false, glyph: null, flow: 'in' },
  { id: 'deposit', re: DEPOSIT, category: 'income', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null, flow: 'in' },
  { id: 'cash-withdrawal', re: CASH_RE, category: 'cash_withdrawal', klass: 'need', purpose: 'personal', merchant: 'Cash withdrawal', review: true, glyph: null, flow: 'out' },

  // debt and taxes
  { id: 'sba-loan', re: r`\bsba\b.*(loan|eidl|pymt|payment)|sba eidl|small business admin|u\.?s\.? sba`, category: 'debt_service', klass: 'book', purpose: 'studio', merchant: 'SBA loan payment', review: true, glyph: null },
  { id: 'student-loan', re: r`nelnet|navient|mohela|aidvantage|great lakes|fedloan|dept of ed(ucation)?|studentaid|sallie mae|earnest|sofi loan`, category: 'debt_service', klass: 'book', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'pay-later', re: r`\baffirm\b|\bklarna\b|afterpay|\bsezzle\b|\bzip\.co\b|quadpay|paypal pay in 4|apple (card )?installment|monthly installments`, category: 'debt_service', klass: 'book', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'loan-payment', re: r`(ally|capital one|chase|toyota|honda|ford|gm|nissan|hyundai|santander|carmax|carvana|bridgecrest|westlake) (auto|financial|motor credit|finance|fin)|auto loan|car payment|personal loan|loan (pymt|pmt|payment)|lending ?club|upstart|sofi\b.*loan|marcus loan|\bprosper\b|onemain|upgrade inc`, category: 'debt_service', klass: 'book', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'tax-payment', re: r`irs usataxpymt|\beftps\b|irs direct pay|nys dtf|ny state tax|nyc dept of finance.*tax|estimated tax|\btax pymt\b|franchise tax`, category: 'taxes', klass: 'oneoff', purpose: 'personal', merchant: null, review: true, glyph: null },

  // Amazon in its several descriptor forms
  { id: 'aws', re: r`amazon web services|\baws\b`, category: 'software', klass: 'oneoff', purpose: 'studio', merchant: 'Amazon Web Services', review: true, glyph: null },
  { id: 'prime-video', re: r`prime video|amazon video|amzn ?\*? ?video|amazon digital.*video`, category: 'entertainment', klass: 'want', purpose: 'personal', merchant: 'Prime Video', review: false, glyph: null },
  { id: 'amazon-prime', re: r`amazon prime|amzn ?\*? ?prime|prime membership|amazon\.com ?\*? ?prime`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: 'Amazon Prime', review: false, glyph: null },
  { id: 'audible', re: r`audible`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: 'Audible', review: false, glyph: null },
  { id: 'amazon-digital', re: r`kindle|amazon digital|amzn digital|amazon music|amzn ?\*? ?music|amazon ?\*? ?digit`, category: 'entertainment', klass: 'want', purpose: 'personal', merchant: 'Amazon digital', review: true, glyph: null },
  { id: 'amazon-fresh', re: r`amazon fresh|amzn ?\*? ?fresh|amazon go\b|amazon grocery`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: 'Amazon Fresh', review: false, glyph: null },
  { id: 'whole-foods', re: r`whole ?foods|wholefds|\bwfm\b`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: 'Whole Foods', review: false, glyph: null },
  { id: 'amazon-tips', re: r`amazon tips|amzn ?\*? ?tips`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: 'Amazon delivery tip', review: false, glyph: null },
  { id: 'amazon-business', re: r`amazon (business|biz)|amzn ?\*? ?business`, category: 'supplies', klass: 'need', purpose: 'studio', merchant: 'Amazon Business', review: true, glyph: null },
  { id: 'amazon', re: r`amzn ?mktp|amzn mktplace|amazon mktpl|amazon mark|amazon\.com|amazon ?reta|amazon ret\*|\bamzn\b|\bamazon\b|amz\*|a ?m ?a ?z ?o ?n\.com`, category: 'shopping', klass: 'want', purpose: 'personal', merchant: 'Amazon', review: true, glyph: null },

  // food delivery and grocery delivery
  { id: 'uber-one', re: r`uber ?\*? ?one\b|uber one membership`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: 'Uber One', review: false, glyph: null },
  { id: 'uber-eats', re: r`uber ?\*? ?eats|ubereats|eats\.uber|uber \*eats pending`, category: 'delivery', klass: 'game', purpose: 'personal', merchant: 'Uber Eats', review: false, glyph: null },
  { id: 'dashpass', re: r`dashpass|doordash ?\*? ?dashpass`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: 'DashPass', review: false, glyph: null },
  { id: 'doordash', re: r`doordash|dd ?\*? ?doordash|\bdd \*`, category: 'delivery', klass: 'game', purpose: 'personal', merchant: 'DoorDash', review: false, glyph: null },
  { id: 'grubhub-plus', re: r`grubhub\+|seamless\+|grubhub ?plus`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: 'Grubhub+', review: false, glyph: null },
  { id: 'grubhub', re: r`grubhub|seamless|\bgh ?\*|seamlss`, category: 'delivery', klass: 'game', purpose: 'personal', merchant: 'Grubhub / Seamless', review: false, glyph: null },
  { id: 'delivery-app', re: r`postmates|\bcaviar\b|trycaviar|gopuff|go ?puff|chowbus|fantuan|hungrypanda|slice ?\*|slicelife|mealpal|snackpass|ritual ?\*|toasttab\.com|order\.online|chownow|too good to go|toogoodtogo`, category: 'delivery', klass: 'game', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'grocery-delivery', re: r`instacart|ic ?\* ?instacart|freshdirect|fresh direct|\bpeapod\b|\bshipt\b|misfits market|imperfect foods|thrive market|weee!?|sayweee`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'meal-kit-subscription', re: r`hellofresh|blue apron|factor ?75|factor_|home ?chef|cookunity|daily harvest|everyplate`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: null, review: false, glyph: null },

  // transit, tolls, parking, rides
  { id: 'mta', re: r`mta ?\* ?nyct paygo|nyct paygo|\bomny\b|mta\*omny|mta ?\*? ?(nyct|mvm|metrocard|vending)|metrocard|nyc transit|mta bus`, category: 'transit', klass: 'need', purpose: 'personal', merchant: 'MTA subway and bus', review: false, glyph: null },
  { id: 'lirr-metro-north', re: r`mta ?\*? ?(lirr|mnr|etix|metro-?north)|\blirr\b|\bmnr\b|metro-?north|long island rail|mta e-?tix|traintime`, category: 'transit', klass: 'need', purpose: 'personal', merchant: 'LIRR / Metro-North', review: false, glyph: null },
  { id: 'nj-transit-path', re: r`nj ?transit|njt (rail|bus|mobile|myt)|\bpath (tapp|smartlink|train)|panynj path|smartlink|port authority trans`, category: 'transit', klass: 'need', purpose: 'personal', merchant: 'NJ Transit / PATH', review: false, glyph: null },
  { id: 'ferry', re: r`nyc ferry|ny waterway|nywaterway|seastreak|hornblower|liberty landing ferry`, category: 'transit', klass: 'need', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'citi-bike', re: r`citi ?bike|citibik|lyft ?\*? ?citi|nyc bike share|motivate (llc|intl)|\bnycbs\b`, category: 'transit', klass: 'need', purpose: 'personal', merchant: 'Citi Bike', review: false, glyph: null },
  { id: 'intercity', re: r`amtrak|greyhound|megabus|flixbus|peter pan bus|trailways|coach usa|boltbus|ourbus|\bgo ?bus\b|hampton jitney`, category: 'travel', klass: 'want', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'air-travel', re: r`delta air|united air|jetblue|american air|southwest air|spirit air|frontier air|alaska air|air canada|british airways|\bexpedia\b|\bkayak\b|priceline|\bhopper\b|google flights`, category: 'travel', klass: 'want', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'ezpass', re: r`e-?z ?pass|ezpass|e-zpass ny|mta b&t|mta bridges|tolls ?by ?mail|\bnjta\b|nj turnpike|garden state pkwy|pa turnpike|nys thruway|thruway auth|panynj (toll|ezp)|port authority.*toll|congestion (relief|pricing)|\bcbdtp\b|crz toll`, category: 'tolls_parking', klass: 'need', purpose: 'personal', merchant: 'E-ZPass', review: true, glyph: null },
  { id: 'nyc-fine', re: r`nyc ?dof|nyc finance|nyc dept of fin|parking violation|nyc pvb|camera violation|red light|nyc fines|nycdof pvo`, category: 'tolls_parking', klass: 'oneoff', purpose: 'personal', merchant: 'NYC parking or camera fine', review: true, glyph: null },
  { id: 'street-or-app-parking', re: r`parknyc|park ?nyc|nyc dot (park|meter)|nycdot|parkmobile|paybyphone|pay by phone|passport parking|flowbird|muni ?meter|spothero|parkwhiz|bestparking|arrive parking`, category: 'tolls_parking', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'parking-garage', re: r`icon parking|\bsp\+|sp plus|laz parking|\blaz \d|imperial parking|\bimpark\b|mpg parking|quik ?park|edison park|\bipark\b|park ?fast|glenwood (mgmt|parking)|central parking|city ?parking|propark|champion parking|rapid park|little man parking|ggmc|enterprise parking|premium parking|parking (garage|lot|systems|corp|llc)|\bgarage\b|\bparking\b`, category: 'tolls_parking', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'uber', re: r`\buber\b|uber ?\* ?(trip|pending)|uber technologies`, category: 'rideshare', klass: 'want', purpose: 'personal', merchant: 'Uber', review: false, glyph: null },
  { id: 'lyft', re: r`\blyft\b`, category: 'rideshare', klass: 'want', purpose: 'personal', merchant: 'Lyft', review: false, glyph: null },
  { id: 'curb', re: r`\bcurb\b|curb mobility`, category: 'rideshare', klass: 'want', purpose: 'personal', merchant: 'Curb', review: false, glyph: null },
  { id: 'nyc-taxi', re: r`nyc ?taxi|nyctaxi|yellow cab|\bcmt\b nyc|vts (nyc|taxi)|verifone trans`, category: 'rideshare', klass: 'want', purpose: 'personal', merchant: 'NYC taxi', review: false, glyph: null },
  { id: 'car-service', re: r`\brevel\b|\barro\b|taxi|\bcab\b|ridewithvia|via ?\* ?(ride|transportation)|\bmyle\b|\bgett\b|\balto\b ride|dial ?7|carmel (car|limo)|\blimo\b|car service|livery`, category: 'rideshare', klass: 'want', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'scooter-share', re: r`lime ?\*|\blime (ride|scooter|bike)|bird (app|rides)|\bveo\b ride|spin scooter`, category: 'rideshare', klass: 'want', purpose: 'personal', merchant: null, review: false, glyph: null },

  // coffee, bakeries, bagels, tea
  { id: 'starbucks', re: r`starbucks|sbux`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: 'Starbucks', review: false, glyph: null },
  { id: 'dunkin', re: r`dunkin|dnkn|baskin`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: "Dunkin'", review: false, glyph: null },
  { id: 'blank-street-coffee', re: r`blank street`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: 'Blank Street Coffee', review: false, glyph: null },
  { id: 'gregorys-coffee', re: r`gregory'?s coffee|gregorys`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: 'Gregorys Coffee', review: false, glyph: null },
  { id: 'joe-coffee', re: r`joe coffee|joe ?& ?the juice|joe and the juice|joe the art of coffee`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: 'Joe Coffee', review: false, glyph: null },
  { id: 'blue-bottle-coffee', re: r`blue bottle`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: 'Blue Bottle Coffee', review: false, glyph: null },
  { id: 'bluestone-lane', re: r`bluestone lane`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: 'Bluestone Lane', review: false, glyph: null },
  { id: 'la-colombe', re: r`la colombe`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: 'La Colombe', review: false, glyph: null },
  { id: 'think-coffee', re: r`think coffee`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: 'Think Coffee', review: false, glyph: null },
  { id: 'birch-coffee', re: r`birch coffee`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: 'Birch Coffee', review: false, glyph: null },
  { id: 'variety-coffee-roasters', re: r`variety coffee`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: 'Variety Coffee Roasters', review: false, glyph: null },
  { id: 'partners-coffee', re: r`partners coffee`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: 'Partners Coffee', review: false, glyph: null },
  { id: 'stumptown-coffee', re: r`stumptown`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: 'Stumptown Coffee', review: false, glyph: null },
  { id: 'devocion', re: r`devoci[oó]n`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: 'Devocion', review: false, glyph: null },
  { id: 'cafe-grumpy', re: r`cafe grumpy`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: 'Cafe Grumpy', review: false, glyph: null },
  { id: 'coffee-shop', re: r`blue bottle|bluestone lane|la colombe|think coffee|birch coffee|stumptown|variety coffee|devoci[oó]n|partners coffee|cafe grumpy|black fox coffee|culture espresso|ralph'?s coffee|787 coffee|\bmaman\b|coffee project|la cabra|sey coffee|abra[cç]o|% ?arabica|oslo coffee|irving farm|toby'?s estate|ninth street espresso|9th st(reet)? espresso|everyman espresso|hungry ghost|for five coffee|kobrick|porto rico importing|paper coffee|felix roasting|intelligentsia|counter culture|butler bake|drip coffee|coffee bean & tea|peet'?s|philz|tim hortons|caribou coffee|dutch bros|\bcapital one caf[eé]`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'pret-a-manger', re: r`pret a manger|\bpret\b`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: 'Pret A Manger', review: false, glyph: null },
  { id: 'le-pain-quotidien', re: r`le pain quotidien|\blpq\b`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: 'Le Pain Quotidien', review: false, glyph: null },
  { id: 'paris-baguette', re: r`paris baguette`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: 'Paris Baguette', review: false, glyph: null },
  { id: 'bakery-cafe', re: r`pret a manger|\bpret\b|le pain quotidien|\blpq\b|paris baguette|tous les jours|maison kayser|breads bakery|levain|magnolia bakery|daily provisions|angelina paris|ole ?& ?steen|lady m\b|eataly caff|financier patisserie|bien cuit|orwashers|amy'?s bread|zaro'?s|europan|krispy kreme|dough doughnuts|doughnut plant|peter pan donut`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'bagel-shop', re: r`zucker'?s|black seed|tompkins square bagel|ess-?a-?bagel|russ ?& ?daughters|absolute bagels|bagel pub|best bagel|brooklyn bagel|bo'?s bagels|liberty bagels|murray'?s bagels|h&h bagels|pick a bagel|\bbagel`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'tea-boba-or-juice-bar', re: r`kung fu tea|gong ?cha|tiger sugar|boba guys|vivi bubble|coco fresh tea|möge tee|moge tee|yi fang|xing fu tang|chatime|heytea|\bteazzi|bubble tea|\bboba\b|matcha|cha cha matcha|juice press|pressed juicery|juice generation|liquiteria|jamba|smoothie king|playa bowls`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: null, review: false, glyph: null },

  // eating out
  { id: 'chipotle', re: r`chipotle`, category: 'eating_out', klass: 'game', purpose: 'personal', merchant: 'Chipotle', review: false, glyph: null },
  { id: 'sweetgreen', re: r`sweetgreen`, category: 'eating_out', klass: 'game', purpose: 'personal', merchant: 'Sweetgreen', review: false, glyph: null },
  { id: 'shake-shack', re: r`shake shack`, category: 'eating_out', klass: 'game', purpose: 'personal', merchant: 'Shake Shack', review: false, glyph: null },
  { id: 'mcdonalds', re: r`mcdonald`, category: 'eating_out', klass: 'game', purpose: 'personal', merchant: "McDonald's", review: false, glyph: null },
  { id: 'the-halal-guys', re: r`halal guys`, category: 'eating_out', klass: 'game', purpose: 'personal', merchant: 'The Halal Guys', review: false, glyph: null },
  { id: 'chopt', re: r`\bchopt\b`, category: 'eating_out', klass: 'game', purpose: 'personal', merchant: 'Chopt', review: false, glyph: null },
  { id: 'just-salad', re: r`just salad`, category: 'eating_out', klass: 'game', purpose: 'personal', merchant: 'Just Salad', review: false, glyph: null },
  { id: 'cava', re: r`\bcava\b`, category: 'eating_out', klass: 'game', purpose: 'personal', merchant: 'Cava', review: false, glyph: null },
  { id: 'panera-bread', re: r`panera`, category: 'eating_out', klass: 'game', purpose: 'personal', merchant: 'Panera Bread', review: false, glyph: null },
  { id: 'five-guys', re: r`five guys`, category: 'eating_out', klass: 'game', purpose: 'personal', merchant: 'Five Guys', review: false, glyph: null },
  { id: 'fast-casual-lunch', re: r`sweetgreen|\bchopt\b|just salad|\bcava\b|\bdig inn\b|\bdig \d|\bdig\b nyc|fresh ?& ?co|\bnaya\b|dos toros|chipotle|qdoba|\bmoe'?s\b|panera|potbelly|jersey mike|jimmy john|firehouse subs|\bsubway\b|blimpie|cosi\b|hale and hearty|westville|the little beet|inday|bonchon|mighty quinn|luke'?s lobster|\bbeatnic\b|by chloe|honeygrow|mulberry ?& ?vine|springbone|poke ?works|sweetcatch|wonder (food|group)|urbanspace|\bdekalb market`, category: 'eating_out', klass: 'game', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'fast-food', re: r`mcdonald|burger king|wendy'?s|chick-?fil-?a|popeyes|taco bell|\bkfc\b|five guys|shake shack|white castle|checkers|\bsonic drive|arby'?s|jack in the box|in-?n-?out|whataburger|raising cane|wingstop|buffalo wild|panda express|jollibee|nathan'?s famous|papaya (king|dog)|gray'?s papaya|halal guys|xi'?an famous|vanessa'?s dumpling|joe'?s shanghai|mamoun|\bsmashburger|bareburger|7th street burger|black tap|golden krust|pollo campero|pio pio|boston market`, category: 'eating_out', klass: 'game', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'pizza', re: r`domino'?s|papa john|pizza hut|little caesars|joe'?s pizza|2 bros|two bros|99 ?(c|¢|cent)s? (fresh )?pizza|prince st(reet)? pizza|artichoke (basille|pizza)|scarr'?s|l'?industrie|lombardi|grimaldi|patsy'?s|john'?s of bleecker|roberta'?s|paulie gee|rubirosa|&pizza|sbarro|famous (original )?ray|ray'?s pizza|upside pizza|unregular pizza|motorino|\bkeste\b|emmy squared|pizza`, category: 'eating_out', klass: 'game', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'sit-down-restaurant', re: r`ihop|applebee|olive garden|cheesecake factory|chili'?s|tgi ?friday|outback|red lobster|texas roadhouse|\bdenny'?s|cracker barrel|waffle house|dave ?& ?buster|hooters|benihana|p\.?f\.? chang|carmine'?s|junior'?s|\bkatz'?s|sarge'?s|2nd ave deli|second ave(nue)? deli|veselka|\bbcd tofu|ippudo|totto ramen|ichiran|momofuku|nobu|\bcarbone\b|balthazar|\bbuvette\b|\btao\b (uptown|downtown)|\bresy\b|opentable|\btock\b`, category: 'eating_out', klass: 'game', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'dessert-or-sweets', re: r`insomnia cookies|van leeuwen|ample hills|mister softee|haagen|h[aä]agen-?dazs|ben ?& ?jerry|16 handles|pinkberry|red mango|carvel|dairy queen|cold stone|baskin|morgenstern|milk bar|crumbl|schmackary|levain|chip city|sugar factory|economy candy|dylan'?s candy|\bit'?sugar`, category: 'eating_out', klass: 'game', purpose: 'personal', merchant: null, review: false, glyph: null },

  // corner stores and vending
  { id: 'seven-eleven', re: r`7-?eleven|7 eleven`, category: 'convenience', klass: 'game', purpose: 'personal', merchant: '7-Eleven', review: false, glyph: null },
  { id: 'convenience-store', re: r`7-?eleven|7 eleven|\bwawa\b|quick ?chek|cumberland farms|circle k|\bsheetz\b|hudson news|hudson (st )?booksellers|\bhudson st\d|\bhudsonnews|inmotion ent|\bcibo express|\bduty free|news ?stand|\bnewsstand`, category: 'convenience', klass: 'game', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'vending', re: r`\busa ?\* ?(vend|snack|canteen|coca|pepsi)|\bctlp ?\*|cantaloupe|\bnayax\b|365 ?market|canteen vending|vending|\bvend\b|usconnect|avanti market|coca[- ]?cola|pepsi vending|farmer'?s fridge|farmers fridge`, category: 'convenience', klass: 'game', purpose: 'personal', merchant: null, review: false, glyph: null },

  // groceries
  { id: 'trader-joes', re: r`trader joe`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: "Trader Joe's", review: false, glyph: null },
  { id: 'key-food', re: r`key ?food`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: 'Key Food', review: false, glyph: null },
  { id: 'c-town', re: r`c-?town`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: 'C-Town', review: false, glyph: null },
  { id: 'food-bazaar', re: r`food bazaar`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: 'Food Bazaar', review: false, glyph: null },
  { id: 'associated-supermarket', re: r`associated (supermarket|food|market)`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: 'Associated Supermarket', review: false, glyph: null },
  { id: 'foodtown', re: r`foodtown|food town`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: 'Foodtown', review: false, glyph: null },
  { id: 'fine-fare', re: r`fine fare`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: 'Fine Fare', review: false, glyph: null },
  { id: 'western-beef', re: r`western beef`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: 'Western Beef', review: false, glyph: null },
  { id: 'morton-williams', re: r`morton williams`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: 'Morton Williams', review: false, glyph: null },
  { id: 'gristedes', re: r`gristedes|d'?agostino`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: "Gristedes / D'Agostino", review: false, glyph: null },
  { id: 'nyc-supermarket', re: r`trader joe|key food|c-?town|associated (supermarket|food|market)|food bazaar|foodtown|food town|fine fare|met ?food|pioneer (supermarket|market)|bravo (supermarket|market)|western beef|gristedes|d'?agostino|morton williams|fairway|westside market|citarella|zabar'?s|union market|brooklyn fare|food emporium|garden of eden|gourmet garage|lincoln market|ideal food basket|cherry valley|compare foods|super ?fresh|shop ?fair|city ?fresh market|city acres|foragers|park slope food co|4th st(reet)? food co-?op|greene grape|mr\.? mango|mr\.? kiwi|\bkey ?food\b`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'supermarket', re: r`stop ?& ?shop|stop and shop|shop ?rite|wegmans|\baldi\b|\blidl\b|kroger|safeway|publix|\bacme\b (market|store)|giant food|food lion|h-?e-?b\b|meijer|sprouts|fresh market|\bbj'?s\b (wholesale|whsl)|bjs wholesale|costco (whse|wholesale|\.com)|\bcostco\b|sam'?s ?club`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'speciality-grocery', re: r`h ?-?mart|\bhmart\b|99 ranch|hong kong supermarket|new york mart|jmart|j-mart|sky foods|good fortune super|great wall super|patel brothers|apna bazar|kalustyan|sahadi|eataly|\bmitsuwa|sunrise mart|katagiri|dainobu|net cost market|netcost|\bcherry hill gourmet|\btashkent super|fei long|pacific super`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'farmers-market', re: r`green ?market|grownyc|farmers'? market|farm ?stand|\bcsa\b share|union sq(uare)? greenmarket`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: null, review: false, glyph: null },

  // health
  { id: 'duane-reade', re: r`duane ?reade`, category: 'health', klass: 'need', purpose: 'personal', merchant: 'Duane Reade', review: true, glyph: null },
  { id: 'cvs', re: r`\bcvs\b|cvs/?pharm`, category: 'health', klass: 'need', purpose: 'personal', merchant: 'CVS', review: true, glyph: null },
  { id: 'walgreens', re: r`walgreens`, category: 'health', klass: 'need', purpose: 'personal', merchant: 'Walgreens', review: true, glyph: null },
  { id: 'rite-aid', re: r`rite ?aid`, category: 'health', klass: 'need', purpose: 'personal', merchant: 'Rite Aid', review: true, glyph: null },
  { id: 'chain-pharmacy', re: r`duane ?reade|\bcvs\b|cvs/?pharm|walgreens|rite ?aid`, category: 'health', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'pharmacy', re: r`capsule (pharmacy|corp)|alto pharmacy|\bmedly\b|pharmacy|pharmacies|\bapothecary|drug ?store|\bdrugs\b|\brx\b|express scripts|optumrx|goodrx|cost plus drugs`, category: 'health', klass: 'need', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'medical', re: r`city ?md|one medical|mount sinai|mt\.? sinai|nyu langone|northwell|montefiore|\bnyp\b|ny presbyterian|weill cornell|columbia doctors|\bhss\b|memorial sloan|quest diag|labcorp|zocdoc|urgent care|medical|physician|\bclinic\b|hospital|dental|dentist|orthodont|\boptical\b|optometr|eye ?care|warby parker|lenscrafters|dermatolog|chiropract|physical therapy|\bpt solutions|radiology|pediatric|ob ?gyn|planned parenthood|\bcallen-?lorde|carbon health|\bsesame care|teladoc|\bhims\b|\bhers\b health|ro\.co|talkspace|betterhelp|headway|alma\b.*therapy|therapy|psycholog|counseling`, category: 'health', klass: 'need', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'gym', re: r`planet fit|blink fit|equinox|crunch fit|\bnysc\b|new york sports club|\bymca\b|\bymha\b|classpass|peloton|soulcycle|orangetheory|la fitness|24 hour fit|chelsea piers|barry'?s boot|solidcore|corepower|y7 studio|modo yoga|yoga|pilates|crossfit|\bgym\b|fitness|climbing|brooklyn boulders|\bvital climb|the cliffs`, category: 'health', klass: 'need', purpose: 'personal', merchant: null, review: false, glyph: null },

  // fuel and car
  { id: 'fuel', re: r`\bexxon|\bmobil\b|exxonmobil|\bshell\b|\bbp\b ?#?\d*|sunoco|\bgulf\b|citgo|valero|chevron|texaco|speedway|marathon (petro|gas)|phillips 66|conoco|costco gas|bj'?s fuel|racetrac|quik ?trip|\bgetty\b|lukoil|\bdelta\b (gas|fuel)|\bmerit\b (gas|fuel)|gas ?station|gas ?mart|\bfuel\b|petroleum|service station|gasoline`, category: 'fuel_auto', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'ev-charging', re: r`chargepoint|\bevgo\b|electrify america|tesla supercharg|blink charging|revel charging|\bev charging|volta charging|flo charging`, category: 'fuel_auto', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'auto-service', re: r`autozone|advance auto|pep boys|o'?reilly auto|napa auto|jiffy lube|\bmidas\b|meineke|firestone|valvoline|\bmavis\b|goodyear|monro\b|\btires?\b|auto (repair|body|service|care|parts|glass)|car ?wash|collision|muffler|\bnys? ?dmv\b|\bdmv\b|ny dept of motor|motor vehicles|inspection station|\baaa\b (ny|northeast|membership)`, category: 'fuel_auto', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'car-rental', re: r`zipcar|getaround|\bturo\b|hertz|\bavis\b|enterprise rent|budget rent|national car|\bsixt\b|alamo rent|thrifty|dollar rent|u-?haul|penske|budget truck|home depot rental|\bfluid truck|kyte\b`, category: 'fuel_auto', klass: 'oneoff', purpose: 'personal', merchant: null, review: true, glyph: null },

  // chess
  { id: 'chesscom', re: r`chess\.com|chesscom|chess com\b`, category: 'software', klass: 'oneoff', purpose: 'coaching', merchant: 'Chess.com', review: false, glyph: null },
  { id: 'lichess', re: r`lichess`, category: 'software', klass: 'oneoff', purpose: 'coaching', merchant: 'Lichess', review: false, glyph: null },
  { id: 'chessable', re: r`chessable`, category: 'software', klass: 'oneoff', purpose: 'coaching', merchant: 'Chessable', review: false, glyph: null },
  { id: 'chessbase', re: r`chessbase`, category: 'software', klass: 'oneoff', purpose: 'coaching', merchant: 'ChessBase', review: false, glyph: null },
  { id: 'chesskid', re: r`chesskid`, category: 'software', klass: 'oneoff', purpose: 'coaching', merchant: 'ChessKid', review: false, glyph: null },
  { id: 'chess-site', re: r`chess\.com|chesscom|chess com\b|lichess|chessable|chessbase|chess24|chesskid|chesstempo|aimchess|chessmood|chess ?mood|modern chess|internet chess club|chessclub\.com|\bicc\b chess|chessify|chess ?dojo|chessdojo|killer chess training|chess university|chessly|gothamchess|noctie|decodechess|forward ?chess|chess king|chess openings wizard|\bhiarcs|chessify|play ?magnus|magnus trainer|chess ?gym`, category: 'software', klass: 'oneoff', purpose: 'coaching', merchant: null, review: false, glyph: null },
  { id: 'chess-equipment', re: r`chess ?house|house of staunton|wholesale chess|chess ?4 ?less|chess4less|chessusa|chess usa|the chess store|chess ?central|uscf ?sales|us chess sales|american chess equip|chess ?bazaar|chessbazaar|\bdgt\b|new in chess|quality chess|everyman chess|thinkers publishing|chess forum|chess ?& ?bridge|chess ?n ?math|chess emporium|royal chess mall|chess empire|chess stars|russell enterprises|mongoose press|gambit publications`, category: 'supplies', klass: 'need', purpose: 'coaching', merchant: null, review: false, glyph: null },
  { id: 'chess-club', re: r`\buscf\b|us ?chess (fed|org)?|uschess|\bfide\b|continental chess|chess ?tournaments?|chesstour|marshall chess|chess (club|center|academy|school|max|nyc|in the schools)|charlotte chess|saint louis chess|st\.? louis chess|world open|\bchess ?action|kingregistration|king registration|caissa chess|caissachess|\bchess\b`, category: 'education', klass: 'oneoff', purpose: 'coaching', merchant: null, review: true, glyph: null },

  // music, pro audio and the studio
  { id: 'ableton', re: r`ableton`, category: 'software', klass: 'oneoff', purpose: 'studio', merchant: 'Ableton', review: false, glyph: null },
  { id: 'native-instruments', re: r`native instruments|native-instruments`, category: 'software', klass: 'oneoff', purpose: 'studio', merchant: 'Native Instruments', review: true, glyph: null },
  { id: 'sweetwater', re: r`sweetwater`, category: 'gear', klass: 'oneoff', purpose: 'studio', merchant: 'Sweetwater', review: true, glyph: null },
  { id: 'guitar-center', re: r`guitar ?center`, category: 'gear', klass: 'oneoff', purpose: 'studio', merchant: 'Guitar Center', review: true, glyph: null },
  { id: 'sam-ash', re: r`sam ?ash`, category: 'gear', klass: 'oneoff', purpose: 'studio', merchant: 'Sam Ash', review: true, glyph: null },
  { id: 'vintage-king', re: r`vintage king`, category: 'gear', klass: 'oneoff', purpose: 'studio', merchant: 'Vintage King', review: true, glyph: null },
  { id: 'reverb', re: r`reverb\.com|reverb ?\*|\breverb\b (llc|com)`, category: 'gear', klass: 'oneoff', purpose: 'studio', merchant: 'Reverb', review: true, glyph: null },
  { id: 'pro-audio-retailer', re: r`sweetwater|guitar ?center|sam ?ash|vintage king|reverb\.com|reverb ?\*|\breverb\b (llc|com)|thomann|zzounds|musician'?s ?friend|american musical|full compass|pro ?audio ?star|front end audio|alto music|westlake pro|perfect circuit|rudy'?s music|main drag music|rogue music|chuck levin|\bkraft music|sound pure|mercenary audio|atlas pro audio|rspe audio|dale pro audio|gotham sound|\bturntable lab|control voltage|detroit modular|noisebug|\bjrr shop|audiodeluxe|music go round|\bmusic store|music & arts|long ?& ?mcquade|andertons|gear4music|soundgas`, category: 'gear', klass: 'oneoff', purpose: 'studio', merchant: null, review: true, glyph: null },
  { id: 'audio-maker', re: r`universal audio|uaudio|\bua\b digital|focusrite|presonus|apogee (elec|digital)|solid state logic|\bssl\b store|genelec|neumann|sennheiser|\bshure\b|audio-?technica|\brode\b mic|\bakg\b|warm audio|\bneve\b|api audio|rupert neve|\bmanley\b|\bavalon design|black lion audio|antelope audio|\bmotu\b|\brme\b audio|lynx studio|\bburl audio|\bcranborne|heritage audio|golden age|\bslate (media|digital)|townsend labs|\bkali audio|adam audio|\byamaha\b|\broland\b|\bkorg\b|\bmoog\b|\bakai\b|elektron|teenage engineering|behringer|\bmackie\b|\bkrk\b|\bjbl\b pro|\bnord\b keyboards|sequential|arturia|novation|native instruments|ableton|\bsoyuz|\baea ribbon|royer labs|earthworks|telefunken|lauten audio|aston mic|se electronics`, category: 'gear', klass: 'oneoff', purpose: 'studio', merchant: null, review: true, glyph: null },
  { id: 'studio-build', re: r`primacoustic|gik acoustics|auralex|acoustimac|ats acoustics|acoustical solutions|\bvicoustic|rockwool|owens corning|mogami|redco audio|markertek|monoprice|hosa tech|\bmouser\b|digi-?key|parts express|\bneutrik|canare|\bbelden|full compass|ultimate support|\bk&m\b stands|on-?stage stands|gator cases|\bskb\b cases|pelican (products|cases)|\bsamson tech|ebtech|furman|\bapc\b by|cyberpower|tripp ?lite`, category: 'gear', klass: 'oneoff', purpose: 'studio', merchant: null, review: true, glyph: null },

  // electronics
  { id: 'b-h-photo', re: r`b ?& ?h photo|b&h ?photo|bh ?photo|bhphoto|\bb&h\b`, category: 'gear', klass: 'oneoff', purpose: 'personal', merchant: 'B&H Photo', review: true, glyph: null },
  { id: 'adorama', re: r`adorama`, category: 'gear', klass: 'oneoff', purpose: 'personal', merchant: 'Adorama', review: true, glyph: null },
  { id: 'best-buy', re: r`\bbest ?buy(?!er)`, category: 'gear', klass: 'oneoff', purpose: 'personal', merchant: 'Best Buy', review: true, glyph: null },
  { id: 'apple-store', re: r`apple store|apple online store|apple\.com/us`, category: 'gear', klass: 'oneoff', purpose: 'personal', merchant: 'Apple Store', review: true, glyph: null },
  { id: 'electronics', re: r`b ?& ?h photo|b&h ?photo|bh ?photo|bhphoto|\bb&h\b|adorama|\bmicro ?center|\bnewegg|\bbest ?buy(?!er)|apple store|apple online store|apple\.com/us|\bbackmarket|back market|\bswappa|tekserve|\bdataivision|data vision|\bp\.?c\.? richard|\bcrutchfield|\bfocus camera|\bworld ?wide stereo`, category: 'gear', klass: 'oneoff', purpose: 'personal', merchant: null, review: true, glyph: null },

  // software and subscriptions
  { id: 'avid', re: r`\bavid ?(tech|\.com|\*|pro\b|sibelius|media comp)|\*avid\b|pro ?tools`, category: 'software', klass: 'oneoff', purpose: 'studio', merchant: 'Avid (Pro Tools)', review: false, glyph: null },
  { id: 'waves', re: r`waves (audio|inc|\.com)|\bwaves\b creative`, category: 'software', klass: 'oneoff', purpose: 'studio', merchant: 'Waves', review: false, glyph: null },
  { id: 'splice', re: r`\bsplice\b|splice\.com`, category: 'software', klass: 'oneoff', purpose: 'studio', merchant: 'Splice', review: false, glyph: null },
  { id: 'izotope', re: r`izotope`, category: 'software', klass: 'oneoff', purpose: 'studio', merchant: 'iZotope', review: false, glyph: null },
  { id: 'plugin-alliance', re: r`plugin ?alliance`, category: 'software', klass: 'oneoff', purpose: 'studio', merchant: 'Plugin Alliance', review: false, glyph: null },
  { id: 'plugin-boutique', re: r`plugin ?bouti`, category: 'software', klass: 'oneoff', purpose: 'studio', merchant: 'Plugin Boutique', review: false, glyph: null },
  { id: 'fabfilter', re: r`fabfilter`, category: 'software', klass: 'oneoff', purpose: 'studio', merchant: 'FabFilter', review: false, glyph: null },
  { id: 'soundtoys', re: r`soundtoys`, category: 'software', klass: 'oneoff', purpose: 'studio', merchant: 'Soundtoys', review: false, glyph: null },
  { id: 'slate-digital', re: r`slate digital`, category: 'software', klass: 'oneoff', purpose: 'studio', merchant: 'Slate Digital', review: false, glyph: null },
  { id: 'distrokid', re: r`distrokid`, category: 'software', klass: 'oneoff', purpose: 'studio', merchant: 'DistroKid', review: false, glyph: null },
  { id: 'dropbox', re: r`dropbox`, category: 'software', klass: 'oneoff', purpose: 'personal', merchant: 'Dropbox', review: true, glyph: null },
  { id: 'adobe', re: r`\badobe\b`, category: 'software', klass: 'oneoff', purpose: 'personal', merchant: 'Adobe', review: true, glyph: null },
  { id: 'youtube', re: r`youtube ?(premium|tv|music)|google ?\*? ?youtube`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: 'YouTube Premium', review: false, glyph: null },
  { id: 'audio-software', re: r`\bavid ?(tech|\.com|\*|pro\b|sibelius|media comp)|\*avid\b|pro ?tools|waves (audio|inc|\.com)|\bwaves\b creative|\buadx?\b|\bua connect|\bsplice\b|splice\.com|izotope|plugin ?alliance|plugin ?bouti|fabfilter|soundtoys|slate digital|steinberg|image-?line|fl studio|presonus sphere|studio one\+|antares|auto-?tune|celemony|melodyne|eventide|spectrasonics|\boutput\b (inc|\.com)|sonarworks|softube|valhalla ?dsp|kilohearts|\bxfer\b records|sound ?radix|oeksound|goodhertz|east ?west|soundsonline|spitfire audio|toontrack|xln audio|ik multimedia|audiomovers|\bsoundly\b|source-?connect|source elements|sessionwire|\bilok\b|pace anti|\bgobbler\b|\bloopcloud|loopmasters|\bcableguys|\blunacy audio|\bbaby audio|\bmcdsp|\bbrainworx|\bsonnox|\blexicon\b pcm|\breason studios|\bbitwig|\breaper\b|cockos|\bcubase|\blogic pro|\bmainstage|\bsynchro arts|\bzynaptiq|\bacon digital|\baccusonus|\blandr\b|\bemastered|\bcloudbounce|\bmuse ?score|\bnoteflight|\bguitar pro`, category: 'software', klass: 'oneoff', purpose: 'studio', merchant: null, review: false, glyph: null },
  { id: 'music-distribution', re: r`distrokid|tunecore|cd ?baby|\bditto music|\bamuse\b|unitedmasters|soundcloud|bandcamp|bandlab|beatstars|airbit|traktrain|\bsongtrust|\bsoundbetter|\bengineears|\bmuso\.ai|\bsoundtrap|epidemic sound|\bartlist\b|\bpond5\b|\bmusicbed|\bsoundstripe|songwhip|linkfire|\btoneden|\bsubmithub|\bgroover\b|playlist ?push`, category: 'software', klass: 'oneoff', purpose: 'studio', merchant: null, review: true, glyph: null },
  { id: 'business-software', re: r`acuity ?scheduling|squarespace|\bsqsp\b|\bwix\b|wix\.com|godaddy|namecheap|google ?\*? ?domains|hover\.com|\bcalendly|\bsetmore|\bbooksy|\bvagaro|\bmindbody|\bpeerspace|\bgiggster|\bsplacer|\bhoneybook|\bdubsado|\btypeform|\bjotform|mailchimp|constant contact|convertkit|\bkit\.com|\blinktree|\bcarrd\b|\bwebflow|wordpress|\bwpengine|\bbluehost|hostgator|siteground|digitalocean|\blinode|\bvercel|\bnetlify|cloudflare|\bheroku|\bgithub|\bgitlab|\bnotion\b|\bairtable|\bslack\b|\bzoom\b|zoom\.us|zoom video|loom\.com|\bdropbox|\bbox\.com|\bbackblaze|carbonite|\bidrive|frame\.io|\bwetransfer|\bcanva\b|\badobe\b|\bfigma\b|\bquickbooks|intuit ?\*? ?qb|\bfreshbooks|\bxero\b|\bwave ?\* ?|waveapps|turbotax|\bh&r block|\btaxact|freetaxusa|\bgusto\b fee|\bdocusign|\bhellosign|\b1password|lastpass|bitwarden|nordvpn|expressvpn|proton|\bfastmail|\bgrammarly|\bopenai|chatgpt|anthropic|claude\.ai|\bmidjourney|perplexity|\bcursor\b|elevenlabs|\bsuno\b|\budio\b`, category: 'software', klass: 'oneoff', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'google-fi', re: r`google ?\*? ?fi\b`, category: 'phone_internet', klass: 'book', purpose: 'personal', merchant: 'Google Fi', review: false, glyph: null },
  { id: 'google-subscription', re: r`google ?\*? ?(workspace|gsuite|g suite|cloud)|google ?\*? ?(one|storage)\b`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: 'Google subscription', review: true, glyph: null },
  { id: 'microsoft', re: r`microsoft ?\*? ?(365|office|store|onedrive)|\bmsft\b|microsoft\.com`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: 'Microsoft subscription', review: true, glyph: null },
  { id: 'apple-services', re: r`apple\.com/bill|itunes\.com|\bapple ?\*? ?(services|icloud|one\b|music|tv|arcade|fitness)|\bitunes\b|apl\* ?itunes|icloud`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: 'Apple services', review: true, glyph: null },
  { id: 'google-play', re: r`google ?\*|google play|play\.google`, category: 'entertainment', klass: 'want', purpose: 'personal', merchant: null, review: true, glyph: null },

  // streaming, news, games, going out
  { id: 'netflix', re: r`netflix`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: 'Netflix', review: false, glyph: null },
  { id: 'hulu', re: r`\bhulu\b`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: 'Hulu', review: false, glyph: null },
  { id: 'disney-plus', re: r`disney ?(plus|\+)|disneyplus`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: 'Disney+', review: false, glyph: null },
  { id: 'max', re: r`hbo ?max|\bmax\.com|help\.max`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: 'Max', review: false, glyph: null },
  { id: 'streaming', re: r`netflix|\bhulu\b|disney ?(plus|\+)|disneyplus|hbo ?max|\bmax\.com|help\.max|peacock|paramount ?(plus|\+)|apple tv|youtube ?(premium|tv|music)|google ?\*? ?youtube|siriusxm|sirius xm|crunchyroll|\bespn ?(plus|\+)|\bdazn\b|\bmubi\b|criterion channel|discovery ?(plus|\+)|\bamc ?\+|\bstarz|showtime|\bfubo|sling tv|philo\b|\btwitch\b|\bpatreon|\bsubstack|\bmedium\.com|\bnebula\b`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'spotify', re: r`spotify`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: 'Spotify', review: true, glyph: null },
  { id: 'music-streaming', re: r`spotify|\btidal\b|apple music|\bqobuz|\bdeezer|pandora|soundcloud go`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'nytimes', re: r`ny ?times|nytimes|new york times`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: 'The New York Times', review: false, glyph: null },
  { id: 'news', re: r`ny ?times|nytimes|new york times|washington post|wsj|wall street journal|the atlantic|new yorker|the economist|\bft\.com|financial times|bloomberg|\bwired\b|\bthe athletic|\bnew york mag|\bvulture\b|\bconsumer reports|\bscribd|\beveryday health`, category: 'subscriptions', klass: 'book', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'games', re: r`playstation|\bpsn\b|sony interactive|nintendo|xbox|steam ?games|steampowered|valve\b|epic games|blizzard|riot games|\broblox|\bea \*|electronic arts|\bgamestop|\bitch\.io|duolingo|headspace|calm\.com|\bmasterclass`, category: 'entertainment', klass: 'want', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'cinema', re: r`\bamc\b (theat|\d|empire|lincoln|village|kips|34th|84th)|amc theatres|regal (cinema|union|essex|battery|e-walk)|alamo drafthouse|angelika|ifc center|film forum|metrograph|nitehawk|\bbam\b (rose|harvey|cinema)|village east|cinema village|quad cinema|film at lincoln|fandango|atom tickets|\bcinemas?\b|\btheat(er|re)s?\b|\bmovie`, category: 'entertainment', klass: 'want', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'tickets', re: r`ticketmaster|live ?nation|stubhub|seatgeek|\baxs\b|vivid ?seats|eventbrite|dice\.fm|\bdice fm|resident advisor|\bra\.co|\btixr|\bseetickets|see tickets|todaytix|telecharge|\btkts\b|ticketweb|\betix\b|ovationtix|madison square|\bmsg\b (ent|ticket)|barclays center|\bubs arena|yankee stadium|citi field|comedy cellar|blue note|village vanguard|\bsmalls jazz|birdland|bowery (ballroom|presents)|brooklyn steel|terminal 5|webster hall|music hall of w|\belsewhere\b|\bknockdown|\bavant gardner|\bnational sawdust|lincoln center|carnegie hall|\bthe met\b|metropolitan (museum|opera)|\bmoma\b|whitney museum|guggenheim|\bamnh\b|museum|brooklyn museum|\bbowlero|\bbarcade|\bchelsea piers bowl|\bkaraoke|\bbilliards|\bescape (room|the room)|\barcade\b`, category: 'entertainment', klass: 'want', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'wine-shop', re: r`liquor|wine ?(shop|store|merchants?|& ?spirits|s & spirits)|\bwines?\b|\bspirits\b|beer (store|shop|distribut)|\bbottle shop|astor wines|union square wines|\bbevmo|total wine|beverage (center|barn)|\bdrizly|\bminibar delivery|\breservebar`, category: 'entertainment', klass: 'want', purpose: 'personal', merchant: null, review: false, glyph: null },

  // utilities, phone, internet, insurance, housing
  { id: 'con-edison', re: r`con ?ed(ison)?\b|coned|consolidated edison|con ed of ny`, category: 'utilities', klass: 'book', purpose: 'personal', merchant: 'Con Edison', review: true, glyph: null },
  { id: 'national-grid', re: r`national grid|nationalgrid|\bngrid|nat grid|keyspan`, category: 'utilities', klass: 'book', purpose: 'personal', merchant: 'National Grid', review: true, glyph: null },
  { id: 'utility', re: r`\bpseg\b|pse&g|\blipa\b|nyseg|central hudson|orange ?& ?rockland|\bo&r util|nyc water|nyc dep\b|dep water|nycwater|water board|green mountain energy|constellation (energy|newenergy)|direct energy|ambit energy|just energy|\barcadia\b|clearview energy|\bxoom energy|\bspark energy|utility ?pay|utilit(y|ies)`, category: 'utilities', klass: 'book', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'verizon-wireless', re: r`verizon wireless|\bvzw|vzwrlss|verizon ?\*? ?wrls`, category: 'phone_internet', klass: 'book', purpose: 'personal', merchant: 'Verizon Wireless', review: false, glyph: null },
  { id: 't-mobile', re: r`t-?mobile|tmobile`, category: 'phone_internet', klass: 'book', purpose: 'personal', merchant: 'T-Mobile', review: false, glyph: null },
  { id: 'att', re: r`\bat&t\b|\batt ?\*|at ?& ?t (mobility|wireless|payment)`, category: 'phone_internet', klass: 'book', purpose: 'personal', merchant: 'AT&T', review: false, glyph: null },
  { id: 'mint-mobile', re: r`mint mobile`, category: 'phone_internet', klass: 'book', purpose: 'personal', merchant: 'Mint Mobile', review: false, glyph: null },
  { id: 'mobile-phone', re: r`verizon wireless|\bvzw|vzwrlss|verizon ?\*? ?wrls|\bat&t\b|\batt ?\*|at ?& ?t (mobility|wireless|payment)|t-?mobile|tmobile|mint mobile|\bvisible\b (service|wireless)|cricket wireless|boost mobile|metro by t|metropcs|us mobile|\btello\b|\bting\b mobile|straight talk|tracfone|consumer cellular|xfinity mobile|spectrum mobile|google ?\*? ?fi`, category: 'phone_internet', klass: 'book', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'verizon-fios', re: r`\bfios\b|verizon ?\*? ?fios`, category: 'phone_internet', klass: 'book', purpose: 'personal', merchant: 'Verizon Fios', review: true, glyph: null },
  { id: 'spectrum', re: r`spectrum|charter comm`, category: 'phone_internet', klass: 'book', purpose: 'personal', merchant: 'Spectrum', review: true, glyph: null },
  { id: 'optimum', re: r`optimum|altice|cablevision`, category: 'phone_internet', klass: 'book', purpose: 'personal', merchant: 'Optimum', review: true, glyph: null },
  { id: 'internet', re: r`verizon|\bfios\b|spectrum|charter comm|optimum|altice|cablevision|\brcn\b|astound|\bstarry\b|comcast|xfinity|honest networks|natural wireless|pilot fiber|\bsonic\.net|\bstarlink|\bearthlink|frontier comm`, category: 'phone_internet', klass: 'book', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'insurance', re: r`geico|progressive (ins|\*|direct)|state farm|allstate|liberty mutual|lemonade|\busaa\b (ins|p&c)|travelers|nationwide|farmers ins|esurance|root insurance|\bnext insurance|\bhiscox|the hartford|\bthimble\b|simply business|\bchubb\b|\bcoverwallet|\bpie insurance|\bbiberk|front row insurance|music ?pro insurance|musicpro|clarion (associates|ins)|\bmarkel\b|insureon`, category: 'insurance', klass: 'book', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'health-insurance', re: r`oscar health|\bhioscar|healthfirst|emblem ?health|fidelis|\baetna\b|\bcigna\b|united ?health|\buhc\b|anthem|empire b(cbs|lue)|blue cross|blue shield|metroplus|ny ?state ?of ?health|nystateofhealth|\bguardian\b (life|dental)|metlife|delta dental|\bvsp\b vision|\bhumana|kaiser|freelancers union|\bcobra\b|health ins|\binsurance\b|\binsur\b|ins prem`, category: 'insurance', klass: 'book', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'self-storage', re: r`public storage|manhattan mini storage|cubesmart|extra space|\blife storage|storage ?(post|mart|quarters)|\bstoragemart|self storage|\bclutter\b|makespace|\bstorage\b`, category: 'housing', klass: 'book', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'rent', re: r`\bbilt\b ?(rent|rewards|pymt)?|biltrent|\bzego\b|paylease|pay ?your ?rent|click ?pay|rent ?cafe|rentcafe|rentmoola|rent ?payment|rentpayment|\bavail\.co|apartments\.com|\bcozy\b|yardi|appfolio|buildium|resident ?portal|residentportal|\brentler|\bzillow rent|streeteasy|\blandlord|property (mgmt|management)|\brealty\b|real estate|management (co|corp|llc|inc)|\bmgmt (co|corp|llc|inc)|\bhoa\b|co-?op maintenance|maintenance (fee|pymt)|\bmortgage|mr\.? cooper|rocket mortgage|loancare|\blease (pymt|payment)|\brent\b(?! the runway)`, category: 'housing', klass: 'book', purpose: 'personal', merchant: null, review: true, glyph: null },

  // supplies, home, shopping, education, travel, giving, government
  { id: 'office-supplies', re: r`staples|office ?depot|officemax|\bw\.?b\.? mason|\bquill\b|\buline\b|paper source|\bmichaels\b|\bblick\b|dick blick|jerry'?s artarama|artist ?& ?craftsman|lakeshore learning|scholastic|teachers ?pay ?teachers|\btpt\b|really good stuff|oriental trading|discount school supply|school specialty|\bkaplan early|vistaprint|\bmoo\.com|moo print|\bgotprint|\buprinting|sticker ?mule|\b4imprint|custom ?ink|\bprint ?shop|\bprinting\b|\bcopy (center|shop)|copies`, category: 'supplies', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'postage', re: r`fedex|\bups\b ?(store|\*)|the ups store|\busps\b|u\.?s\.? postal|post office|stamps\.com|pitney|pirate ship|pirateship|shippo|\bdhl\b|shipstation|\bpak ?mail|mail boxes`, category: 'supplies', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'hardware-home', re: r`home depot|homedepot|lowe'?s|\blowes\b|ace hardware|true value|\bhardware\b|\blumber\b|\bpaint\b|sherwin|benjamin moore|\bgrainger|harbor freight|\bmcmaster|\bikea\b|bed bath|container store|\bwayfair|west elm|crate ?& ?barrel|\bcb2\b|pottery barn|\barticle\.com|\bfloyd\b home|home ?goods|homegoods|at home store|\bp\.?c\.? richard|\bkitchen supply|restaurant depot`, category: 'household', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'personal-care', re: r`barber|\bsalon\b|hair ?cut|haircut|\bsupercuts|\bnails?\b|\bspa\b|massage|\bwax(ing)?\b|european wax`, category: 'personal_care', klass: 'need', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'laundry-dollar-store', re: r`laundromat|laundry|wash ?& ?fold|dry ?clean|\bcleaners\b|csc service ?works|\bhercules\b laundry|\bwash ?club|\brinse\b|\bcleanly\b|\btailor|shoe repair|\blocksmith|dollar tree|dollar general|family dollar|99 ?cents?|\bjack'?s 99|five below|\bdaiso|\bminiso`, category: 'household', klass: 'need', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'big-box', re: r`\btarget\b|walmart|wal-?mart|wm supercenter|\bkmart|\bkohl'?s|\bcostco\.com`, category: 'shopping', klass: 'want', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'ebay', re: r`\bebay\b`, category: 'shopping', klass: 'want', purpose: 'personal', merchant: 'eBay', review: true, glyph: null },
  { id: 'marketplace', re: r`\bebay\b|\betsy\b|aliexpress|\btemu\b|\bshein\b|\bwish\.com|facebook marketplace|\bmercari|\bofferup|poshmark|\bdepop|\bgrailed|\bthe realreal|stockx|goat\.com`, category: 'shopping', klass: 'want', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'clothing', re: r`uniqlo|\bh&m\b|h ?& ?m\b|\bzara\b|\bgap\b|old navy|banana republic|j\.? ?crew|madewell|\bnike\b|adidas|foot ?locker|\bnew balance|\bvans\b|converse|\bmacy'?s|nordstrom|bloomingdale|saks|tj ?maxx|t\.?j\.? maxx|marshalls|burlington|century 21|\bross\b stores|primark|urban outfitters|anthropologie|\bmuji\b|\bcos\b store|\barket\b|aritzia|lululemon|patagonia|\brei\b|north face|\bl\.?l\.? ?bean|\buniqlo|levi'?s|american eagle|\baerie|abercrombie|hollister|forever 21|\basos\b|\bssense|\bend clothing|\bkith\b|\bbeacon'?s closet|\bbuffalo exchange|\bl train vintage|goodwill|salvation army|housing works`, category: 'shopping', klass: 'want', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'shopping', re: r`strand book|barnes ?& ?noble|barnesnoble|\bbn\.com|bookshop\.org|mcnally jackson|books are magic|greenlight books|\bbook ?culture|three lives|\bbookstore|\bbooks\b|sephora|\bulta\b|\blush\b|kiehl'?s|glossier|\baesop\b|\bbath ?& ?body|warby|\bbonobos|\ballbirds|\bcasper\b|\bapple store|\bpaypal ?\*|\bshop ?pay|\bsp ?\* |\bshopify`, category: 'shopping', klass: 'want', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'courses', re: r`tuition|\buniversity\b|\bcollege\b|\bcuny\b|\bsuny\b|\bnyu\b|columbia univ|the new school|\bberklee|juilliard|\bcoursera|\budemy|skillshare|\bedx\b|linkedin learning|pluralsight|brilliant\.org|khan academy|point blank music|mix with the masters|pure ?mix|\bpro mix academy|\bmixing ?light|\bpensado|\bproduce like a pro|\bnail the mix|\burm academy|\bdomestika|\bmaven\b|\btestprep|\bkaplan\b|princeton review|\bworkshop\b|\bseminar\b|\bcourse\b|\bcertification|\blicens(e|ing) fee|continuing ed`, category: 'education', klass: 'oneoff', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'lodging', re: r`marriott|hilton|hyatt|\bihg\b|holiday inn|hampton inn|courtyard by|residence inn|best western|\bmotel\b|\bhotel\b|\bhostel\b|airbnb|\bvrbo\b|booking\.com|hotels\.com|hoteltonight`, category: 'travel', klass: 'want', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'donation', re: r`\bgofundme|\bdonat|\bcharity|red cross|\bunicef|\baclu\b|planned parenthood fed|\bwnyc\b|\bnpr\b|wikimedia|\bpbs\b|\bchurch\b|\btemple\b|\bmosque\b|\btithe`, category: 'gifts', klass: 'want', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'government-fees', re: r`nyc ?gov|city of new york|nyc (dca|dcwp|dob|doh|clerk)|nys (dos|dol|ed)|ny dept of state|\bsec(retary)? of state|\bcounty clerk|\bcourt\b|\bpassport|\bus ?cis\b|\bnotary|\blegalzoom|registered agent|\bincfile|\bzenbusiness|business licen[cs]e|\bpermit\b|\bfiling fee`, category: 'other', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null },

  // generic words, weakest last
  { id: 'deli-bodega', re: r`\bdeli\b|delicatessen|\bbodega\b|deli ?& ?grocery|deli grocery|grocery ?& ?deli|gourmet deli|gourmet market|\bconvenience\b|\bconv\.? store|mini ?mart|mini ?market|minimarket|food ?mart|quick ?stop|\bstop ?(1|one)\b|smoke ?shop|\btobacco|\bvape\b|\bcandy\b|\blotto\b|\blottery\b|\bnews\b ?(corp|inc|shop)?$|\b24 ?(hr|hour)s?\b|\bfood corp\b|\bkiosk\b`, category: 'convenience', klass: 'game', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'cafe', re: r`coffee|\bcafe\b|\bcaf[eé]\b|caff[eè]|cafeteria|espresso|roaster|\btea\b|\bteahouse|bakery|bakeshop|\bbake shop|patisserie|p[aâ]tisserie|pasticceria|panader[ií]a|donut|doughnut|\bjuice\b|smoothie|creperie|cr[eê]perie|gelato|ice cream|\bfroyo|frozen yogurt`, category: 'cafe', klass: 'game', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'restaurant', re: r`restaurant|\brestaur|\bdiner\b|\bgrill\b|\bgrille\b|kitchen|bistro|brasserie|trattoria|osteria|ristorante|ramen|sushi|izakaya|noodle|dumpling|taqueria|\btacos?\b|burrito|burger|\bbbq\b|barbecue|bar-?b-?q|steakhouse|steak house|shawarma|falafel|\bhalal\b|\bwok\b|\bpho\b|\bpoke\b|\bthai\b|szechuan|sichuan|\bhunan\b|curry|tandoor|biryani|\bkebab|\bgyro|empanada|arepa|\bchicken\b|\bwings\b|sandwich|\bhero(es)?\b|\beatery\b|cantina|tavern|\bpub\b|\bbar\b|\bbar ?& ?grill|brewery|brewing|taproom|tap room|\blounge\b|food (court|hall|truck)|cuisine|buffet|\bcatering|\bfood cart|oyster|seafood|\bcrab\b|lobster|\bbrunch\b|\bbreakfast|\bluncheonette|\bchinese food|\bmexican\b|\bitalian\b|\bkorean\b|\bjapanese\b|\bindian\b|\bcaribbean|jerk (chicken|center)|soul food|\bsalad\b|\bsoup\b|\bcreamery\b|\btst ?\*|toast ?\*`, category: 'eating_out', klass: 'game', purpose: 'personal', merchant: null, review: false, glyph: null },
  { id: 'grocery', re: r`supermarket|super market|\bgrocer(y|ies)?\b|\bfoods\b|\bfood market|\bmarketplace\b|meat market|fish market|\bbutcher|\bproduce\b|\bfruit|\borganic|\bnatural foods|health food|\bfarm\b|\bmarket\b`, category: 'groceries', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'cheque-bill-pay', re: r`\bcheck ?#? ?\d+\b|^check\b|check paid|\bcheck_paid\b|\bbill ?pay(ment)?\b|\bbillpay\b`, category: 'other', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null },
  { id: 'processor', re: r`\bsq ?\*|\bgosq\.com|\bsquare\b|\bclover\b|\bsumup|\bzettle|\bstripe\b|\bpaypal\b|\bwpy ?\*|\bbt ?\*|\bin ?\*`, category: 'other', klass: 'need', purpose: 'personal', merchant: null, review: true, glyph: null },
];

/* ------------------------------------------------------ merchant category codes */

/** ISO 18245 merchant category code -> category key. Used when no merchant rule names a category. */
export const MCC = {
  // food and drink
  5812: 'eating_out', 5813: 'eating_out', 5814: 'eating_out', 5811: 'eating_out',
  5462: 'cafe',
  5499: 'convenience', 5441: 'convenience', 5993: 'convenience', 5994: 'convenience',
  5411: 'groceries', 5422: 'groceries', 5451: 'groceries', 5300: 'groceries',
  // getting around
  4111: 'transit', 4112: 'transit', 4131: 'transit', 4789: 'transit',
  4121: 'rideshare',
  4784: 'tolls_parking', 7523: 'tolls_parking',
  5541: 'fuel_auto', 5542: 'fuel_auto', 5533: 'fuel_auto', 7531: 'fuel_auto', 7534: 'fuel_auto',
  7538: 'fuel_auto', 7542: 'fuel_auto', 7549: 'fuel_auto', 7512: 'fuel_auto', 7513: 'fuel_auto',
  4511: 'travel', 4411: 'travel', 4722: 'travel', 7011: 'travel',
  // health and care
  5912: 'health', 5975: 'health', 5976: 'health', 8011: 'health', 8021: 'health', 8031: 'health',
  8041: 'health', 8042: 'health', 8043: 'health', 8049: 'health', 8050: 'health', 8062: 'health',
  8071: 'health', 8099: 'health', 7997: 'health',
  7230: 'personal_care', 7297: 'personal_care', 7298: 'personal_care', 5977: 'personal_care',
  // home
  5200: 'household', 5211: 'household', 5231: 'household', 5251: 'household', 5261: 'household',
  5712: 'household', 5719: 'household', 5722: 'household', 7210: 'household', 7211: 'household',
  7216: 'household',
  6513: 'housing', 4225: 'housing',
  4900: 'utilities',
  4812: 'phone_internet', 4814: 'phone_internet',
  4899: 'subscriptions', 5968: 'subscriptions',
  6300: 'insurance', 5960: 'insurance',
  // work
  5111: 'supplies', 5943: 'supplies', 5044: 'supplies', 7338: 'supplies', 4215: 'supplies', 9402: 'supplies',
  5045: 'gear', 5732: 'gear', 5733: 'gear', 5946: 'gear',
  5734: 'software', 5817: 'software', 7372: 'software',
  8211: 'education', 8220: 'education', 8241: 'education', 8244: 'education', 8249: 'education', 8299: 'education',
  // extras
  5310: 'shopping', 5311: 'shopping', 5331: 'shopping', 5399: 'shopping', 5611: 'shopping', 5621: 'shopping',
  5631: 'shopping', 5641: 'shopping', 5651: 'shopping', 5655: 'shopping', 5661: 'shopping', 5691: 'shopping',
  5699: 'shopping', 5941: 'shopping', 5942: 'shopping', 5944: 'shopping', 5945: 'shopping', 5948: 'shopping',
  5949: 'shopping', 5964: 'shopping', 5965: 'shopping', 5969: 'shopping', 5192: 'shopping', 5999: 'shopping',
  5735: 'entertainment', 5815: 'entertainment', 5816: 'entertainment', 5818: 'entertainment',
  5921: 'entertainment', 7832: 'entertainment', 7841: 'entertainment', 7922: 'entertainment',
  7929: 'entertainment', 7932: 'entertainment', 7933: 'entertainment', 7941: 'entertainment',
  7991: 'entertainment', 7993: 'entertainment', 7994: 'entertainment', 7996: 'entertainment',
  7998: 'entertainment', 7999: 'entertainment',
  5947: 'gifts', 5992: 'gifts', 8398: 'gifts', 8661: 'gifts',
  // money
  6010: 'cash_withdrawal', 6011: 'cash_withdrawal',
  9311: 'taxes',
};

/** Code ranges the card networks reserve for individual airlines, car-rental firms and hotels: [first, last, category]. */
export const MCC_RANGES = [
  [3000, 3350, 'travel'],
  [3351, 3500, 'fuel_auto'],
  [3501, 3999, 'travel'],
];

/* ---------------------------------------------------------------- account names */

/**
 * Words in an account's name that give away its type, strongest first: the first pattern that
 * matches wins. Plain deposit words outrank card brands ("Discover Online Savings" is savings),
 * and card product names outrank the weak savings word "reserve" ("Sapphire Reserve" is a card).
 */
export const ACCOUNT_TYPE_HINTS = [
  ['investment', r`brokerage|invest|\bira\b|\b401|\b403|roth|retirement|\b529\b|mutual fund|securities`],
  ['loan', r`\bloan\b|mortgage|line of credit|\bheloc\b`],
  ['checking', r`checking|\bchk\b|\bspending\b|\bdebit\b|cash management|share draft`],
  ['savings', r`saving|money market|\bmma\b|\bmmkt\b|\bcd\b|certificate of deposit|\bhysa\b`],
  ['credit_card', r`\bcard\b|credit|visa|master ?card|\bamex\b|american express|discover|rewards?\b|cash ?back|quicksilver|savor|venture|sapphire|freedom|\bslate\b|double cash|custom cash|blue cash|platinum|\bgold\b|\bprime\b|\bbilt\b|\bink\b|\bspark\b|skymiles|bonvoy|aadvantage|mileageplus|active cash|autograph|unlimited|world elite|signature|\bcc\b`],
  ['loan', r`\bauto\b|student|\bvehicle\b|financing|installment`],
  ['savings', r`reserve|emergency|rainy day`],
];
