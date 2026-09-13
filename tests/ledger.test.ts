import { describe, it, expect } from 'bun:test';
import {
  matchToPostings,
  matchesToPostings,
  validatePostingsBalance,
  validateTransactionBalance,
  createReconciliationPostings,
  PostingSchema,
  LedgerTransactionSchema,
  type Posting,
  type PostingLine,
  type LedgerTransaction,
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

describe('Clearing Suspense Account Postings (createReconciliationPostings)', () => {
  const accounts = {
    bank: 'act_bank_1001',
    suspense: 'act_suspense_9999',
    ar: 'act_ar_1200',
    feeExpense: 'act_fee_6500',
  };

  it('creates balanced Event 1 and Event 2 for exact match without fees', () => {
    const inv: NormalizedInvoice = {
      id: 'inv_exact',
      invoiceNumber: 'INV-2024-EXACT',
      amountCents: 10000,
      currency: 'EUR',
      issueDate: '2024-09-01',
      status: 'OPEN',
      customerName: 'Alpha Corp',
    };
    const tx: NormalizedTransaction = {
      id: 'tx_exact',
      bookingDate: '2024-09-02',
      amountCents: 10000,
      currency: 'EUR',
      direction: 'INCOMING',
      reference: 'INV-2024-EXACT',
      sourceFormat: 'revolut',
    };

    const report = reconcile([tx], [inv]);
    expect(report.matches.length).toBe(1);
    const match = report.matches[0];

    const transactions = createReconciliationPostings(match, accounts);
    expect(transactions.length).toBe(2);

    const [event1, event2] = transactions;

    // Schema validation
    transactions.forEach((t) => expect(() => LedgerTransactionSchema.parse(t)).not.toThrow());

    // Event 1 (Bank Clearing): Debit Bank, Credit Suspense
    expect(event1.id).toBe('tx_exact-clearing');
    expect(event1.postedAt).toBe('2024-09-02');
    expect(event1.lines).toEqual([
      { accountId: 'act_bank_1001', direction: 'DEBIT', amountCents: 10000, currency: 'EUR' },
      { accountId: 'act_suspense_9999', direction: 'CREDIT', amountCents: 10000, currency: 'EUR' },
    ]);

    // Event 2 (Invoice Settlement): Debit Suspense, Credit AR
    expect(event2.id).toBe('tx_exact-settlement');
    expect(event2.postedAt).toBe('2024-09-02');
    expect(event2.lines).toEqual([
      { accountId: 'act_suspense_9999', direction: 'DEBIT', amountCents: 10000, currency: 'EUR' },
      { accountId: 'act_ar_1200', direction: 'CREDIT', amountCents: 10000, currency: 'EUR' },
    ]);

    // Verify double-entry conservation invariant sum(DEBIT) === sum(CREDIT) for each event
    for (const t of transactions) {
      expect(validateTransactionBalance(t)).toBe(true);
      const debits = t.lines.filter((l) => l.direction === 'DEBIT').reduce((s, l) => s + l.amountCents, 0);
      const credits = t.lines.filter((l) => l.direction === 'CREDIT').reduce((s, l) => s + l.amountCents, 0);
      expect(debits).toBe(credits);
    }

    // Verify suspense clearing account has zero net balance
    const allLines = transactions.flatMap((t) => t.lines);
    const suspenseDebits = allLines
      .filter((l) => l.accountId === 'act_suspense_9999' && l.direction === 'DEBIT')
      .reduce((s, l) => s + l.amountCents, 0);
    const suspenseCredits = allLines
      .filter((l) => l.accountId === 'act_suspense_9999' && l.direction === 'CREDIT')
      .reduce((s, l) => s + l.amountCents, 0);
    expect(suspenseDebits).toBe(10000);
    expect(suspenseCredits).toBe(10000);
    expect(suspenseDebits - suspenseCredits).toBe(0);
  });

  it('creates balanced Event 1 and Event 2 with fee expense for fee tolerance / gateway match', () => {
    const inv: NormalizedInvoice = {
      id: 'inv_fee',
      invoiceNumber: 'INV-2024-FEE',
      amountCents: 10000, // $100.00 USD
      currency: 'USD',
      issueDate: '2024-09-01',
      status: 'OPEN',
      customerName: 'Beta Corp',
    };
    const tx: NormalizedTransaction = {
      id: 'tx_fee',
      bookingDate: '2024-09-02',
      amountCents: 9710, // $97.10 USD ($2.90 gateway fee)
      currency: 'USD',
      direction: 'INCOMING',
      reference: 'INV-2024-FEE',
      sourceFormat: 'stripe',
    };

    const report = reconcile([tx], [inv], { feeTolerancePercentage: 0.03 });
    expect(report.matches.length).toBe(1);
    const match = report.matches[0];
    expect(match.inferredFeeCents).toBe(290);

    const transactions = createReconciliationPostings(match, accounts);
    expect(transactions.length).toBe(2);

    const [event1, event2] = transactions;

    transactions.forEach((t) => expect(() => LedgerTransactionSchema.parse(t)).not.toThrow());

    // Event 1 (Bank Clearing): Debit Bank 9710, Credit Suspense 9710
    expect(event1.id).toBe('tx_fee-clearing');
    expect(event1.lines).toEqual([
      { accountId: 'act_bank_1001', direction: 'DEBIT', amountCents: 9710, currency: 'USD' },
      { accountId: 'act_suspense_9999', direction: 'CREDIT', amountCents: 9710, currency: 'USD' },
    ]);

    // Event 2 (Invoice Settlement): Debit Suspense 9710, Debit FeeExpense 290, Credit AR 10000
    expect(event2.id).toBe('tx_fee-settlement');
    expect(event2.lines).toEqual([
      { accountId: 'act_suspense_9999', direction: 'DEBIT', amountCents: 9710, currency: 'USD' },
      { accountId: 'act_fee_6500', direction: 'DEBIT', amountCents: 290, currency: 'USD' },
      { accountId: 'act_ar_1200', direction: 'CREDIT', amountCents: 10000, currency: 'USD' },
    ]);

    // Verify invariant sum(DEBIT) === sum(CREDIT) for each event
    for (const t of transactions) {
      expect(validateTransactionBalance(t)).toBe(true);
      const debits = t.lines.filter((l) => l.direction === 'DEBIT').reduce((s, l) => s + l.amountCents, 0);
      const credits = t.lines.filter((l) => l.direction === 'CREDIT').reduce((s, l) => s + l.amountCents, 0);
      expect(debits).toBe(credits);
    }

    // In Event 2: debits (9710 + 290) = 10000 === credit (10000)
    const event2Debits = event2.lines.filter((l) => l.direction === 'DEBIT').reduce((s, l) => s + l.amountCents, 0);
    const event2Credits = event2.lines.filter((l) => l.direction === 'CREDIT').reduce((s, l) => s + l.amountCents, 0);
    expect(event2Debits).toBe(10000);
    expect(event2Credits).toBe(10000);

    // Suspense clears to zero
    const allLines = transactions.flatMap((t) => t.lines);
    const suspenseDebits = allLines
      .filter((l) => l.accountId === 'act_suspense_9999' && l.direction === 'DEBIT')
      .reduce((s, l) => s + l.amountCents, 0);
    const suspenseCredits = allLines
      .filter((l) => l.accountId === 'act_suspense_9999' && l.direction === 'CREDIT')
      .reduce((s, l) => s + l.amountCents, 0);
    expect(suspenseDebits - suspenseCredits).toBe(0);
  });

  it('verifies ledger conservation invariant across multiple batch matches with mixed fees', () => {
    const inv1: NormalizedInvoice = {
      id: 'inv_1',
      invoiceNumber: 'INV-1',
      amountCents: 5000,
      currency: 'EUR',
      issueDate: '2024-09-01',
      status: 'OPEN',
      customerName: 'Company 1',
    };
    const tx1: NormalizedTransaction = {
      id: 'tx_1',
      bookingDate: '2024-09-02',
      amountCents: 5000,
      currency: 'EUR',
      direction: 'INCOMING',
      reference: 'INV-1',
      sourceFormat: 'revolut',
    };

    const inv2: NormalizedInvoice = {
      id: 'inv_2',
      invoiceNumber: 'INV-2',
      amountCents: 8000,
      currency: 'EUR',
      issueDate: '2024-09-01',
      status: 'OPEN',
      customerName: 'Company 2',
    };
    const tx2: NormalizedTransaction = {
      id: 'tx_2',
      bookingDate: '2024-09-02',
      amountCents: 7800, // 200 cents fee
      currency: 'EUR',
      direction: 'INCOMING',
      reference: 'INV-2',
      sourceFormat: 'stripe',
    };

    const report = reconcile([tx1, tx2], [inv1, inv2], { feeTolerancePercentage: 0.05 });
    const allTransactions = report.matches.flatMap((m) => createReconciliationPostings(m, accounts));

    expect(allTransactions.length).toBe(4); // 2 events per match

    for (const t of allTransactions) {
      expect(validateTransactionBalance(t)).toBe(true);
      const debits = t.lines.filter((l) => l.direction === 'DEBIT').reduce((s, l) => s + l.amountCents, 0);
      const credits = t.lines.filter((l) => l.direction === 'CREDIT').reduce((s, l) => s + l.amountCents, 0);
      expect(debits).toBe(credits);
    }
  });

  it('returns empty array when transaction is unmatched', () => {
    const tx: NormalizedTransaction = {
      id: 'tx_unknown',
      bookingDate: '2024-09-02',
      amountCents: 3000,
      currency: 'EUR',
      direction: 'INCOMING',
      reference: 'No match',
      sourceFormat: 'revolut',
    };

    const report = reconcile([tx], []);
    const transactions = createReconciliationPostings(report.matches[0], accounts);
    expect(transactions).toEqual([]);
  });

  it('produces deterministic transaction IDs from match', () => {
    const inv: NormalizedInvoice = {
      id: 'inv_det',
      invoiceNumber: 'INV-DET',
      amountCents: 4000,
      currency: 'EUR',
      issueDate: '2024-09-01',
      status: 'OPEN',
      customerName: 'Det Corp',
    };
    const tx: NormalizedTransaction = {
      id: 'tx_det',
      bookingDate: '2024-09-02',
      amountCents: 4000,
      currency: 'EUR',
      direction: 'INCOMING',
      reference: 'INV-DET',
      sourceFormat: 'revolut',
    };

    const report = reconcile([tx], [inv]);
    const res1 = createReconciliationPostings(report.matches[0], accounts);
    const res2 = createReconciliationPostings(report.matches[0], accounts);

    expect(res1[0].id).toBe(res2[0].id);
    expect(res1[1].id).toBe(res2[1].id);
  });
});

