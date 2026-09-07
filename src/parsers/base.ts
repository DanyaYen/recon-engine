import type { NormalizedTransaction } from '../schemas/transaction.js';

export interface ParseOptions {
  format?: string;
  columnMapping?: Record<string, string>;
  defaultCurrency?: string;
}

export interface StatementParser {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  supports(content: string, filename?: string): boolean;
  parse(content: string, options?: ParseOptions): Promise<NormalizedTransaction[]>;
}
