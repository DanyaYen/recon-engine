import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseStatement } from '../src/parsers/index.js';
import { detectFormat } from '../src/parsers/detector.js';

const FIXTURES_DIR = join(import.meta.dir, 'fixtures');

describe('Universal Statement Parser - Auto Detection and Parsing', () => {
  // 1. Revolut fixtures
  describe('Revolut Business CSV', () => {
    const revolutDir = join(FIXTURES_DIR, 'revolut');
    const files = readdirSync(revolutDir);

    it('has at least 5 fixtures', () => {
      expect(files.length).toBeGreaterThanOrEqual(5);
    });

    for (const file of files) {
      it(`parses ${file} correctly`, async () => {
        const content = readFileSync(join(revolutDir, file), 'utf-8');
        const detected = detectFormat(content, file);
        expect(detected.id).toBe('revolut-csv');

        const result = await parseStatement(content);
        expect(result.parserId).toBe('revolut-csv');
        expect(result.transactions.length).toBeGreaterThan(0);

        for (const tx of result.transactions) {
          expect(tx.bookingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(tx.amountCents).toBeGreaterThan(0);
          expect(['INCOMING', 'OUTGOING']).toContain(tx.direction);
          expect(tx.currency.length).toBe(3);
        }
      });
    }

    it('filters out REVERTED and DECLINED transactions in revolut-with-reverted.csv', async () => {
      const content = readFileSync(join(revolutDir, 'revolut-with-reverted.csv'), 'utf-8');
      const result = await parseStatement(content);
      // Original file has 4 rows: 2 COMPLETED, 1 DECLINED, 1 REVERTED
      expect(result.transactions.length).toBe(2);
      expect(result.transactions[0].amountCents).toBe(100000);
      expect(result.transactions[1].amountCents).toBe(200000);
    });
  });

  // 2. Stripe fixtures
  describe('Stripe Export CSV', () => {
    const stripeDir = join(FIXTURES_DIR, 'stripe');
    const files = readdirSync(stripeDir);

    it('has at least 4 fixtures', () => {
      expect(files.length).toBeGreaterThanOrEqual(4);
    });

    for (const file of files) {
      it(`parses ${file} correctly`, async () => {
        const content = readFileSync(join(stripeDir, file), 'utf-8');
        const detected = detectFormat(content, file);
        expect(detected.id).toBe('stripe-csv');

        const result = await parseStatement(content);
        expect(result.parserId).toBe('stripe-csv');
        expect(result.transactions.length).toBeGreaterThan(0);

        for (const tx of result.transactions) {
          expect(tx.bookingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(tx.amountCents).toBeGreaterThan(0);
          expect(['INCOMING', 'OUTGOING']).toContain(tx.direction);
        }
      });
    }
  });

  // 3. CAMT.053 XML fixtures
  describe('CAMT.053 ISO 20022 XML', () => {
    const camtDir = join(FIXTURES_DIR, 'camt053');
    const files = readdirSync(camtDir);

    it('has at least 5 fixtures', () => {
      expect(files.length).toBeGreaterThanOrEqual(5);
    });

    for (const file of files) {
      it(`parses ${file} correctly`, async () => {
        const content = readFileSync(join(camtDir, file), 'utf-8');
        const detected = detectFormat(content, file);
        expect(detected.id).toBe('camt053');

        const result = await parseStatement(content);
        expect(result.parserId).toBe('camt053');
        expect(result.transactions.length).toBeGreaterThan(0);

        for (const tx of result.transactions) {
          expect(tx.bookingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(tx.amountCents).toBeGreaterThan(0);
          expect(tx.currency).toBe('EUR');
        }
      });
    }

    it('extracts structured creditor reference in camt053-structured-reference.xml', async () => {
      const content = readFileSync(join(camtDir, 'camt053-structured-reference.xml'), 'utf-8');
      const result = await parseStatement(content);
      expect(result.transactions[0].reference).toBe('INV-2024-8891');
      expect(result.transactions[0].counterpartyName).toBe('KPMG Advisory GmbH');
    });

    it('handles prefixed XML namespaces and reverses transaction direction when RvslInd is true', async () => {
      const content = readFileSync(join(camtDir, 'camt053-prefixed-ns.xml'), 'utf-8');
      const result = await parseStatement(content);
      expect(result.transactions.length).toBe(2);

      const [normalTx, reversedTx] = result.transactions;
      expect(normalTx.amountCents).toBe(150000);
      expect(normalTx.direction).toBe('INCOMING');
      expect(normalTx.counterpartyName).toBe('Acme Enterprise GmbH');
      expect(normalTx.reference).toBe('Invoice INV-2024-PREFIX-1');

      expect(reversedTx.amountCents).toBe(25000);
      expect(reversedTx.direction).toBe('OUTGOING');
      expect(reversedTx.counterpartyName).toBe('Reversed Client');
      expect(reversedTx.reference).toBe('Reversal of returned direct debit');
    });

    it('parses individual TxDtls amounts without duplicating parent Ntry amount', async () => {
      const content = readFileSync(join(camtDir, 'camt053-split-txdtls.xml'), 'utf-8');
      const result = await parseStatement(content);
      expect(result.transactions.length).toBe(2);

      const [tx1, tx2] = result.transactions;
      expect(tx1.amountCents).toBe(40000);
      expect(tx1.counterpartyName).toBe('Client Alpha GmbH');
      expect(tx1.reference).toBe('Payment Part 1 INV-2024-ALPHA');

      expect(tx2.amountCents).toBe(60000);
      expect(tx2.counterpartyName).toBe('Client Beta BV');
      expect(tx2.reference).toBe('Payment Part 2 INV-2024-BETA');

      expect(tx1.amountCents + tx2.amountCents).toBe(100000);
    });

    it('avoids duplicating parent amount when multiple TxDtls lack individual amounts', async () => {
      const content = readFileSync(join(camtDir, 'camt053-batch-no-subamt.xml'), 'utf-8');
      const result = await parseStatement(content);
      expect(result.transactions.length).toBe(1);
      expect(result.transactions[0].amountCents).toBe(80000);
      expect(result.transactions[0].reference).toContain('Sub-item 1');
      expect(result.transactions[0].reference).toContain('Sub-item 2');
    });

    it('handles namespaced XML (<ns2:Document>) and asserts correct inverted debit/credit for both CRDT and DBIT with RvslInd=true', async () => {
      const content = readFileSync(join(camtDir, 'camt053-reversals-debit-credit.xml'), 'utf-8');
      const result = await parseStatement(content);
      expect(result.transactions.length).toBe(2);

      const [crdtReversal, dbitReversal] = result.transactions;

      // CRDT (normally INCOMING) reversed -> must become OUTGOING (debit)
      expect(crdtReversal.amountCents).toBe(35000);
      expect(crdtReversal.direction).toBe('OUTGOING');
      expect(crdtReversal.isReversal).toBe(true);
      expect(crdtReversal.counterpartyName).toBe('Reversed Credit Payer');
      expect(crdtReversal.reference).toBe('Reversed Incoming Transfer');

      // DBIT (normally OUTGOING) reversed -> must become INCOMING (credit)
      expect(dbitReversal.amountCents).toBe(12000);
      expect(dbitReversal.direction).toBe('INCOMING');
      expect(dbitReversal.isReversal).toBe(true);
      expect(dbitReversal.counterpartyName).toBe('Reversed Debit Beneficiary');
      expect(dbitReversal.reference).toBe('Reversed Outgoing Wire Fee');
    });
  });

  // 4. SWIFT MT940 fixtures
  describe('SWIFT MT940', () => {
    const mt940Dir = join(FIXTURES_DIR, 'mt940');
    const files = readdirSync(mt940Dir);

    it('has at least 5 fixtures', () => {
      expect(files.length).toBeGreaterThanOrEqual(5);
    });

    for (const file of files) {
      it(`parses ${file} correctly`, async () => {
        const content = readFileSync(join(mt940Dir, file), 'utf-8');
        const detected = detectFormat(content, file);
        expect(detected.id).toBe('mt940');

        const result = await parseStatement(content);
        expect(result.parserId).toBe('mt940');
        expect(result.transactions.length).toBeGreaterThan(0);

        for (const tx of result.transactions) {
          expect(tx.bookingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(tx.amountCents).toBeGreaterThan(0);
        }
      });
    }

    it('extracts counterparty and reference from Deutsche Bank subfields ?20 and ?32', async () => {
      const content = readFileSync(join(mt940Dir, 'mt940-deutsche-bank.sta'), 'utf-8');
      const result = await parseStatement(content);
      expect(result.transactions.length).toBe(2);
      expect(result.transactions[0].counterpartyName).toBe('BMW GROUP AG');
      expect(result.transactions[0].reference).toContain('INV-2024-701');
    });

    it('extracts counterparty and reference from Commerzbank /EREF/ and /BENM/', async () => {
      const content = readFileSync(join(mt940Dir, 'mt940-commerzbank.sta'), 'utf-8');
      const result = await parseStatement(content);
      expect(result.transactions[0].counterpartyName).toBe('ZALANDO SE');
      expect(result.transactions[0].reference).toBe('INV-2024-998');
    });

    it('unwraps SWIFT envelopes ({1:...}{4:... -}) and parses transactions in mt940-enveloped.sta', async () => {
      const content = readFileSync(join(mt940Dir, 'mt940-enveloped.sta'), 'utf-8');
      const detected = detectFormat(content, 'mt940-enveloped.sta');
      expect(detected.id).toBe('mt940');

      const result = await parseStatement(content);
      expect(result.parserId).toBe('mt940');
      expect(result.transactions.length).toBe(2);
      expect(result.rejectedRows.length).toBe(0);

      const [tx1, tx2] = result.transactions;
      expect(tx1.bookingDate).toBe('2024-09-01');
      expect(tx1.amountCents).toBe(150000);
      expect(tx1.direction).toBe('INCOMING');
      expect(tx1.reference).toContain('INV-2024-ENV1');

      expect(tx2.bookingDate).toBe('2024-09-02');
      expect(tx2.amountCents).toBe(45000);
      expect(tx2.direction).toBe('OUTGOING');
      expect(tx2.reference).toContain('INV-2024-ENV2');
    });
  });

  // 5. Generic CSV fixtures
  describe('Generic CSV & Custom Mapping', () => {
    const genericDir = join(FIXTURES_DIR, 'generic');

    it('parses German semicolon statement with automatic synonym detection', async () => {
      const content = readFileSync(join(genericDir, 'generic-european-semicolon.csv'), 'utf-8');
      const result = await parseStatement(content);
      expect(result.transactions.length).toBe(3);
      expect(result.transactions[0].amountCents).toBe(345000);
      expect(result.transactions[0].direction).toBe('INCOMING');
      expect(result.transactions[1].amountCents).toBe(14990);
      expect(result.transactions[1].direction).toBe('OUTGOING');
    });

    it('parses multiline quoted CSV correctly', async () => {
      const content = readFileSync(join(genericDir, 'generic-quoted-multiline.csv'), 'utf-8');
      const result = await parseStatement(content);
      expect(result.transactions.length).toBe(2);
      expect(result.transactions[0].amountCents).toBe(150050);
      expect(result.transactions[0].reference).toContain('Invoice #2024-99');
    });

    it('supports custom --map parameter for generic-custom-headers.csv', async () => {
      const content = readFileSync(join(genericDir, 'generic-custom-headers.csv'), 'utf-8');
      const result = await parseStatement(content, {
        columnMapping: {
          date: 'col_when',
          counterparty: 'col_who',
          amount: 'col_val',
          reference: 'col_note',
        },
      });
      expect(result.transactions.length).toBe(3);
      expect(result.transactions[0].bookingDate).toBe('2024-09-01');
      expect(result.transactions[0].counterpartyName).toBe('FinTech Client A');
      expect(result.transactions[0].reference).toBe('INV-MAP-001');
      expect(result.transactions[0].amountCents).toBe(220000);
    });

    it('quarantines invalid rows into rejectedRows while parsing valid rows in batch', async () => {
      const content = readFileSync(join(genericDir, 'generic-with-invalid-row.csv'), 'utf-8');
      const result = await parseStatement(content);
      expect(result.parserId).toBe('generic-csv');
      expect(result.transactions.length).toBe(2);
      expect(result.rejectedRows.length).toBe(1);

      // Valid transactions
      expect(result.transactions[0].bookingDate).toBe('2024-09-01');
      expect(result.transactions[0].amountCents).toBe(15000);
      expect(result.transactions[0].counterpartyName).toBe('Alpha Services');

      expect(result.transactions[1].bookingDate).toBe('2024-09-03');
      expect(result.transactions[1].amountCents).toBe(30000);
      expect(result.transactions[1].counterpartyName).toBe('Gamma Holdings');

      // Quarantined invalid row
      const rejected = result.rejectedRows[0];
      expect(rejected.index).toBe(1);
      expect(rejected.error).toBeDefined();
      expect(rejected.error.issues.length).toBeGreaterThan(0);
      expect((rejected.raw as any).counterpartyName || (rejected.raw as any).counterparty).toContain('Bad Date');
    });
  });
});
