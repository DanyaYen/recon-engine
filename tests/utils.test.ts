import { describe, it, expect } from 'bun:test';
import { parseAmountToCents, formatCents, InvalidAmountError, AmbiguousAmountError } from '../src/utils/money.js';
import { parseBankDate, InvalidDateError, getDayDifference } from '../src/utils/date.js';
import { parseCsv } from '../src/utils/csv.js';
import { cleanCompanyName, extractInvoiceCandidates, normalizeRemittance } from '../src/utils/text.js';

describe('Money utilities', () => {
  it('parses US formatted decimal amounts to integer cents', () => {
    expect(parseAmountToCents('1,250.50')).toEqual({ amountCents: 125050, direction: 'INCOMING' });
    expect(parseAmountToCents('1250.50')).toEqual({ amountCents: 125050, direction: 'INCOMING' });
    expect(parseAmountToCents('1250.45')).toEqual({ amountCents: 125045, direction: 'INCOMING' });
    expect(parseAmountToCents('-45.10')).toEqual({ amountCents: 4510, direction: 'OUTGOING' });
    expect(parseAmountToCents('-45.20')).toEqual({ amountCents: 4520, direction: 'OUTGOING' });
    expect(parseAmountToCents('(100.00)')).toEqual({ amountCents: 10000, direction: 'OUTGOING' });
  });

  it('parses European comma decimal amounts to integer cents', () => {
    expect(parseAmountToCents('1.250,50')).toEqual({ amountCents: 125050, direction: 'INCOMING' });
    expect(parseAmountToCents('1.250,50 EUR')).toEqual({ amountCents: 125050, direction: 'INCOMING' });
    expect(parseAmountToCents('1250,50')).toEqual({ amountCents: 125050, direction: 'INCOMING' });
    expect(parseAmountToCents('-3.450,00')).toEqual({ amountCents: 345000, direction: 'OUTGOING' });
    expect(parseAmountToCents('99,99')).toEqual({ amountCents: 9999, direction: 'INCOMING' });
  });

  it('handles currency symbols and numbers directly', () => {
    expect(parseAmountToCents('€ 1,500.00')).toEqual({ amountCents: 150000, direction: 'INCOMING' });
    expect(parseAmountToCents('$ -25.50')).toEqual({ amountCents: 2550, direction: 'OUTGOING' });
    expect(parseAmountToCents(123.45)).toEqual({ amountCents: 12345, direction: 'INCOMING' });
    expect(parseAmountToCents(-80.0)).toEqual({ amountCents: 8000, direction: 'OUTGOING' });
  });

  it('handles boundary amounts and rounding edge cases without floating point inaccuracies', () => {
    expect(parseAmountToCents('29.99')).toEqual({ amountCents: 2999, direction: 'INCOMING' });
    expect(parseAmountToCents('0.07')).toEqual({ amountCents: 7, direction: 'INCOMING' });
    expect(parseAmountToCents('1234.5678')).toEqual({ amountCents: 123457, direction: 'INCOMING' });
    expect(parseAmountToCents('$ 1,234.567')).toEqual({ amountCents: 123457, direction: 'INCOMING' });
    expect(parseAmountToCents('$ -1,234.567')).toEqual({ amountCents: 123457, direction: 'OUTGOING' });
  });

  it('throws AmbiguousAmountError for single dot followed by exactly 3 digits unless thousandsSeparator is passed', () => {
    expect(() => parseAmountToCents('50.000')).toThrow(AmbiguousAmountError);
    expect(() => parseAmountToCents('1.000')).toThrow(AmbiguousAmountError);
    expect(() => parseAmountToCents('1.005')).toThrow(AmbiguousAmountError);
    expect(() => parseAmountToCents('-1.005')).toThrow(AmbiguousAmountError);
    expect(() => parseAmountToCents('0.005')).toThrow(AmbiguousAmountError);

    expect(parseAmountToCents('50.000', { thousandsSeparator: '.' })).toEqual({
      amountCents: 5000000,
      direction: 'INCOMING',
    });
    expect(parseAmountToCents('-50.000', { thousandsSeparator: '.' })).toEqual({
      amountCents: 5000000,
      direction: 'OUTGOING',
    });
    expect(parseAmountToCents('1.000', { thousandsSeparator: '.' })).toEqual({
      amountCents: 100000,
      direction: 'INCOMING',
    });
    expect(parseAmountToCents('1.500', 'INCOMING', { thousandsSeparator: '.' })).toEqual({
      amountCents: 150000,
      direction: 'INCOMING',
    });
  });

  it('prevents floating-point precision loss and parses edge cases to integer cents', () => {
    // Edge cases specified in requirements
    // "0.07" -> 7
    const c1 = parseAmountToCents('0.07');
    expect(c1).toEqual({ amountCents: 7, direction: 'INCOMING' });
    expect(c1.amountCents).toBe(7);
    expect(Number(c1)).toBe(7);

    // "1250.45" -> 125045
    const c2 = parseAmountToCents('1250.45');
    expect(c2).toEqual({ amountCents: 125045, direction: 'INCOMING' });
    expect(c2.amountCents).toBe(125045);
    expect(Number(c2)).toBe(125045);

    // "1.250,50" -> 125050
    const c3 = parseAmountToCents('1.250,50');
    expect(c3).toEqual({ amountCents: 125050, direction: 'INCOMING' });
    expect(c3.amountCents).toBe(125050);
    expect(Number(c3)).toBe(125050);

    // "-45.10" -> -4510
    const c4 = parseAmountToCents('-45.10');
    expect(c4).toEqual({ amountCents: 4510, direction: 'OUTGOING' });
    expect(c4.amountCents).toBe(4510);
    expect(c4.direction).toBe('OUTGOING');
    expect(Number(c4)).toBe(-4510);

    // European formatting ("1.250,50 EUR", "1250,50") and US/UK formatting ("1,250.50", "1250.50")
    expect(parseAmountToCents('1.250,50 EUR').amountCents).toBe(125050);
    expect(parseAmountToCents('1250,50').amountCents).toBe(125050);
    expect(parseAmountToCents('1,250.50').amountCents).toBe(125050);
    expect(parseAmountToCents('1250.50').amountCents).toBe(125050);
  });

  it('throws InvalidAmountError on invalid amounts instead of returning 0', () => {
    expect(() => parseAmountToCents('')).toThrow(InvalidAmountError);
    expect(() => parseAmountToCents('   ')).toThrow(InvalidAmountError);
    expect(() => parseAmountToCents('INVALID')).toThrow(InvalidAmountError);
    expect(() => parseAmountToCents('N/A')).toThrow(InvalidAmountError);
    expect(() => parseAmountToCents(NaN)).toThrow(InvalidAmountError);

    try {
      parseAmountToCents('INVALID_AMOUNT');
    } catch (err) {
      expect(err instanceof InvalidAmountError).toBe(true);
      expect((err as InvalidAmountError).rawAmount).toBe('INVALID_AMOUNT');
    }
  });

  it('formats cents into readable strings', () => {
    expect(formatCents(125050, 'EUR')).toBe('1,250.50 EUR');
    expect(formatCents(500, 'USD')).toBe('5.00 USD');
  });
});

