import { z } from 'zod';
import { NormalizedTransactionSchema } from './transaction.js';
import { NormalizedInvoiceSchema } from './invoice.js';

export const MatchStatusSchema = z.enum(['MATCHED', 'REVIEW_NEEDED', 'UNMATCHED']);
export type MatchStatus = z.infer<typeof MatchStatusSchema>;

export const MatchLevelSchema = z.enum([
  'EXACT_REFERENCE',
  'EXACT_METRICS',
  'FUZZY_REFERENCE',
  'FEE_TOLERANCE',
  'NONE',
]);
export type MatchLevel = z.infer<typeof MatchLevelSchema>;

export const MatchResultSchema = z.object({
  status: MatchStatusSchema,
  level: MatchLevelSchema,
  confidenceScore: z.number().min(0).max(1),
  transaction: NormalizedTransactionSchema,
  invoice: NormalizedInvoiceSchema.optional(),
  discrepancies: z.array(z.string()).default([]),
  applied: z.boolean().default(false).describe('Whether the invoice was marked paid in the external system'),
});

export type MatchResult = z.infer<typeof MatchResultSchema>;

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
    totalMatchedCents: z.number().int().nonnegative(),
    currency: z.string(),
  }),
  matches: z.array(MatchResultSchema),
  unmatchedInvoices: z.array(NormalizedInvoiceSchema),
});

export type ReconciliationReport = z.infer<typeof ReconciliationReportSchema>;
