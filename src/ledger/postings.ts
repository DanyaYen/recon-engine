import { z } from 'zod';
import type { MatchResult } from '../schemas/reconciliation.js';

export const PostingDirectionSchema = z.enum(['DEBIT', 'CREDIT']);
export type PostingDirection = z.infer<typeof PostingDirectionSchema>;

export const PostingSchema = z.object({
  accountId: z.string(),
  direction: PostingDirectionSchema,
  amountCents: z.number().int().nonnegative(),
  currency: z.string(),
});
export type Posting = z.infer<typeof PostingSchema>;

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
export function validatePostingsBalance(postings: Posting[]): boolean {
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
