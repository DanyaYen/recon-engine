import { describe, it, expect } from 'bun:test';
import {
  matchToPostings,
  matchesToPostings,
  validatePostingsBalance,
  PostingSchema,
  type Posting,
} from '../src/ledger/index.js';
import { reconcile } from '../src/matcher/engine.js';
import type { NormalizedTransaction } from '../src/schemas/transaction.js';
import type { NormalizedInvoice } from '../src/schemas/invoice.js';

describe('Double-Entry Ledger Posting Adapter', () => {
  const ledgerConfig = {
    bankAccountId: 'act_bank_1001',
    arAccountId: 'act_ar_1200',
    feeAccountId: 'act_fee_6500',
  };

  it('generates balanced postings for an exact match (no fees)', () => {
    const inv: NormalizedInvoice = {
      id: 'inv_101',
      invoiceNumber: 'INV-2024-001',
      amountCents: 150000, // 1,500.00 EUR
      currency: 'EUR',
      issueDate: '2024-09-01',
      status: 'OPEN',
      customerName: 'Acme Corp',
    };

    const tx: NormalizedTransaction = {
      id: 'tx_101',
      bookingDate: '2024-09-02',
      amountCents: 150000,
      currency: 'EUR',
      direction: 'INCOMING',
      reference: 'Payment INV-2024-001',
      sourceFormat: 'revolut',
    };

    const report = reconcile([tx], [inv]);
    expect(report.matches.length).toBe(1);
    const match = report.matches[0];

    const postings = matchToPostings(match, ledgerConfig);

    // Schema validation
    postings.forEach((p) => expect(() => PostingSchema.parse(p)).not.toThrow());

    expect(postings).toEqual([
      {
        accountId: 'act_bank_1001',
        direction: 'DEBIT',
        amountCents: 150000,
        currency: 'EUR',
      },
      {
        accountId: 'act_ar_1200',
        direction: 'CREDIT',
        amountCents: 150000,
        currency: 'EUR',
      },
    ]);

    expect(validatePostingsBalance(postings)).toBe(true);
    const debits = postings.filter((p) => p.direction === 'DEBIT').reduce((s, p) => s + p.amountCents, 0);
    const credits = postings.filter((p) => p.direction === 'CREDIT').reduce((s, p) => s + p.amountCents, 0);
    expect(debits).toBe(150000);
    expect(credits).toBe(150000);
    expect(debits).toBe(credits);
  });

  it('generates balanced postings for fee tolerance / gateway match with fee deduction', () => {
    const inv: NormalizedInvoice = {
      id: 'inv_stripe_100',
      invoiceNumber: 'INV-2024-STRIPE',
      amountCents: 10000, // $100.00 USD
      currency: 'USD',
      issueDate: '2024-09-01',
      status: 'OPEN',
      customerName: 'Stripe Client Corp',
    };

    const tx: NormalizedTransaction = {
      id: 'tx_stripe_9710',
      bookingDate: '2024-09-02',
      amountCents: 9710, // $97.10 USD (gateway fee $2.90 deducted)
      currency: 'USD',
      direction: 'INCOMING',
      reference: 'Payout for INV-2024-STRIPE',
      sourceFormat: 'stripe',
    };

    const report = reconcile([tx], [inv], { feeTolerancePercentage: 0.03 });
    expect(report.matches.length).toBe(1);
    const match = report.matches[0];
    expect(match.inferredFeeCents).toBe(290);

    const postings = matchToPostings(match, ledgerConfig);

    postings.forEach((p) => expect(() => PostingSchema.parse(p)).not.toThrow());

    expect(postings).toEqual([
      {
        accountId: 'act_bank_1001',
        direction: 'DEBIT',
        amountCents: 9710,
        currency: 'USD',
      },
      {
        accountId: 'act_fee_6500',
        direction: 'DEBIT',
        amountCents: 290,
        currency: 'USD',
      },
      {
        accountId: 'act_ar_1200',
        direction: 'CREDIT',
        amountCents: 10000,
        currency: 'USD',
      },
    ]);

    expect(validatePostingsBalance(postings)).toBe(true);
    const debits = postings.filter((p) => p.direction === 'DEBIT').reduce((s, p) => s + p.amountCents, 0);
    const credits = postings.filter((p) => p.direction === 'CREDIT').reduce((s, p) => s + p.amountCents, 0);
    expect(debits).toBe(10000);
    expect(credits).toBe(10000);
    expect(debits).toBe(credits);
  });

  it('handles partial payment match while conserving balance', () => {
    const inv: NormalizedInvoice = {
      id: 'inv_part_1',
      invoiceNumber: 'INV-2024-PART',
      amountCents: 100000, // 1,000.00 EUR
      currency: 'EUR',
      issueDate: '2024-09-01',
      status: 'OPEN',
      customerName: 'Client Part',
    };

    const tx: NormalizedTransaction = {
      id: 'tx_part_1',
      bookingDate: '2024-09-02',
      amountCents: 60000, // 600.00 EUR partial payment
      currency: 'EUR',
      direction: 'INCOMING',
      reference: 'Partial payment for INV-2024-PART',
      sourceFormat: 'revolut',
    };

    const report = reconcile([tx], [inv]);
    expect(report.matches.length).toBe(1);
    const match = report.matches[0];
    expect(match.status).toBe('PARTIAL_MATCH');
    expect(match.remainingCents).toBe(40000);

    const postings = matchToPostings(match, ledgerConfig);
    expect(postings).toEqual([
      {
        accountId: 'act_bank_1001',
        direction: 'DEBIT',
        amountCents: 60000,
        currency: 'EUR',
      },
      {
        accountId: 'act_ar_1200',
        direction: 'CREDIT',
        amountCents: 60000,
        currency: 'EUR',
      },
    ]);
    expect(validatePostingsBalance(postings)).toBe(true);
  });

  it('returns empty postings array for unmatched transaction', () => {
    const tx: NormalizedTransaction = {
      id: 'tx_unmatched_1',
      bookingDate: '2024-09-02',
      amountCents: 50000,
      currency: 'EUR',
      direction: 'INCOMING',
      reference: 'Unknown payment',
      sourceFormat: 'revolut',
    };

    const report = reconcile([tx], []);
    expect(report.matches.length).toBe(1);
    const match = report.matches[0];
    expect(match.status).toBe('UNMATCHED');

    const postings = matchToPostings(match, ledgerConfig);
    expect(postings).toEqual([]);
    expect(validatePostingsBalance(postings)).toBe(true);
  });

  it('converts batch reconciliation matches across multiple currencies using matchesToPostings', () => {
    const invEUR: NormalizedInvoice = {
      id: 'inv_eur',
      invoiceNumber: 'INV-EUR-1',
      amountCents: 20000,
      currency: 'EUR',
      issueDate: '2024-09-01',
      status: 'OPEN',
      customerName: 'Euro Corp',
    };
    const txEUR: NormalizedTransaction = {
      id: 'tx_eur',
      bookingDate: '2024-09-02',
      amountCents: 20000,
      currency: 'EUR',
      direction: 'INCOMING',
      reference: 'INV-EUR-1',
      sourceFormat: 'revolut',
    };

    const invUSD: NormalizedInvoice = {
      id: 'inv_usd',
      invoiceNumber: 'INV-USD-1',
      amountCents: 10000,
      currency: 'USD',
      issueDate: '2024-09-01',
      status: 'OPEN',
      customerName: 'USD Corp',
    };
    const txUSD: NormalizedTransaction = {
      id: 'tx_usd',
      bookingDate: '2024-09-02',
      amountCents: 9700,
      currency: 'USD',
      direction: 'INCOMING',
      reference: 'INV-USD-1',
      sourceFormat: 'stripe',
    };

    const report = reconcile([txEUR, txUSD], [invEUR, invUSD], { feeTolerancePercentage: 0.05 });
    expect(report.matches.length).toBe(2);

    const allPostings = matchesToPostings(report.matches, ledgerConfig);
    expect(allPostings.length).toBe(5); // 2 from EUR, 3 from USD
    expect(validatePostingsBalance(allPostings)).toBe(true);
  });

  it('detects unbalanced postings with validatePostingsBalance', () => {
    const unbalancedPostings: Posting[] = [
      {
        accountId: 'act_bank_1001',
        direction: 'DEBIT',
        amountCents: 10000,
        currency: 'EUR',
      },
      {
        accountId: 'act_ar_1200',
        direction: 'CREDIT',
        amountCents: 9500, // 500 cents missing credit!
        currency: 'EUR',
      },
    ];

    expect(validatePostingsBalance(unbalancedPostings)).toBe(false);
  });
});
