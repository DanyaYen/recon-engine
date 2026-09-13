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

  it('strictly validates invoices array against NormalizedInvoiceSchema', async () => {
    const stmtCsv = `Completed Date,Description,Amount,Fee,Currency,State,Balance,Payer,Beneficiary,Reference\n2024-09-01 10:00:00,Payment,1500.00,0.00,EUR,COMPLETED,1500.00,Acme Corp GmbH,,INV-2024-001`;

    // Malformed invoice missing required fields: amountCents, invoiceNumber, currency, issueDate
    const invalidInvoices = [
      {
        id: 'inv_broken',
        customerName: 'Acme Corp',
      },
    ];

    const res = await app.handle(
      new Request('http://localhost/v1/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          statement: stmtCsv,
          invoices: invalidInvoices,
        }),
      })
    );

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBeDefined();
  });

  it('rejects empty or missing parameters in POST /v1/match', async () => {
    const res = await app.handle(
      new Request('http://localhost/v1/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statement: '' }),
      })
    );
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBeDefined();
  });

  it('returns 400 on malformed invoice JSON in POST /v1/match and server remains alive for subsequent GET /health requests', async () => {
    const stmtCsv = `Completed Date,Description,Amount,Fee,Currency,State,Balance,Payer,Beneficiary,Reference\n2024-09-01 10:00:00,Payment,1500.00,0.00,EUR,COMPLETED,1500.00,Acme Corp GmbH,,INV-2024-001`;

    const invalidInvoiceJson = JSON.stringify([
      {
        id: 'inv_malformed',
        invoiceNumber: 'INV-2024-999',
        amountCents: 1500.5, // Float is invalid for amountCents
        currency: 'EUR',
        issueDate: '2024-09-01',
        customerName: 'Acme Corp',
      },
    ]);

    const res = await app.handle(
      new Request('http://localhost/v1/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          statement: stmtCsv,
          invoices: invalidInvoiceJson,
        }),
      })
    );

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBeDefined();

    // Verify the server did not crash and responds to subsequent requests
    const healthRes = await app.handle(new Request('http://localhost/health'));
    expect(healthRes.status).toBe(200);
    const healthBody: any = await healthRes.json();
    expect(healthBody.status).toBe('ok');
  });

  it('prioritizes explicit format over auto-detection in POST /v1/match', async () => {
    const stmtCsv = `Date,Amount,Currency,Partner Name,Label\n2024-09-01,1500.00,EUR,Stripe Payout,INV-2024-001`;
    const invoices = [
      {
        id: 'inv_1',
        invoiceNumber: 'INV-2024-001',
        amountCents: 150000,
        currency: 'EUR',
        issueDate: '2024-09-01',
        status: 'OPEN',
        customerName: 'Stripe Payout',
      },
    ];

    // 1. Explicit format at top level of body
    const res1 = await app.handle(
      new Request('http://localhost/v1/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          statement: stmtCsv,
          invoices,
          format: 'generic-csv',
        }),
      })
    );
    expect(res1.status).toBe(200);
    const report1: any = await res1.json();
    expect(report1.summary.matchedCount).toBe(1);

    // 2. Explicit format in options.format
    const res2 = await app.handle(
      new Request('http://localhost/v1/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          statement: stmtCsv,
          invoices,
          options: { format: 'generic-csv' },
        }),
      })
    );
    expect(res2.status).toBe(200);
    const report2: any = await res2.json();
    expect(report2.summary.matchedCount).toBe(1);

    // 3. Explicit format in query parameter
    const res3 = await app.handle(
      new Request('http://localhost/v1/match?format=generic-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          statement: stmtCsv,
          invoices,
        }),
      })
    );
    expect(res3.status).toBe(200);
    const report3: any = await res3.json();
    expect(report3.summary.matchedCount).toBe(1);
  });
});
