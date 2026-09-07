import { Elysia, t } from 'elysia';
import { parseStatement } from '../parsers/index.js';
import { loadInvoices } from '../matcher/invoices.js';
import { reconcile, type MatcherOptions } from '../matcher/engine.js';
import type { NormalizedInvoice } from '../schemas/invoice.js';

export function createServerApp() {
  const app = new Elysia()
    .get('/health', () => ({
      status: 'ok',
      version: '0.2.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }))
    .post('/v1/parse', async ({ body, set }) => {
      try {
        let content = '';
        let format: string | undefined;
        let columnMapping: Record<string, string> | undefined;
        let defaultCurrency: string | undefined;

        const reqBody = body as any;

        if (typeof reqBody === 'string') {
          content = reqBody;
        } else if (reqBody && typeof reqBody === 'object') {
          // File upload via multipart
          if (reqBody.file instanceof Blob || (reqBody.file && typeof reqBody.file.text === 'function')) {
            content = await reqBody.file.text();
          } else if (typeof reqBody.content === 'string') {
            content = reqBody.content;
          }

          format = reqBody.format;
          columnMapping = reqBody.columnMapping;
          defaultCurrency = reqBody.defaultCurrency;
        }

        if (!content || content.trim().length === 0) {
          set.status = 400;
          return { error: 'Missing statement content. Provide via body.content or multipart file field.' };
        }

        const result = await parseStatement(content, {
          format,
          columnMapping,
          defaultCurrency,
        });

        return {
          parserId: result.parserId,
          parserName: result.parserName,
          count: result.transactions.length,
          transactions: result.transactions,
        };
      } catch (err: any) {
        set.status = 400;
        return { error: err.message || 'Failed to parse statement' };
      }
    })
    .post('/v1/match', async ({ body, set }) => {
      try {
        let statementContent = '';
        let invoicesInput: any = null;
        let format: string | undefined;
        let dateToleranceDays = 2;
        let feeToleranceCents = 2500;

        const reqBody = body as any;

        if (reqBody && typeof reqBody === 'object') {
          // 1. Resolve statement content
          if (reqBody.statement instanceof Blob || (reqBody.statement && typeof reqBody.statement.text === 'function')) {
            statementContent = await reqBody.statement.text();
          } else if (typeof reqBody.statement === 'string') {
            statementContent = reqBody.statement;
          }

          // 2. Resolve invoices input
          if (reqBody.invoices instanceof Blob || (reqBody.invoices && typeof reqBody.invoices.text === 'function')) {
            invoicesInput = await reqBody.invoices.text();
          } else if (reqBody.invoices) {
            invoicesInput = reqBody.invoices;
          }

          format = reqBody.format;
          if (reqBody.dateToleranceDays !== undefined) {
            dateToleranceDays = Number(reqBody.dateToleranceDays) || 2;
          }
          if (reqBody.feeToleranceCents !== undefined) {
            feeToleranceCents = Number(reqBody.feeToleranceCents) || 2500;
          }
        }

        if (!statementContent) {
          set.status = 400;
          return { error: 'Missing statement content in request.' };
        }
        if (!invoicesInput) {
          set.status = 400;
          return { error: 'Missing invoices content in request.' };
        }

        // Parse statement
        const stmtResult = await parseStatement(statementContent, { format });

        // Parse/load invoices
        let invoices: NormalizedInvoice[] = [];
        if (Array.isArray(invoicesInput)) {
          // Passed directly as array of invoice objects
          invoices = invoicesInput;
        } else if (typeof invoicesInput === 'string') {
          invoices = await loadInvoices(invoicesInput);
        } else {
          set.status = 400;
          return { error: 'Invalid invoices format. Expected JSON array or CSV/JSON string.' };
        }

        // Reconcile
        const report = reconcile(stmtResult.transactions, invoices, {
          dateToleranceDays,
          feeToleranceCents,
          sourceFormat: stmtResult.parserName,
        });

        return report;
      } catch (err: any) {
        set.status = 400;
        return { error: err.message || 'Failed to reconcile statement' };
      }
    });

  return app;
}

export interface ServerStartOptions {
  strictPort?: boolean;
  maxAttempts?: number;
}

export interface ServerInstance {
  app: ReturnType<typeof createServerApp>;
  port: number;
  initialPort: number;
  wasFallback: boolean;
}

export function startHttpServer(initialPort: number, options?: ServerStartOptions): ServerInstance {
  let port = initialPort;
  const maxAttempts = options?.maxAttempts ?? 30;
  const strict = options?.strictPort ?? false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const app = createServerApp();
      app.listen({
        port,
        reusePort: false,
      });
      return {
        app,
        port,
        initialPort,
        wasFallback: port !== initialPort,
      };
    } catch (err: any) {
      const isAddrInUse = err?.code === 'EADDRINUSE' || err?.message?.includes('EADDRINUSE');
      if (isAddrInUse && !strict) {
        port++;
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Could not find an available port after ${maxAttempts} attempts starting from ${initialPort}`);
}
