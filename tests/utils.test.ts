import { describe, it, expect } from 'bun:test';
import { parseAmountToCents, formatCents } from '../src/utils/money.js';
import { parseBankDate } from '../src/utils/date.js';
import { parseCsv } from '../src/utils/csv.js';
import { cleanCompanyName, extractInvoiceCandidates, normalizeRemittance } from '../src/utils/text.js';

describe('Money utilities', () => {
  it('parses US formatted decimal amounts to integer cents', () => {
    expect(parseAmountToCents('1,250.50')).toEqual({ amountCents: 125050, direction: 'INCOMING' });
    expect(parseAmountToCents('-45.20')).toEqual({ amountCents: 4520, direction: 'OUTGOING' });
    expect(parseAmountToCents('(100.00)')).toEqual({ amountCents: 10000, direction: 'OUTGOING' });
  });

  it('parses European comma decimal amounts to integer cents', () => {
    expect(parseAmountToCents('1.250,50')).toEqual({ amountCents: 125050, direction: 'INCOMING' });
    expect(parseAmountToCents('-3.450,00')).toEqual({ amountCents: 345000, direction: 'OUTGOING' });
    expect(parseAmountToCents('99,99')).toEqual({ amountCents: 9999, direction: 'INCOMING' });
  });

  it('handles currency symbols and numbers directly', () => {
    expect(parseAmountToCents('€ 1,500.00')).toEqual({ amountCents: 150000, direction: 'INCOMING' });
    expect(parseAmountToCents('$ -25.50')).toEqual({ amountCents: 2550, direction: 'OUTGOING' });
    expect(parseAmountToCents(123.45)).toEqual({ amountCents: 12345, direction: 'INCOMING' });
    expect(parseAmountToCents(-80.0)).toEqual({ amountCents: 8000, direction: 'OUTGOING' });
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

  it('parses slash dates DD/MM/YYYY and YYYY/MM/DD', () => {
    expect(parseBankDate('01/09/2024')).toBe('2024-09-01');
    expect(parseBankDate('2024/09/01')).toBe('2024-09-01');
  });

  it('parses SWIFT MT940 YYMMDD', () => {
    expect(parseBankDate('240901')).toBe('2024-09-01');
    expect(parseBankDate('991231')).toBe('1999-12-31');
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

  it('normalizes remittance information', () => {
    const text = 'Rechnung INV-2024-99 payment for software subscription GmbH';
    const normalized = normalizeRemittance(text);
    expect(normalized).toContain('inv 2024 99');
    expect(normalized).not.toContain('rechnung');
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
