import { describe, it, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { generateTransactionFingerprint } from '../src/utils/fingerprint.js';
import { GenericCsvParser } from '../src/parsers/csv/generic.js';
import { Mt940Parser } from '../src/parsers/swift/mt940.js';
import { Camt053Parser } from '../src/parsers/xml/camt053.js';
import { reconcile } from '../src/matcher/engine.js';
import type { NormalizedTransaction } from '../src/schemas/transaction.js';
import type { NormalizedInvoice } from '../src/schemas/invoice.js';

describe('Canonical SHA-256 Idempotency Fingerprint', () => {
  it('generates expected SHA-256 hex digest from canonical payload', () => {
    const params = {
      accountIban: ' DE89370400440532013000 ',
      bookingDate: '2024-09-01',
      amountCents: 150000,
      currency: 'eur',
      bankRef: ' INV-2024-001 ',
      endToEndId: ' E2E-9999 ',
      direction: 'INCOMING' as const,
    };

    const expectedPayload =
      'DE89370400440532013000|2024-09-01|150000|EUR|INV-2024-001|E2E-9999|INCOMING';
    const expectedHash = createHash('sha256').update(expectedPayload).digest('hex');

    const result = generateTransactionFingerprint(params);
    expect(result).toBe(expectedHash);
    expect(result.length).toBe(64);
  });

  it('handles empty or missing optional fields with empty strings in payload', () => {
    const params = {
      accountIban: undefined,
      bookingDate: '2024-09-05',
      amountCents: 4200,
      currency: 'USD',
      bankRef: undefined,
      endToEndId: null,
      direction: 'OUTGOING' as const,
    };

    const expectedPayload = '|2024-09-05|4200|USD|||OUTGOING';
    const expectedHash = createHash('sha256').update(expectedPayload).digest('hex');

    expect(generateTransactionFingerprint(params)).toBe(expectedHash);
  });

  it('asserts identical inputs with shuffled lines produce the exact same IDs in GenericCsvParser', async () => {
    const parser = new GenericCsvParser();

    const originalCsv = `Date,Amount,Currency,Reference,Counterparty
2024-09-01,150.00,EUR,INV-2024-001,Acme Corp
2024-09-02,250.50,EUR,INV-2024-002,Beta Ltd
2024-09-03,300.00,EUR,INV-2024-003,Gamma Inc`;

    const shuffledCsv = `Date,Amount,Currency,Reference,Counterparty
2024-09-03,300.00,EUR,INV-2024-003,Gamma Inc
2024-09-01,150.00,EUR,INV-2024-001,Acme Corp
2024-09-02,250.50,EUR,INV-2024-002,Beta Ltd`;

    const originalTxs = await parser.parse(originalCsv);
    const shuffledTxs = await parser.parse(shuffledCsv);

    expect(originalTxs.length).toBe(3);
    expect(shuffledTxs.length).toBe(3);

    const originalMap = new Map(originalTxs.map((tx) => [tx.reference, tx.id]));
    const shuffledMap = new Map(shuffledTxs.map((tx) => [tx.reference, tx.id]));

    // All transaction IDs must match regardless of row position/line order
    expect(shuffledMap.get('INV-2024-001')).toBe(originalMap.get('INV-2024-001')!);
    expect(shuffledMap.get('INV-2024-002')).toBe(originalMap.get('INV-2024-002')!);
    expect(shuffledMap.get('INV-2024-003')).toBe(originalMap.get('INV-2024-003')!);

    // Ensure IDs are 64-character SHA-256 hashes rather than row indices
    for (const tx of originalTxs) {
      expect(tx.id).toMatch(/^[a-f0-9]{64}$/);
      expect(tx.id).not.toContain('csv-');
    }
  });

  it('produces identical fingerprint IDs when MT940 transactions without bankRef are shuffled', async () => {
    const parser = new Mt940Parser();

    const mt940OrderA = `:20:STMT-001
:25:DE89370400440532013000
:28C:001/01
:60F:C240901EUR10000,00
:61:2409010901C1500,00NTRFNONREF//
:86:INV-2024-ALPHA
:61:2409020902C2500,00NTRFNONREF//
:86:INV-2024-BETA
:62F:C240902EUR14000,00
-`;

    const mt940OrderB = `:20:STMT-002
:25:DE89370400440532013000
:28C:001/01
:60F:C240901EUR10000,00
:61:2409020902C2500,00NTRFNONREF//
:86:INV-2024-BETA
:61:2409010901C1500,00NTRFNONREF//
:86:INV-2024-ALPHA
:62F:C240902EUR14000,00
-`;

    const txsA = await parser.parse(mt940OrderA);
    const txsB = await parser.parse(mt940OrderB);

    expect(txsA.length).toBe(2);
    expect(txsB.length).toBe(2);

    const mapA = new Map(txsA.map((t) => [t.reference, t.id]));
    const mapB = new Map(txsB.map((t) => [t.reference, t.id]));

    expect(mapA.get('INV-2024-ALPHA')).toBe(mapB.get('INV-2024-ALPHA')!);
    expect(mapA.get('INV-2024-BETA')).toBe(mapB.get('INV-2024-BETA')!);
    expect(mapA.get('INV-2024-ALPHA')!).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces identical fingerprint IDs when CAMT.053 entries without unique bank IDs are shuffled', async () => {
    const parser = new Camt053Parser();

    const camtOrderA = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Acct><Id><IBAN>DE89370400440532013000</IBAN></Id></Acct>
      <Ntry>
        <Amt Ccy="EUR">400.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2024-09-01</Dt></BookgDt>
        <NtryDtls><TxDtls><RmtInf><Ustrd>INV-CAMT-1</Ustrd></RmtInf></TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">600.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2024-09-02</Dt></BookgDt>
        <NtryDtls><TxDtls><RmtInf><Ustrd>INV-CAMT-2</Ustrd></RmtInf></TxDtls></NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

    const camtOrderB = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Acct><Id><IBAN>DE89370400440532013000</IBAN></Id></Acct>
      <Ntry>
        <Amt Ccy="EUR">600.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2024-09-02</Dt></BookgDt>
        <NtryDtls><TxDtls><RmtInf><Ustrd>INV-CAMT-2</Ustrd></RmtInf></TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">400.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2024-09-01</Dt></BookgDt>
        <NtryDtls><TxDtls><RmtInf><Ustrd>INV-CAMT-1</Ustrd></RmtInf></TxDtls></NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

    const txsA = await parser.parse(camtOrderA);
    const txsB = await parser.parse(camtOrderB);

    expect(txsA.length).toBe(2);
    expect(txsB.length).toBe(2);

    const mapA = new Map(txsA.map((t) => [t.reference, t.id]));
    const mapB = new Map(txsB.map((t) => [t.reference, t.id]));

    expect(mapA.get('INV-CAMT-1')).toBe(mapB.get('INV-CAMT-1')!);
    expect(mapA.get('INV-CAMT-2')).toBe(mapB.get('INV-CAMT-2')!);
    expect(mapA.get('INV-CAMT-1')!).toMatch(/^[a-f0-9]{64}$/);
  });

  it('deduplicates incoming transactions by id prior to executing matches in reconciliation engine', () => {
    const tx1: NormalizedTransaction = {
      id: 'sha256_canonical_tx_1',
      bookingDate: '2024-09-01',
      amountCents: 10000,
      currency: 'EUR',
      direction: 'INCOMING',
      reference: 'INV-2024-DUP-1',
      sourceFormat: 'generic-csv',
    };

    // Duplicate transaction with identical id (e.g. from file re-export)
    const tx1Duplicate: NormalizedTransaction = {
      ...tx1,
    };

    const inv: NormalizedInvoice = {
      id: 'inv_dup_1',
      invoiceNumber: 'INV-2024-DUP-1',
      amountCents: 10000,
      currency: 'EUR',
      issueDate: '2024-09-01',
      status: 'OPEN',
      customerName: 'Dup Client',
    };

    const report = reconcile([tx1, tx1Duplicate], [inv]);

    // Matching engine must have deduplicated the duplicate incoming transaction
    expect(report.summary.totalTransactions).toBe(1);
    expect(report.summary.matchedCount).toBe(1);
    expect(report.matches.length).toBe(1);
    expect(report.matches[0].transaction.id).toBe('sha256_canonical_tx_1');
    expect(report.matches[0].invoice?.id).toBe('inv_dup_1');
  });
});
