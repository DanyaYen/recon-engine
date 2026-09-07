import { describe, it, expect } from 'bun:test';
import { createServerApp } from '../src/server/api.js';

describe('HTTP API Server (Elysia)', () => {
  const app = createServerApp();

  it('responds to GET /health', async () => {
    const res = await app.handle(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.2.0');
  });

  it('parses statement via POST /v1/parse (JSON payload)', async () => {
    const csvContent = `Completed Date,Description,Amount,Fee,Currency,State,Balance,Payer,Beneficiary,Reference\n2024-09-01 10:00:00,Transfer from Alpha Labs,2500.00,0.00,EUR,COMPLETED,2500.00,Alpha Labs GmbH,,INV-ALPHA-01`;

    const res = await app.handle(
      new Request('http://localhost/v1/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: csvContent }),
      })
    );

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.parserId).toBe('revolut-csv');
    expect(body.count).toBe(1);
    expect(body.transactions[0].amountCents).toBe(250000);
    expect(body.transactions[0].counterpartyName).toBe('Alpha Labs GmbH');
  });

  it('reconciles statements and invoices via POST /v1/match', async () => {
    const stmtCsv = `Completed Date,Description,Amount,Fee,Currency,State,Balance,Payer,Beneficiary,Reference\n2024-09-01 10:00:00,Payment from Acme Corp,1500.00,0.00,EUR,COMPLETED,1500.00,Acme Corp GmbH,,INV-2024-001`;

    const invoices = [
      {
        id: 'inv_1',
        invoiceNumber: 'INV-2024-001',
        amountCents: 150000,
        currency: 'EUR',
        issueDate: '2024-09-01',
        status: 'OPEN',
        customerName: 'Acme Corp GmbH',
      },
    ];

    const res = await app.handle(
      new Request('http://localhost/v1/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          statement: stmtCsv,
          invoices,
        }),
      })
    );

    expect(res.status).toBe(200);
    const report: any = await res.json();
    expect(report.summary.matchedCount).toBe(1);
    expect(report.matches[0].status).toBe('MATCHED');
    expect(report.matches[0].level).toBe('EXACT_REFERENCE');
  });

  it('returns 400 when statement content is missing', async () => {
    const res = await app.handle(
      new Request('http://localhost/v1/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBeDefined();
  });
});
