import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { reconcile } from '../src/matcher/engine.js';
import { loadInvoices } from '../src/matcher/invoices.js';
import { jaroSimilarity, jaroWinklerSimilarity } from '../src/utils/fuzzy.js';
import type { NormalizedTransaction } from '../src/schemas/transaction.js';
import type { NormalizedInvoice } from '../src/schemas/invoice.js';

const FIXTURES_DIR = join(import.meta.dir, 'fixtures');
const CLI_PATH = join(import.meta.dir, '../src/cli/index.js');

describe('Fuzzy algorithms (Jaro & Jaro-Winkler)', () => {
  it('computes exact match as 1.0', () => {
    expect(jaroSimilarity('INV-2024-001', 'INV-2024-001')).toBe(1.0);
    expect(jaroWinklerSimilarity('INV-2024-001', 'INV-2024-001')).toBe(1.0);
  });

  it('handles minor typos and transpositions', () => {
    // "INV-2024-001" vs "INV-2024-010" (transposition of last digits)
    const score = jaroWinklerSimilarity('INV-2024-001', 'INV-2024-010');
    expect(score).toBeGreaterThan(0.85);
  });

  it('boosts common prefix in Jaro-Winkler', () => {
    // Common prefix "INV-" boosts similarity
    const jaro = jaroSimilarity('INV-2024-001', 'INV-2024-999');
    const jaroWinkler = jaroWinklerSimilarity('INV-2024-001', 'INV-2024-999');
    expect(jaroWinkler).toBeGreaterThan(jaro);
  });
});

describe('Invoices Loader', () => {
  it('loads and validates invoices from JSON', async () => {
    const invoices = await loadInvoices(join(FIXTURES_DIR, 'invoices/invoices.json'));
    expect(invoices.length).toBeGreaterThanOrEqual(8);
    expect(invoices[0].invoiceNumber).toBe('INV-2024-001');
    expect(invoices[0].amountCents).toBe(150000);
    expect(invoices[0].currency).toBe('EUR');
  });

  it('loads and validates invoices from CSV', async () => {
    const invoices = await loadInvoices(join(FIXTURES_DIR, 'invoices/invoices.csv'));
    expect(invoices.length).toBeGreaterThanOrEqual(8);
    expect(invoices[0].invoiceNumber).toBe('INV-2024-001');
    expect(invoices[0].amountCents).toBe(150000);
  });

  it('fails with process.exit(1) on invalid amountCents (float or string) in JSON instead of falling back to zero invoice', () => {
    const invalidFloatJson = JSON.stringify([
      {
        id: 'inv_invalid_1',
        invoiceNumber: 'INV-2024-999',
        amountCents: 1500.5,
        currency: 'EUR',
        issueDate: '2024-09-01',
        customerName: 'Acme Corp',
      },
    ]);
    const resFloat = spawnSync(
      'bun',
      [
        '-e',
        `import { loadInvoices } from './src/matcher/invoices.js'; await loadInvoices(${JSON.stringify(invalidFloatJson)});`,
      ],
      { encoding: 'utf-8' }
    );
    expect(resFloat.status).toBe(1);
    expect(resFloat.stderr).toContain('Validation error in invoices JSON');

    const invalidStringJson = JSON.stringify([
      {
        id: 'inv_invalid_2',
        invoiceNumber: 'INV-2024-999',
        amountCents: '150000',
        currency: 'EUR',
        issueDate: '2024-09-01',
        customerName: 'Acme Corp',
      },
    ]);
    const resString = spawnSync(
      'bun',
      [
        '-e',
        `import { loadInvoices } from './src/matcher/invoices.js'; await loadInvoices(${JSON.stringify(invalidStringJson)});`,
      ],
      { encoding: 'utf-8' }
    );
    expect(resString.status).toBe(1);
    expect(resString.stderr).toContain('Validation error in invoices JSON');
  });
});

