/**
 * Cash flow: whether a transaction is money that actually left the owner, money that actually reached
 * them, or neither yet. The views colour a transaction's amount by it (red out, green in, ink otherwise).
 *
 *   cashFlowOf(tx, accountOf, pairOf)   'out' | 'in' | null
 *   payFlowOf(status)                   'out' | null, for a row of the payments to make
 *
 * 'out' (money left): an outflow from a cash account (checking, savings, cash) or from no known account:
 *   a purchase, a Zelle or wallet payment sent, a fee, a bank transfer to someone (a transfer with no
 *   other leg on the record); and a payment to a card or a loan, on both legs (from cash, and as it lands
 *   on the card or the loan).
 * 'in' (money arrived): income into any account (pay, a Zelle received, interest, dividends) and a refund
 *   into a cash account (or no known account).
 * null (no money has moved yet, or it stayed the owner's): a charge on a card or a loan, a refund or
 *   credit onto a card, a transfer between two of the owner's accounts that is not a card or loan payment,
 *   a money move inside an investment account, an incoming transfer that is not income, a decline.
 *
 * A pending row and a move the owner typed in follow the same rule. Pure: reads nothing but its arguments.
 */

import { ACCOUNT_TYPES } from './schema.js';

/** 'cash' | 'card' | 'asset' | 'debt', or null for no known account (treated as cash). */
function groupOf(account) {
  if (!account || !ACCOUNT_TYPES[account.type]) return null;
  return ACCOUNT_TYPES[account.type].group;
}

function cashSide(group) {
  return group === null || group === 'cash';
}

function debtSide(group) {
  return group === 'card' || group === 'debt';
}

/**
 * @param {object} tx                                   a transaction of the document
 * @param {(id: string) => object|null} [accountOf]     an account by id
 * @param {(id: string) => object|null} [pairOf]        a transaction by id (the other leg of a pair)
 * @returns {'out'|'in'|null}
 */
export function cashFlowOf(tx, accountOf, pairOf) {
  if (!tx || tx.kind === 'decline' || !(tx.amount > 0)) return null;
  const lookup = typeof accountOf === 'function' ? accountOf : () => null;
  const group = groupOf(tx.accountId ? lookup(tx.accountId) : null);
  const out = tx.flow === 'out';
  const into = tx.flow === 'in';
  switch (tx.kind) {
    case 'spend':
      return out && cashSide(group) ? 'out' : null;
    case 'income':
      return into ? 'in' : null;
    case 'refund':
      return into && cashSide(group) ? 'in' : null;
    case 'payment':
      return (out && cashSide(group)) || (into && debtSide(group)) ? 'out' : null;
    case 'transfer': {
      // landing on a card or a loan, it pays it down: money the owner paid
      if (into && debtSide(group)) return 'out';
      if (!out || !cashSide(group)) return null;
      if (!tx.pairId) return 'out'; // to someone, or to an account not on the record
      const pair = typeof pairOf === 'function' ? pairOf(tx.pairId) : null;
      const pairGroup = pair && pair.accountId ? groupOf(lookup(pair.accountId)) : null;
      return debtSide(pairGroup) ? 'out' : null; // to a card or loan: a payment; else between own accounts
    }
    default:
      return null;
  }
}

/**
 * The same rule for a row of the payments the owner sends (byhand.byHandMonth): paid at the bank, pending
 * at the bank or ticked as sent is money that left ('out'); due or overdue has not left yet (null).
 * @param {string} status  'bank' | 'pending' | 'hand' | 'due' | 'overdue'
 * @returns {'out'|null}
 */
export function payFlowOf(status) {
  return status === 'bank' || status === 'pending' || status === 'hand' ? 'out' : null;
}
