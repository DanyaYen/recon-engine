import { z } from 'zod';
import type { MatchResult } from '../schemas/reconciliation.js';

export const PostingDirectionSchema = z.enum(['DEBIT', 'CREDIT']);
export type PostingDirection = z.infer<typeof PostingDirectionSchema>;

export interface PostingLine {
  accountId: string;
  direction: 'DEBIT' | 'CREDIT';
  amountCents: number;
  currency: string;
}

export const PostingLineSchema = z.object({
  accountId: z.string(),
  direction: PostingDirectionSchema,
  amountCents: z.number().int().nonnegative(),
  currency: z.string(),
});

// Alias for backwards compatibility
export const PostingSchema = PostingLineSchema;
export type Posting = PostingLine;

export interface LedgerTransaction {
  id: string; // deterministic from match
  postedAt: string;
  lines: PostingLine[];
}

export const LedgerTransactionSchema = z.object({
  id: z.string(),
  postedAt: z.string(),
  lines: z.array(PostingLineSchema),
});

export const ReconciliationAccountsSchema = z.object({
  bank: z.string(),
  suspense: z.string(),
  ar: z.string(),
  feeExpense: z.string(),
});
export type ReconciliationAccounts = z.infer<typeof ReconciliationAccountsSchema>;

export const LedgerConfigSchema = z.object({
  bankAccountId: z.string(),
  arAccountId: z.string(),
  feeAccountId: z.string(),
});
export type LedgerConfig = z.infer<typeof LedgerConfigSchema>;

/**
 * Validates that double-entry balance is conserved across postings.
 * Ensures sum(DEBITS) === sum(CREDITS) per currency.
 */
export function validatePostingsBalance(postings: PostingLine[]): boolean {
  const currencies = new Set(postings.map((p) => p.currency));
  for (const currency of currencies) {
    const currencyPostings = postings.filter((p) => p.currency === currency);
    const totalDebits = currencyPostings
      .filter((p) => p.direction === 'DEBIT')
      .reduce((sum, p) => sum + p.amountCents, 0);
    const totalCredits = currencyPostings
      .filter((p) => p.direction === 'CREDIT')
      .reduce((sum, p) => sum + p.amountCents, 0);
    if (totalDebits !== totalCredits) {
      return false;
    }
  }
  return true;
}

/**
 * Validates that a single ledger transaction satisfies the double-entry invariant:
 * sum(DEBITS) === sum(CREDITS) for each currency.
 */
export function validateTransactionBalance(transaction: LedgerTransaction): boolean {
  return validatePostingsBalance(transaction.lines);
}

/**
 * Converts a reconciliation MatchResult into balanced double-entry ledger postings.
 *
 * Invariant: sum(DEBITS) === sum(CREDITS)
 *
 * Rules:
 * - If unmatched or without invoice: returns []
 * - Standard match (no fee):
 *   - Debit Bank Account (net amount)
 *   - Credit Accounts Receivable (gross invoice amount)
 * - Fee match (fee exists):
 *   - Debit Bank Account (net amount)
 *   - Debit Fee Expense Account (fee amount)
 *   - Credit Accounts Receivable (gross invoice amount = net + fee)
 */
export function matchToPostings(
  match: MatchResult,
  config: { bankAccountId: string; arAccountId: string; feeAccountId: string }
): Posting[] {
  if (match.status === 'UNMATCHED' || !match.invoice) {
    return [];
  }

  const currency = match.transaction.currency;
  const netAmount = match.transaction.amountCents;
  const feeAmount = match.inferredFeeCents ?? match.feeDeductionCents ?? 0;
  const grossAmount = netAmount + feeAmount;

  if (grossAmount === 0) {
    return [];
  }

  const postings: Posting[] = [
    {
      accountId: config.bankAccountId,
      direction: 'DEBIT',
      amountCents: netAmount,
      currency,
    },
  ];

  if (feeAmount > 0) {
    postings.push({
      accountId: config.feeAccountId,
      direction: 'DEBIT',
      amountCents: feeAmount,
      currency,
    });
  }

  postings.push({
    accountId: config.arAccountId,
    direction: 'CREDIT',
    amountCents: grossAmount,
    currency,
  });

  // Strict invariant enforcement: sum(DEBITS) === sum(CREDITS)
  if (!validatePostingsBalance(postings)) {
    const totalDebits = postings
      .filter((p) => p.direction === 'DEBIT')
      .reduce((sum, p) => sum + p.amountCents, 0);
    const totalCredits = postings
      .filter((p) => p.direction === 'CREDIT')
      .reduce((sum, p) => sum + p.amountCents, 0);
    throw new Error(
      `Double-entry invariant violated: sum(DEBITS) (${totalDebits}) !== sum(CREDITS) (${totalCredits})`
    );
  }

  return postings;
}