describe('Date utilities', () => {
  it('parses ISO dates', () => {
    expect(parseBankDate('2024-09-01')).toBe('2024-09-01');
    expect(parseBankDate('2024-09-01T15:30:00Z')).toBe('2024-09-01');
  });

  it('parses European dot dates DD.MM.YYYY', () => {
    expect(parseBankDate('01.09.2024')).toBe('2024-09-01');
    expect(parseBankDate('15.12.2023')).toBe('2023-12-15');
  });

  it('parses slash dates DD/MM/YYYY and YYYY/MM/DD and handles US vs European format', () => {
    expect(parseBankDate('01/09/2024')).toBe('2024-09-01');
    expect(parseBankDate('2024/09/01')).toBe('2024-09-01');

    // US dates where part 2 > 12: MM/DD/YYYY
    expect(parseBankDate('12/25/2026')).toBe('2026-12-25');
    expect(parseBankDate('07/19/2025')).toBe('2025-07-19');

    // European dates where part 1 > 12: DD/MM/YYYY
    expect(parseBankDate('25/12/2026')).toBe('2026-12-25');
    expect(parseBankDate('19/07/2025')).toBe('2025-07-19');

    // Ambiguous dates where both part 1 and part 2 <= 12: default to DD/MM/YYYY unless dateLocale is MM/DD/YYYY
    expect(parseBankDate('05/06/2026')).toBe('2026-06-05'); // 5th of June (DD/MM/YYYY default)
    expect(parseBankDate('05/06/2026', { dateLocale: 'MM/DD/YYYY' })).toBe('2026-05-06'); // May 6th (US MM/DD/YYYY)
  });

  it('parses SWIFT MT940 YYMMDD', () => {
    expect(parseBankDate('240901')).toBe('2024-09-01');
    expect(parseBankDate('991231')).toBe('1999-12-31');
  });

  it('correctly handles leap year dates', () => {
    expect(parseBankDate('2024-02-29')).toBe('2024-02-29');
    expect(() => parseBankDate('2023-02-29')).toThrow(InvalidDateError);
  });

  it('rejects invalid dates like 2026-99-99 and broken dates without falling back to today', () => {
    expect(() => parseBankDate('2026-99-99')).toThrow(InvalidDateError);
    expect(() => parseBankDate('31.02.2024')).toThrow(InvalidDateError);
    expect(() => parseBankDate('2024-04-31')).toThrow(InvalidDateError);
    expect(() => parseBankDate('corrupt-date-string')).toThrow(InvalidDateError);
    expect(() => parseBankDate('')).toThrow(InvalidDateError);
    expect(() => parseBankDate(undefined)).toThrow(InvalidDateError);

    try {
      parseBankDate('2026-99-99');
    } catch (err) {
      expect(err instanceof InvalidDateError).toBe(true);
      expect((err as InvalidDateError).rawDate).toBe('2026-99-99');
    }
  });

  describe('getDayDifference', () => {
    it('calculates calendar day differences in UTC without timezone drift', () => {
      expect(getDayDifference('2024-09-01', '2024-09-01')).toBe(0);
      expect(getDayDifference('2024-09-01', '2024-09-03')).toBe(2);
      expect(getDayDifference('2024-09-03', '2024-09-01')).toBe(2);
      expect(getDayDifference('2024-01-01', '2024-01-31')).toBe(30);
    });

    it('correctly handles leap years and month transitions', () => {
      expect(getDayDifference('2024-02-28', '2024-03-01')).toBe(2); // 2024 is leap year (Feb 29)
      expect(getDayDifference('2023-02-28', '2023-03-01')).toBe(1); // 2023 is non-leap year
    });

    it('avoids daylight saving time (DST) shifts', () => {
      // European spring forward (March) and fall back (October)
      expect(getDayDifference('2024-03-30', '2024-04-01')).toBe(2);
      expect(getDayDifference('2024-10-26', '2024-10-28')).toBe(2);
    });
  });
});

