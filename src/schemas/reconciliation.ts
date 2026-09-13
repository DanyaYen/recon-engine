import { z } from 'zod';
import { NormalizedTransactionSchema } from './transaction.js';
import { NormalizedInvoiceSchema } from './invoice.js';

export const MatchStatusSchema = z.enum([
  'EXACT_MATCH',
  'FUZZY_MATCH',
  'PARTIAL_MATCH',
  'UNMATCHED',
  'MATCHED',
  'REVIEW_NEEDED',
]);
export type MatchStatus = z.infer<typeof MatchStatusSchema>;

export const MatchLevelSchema = z.enum([
  'EXACT_REFERENCE',
  'EXACT_METRICS',
  'FUZZY_REFERENCE',
  'FEE_TOLERANCE',
  'PARTIAL_MATCH',
  'NONE',
]);
export type MatchLevel = z.infer<typeof MatchLevelSchema>;

export const MatchResultSchema = z.object({
  status: MatchStatusSchema,
  level: MatchLevelSchema,
  confidenceScore: z.number().min(0).max(1),
  feeDeductionCents: z.number().int().nonnegative().optional().describe('Deducted bank wire fee in minor units'),
  inferredFeeCents: z.number().int().nonnegative().optional().describe('Inferred processing/gateway fee in minor units (invoice - tx)'),
  matchedCents: z.number().int().nonnegative().optional().describe('Matched transaction/invoice amount in minor units'),
  remainingCents: z.number().int().nonnegative().optional().describe('Remaining unpaid invoice amount in minor units (invoice.amountCents - transaction.amountCents)'),
  transaction: NormalizedTransactionSchema,
  invoice: NormalizedInvoiceSchema.optional(),
  discrepancies: z.array(z.string()).default([]),
  applied: z.boolean().default(false).describe('Whether the invoice was marked paid in the external system'),
  requiresForce: z.boolean().optional().describe('Whether confirming this match with --yes requires explicit --force'),
});

export type MatchResult = z.infer<typeof MatchResultSchema>;

export const MatcherOptionsSchema = z.object({
  dateToleranceDays: z.number().nonnegative().optional(),
  feeToleranceCents: z.number().int().nonnegative().optional(),
  feeTolerancePercent: z.number().min(0).max(1).optional(),
  feeTolerancePercentage: z.number().min(0).max(1).optional(),
  statementFile: z.string().optional(),
  sourceFormat: z.string().optional(),
});

export type MatcherOptions = z.infer<typeof MatcherOptionsSchema>;

export const CurrencyTotalSchema = z.object({
  matchedCents: z.number(),
  unmatchedCents: z.number(),
  feeCents: z.number(),
});
export type CurrencyTotal = z.infer<typeof CurrencyTotalSchema>;

export const ReconciliationReportSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  statementFile: z.string(),
  sourceFormat: z.string(),
  summary: z.object({
    totalTransactions: z.number().int().nonnegative(),
    totalInvoices: z.number().int().nonnegative(),
    matchedCount: z.number().int().nonnegative(),
    reviewNeededCount: z.number().int().nonnegative(),
    unmatchedCount: z.number().int().nonnegative(),
    /** @deprecated Use totalsByCurrency instead */
    totalMatchedCents: z.number().optional(),
    /** @deprecated Use totalsByCurrency instead */
    currency: z.string().optional(),
    totalsByCurrency: z.record(
      z.string(),
      z.object({
        matchedCents: z.number(),
        unmatchedCents: z.number(),
        feeCents: z.number(),
      })
    ),
  }),
  matches: z.array(MatchResultSchema),
  unmatchedInvoices: z.array(NormalizedInvoiceSchema),
  skippedInvoices: z.array(NormalizedInvoiceSchema).optional(),
});

export type ReconciliationReport = z.infer<typeof ReconciliationReportSchema>;
