/**
 * Utilities for precise financial amount and currency calculations.
 * Always operates on integer minor units (cents) to avoid IEEE 754 floating point issues.
 */

export class InvalidAmountError extends Error {
  public readonly rawAmount: unknown;

  constructor(rawAmount: unknown, message?: string) {
    super(message ?? `Invalid amount: ${JSON.stringify(rawAmount)}`);
    this.name = 'InvalidAmountError';
    this.rawAmount = rawAmount;
    Object.setPrototypeOf(this, InvalidAmountError.prototype);
  }
}

export class AmbiguousAmountError extends Error {
  public readonly rawAmount: unknown;

  constructor(rawAmount: unknown, message?: string) {
    super(message ?? `Ambiguous amount format: ${JSON.stringify(rawAmount)}`);
    this.name = 'AmbiguousAmountError';
    this.rawAmount = rawAmount;
    Object.setPrototypeOf(this, AmbiguousAmountError.prototype);
  }
}

export interface ParseAmountOptions {
  forcedDirection?: 'INCOMING' | 'OUTGOING';
  thousandsSeparator?: string;
}

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
  forcedDirectionOrOptions?: 'INCOMING' | 'OUTGOING' | ParseAmountOptions,
  options?: ParseAmountOptions
): ParsedAmount {
  let forcedDirection: 'INCOMING' | 'OUTGOING' | undefined;
  let opts: ParseAmountOptions | undefined;

  if (typeof forcedDirectionOrOptions === 'string') {
    forcedDirection = forcedDirectionOrOptions;
    opts = options;
  } else if (forcedDirectionOrOptions && typeof forcedDirectionOrOptions === 'object') {
    opts = forcedDirectionOrOptions;
    forcedDirection = opts.forcedDirection;
  }

  if (rawAmount === null || rawAmount === undefined) {
    throw new InvalidAmountError(rawAmount, 'Amount is missing (null or undefined)');
  }

  let isNegative = false;
  let cleaned = '';

  if (typeof rawAmount === 'number') {
    if (isNaN(rawAmount) || !Number.isFinite(rawAmount)) {
      throw new InvalidAmountError(rawAmount, `Invalid numeric amount: ${rawAmount}`);
    }
    isNegative = rawAmount < 0;
    cleaned = Math.abs(rawAmount).toString();
  } else if (typeof rawAmount === 'string') {
    const rawTrimmed = rawAmount.trim();
    if (!rawTrimmed) {
      throw new InvalidAmountError(rawAmount, 'Amount string is empty');
    }

    // Must contain at least one digit
    if (!/\d/.test(rawTrimmed)) {
      throw new InvalidAmountError(rawAmount, `No digits found in amount: "${rawAmount}"`);
    }

    cleaned = rawTrimmed;

    // Check for negative signs or accounting brackets like (100.00) or $ -25.50 or -$25.50
    if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
      isNegative = true;
      cleaned = cleaned.slice(1, -1).trim();
    } else if (cleaned.includes('-')) {
      isNegative = true;
      cleaned = cleaned.replace(/-/g, '').trim();
    } else if (cleaned.startsWith('+')) {
      cleaned = cleaned.slice(1).trim();
    }

    // Strip currency symbols and letters (e.g. EUR, USD, €, $, £)
    cleaned = cleaned.replace(/[^\d.,]/g, '').trim();
  } else {
    throw new InvalidAmountError(rawAmount, `Unsupported amount type: ${typeof rawAmount}`);
  }

  if (!cleaned || !/\d/.test(cleaned)) {
    throw new InvalidAmountError(rawAmount, `Failed to extract numeric characters from amount: "${rawAmount}"`);
  }

  let whole = '';
  let fraction = '';

  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');

  if (lastDot !== -1 && lastComma !== -1) {
    if (lastComma > lastDot) {
      // European: 1.234,56 -> comma is decimal separator
      whole = cleaned.slice(0, lastComma).replace(/\./g, '');
      fraction = cleaned.slice(lastComma + 1);
    } else {
      // US/UK: 1,234.56 -> dot is decimal separator
      whole = cleaned.slice(0, lastDot).replace(/,/g, '');
      fraction = cleaned.slice(lastDot + 1);
    }
  } else if (lastComma !== -1) {
    const commaParts = cleaned.split(',');
    if (commaParts.length === 2 && commaParts[1].length <= 2) {
      // Decimal comma: "1250,50"
      whole = commaParts[0];
      fraction = commaParts[1];
    } else {
      // Thousands separator: "1,000,000"
      whole = cleaned.replace(/,/g, '');
      fraction = '';
    }
  } else if (lastDot !== -1) {
    const dotParts = cleaned.split('.');
    if (dotParts.length > 2) {
      // Multiple dots: "1.000.000" -> thousands separator
      whole = cleaned.replace(/\./g, '');
      fraction = '';
    } else if (dotParts.length === 2 && dotParts[1].length === 3) {
      // Single dot separator followed by exactly 3 digits and no other separators exist (e.g. "50.000")
      if (opts?.thousandsSeparator === '.') {
        whole = cleaned.replace(/\./g, '');
        fraction = '';
      } else {
        throw new AmbiguousAmountError(
          rawAmount,
          `Ambiguous amount with single dot and 3 digits: "${rawAmount}". Pass thousandsSeparator: '.' if dot represents thousands.`
        );
      }
    } else {
      // Single dot: standard decimal "1250.50"
      whole = dotParts[0];
      fraction = dotParts[1] || '';
    }
  } else {
    whole = cleaned;
    fraction = '';
  }

  whole = whole.replace(/\D/g, '');
  if (!whole) {
    whole = '0';
  }
  fraction = fraction.replace(/\D/g, '');

  // Round and pad fraction strictly to 2 characters via string arithmetic
  if (fraction.length === 0) {
    fraction = '00';
  } else if (fraction.length === 1) {
    fraction = fraction + '0';
  } else if (fraction.length === 2) {
    // Exactly 2 digits
  } else {
    // 3 or more digits: round 3rd digit (half-up)
    const d1d2 = fraction.slice(0, 2);
    const d3 = parseInt(fraction[2], 10);
    if (d3 >= 5) {
      const centsVal = parseInt(d1d2, 10) + 1;
      if (centsVal === 100) {
        whole = (BigInt(whole) + 1n).toString();
        fraction = '00';
      } else {
        fraction = centsVal.toString().padStart(2, '0');
      }
    } else {
      fraction = d1d2;
    }
  }

  const major = BigInt(whole);
  const minor = BigInt(fraction);
  const totalCents = major * 100n + minor;
  const amountCents = Number(totalCents);

  if (isNaN(amountCents) || !Number.isSafeInteger(amountCents)) {
    throw new InvalidAmountError(rawAmount, `Calculation resulted in invalid integer cents for amount: "${rawAmount}"`);
  }

  const direction = forcedDirection ?? (isNegative ? 'OUTGOING' : 'INCOMING');

  const result: ParsedAmount = {
    amountCents,
    direction,
  };

  Object.defineProperty(result, 'valueOf', {
    value: () => (isNegative ? -amountCents : amountCents),
    enumerable: false,
  });

  Object.defineProperty(result, Symbol.toPrimitive, {
    value: (hint: string) => {
      if (hint === 'string') {
        return (isNegative ? -amountCents : amountCents).toString();
      }
      return isNegative ? -amountCents : amountCents;
    },
    enumerable: false,
  });

  return result;
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
