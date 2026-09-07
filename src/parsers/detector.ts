import type { StatementParser } from './base.js';
import { Camt053Parser } from './xml/camt053.js';
import { Mt940Parser } from './swift/mt940.js';
import { StripeCsvParser } from './csv/stripe.js';
import { RevolutCsvParser } from './csv/revolut.js';
import { GenericCsvParser } from './csv/generic.js';

export const BUILTIN_PARSERS: StatementParser[] = [
  new Camt053Parser(),
  new Mt940Parser(),
  new StripeCsvParser(),
  new RevolutCsvParser(),
  new GenericCsvParser(),
];

/**
 * Detects the most appropriate statement parser based on content inspection.
 */
export function detectFormat(content: string, filename?: string): StatementParser {
  // Check in priority order: structured formats first, then specific CSVs, then generic
  for (const parser of BUILTIN_PARSERS) {
    if (parser.supports(content, filename)) {
      return parser;
    }
  }

  throw new Error(
    'Unable to auto-detect statement format. Specify explicitly with --format <camt053|mt940|revolut-csv|stripe-csv|generic-csv>'
  );
}

export function getParserById(id: string): StatementParser | undefined {
  const normalizedId = id.toLowerCase().trim();
  return BUILTIN_PARSERS.find(
    (p) =>
      p.id.toLowerCase() === normalizedId ||
      p.id.replace(/-/g, '') === normalizedId.replace(/-/g, '')
  );
}