describe('Text utilities', () => {
  it('cleans company names by removing legal entity forms', () => {
    expect(cleanCompanyName('Acme Corp GmbH')).toBe('acme');
    expect(cleanCompanyName('Global Logistics Ltd.')).toBe('global logistics');
    expect(cleanCompanyName('Siemens AG')).toBe('siemens');
    expect(cleanCompanyName('Airbus Operations SAS')).toBe('airbus operations');
  });

  it('extracts candidate invoice numbers', () => {
    const text = 'SEPA transfer for invoice INV-2024-001 and #88912';
    const candidates = extractInvoiceCandidates(text);
    expect(candidates).toContain('INV-2024-001');
    expect(candidates).toContain('88912');
  });

  it('normalizes remittance information and strips stop-words and tags', () => {
    const text = 'EREF+9912 Rechnung INV-2024-99 payment for software subscription GmbH';
    const normalized = normalizeRemittance(text);
    expect(normalized).toContain('2024 99');
    expect(normalized).not.toContain('rechnung');
    expect(normalized).not.toContain('inv');
    expect(normalized).not.toContain('eref');
    expect(normalized).not.toContain('gmbh');
  });
});

describe('CSV parser utility', () => {
  it('handles quoted cells with commas and newlines', () => {
    const csv = '"Col1","Col2"\n"val1, with comma","val2\nwith newline"';
    const res = parseCsv(csv);
    expect(res.headers).toEqual(['Col1', 'Col2']);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]['Col1']).toBe('val1, with comma');
    expect(res.rows[0]['Col2']).toBe('val2\nwith newline');
  });

  it('auto-detects semicolon delimiter', () => {
    const csv = 'Date;Amount;Memo\n2024-09-01;100;Test';
    const res = parseCsv(csv);
    expect(res.headers).toEqual(['Date', 'Amount', 'Memo']);
    expect(res.rows[0]['Amount']).toBe('100');
  });
});
