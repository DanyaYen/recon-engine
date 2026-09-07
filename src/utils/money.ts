/**
 * Utilities for precise financial amount and currency calculations.
 * Always operates on integer minor units (cents) to avoid IEEE 754 floating point issues.
 */

export interface ParsedAmount {
  amountCents: number;
  direction: 'INCOMING' | 'OUTGOING';
}

/**
 * Parses any amount string or number into minor units (integer cents).
 * Handles:
 * - English format: "1,234.56", "-12.50", "+500"
 * - European format: "1.234,56", "-12,50"
 * - Currency symbols: "€ 1,234.56", "$50.00", "50.00 EUR"
 * - Explicit direction overrides (e.g. CRDT/DBIT in CAMT/MT940)
 */
export function parseAmountToCents(
  rawAmount: string | number,
  forcedDirection?: 'INCOMING' | 'OUTGOING'
): ParsedAmount {
  if (typeof rawAmount === 'number') {
    const isNegative = rawAmount < 0;
    const absCents = Math.round(Math.abs(rawAmount) * 100);
    const direction = forcedDirection ?? (isNegative ? 'OUTGOING' : 'INCOMING');
    return { amountCents: absCents, direction };
  }

  let cleaned = rawAmount.trim();

  // Check for negative signs or accounting brackets like (100.00) or $ -25.50 or -$25.50
  let isNegative = false;
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    isNegative = true;
    cleaned = cleaned.slice(1, -1).trim();
  } else if (cleaned.includes('-')) {
    isNegative = true;
  }

  // Strip currency symbols and letters (e.g. EUR, USD, €, $, £)
  cleaned = cleaned.replace(/[^\d.,]/g, '').trim();

  if (!cleaned) {
    return { amountCents: 0, direction: forcedDirection ?? 'INCOMING' };
  }

  // Detect decimal separator:
  // If there is both '.' and ',', the last one is the decimal separator.
  // E.g., "1.234,56" -> comma is decimal. "1,234.56" -> dot is decimal.
  // If only ',' is present: if followed by 2 digits at the end (e.g. "12,50"), it's decimal.
  let normalizedStr = cleaned;
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');

  if (lastDot !== -1 && lastComma !== -1) {
    if (lastComma > lastDot) {
      // European: 1.234,56 -> remove dots, replace comma with dot
      normalizedStr = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      // US/UK: 1,234.56 -> remove commas
      normalizedStr = cleaned.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    // Only comma
    const parts = cleaned.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      // Decimal comma: "1250,50" -> "1250.50"
      normalizedStr = cleaned.replace(',', '.');
    } else {
      // Thousands separator: "1,000,000"
      normalizedStr = cleaned.replace(/,/g, '');
    }
  } else if (lastDot !== -1) {
    // Only dot
    const parts = cleaned.split('.');
    if (parts.length > 2) {
      // Multiple dots: "1.000.000" -> thousands separator
      normalizedStr = cleaned.replace(/\./g, '');
    }
    // Else single dot: standard decimal "1250.50"
  }

  const floatVal = parseFloat(normalizedStr);
  if (isNaN(floatVal)) {
    return { amountCents: 0, direction: forcedDirection ?? 'INCOMING' };
  }

  const amountCents = Math.round(Math.abs(floatVal) * 100);
  const direction = forcedDirection ?? (isNegative ? 'OUTGOING' : 'INCOMING');

  return { amountCents, direction };
}

/**
 * Format integer cents into a standard currency string (e.g. "1,250.50 EUR").
 */
export function formatCents(cents: number, currency = 'EUR'): string {
  const units = (cents / 100).toFixed(2);
  const parts = units.split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${intPart}.${parts[1]} ${currency.toUpperCase()}`;
}