/**
 * Batch converts multiple reconciliation matches into balanced ledger postings.
 */
export function matchesToPostings(
  matches: MatchResult[],
  config: { bankAccountId: string; arAccountId: string; feeAccountId: string }
): Posting[] {
  const allPostings = matches.flatMap((m) => matchToPostings(m, config));
  if (!validatePostingsBalance(allPostings)) {
    throw new Error('Double-entry invariant violated across batch matches');
  }
  return allPostings;
}

/**
 * Creates balanced double-entry accounting postings using a clearing suspense account.
 *
 * Events:
 * - Event 1 (Bank Clearing): Debit Bank Account, Credit Unallocated Suspense Account (`match.tx.amountCents`).
 * - Event 2 (Invoice Settlement): Debit Unallocated Suspense Account (`match.invoice.amountCents - fee`),
 *   Debit Fee Expense Account (if fee exists), Credit Accounts Receivable (`match.invoice.amountCents`).
 *
 * Invariant: For every transaction, sum(DEBIT) === sum(CREDIT).
 */
export function createReconciliationPostings(
  match: MatchResult,
  accounts: { bank: string; suspense: string; ar: string; feeExpense: string }
): LedgerTransaction[] {
  const tx = (match as any).tx ?? match.transaction;
  const inv = (match as any).inv ?? match.invoice;

  if (!tx || !inv || match.status === 'UNMATCHED') {
    return [];
  }

  const bankAccount = accounts.bank || (accounts as any).bankAccountId;
  const suspenseAccount = accounts.suspense || (accounts as any).suspenseAccountId;
  const arAccount = accounts.ar || (accounts as any).arAccountId;
  const feeExpenseAccount =
    accounts.feeExpense || (accounts as any).feeAccountId || (accounts as any).feeExpenseAccountId;

  const currency = tx.currency || inv.currency;
  const postedAt = tx.bookingDate || inv.issueDate || new Date().toISOString().split('T')[0];
  const fee = match.inferredFeeCents ?? match.feeDeductionCents ?? 0;
  const txAmount = tx.amountCents;
  const invAmount = inv.amountCents;

  // Event 1 (Bank Clearing):
  // Debit Bank Account, Credit Unallocated Suspense Account (match.tx.amountCents)
  const event1Lines: PostingLine[] = [
    {
      accountId: bankAccount,
      direction: 'DEBIT',
      amountCents: txAmount,
      currency,
    },
    {
      accountId: suspenseAccount,
      direction: 'CREDIT',
      amountCents: txAmount,
      currency,
    },
  ];

  const event1: LedgerTransaction = {
    id: `${tx.id}-clearing`,
    postedAt,
    lines: event1Lines,
  };

  // Event 2 (Invoice Settlement):
  // Debit Unallocated Suspense Account (match.invoice.amountCents - fee),
  // Debit Fee Expense Account (if fee exists),
  // Credit Accounts Receivable (match.invoice.amountCents)
  const suspenseDebitAmount = invAmount - fee;
  const event2Lines: PostingLine[] = [
    {
      accountId: suspenseAccount,
      direction: 'DEBIT',
      amountCents: suspenseDebitAmount,
      currency,
    },
  ];

  if (fee > 0) {
    event2Lines.push({
      accountId: feeExpenseAccount,
      direction: 'DEBIT',
      amountCents: fee,
      currency,
    });
  }

  event2Lines.push({
    accountId: arAccount,
    direction: 'CREDIT',
    amountCents: invAmount,
    currency,
  });

  const event2: LedgerTransaction = {
    id: `${tx.id}-settlement`,
    postedAt,
    lines: event2Lines,
  };

  const transactions = [event1, event2];

  // Invariant verification: sum(DEBIT) === sum(CREDIT) for every transaction
  for (const t of transactions) {
    if (!validateTransactionBalance(t)) {
      const totalDebits = t.lines
        .filter((l) => l.direction === 'DEBIT')
        .reduce((sum, l) => sum + l.amountCents, 0);
      const totalCredits = t.lines
        .filter((l) => l.direction === 'CREDIT')
        .reduce((sum, l) => sum + l.amountCents, 0);
      throw new Error(
        `Double-entry invariant violated for transaction ${t.id}: sum(DEBIT) (${totalDebits}) !== sum(CREDIT) (${totalCredits})`
      );
    }
  }

  return transactions;
}