describe('Matching Engine (Deterministic & Fuzzy)', () => {
  const sampleInvoices: NormalizedInvoice[] = [
    {
      id: 'inv_1',
      invoiceNumber: 'INV-2024-001',
      amountCents: 100000,
      currency: 'EUR',
      issueDate: '2024-09-01',
      status: 'OPEN',
      customerName: 'Acme GmbH',
    },
    {
      id: 'inv_2',
      invoiceNumber: 'INV-2024-002',
      amountCents: 250000,
      currency: 'EUR',
      issueDate: '2024-09-01',
      status: 'OPEN',
      customerName: 'Beta Logistics BV',
      customerIban: 'NL91INGB0001234567',
    },
    {
      id: 'inv_3',
      invoiceNumber: 'INV-2024-003',
      amountCents: 150000,
      currency: 'EUR',
      issueDate: '2024-09-01',
      status: 'OPEN',
      customerName: 'Gamma SAS',
    },
  ];

  it('performs Exact Match when reference, exact cents, and date ±2 days match', () => {
    const txs: NormalizedTransaction[] = [
      {
        id: 'tx_1',
        bookingDate: '2024-09-02', // +1 day, within ±2 days
        amountCents: 100000, // exact €1,000.00
        currency: 'EUR',
        direction: 'INCOMING',
        counterpartyName: 'Acme GmbH',
        reference: 'Payment for invoice INV-2024-001 thank you',
        sourceFormat: 'test',
      },
    ];

    const report = reconcile(txs, sampleInvoices, { dateToleranceDays: 2 });
    expect(report.summary.matchedCount).toBe(1);
    expect(report.summary.reviewNeededCount).toBe(0);

    const match = report.matches[0];
    expect(match.status).toBe('MATCHED');
    expect(match.level).toBe('EXACT_REFERENCE');
    expect(match.confidenceScore).toBe(1.0);
    expect(match.invoice?.invoiceNumber).toBe('INV-2024-001');
  });

  it('rejects exact reference match if date difference exceeds ±2 days', () => {
    const txs: NormalizedTransaction[] = [
      {
        id: 'tx_late',
        bookingDate: '2024-09-10', // 9 days later, exceeds ±2 days
        amountCents: 100000,
        currency: 'EUR',
        direction: 'INCOMING',
        reference: 'INV-2024-001',
        sourceFormat: 'test',
      },
    ];

    const report = reconcile(txs, sampleInvoices, { dateToleranceDays: 2 });
    // Should not match as exact match due to date tolerance
    expect(report.matches[0].status).not.toBe('MATCHED');
  });

  it('matches via Exact Metrics when IBAN and exact cents match within date window', () => {
    const txs: NormalizedTransaction[] = [
      {
        id: 'tx_iban',
        bookingDate: '2024-09-01',
        amountCents: 250000,
        currency: 'EUR',
        direction: 'INCOMING',
        counterpartyIban: 'NL91INGB0001234567',
        reference: 'Transfer without invoice mention',
        sourceFormat: 'test',
      },
    ];

    const report = reconcile(txs, sampleInvoices, { dateToleranceDays: 2 });
    expect(report.summary.matchedCount).toBe(1);
    expect(report.matches[0].level).toBe('EXACT_METRICS');
    expect(report.matches[0].invoice?.invoiceNumber).toBe('INV-2024-002');
  });

  it('classifies fuzzy typo match as REVIEW_NEEDED or MATCHED with confidence score', () => {
    const txs: NormalizedTransaction[] = [
      {
        id: 'tx_fuzzy',
        bookingDate: '2024-09-02',
        amountCents: 150000,
        currency: 'EUR',
        direction: 'INCOMING',
        counterpartyName: 'Gamma SAS',
        reference: 'RECHNG INV 2024 003 VORAB', // Typo/variation in separator
        sourceFormat: 'test',
      },
    ];

    const report = reconcile(txs, sampleInvoices);
    expect(report.matches[0].invoice?.invoiceNumber).toBe('INV-2024-003');
    expect(report.matches[0].confidenceScore).toBeGreaterThanOrEqual(0.75);
    expect(['MATCHED', 'REVIEW_NEEDED']).toContain(report.matches[0].status);
  });

  it('classifies wire fee deduction within tolerance as REVIEW_NEEDED with explanation', () => {
    // Invoice is €1,500.00 (150,000 cents). Bank receives €1,485.00 (148,500 cents) due to €15 wire fee
    const txs: NormalizedTransaction[] = [
      {
        id: 'tx_wire_fee',
        bookingDate: '2024-09-02',
        amountCents: 148500, // €15.00 fee deducted
        currency: 'EUR',
        direction: 'INCOMING',
        counterpartyName: 'Gamma SAS',
        reference: 'INV-2024-003 wire transfer',
        sourceFormat: 'test',
      },
    ];

    const report = reconcile(txs, sampleInvoices, {
      feeToleranceCents: 2000, // €20 max tolerance
    });

    expect(report.summary.reviewNeededCount).toBe(1);
    const m = report.matches[0];
    expect(m.status).toBe('REVIEW_NEEDED');
    expect(m.level).toBe('FEE_TOLERANCE');
    expect(m.invoice?.invoiceNumber).toBe('INV-2024-003');
    expect(m.discrepancies[0]).toContain('fee tolerance');
  });

  it('enforces 1:1 matching cardinality so the same invoice is never matched twice', () => {
    const txs: NormalizedTransaction[] = [
      {
        id: 'tx_dup_1',
        bookingDate: '2024-09-01',
        amountCents: 100000,
        currency: 'EUR',
        direction: 'INCOMING',
        reference: 'INV-2024-001',
        sourceFormat: 'test',
      },
      {
        id: 'tx_dup_2',
        bookingDate: '2024-09-01',
        amountCents: 100000,
        currency: 'EUR',
        direction: 'INCOMING',
        reference: 'INV-2024-001',
        sourceFormat: 'test',
      },
    ];

    const report = reconcile(txs, sampleInvoices);
    expect(report.summary.matchedCount).toBe(1);
    expect(report.summary.unmatchedCount).toBe(1);
  });

  it('marks both transactions as REVIEW_NEEDED when two transactions contend for the same invoice with close scores', () => {
    const txs: NormalizedTransaction[] = [
      {
        id: 'tx_comp_1',
        bookingDate: '2024-09-02',
        amountCents: 150000,
        currency: 'EUR',
        direction: 'INCOMING',
        counterpartyName: 'Gamma SAS',
        reference: 'INV-2024-008 wire',
        sourceFormat: 'test',
      },
      {
        id: 'tx_comp_2',
        bookingDate: '2024-09-02',
        amountCents: 150000,
        currency: 'EUR',
        direction: 'INCOMING',
        counterpartyName: 'Gamma SAS',
        reference: 'INV-2024-009 wire',
        sourceFormat: 'test',
      },
    ];

    const report = reconcile(txs, sampleInvoices);
    expect(report.summary.reviewNeededCount).toBe(2);
    expect(report.summary.matchedCount).toBe(0);
    expect(report.matches.every((m) => m.status === 'REVIEW_NEEDED')).toBe(true);
    expect(report.matches[0].invoice?.invoiceNumber).toBe('INV-2024-003');
    expect(report.matches[1].invoice?.invoiceNumber).toBe('INV-2024-003');
    expect(report.matches[0].discrepancies[0]).toContain('Ambiguous match: multiple transactions');
  });

  it('prevents greedy collision when multiple invoices qualify within fee tolerance window', () => {
    // 2 identical invoices of €1,000.00
    const duplicateInvoices: NormalizedInvoice[] = [
      {
        id: 'inv_dup_1',
        invoiceNumber: 'INV-2024-COLL-1',
        amountCents: 100000,
        currency: 'EUR',
        issueDate: '2024-09-01',
        status: 'OPEN',
        customerName: 'Acme GmbH',
      },
      {
        id: 'inv_dup_2',
        invoiceNumber: 'INV-2024-COLL-2',
        amountCents: 100000,
        currency: 'EUR',
        issueDate: '2024-09-01',
        status: 'OPEN',
        customerName: 'Acme GmbH',
      },
    ];

    // Transaction for €985.00 (€15 fee deducted)
    const txs: NormalizedTransaction[] = [
      {
        id: 'tx_coll',
        bookingDate: '2024-09-02',
        amountCents: 98500,
        currency: 'EUR',
        direction: 'INCOMING',
        counterpartyName: 'Acme GmbH',
        reference: 'Payment Acme invoice',
        sourceFormat: 'test',
      },
    ];

    const report = reconcile(txs, duplicateInvoices, { feeToleranceCents: 2500 });
    expect(report.matches.length).toBe(1);

    const m = report.matches[0];
    // Must NOT be greedily auto-matched (MATCHED)
    expect(m.status).toBe('REVIEW_NEEDED');
    expect(m.level).toBe('FEE_TOLERANCE');
    expect(m.confidenceScore).toBe(0.65);
    expect(m.feeDeductionCents).toBe(1500);
    expect(m.discrepancies[0]).toContain(
      'Ambiguous match: multiple invoices qualify within fee tolerance window'
    );
  });

  it('explicitly records feeDeductionCents in match result when wire fee is deducted', () => {
    const singleInv: NormalizedInvoice[] = [
      {
        id: 'inv_fee',
        invoiceNumber: 'INV-2024-FEE',
        amountCents: 100000, // €1,000.00
        currency: 'EUR',
        issueDate: '2024-09-01',
        status: 'OPEN',
        customerName: 'Acme GmbH',
      },
    ];

    const txs: NormalizedTransaction[] = [
      {
        id: 'tx_fee',
        bookingDate: '2024-09-02',
        amountCents: 98500, // €985.00 (€15 fee)
        currency: 'EUR',
        direction: 'INCOMING',
        counterpartyName: 'Acme GmbH',
        reference: 'INV-2024-FEE net payment',
        sourceFormat: 'test',
      },
    ];

    const report = reconcile(txs, singleInv, { feeToleranceCents: 2500 });
    expect(report.matches.length).toBe(1);
    const m = report.matches[0];
    expect(m.status).toBe('REVIEW_NEEDED');
    expect(m.feeDeductionCents).toBe(1500); // 100000 - 98500 = 1500 cents
    expect(m.inferredFeeCents).toBe(1500);
  });

  it('matches payment gateway transfer with fee deduction within feeTolerancePercentage and records inferredFeeCents', () => {
    // Stripe entry of $97.10 (9,710 cents) corresponding to invoice of $100.00 (10,000 cents)
    const invs: NormalizedInvoice[] = [
      {
        id: 'inv_stripe_100',
        invoiceNumber: 'INV-2024-STRIPE',
        amountCents: 10000, // $100.00
        currency: 'USD',
        issueDate: '2024-09-01',
        status: 'OPEN',
        customerName: 'Stripe Client Corp',
      },
    ];

    const txs: NormalizedTransaction[] = [
      {
        id: 'tx_stripe_9710',
        bookingDate: '2024-09-02',
        amountCents: 9710, // $97.10 (gateway fee $2.90 = 2.9% deducted)
        currency: 'USD',
        direction: 'INCOMING',
        counterpartyName: 'Stripe Client Corp',
        reference: 'Payout for INV-2024-STRIPE',
        sourceFormat: 'stripe',
      },
    ];

    const report = reconcile(txs, invs, { feeTolerancePercentage: 0.03 });
    expect(report.matches.length).toBe(1);
    const m = report.matches[0];
    expect(m.status).toBe('REVIEW_NEEDED');
    expect(m.level).toBe('FEE_TOLERANCE');
    expect(m.invoice?.invoiceNumber).toBe('INV-2024-STRIPE');
    expect(m.inferredFeeCents).toBe(290); // 10000 - 9710 = 290
    expect(m.feeDeductionCents).toBe(290);
  });

  it('rejects match if transaction amount falls below invoice.amountCents * (1 - feeTolerancePercentage)', () => {
    // Entry of $96.00 (9,600 cents) exceeds 3% fee tolerance on $100.00 (10,000 cents)
    const invs: NormalizedInvoice[] = [
      {
        id: 'inv_stripe_100',
        invoiceNumber: 'INV-2024-STRIPE',
        amountCents: 10000,
        currency: 'USD',
        issueDate: '2024-09-01',
        status: 'OPEN',
        customerName: 'Stripe Client Corp',
      },
    ];

    const txs: NormalizedTransaction[] = [
      {
        id: 'tx_stripe_9600',
        bookingDate: '2024-09-02',
        amountCents: 9600, // 4% fee deducted, exceeds 3%
        currency: 'USD',
        direction: 'INCOMING',
        counterpartyName: 'Stripe Client Corp',
        reference: 'INV-2024-STRIPE',
        sourceFormat: 'stripe',
      },
    ];

    const report = reconcile(txs, invs, { feeTolerancePercentage: 0.03 });
    expect(report.summary.matchedCount).toBe(0);
    expect(report.matches[0].status).toBe('UNMATCHED');
    expect(report.matches[0].invoice).toBeUndefined();
  });

  it('reconciles gateway-invoices.json fixture correctly with gateway fees and records inferredFeeCents', async () => {
    const fixtureInvoices = await loadInvoices(join(FIXTURES_DIR, 'invoices/gateway-invoices.json'));
    expect(fixtureInvoices.length).toBe(2);

    const txs: NormalizedTransaction[] = [
      {
        id: 'tx_gateway_fixture',
        bookingDate: '2024-09-02',
        amountCents: 9710, // $97.10 against $100.00 invoice
        currency: 'USD',
        direction: 'INCOMING',
        counterpartyName: 'Stripe Client Corp',
        reference: 'INV-GATEWAY-100 payout',
        sourceFormat: 'stripe',
      },
    ];

    const report = reconcile(txs, fixtureInvoices, { feeTolerancePercentage: 0.03 });
    expect(report.summary.reviewNeededCount).toBe(1);
    const m = report.matches[0];
    expect(m.invoice?.invoiceNumber).toBe('INV-GATEWAY-100');
    expect(m.inferredFeeCents).toBe(290); // 10000 - 9710 = 290 cents
  });

  it('does not assign MATCHED status to transaction INV-2024-1006 (Zalando) against invoice INV-2024-501 (Siemens)', () => {
    const txs: NormalizedTransaction[] = [
      {
        id: 'tx_zalando',
        bookingDate: '2024-09-01',
        amountCents: 250000,
        currency: 'EUR',
        direction: 'INCOMING',
        counterpartyName: 'Zalando Payments GmbH',
        reference: 'INV-2024-1006 Zalando Order',
        sourceFormat: 'test',
      },
    ];

    const invs: NormalizedInvoice[] = [
      {
        id: 'inv_siemens_501',
        invoiceNumber: 'INV-2024-501',
        amountCents: 250000,
        currency: 'EUR',
        issueDate: '2024-09-01',
        status: 'OPEN',
        customerName: 'Siemens Digital GmbH',
      },
    ];

    const report = reconcile(txs, invs);
    expect(report.matches[0].status).not.toBe('MATCHED');
    expect(report.summary.matchedCount).toBe(0);
  });

  it('computes multi-currency totalsByCurrency accurately for mixed statements', () => {
    const txs: NormalizedTransaction[] = [
      {
        id: 'tx_eur_1',
        bookingDate: '2024-09-01',
        amountCents: 100000,
        currency: 'EUR',
        direction: 'INCOMING',
        reference: 'INV-2024-EUR-1',
        sourceFormat: 'test',
      },
      {
        id: 'tx_eur_2',
        bookingDate: '2024-09-02',
        amountCents: 50000,
        currency: 'EUR',
        direction: 'INCOMING',
        reference: 'Unmatched EUR',
        sourceFormat: 'test',
      },
      {
        id: 'tx_usd_1',
        bookingDate: '2024-09-01',
        amountCents: 200000,
        currency: 'USD',
        direction: 'INCOMING',
        reference: 'INV-2024-USD-1',
        sourceFormat: 'test',
      },
      {
        id: 'tx_usd_fee',
        bookingDate: '2024-09-02',
        amountCents: 9710,
        currency: 'USD',
        direction: 'INCOMING',
        counterpartyName: 'Stripe Gateway',
        reference: 'INV-2024-USD-2 fee payout',
        sourceFormat: 'test',
      },
    ];

    const invs: NormalizedInvoice[] = [
      {
        id: 'inv_eur_1',
        invoiceNumber: 'INV-2024-EUR-1',
        amountCents: 100000,
        currency: 'EUR',
        issueDate: '2024-09-01',
        status: 'OPEN',
        customerName: 'Customer EUR GmbH',
      },
      {
        id: 'inv_usd_1',
        invoiceNumber: 'INV-2024-USD-1',
        amountCents: 200000,
        currency: 'USD',
        issueDate: '2024-09-01',
        status: 'OPEN',
        customerName: 'Customer USD Corp',
      },
      {
        id: 'inv_usd_2',
        invoiceNumber: 'INV-2024-USD-2',
        amountCents: 10000,
        currency: 'USD',
        issueDate: '2024-09-01',
        status: 'OPEN',
        customerName: 'Stripe Gateway',
      },
    ];

    const report = reconcile(txs, invs, { feeTolerancePercentage: 0.03 });
    expect(report.summary.totalsByCurrency).toBeDefined();

    const eurTotals = report.summary.totalsByCurrency['EUR'];
    expect(eurTotals).toBeDefined();
    expect(eurTotals.matchedCents).toBe(100000);
    expect(eurTotals.unmatchedCents).toBe(50000);
    expect(eurTotals.feeCents).toBe(0);

    const usdTotals = report.summary.totalsByCurrency['USD'];
    expect(usdTotals).toBeDefined();
    expect(usdTotals.matchedCents).toBe(200000);
    expect(usdTotals.unmatchedCents).toBe(0);
    expect(usdTotals.feeCents).toBe(290);
  });

  it('yields PARTIAL_MATCH with 400 EUR remaining for a 600 EUR payment against a 1,000 EUR invoice', () => {
    const invs: NormalizedInvoice[] = [
      {
        id: 'inv_partial_1',
        invoiceNumber: 'INV-2024-PARTIAL-1',
        amountCents: 100000, // €1,000.00
        currency: 'EUR',
        issueDate: '2024-09-01',
        status: 'OPEN',
        customerName: 'Acme Corp GmbH',
      },
    ];

    const txs: NormalizedTransaction[] = [
      {
        id: 'tx_partial_1',
        bookingDate: '2024-09-02',
        amountCents: 60000, // €600.00 partial payment
        currency: 'EUR',
        direction: 'INCOMING',
        counterpartyName: 'Acme Corp GmbH',
        reference: 'Partial payment for INV-2024-PARTIAL-1',
        sourceFormat: 'test',
      },
    ];

    const report = reconcile(txs, invs);
    expect(report.matches.length).toBe(1);
    const m = report.matches[0];
    expect(m.status).toBe('PARTIAL_MATCH');
    expect(m.level).toBe('PARTIAL_MATCH');
    expect(m.matchedCents).toBe(60000);
    expect(m.remainingCents).toBe(40000); // 1,000 EUR - 600 EUR = 400 EUR
    expect(m.invoice?.invoiceNumber).toBe('INV-2024-PARTIAL-1');
    expect(m.invoice?.remainingCents).toBe(40000);
    expect(invs[0].remainingCents).toBe(40000);
    expect(m.discrepancies[0]).toContain('Partial payment');
  });

  it('benchmark: matches 2,000 transactions against 2,000 invoices in < 250ms', () => {
    const invoices: NormalizedInvoice[] = [];
    const transactions: NormalizedTransaction[] = [];

    for (let i = 0; i < 2000; i++) {
      const invNum = `INV-2024-${String(i).padStart(5, '0')}`;
      const amountCents = 10000 + (i % 250) * 100;
      invoices.push({
        id: `inv_${i}`,
        invoiceNumber: invNum,
        amountCents,
        currency: 'EUR',
        issueDate: '2024-09-01',
        status: 'OPEN',
        customerName: `Customer ${i % 50} GmbH`,
        customerIban: `DE893704004405320${String(i % 50).padStart(5, '0')}`,
      });

      let txAmountCents = amountCents;
      let reference = `Payment for ${invNum}`;
      if (i % 10 === 0) {
        txAmountCents = Math.max(1000, amountCents - 1500);
        reference = `Net payment for invoice ${invNum}`;
      } else if (i % 7 === 0) {
        reference = `Invoice ${invNum.replace('-', ' ')} transfer`;
      }

      transactions.push({
        id: `tx_${i}`,
        bookingDate: '2024-09-02',
        amountCents: txAmountCents,
        currency: 'EUR',
        direction: 'INCOMING',
        counterpartyName: `Customer ${i % 50} GmbH`,
        reference,
        sourceFormat: 'test',
      });
    }

    const start = performance.now();
    const report = reconcile(transactions, invoices);
    const durationMs = performance.now() - start;

    expect(report.summary.totalTransactions).toBe(2000);
    expect(report.summary.totalInvoices).toBe(2000);
    expect(report.summary.matchedCount + report.summary.reviewNeededCount).toBe(2000);
    expect(durationMs).toBeLessThan(250);
  });

  it('benchmark: matches 5,000 transactions against 5,000 invoices in < 300ms', () => {
    const invoices: NormalizedInvoice[] = [];
    const transactions: NormalizedTransaction[] = [];

    for (let i = 0; i < 5000; i++) {
      const invNum = `INV-2024-${String(i).padStart(5, '0')}`;
      const amountCents = 10000 + (i % 250) * 100;
      invoices.push({
        id: `inv_${i}`,
        invoiceNumber: invNum,
        amountCents,
        currency: 'EUR',
        issueDate: '2024-09-01',
        status: 'OPEN',
        customerName: `Customer ${i % 50} GmbH`,
        customerIban: `DE893704004405320${String(i % 50).padStart(5, '0')}`,
      });

      let txAmountCents = amountCents;
      let reference = `Payment for ${invNum}`;
      if (i % 10 === 0) {
        txAmountCents = Math.max(1000, amountCents - 1500);
        reference = `Net payment for invoice ${invNum}`;
      } else if (i % 7 === 0) {
        reference = `Invoice ${invNum.replace('-', ' ')} transfer`;
      }

      transactions.push({
        id: `tx_${i}`,
        bookingDate: '2024-09-02',
        amountCents: txAmountCents,
        currency: 'EUR',
        direction: 'INCOMING',
        counterpartyName: `Customer ${i % 50} GmbH`,
        reference,
        sourceFormat: 'test',
      });
    }

    const start = performance.now();
    const report = reconcile(transactions, invoices);
    const durationMs = performance.now() - start;

    expect(report.summary.totalTransactions).toBe(5000);
    expect(report.summary.totalInvoices).toBe(5000);
    expect(report.summary.matchedCount + report.summary.reviewNeededCount).toBe(5000);
    expect(durationMs).toBeLessThan(300);
  });
});

