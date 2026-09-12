/**
 * Utilities for remittance information cleaning, legal entity stripping,
 * and invoice reference token extraction.
 */

const LEGAL_SUFFIXES = [
  'gmbh',
  'ug',
  'ag',
  'llc',
  'ltd',
  'limited',
  'inc',
  'corp',
  'corporation',
  'sas',
  'sarl',
  'bv',
  'nv',
  'sp z o o',
  'spzoo',
  'sa',
  'plc',
  'co',
  'cie',
];

export const STOP_WORDS = [
  'eref',
  'svwz',
  'kref',
  'mref',
  'iban',
  'bic',
  'inv',
  'rech',
  'rechnung',
  'rechnungsnr',
  'rechnungsnummer',
  'rechnung-nr',
  'invoice',
  'bill',
  'payment',
  'zahlung',
  'ueberweisung',
  'überweisung',
  'sepa',
  'sepa-ueberweisung',
  'credit',
  'transfer',
  'wire',
  'ref',
  'reference',
  'kdnr',
  'kundennummer',
  'from',
  'to',
  'fuer',
  'für',
];

const LEGAL_SUFFIXES_REGEX = new RegExp(
  `\\b(?:${LEGAL_SUFFIXES.map((s) => s.replace(/ /g, '\\s+')).join('|')})\\b`,
  'gi'
);

/**
 * Normalizes a company or counterparty name by lowercasing,
 * removing punctuation, and stripping common legal corporate forms.
 */
export function cleanCompanyName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, ' ')
    .replace(LEGAL_SUFFIXES_REGEX, ' ');

  return cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * Strips static invoice prefixes (INV-, INV/, INV-2024-, RECH-, RE-, PO-, BILL-, etc.)
 * to isolate the unique numeric or alphanumeric invoice identifier.
 */
export function stripInvoicePrefix(token: string): string {
  if (!token) return '';
  return token
    .replace(/^#+/, '')
    .replace(/^(?:inv|rech|rechnung|re|bill|po|order|invnr)[-_/#\s]*(?:202[0-9][-_/#\s]*)?/i, '')
    .replace(/^202[0-9][-_/#\s]*/i, '')
    .replace(/^[-_/#\s]+/, '')
    .trim();
}

/**
 * Extracts potential invoice reference identifiers from unstructured remittance text.
 * Matches patterns like:
 * - "INV-2024-001"
 * - "INV/2024/099"
 * - "#12345"
 * - "RE-98765"
 * - "2024-1002"
 */
export function extractInvoiceCandidates(text: string): string[] {
  if (!text) return [];

  const candidates = new Set<string>();

  // Pattern 1: Alphanumeric codes with prefixes like INV-1234, RE-2024-001, #9982, PO-123
  const prefixRegex = /\b(?:inv|re|rech|bill|po|order|invnr)[-_/#\s]*([a-z0-9-_/]{3,30})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = prefixRegex.exec(text)) !== null) {
    if (match[1] && match[1].length >= 3) {
      candidates.add(match[1].replace(/[\s/]/g, '-').toUpperCase());
      candidates.add(match[0].replace(/[\s/]/g, '-').toUpperCase());
      const isolated = stripInvoicePrefix(match[0]);
      if (isolated && isolated.length >= 2) {
        candidates.add(isolated.toUpperCase());
      }
    }
  }

  // Pattern 2: Hash prefixed identifiers: #12345, #INV-900
  const hashRegex = /#([a-z0-9-_]{3,25})/gi;
  while ((match = hashRegex.exec(text)) !== null) {
    candidates.add(match[1].toUpperCase());
    const isolated = stripInvoicePrefix(match[1]);
    if (isolated && isolated.length >= 2) {
      candidates.add(isolated.toUpperCase());
    }
  }

  // Pattern 3: Common invoice number shapes like 2024-0012, 2024/0012, 1000293
  const numberRegex = /\b(202[0-9][-/_][0-9]{3,8})\b/g;
  while ((match = numberRegex.exec(text)) !== null) {
    candidates.add(match[1].replace(/[/_]/g, '-'));
    const isolated = stripInvoicePrefix(match[1]);
    if (isolated && isolated.length >= 2) {
      candidates.add(isolated.toUpperCase());
    }
  }

  return Array.from(candidates);
}

const STOP_WORDS_REGEX = new RegExp(
  `\\b(?:${STOP_WORDS.map((w) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\b`,
  'gi'
);

/**
 * Cleans remittance text for fuzzy similarity comparison.
 * Strips ISO/SWIFT tags (EREF+, SVWZ+, /EREF/, etc.), banking stop-words, and legal entity forms.
 */
export function normalizeRemittance(text: string): string {
  if (!text) return '';

  return text
    .replace(/\b(eref|svwz|kref|mref|pref|cred|debt)\+/gi, ' ')
    .replace(/\/(eref|svwz|kref|mref|benm|iban|bic)\//gi, ' ')
    .replace(/\?[0-9]{2}/g, ' ')
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()\\+?<>]/g, ' ')
    .replace(STOP_WORDS_REGEX, ' ')
    .replace(LEGAL_SUFFIXES_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
