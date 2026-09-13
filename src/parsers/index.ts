import { z } from 'zod';
import type { ParseOptions, StatementParser } from './base.js';
import { detectFormat, getParserById, BUILTIN_PARSERS } from './detector.js';
import { NormalizedTransactionSchema, type NormalizedTransaction } from '../schemas/transaction.js';

export * from './base.js';
export * from './detector.js';
export * from './csv/revolut.js';
export * from './csv/stripe.js';
export * from './xml/camt053.js';
export * from './swift/mt940.js';
export * from './csv/generic.js';

export interface RejectedRow {
  index: number;
  raw: unknown;
  error: z.ZodError;
}

export const RejectedRowSchema = z.object({
  index: z.number().int().nonnegative(),
  raw: z.unknown(),
  error: z.instanceof(z.ZodError),
});

export interface ParseStatementResult {
  parserId: string;
  parserName: string;
  transactions: NormalizedTransaction[];
  rejectedRows: RejectedRow[];
}

export const ParseStatementResultSchema = z.object({
  parserId: z.string(),
  parserName: z.string(),
  transactions: z.array(NormalizedTransactionSchema),
  rejectedRows: z.array(RejectedRowSchema),
});

/**
 * Universal statement parsing function:
 * Automatically detects the format (or uses provided options.format),
 * parses all transactions, and validates them against the NormalizedTransaction Zod schema.
 */
export async function parseStatement(
  content: string,
  options?: ParseOptions
): Promise<ParseStatementResult> {
  let parser: StatementParser | undefined;

  if (options?.format) {
    parser = getParserById(options.format);
    if (!parser) {
      const available = BUILTIN_PARSERS.map((p) => p.id).join(', ');
      throw new Error(
        `Unknown format '${options.format}'. Available formats: ${available}`
      );
    }
  } else {
    parser = detectFormat(content);
  }

  const rawTransactions = await parser.parse(content, options);

  // Validate every transaction with Zod and quarantine invalid rows
  const transactions: NormalizedTransaction[] = [];
  const rejectedRows: RejectedRow[] = [];

  for (let i = 0; i < rawTransactions.length; i++) {
    const raw = rawTransactions[i];
    const parseRes = NormalizedTransactionSchema.safeParse(raw);
    if (parseRes.success) {
      transactions.push(parseRes.data);
    } else {
      rejectedRows.push({
        index: i,
        raw,
        error: parseRes.error,
      });
    }
  }

  return {
    parserId: parser.id,
    parserName: parser.name,
    transactions,
    rejectedRows,
  };
}