describe('CLI recon match command', () => {
  const statementFile = join(FIXTURES_DIR, 'camt053/camt053-standard-v2.xml');
  const invoicesFile = join(FIXTURES_DIR, 'invoices/invoices.json');

  it('executes reconciliation and outputs formatted terminal summary', () => {
    const res = spawnSync(
      'bun',
      [CLI_PATH, 'match', '--statement', statementFile, '--invoices', invoicesFile, '--non-interactive'],
      { encoding: 'utf-8' }
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Reconciliation Results');
    expect(res.stdout).toContain('INV-2024-501');
    expect(res.stdout).toContain('Reconciled (MATCHED)');
  });

  it('outputs complete JSON report when using --json', () => {
    const res = spawnSync(
      'bun',
      [CLI_PATH, 'match', '--statement', statementFile, '--invoices', invoicesFile, '--json'],
      { encoding: 'utf-8' }
    );
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.id).toBeDefined();
    expect(report.summary.totalTransactions).toBeGreaterThan(0);
    expect(report.summary.matchedCount).toBeGreaterThanOrEqual(1);
    expect(report.matches.some((m: any) => m.status === 'MATCHED')).toBe(true);
  });

  it('auto-confirms review suggestions with --yes flag', () => {
    const revolutStmt = join(FIXTURES_DIR, 'revolut/revolut-wire-invoices.csv');
    const res = spawnSync(
      'bun',
      [CLI_PATH, 'match', '--statement', revolutStmt, '--invoices', invoicesFile, '--yes', '--json'],
      { encoding: 'utf-8' }
    );
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.summary.reviewNeededCount).toBe(0);
    expect(report.summary.matchedCount).toBeGreaterThanOrEqual(2);
  });

  it('supports --force flag in CLI match command for risky counterparty confirmation', () => {
    const res = spawnSync('bun', [CLI_PATH, 'match', '--help'], { encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('--force');
  });
});
