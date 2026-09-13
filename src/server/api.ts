import { Elysia } from 'elysia';
import { z } from 'zod';
import { parseStatement } from '../parsers/index.js';
import { loadInvoices, parseInvoices, InvalidInvoiceDataError } from '../matcher/invoices.js';
import { reconcile, type MatcherOptions } from '../matcher/engine.js';
import { NormalizedInvoiceSchema, type NormalizedInvoice } from '../schemas/invoice.js';

export const ParseRequestSchema = z.object({
  content: z.string().optional(),
  file: z.custom<Blob>((val) => val instanceof Blob || (val && typeof (val as { text?: unknown }).text === 'function')).optional(),
  format: z.string().optional(),
  columnMapping: z.record(z.string()).optional(),
  defaultCurrency: z.string().optional(),
}).refine(
  (data) => (typeof data.content === 'string' && data.content.trim().length > 0) || data.file !== undefined,
  { message: 'Missing statement content. Provide via body.content or multipart file field.' }
);

export type ParseRequest = z.infer<typeof ParseRequestSchema>;

export const MatchRequestSchema = z.object({
  statement: z.union([
    z.string().min(1, 'Missing statement content in request.'),
    z.custom<Blob>((val) => val instanceof Blob || (val && typeof (val as { text?: unknown }).text === 'function'), {
      message: 'statement must be string or file/Blob',
    }),
  ]),
  invoices: z.union([
    z.array(NormalizedInvoiceSchema).min(1, 'Invoices array cannot be empty'),
    z.string().min(1, 'Missing invoices content in request.'),
    z.custom<Blob>((val) => val instanceof Blob || (val && typeof (val as { text?: unknown }).text === 'function'), {
      message: 'invoices must be string, array of invoices, or file/Blob',
    }),
  ]),
  format: z.string().optional(),
  options: z
    .object({
      format: z.string().optional(),
      columnMapping: z.record(z.string()).optional(),
      defaultCurrency: z.string().optional(),
    })
    .passthrough()
    .optional(),
  dateToleranceDays: z.coerce.number().int().nonnegative().optional().default(2),
  feeToleranceCents: z.coerce.number().int().nonnegative().optional().default(2500),
  feeTolerancePercent: z.coerce.number().min(0).max(1).optional(),
  feeTolerancePercentage: z.coerce.number().min(0).max(1).optional(),
});

export type MatchRequest = z.infer<typeof MatchRequestSchema>;

async function extractPayload(request: Request, body: unknown): Promise<unknown> {
  if (body !== undefined && body !== null && typeof body === 'object') {
    return body;
  }
  try {
    return await request.json();
  } catch {
    if (typeof body === 'string') {
      try {
        return JSON.parse(body);
      } catch {
        return { content: body };
      }
    }
    return body;
  }
}

export function createServerApp() {
  const app = new Elysia()
    .get('/health', () => ({
      status: 'ok',
      version: '0.2.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }))
    .post('/v1/parse', async ({ request, body, set }) => {
      try {
        const raw = await extractPayload(request, body);
        const payload = ParseRequestSchema.parse(
          typeof raw === 'string' ? { content: raw } : raw
        );

        let content = '';
        const fileObj = payload.file as any;
        if (fileObj instanceof Blob || (fileObj && typeof fileObj.text === 'function')) {
          content = await fileObj.text();
        } else if (payload.content) {
          content = payload.content;
        }

        if (!content || content.trim().length === 0) {
          set.status = 400;
          return { error: 'Missing statement content. Provide via body.content or multipart file field.' };
        }

        const result = await parseStatement(content, {
          format: payload.format,
          columnMapping: payload.columnMapping,
          defaultCurrency: payload.defaultCurrency,
        });

        return {
          parserId: result.parserId,
          parserName: result.parserName,
          count: result.transactions.length,
          transactions: result.transactions,
          rejectedRows: result.rejectedRows,
        };
      } catch (err: unknown) {
        set.status = 400;
        if (err instanceof z.ZodError) {
          return { error: err.errors.map((e) => e.message).join('; ') };
        }
        if (err instanceof Error) {
          return { error: err.message };
        }
        return { error: 'Failed to parse statement' };
      }
    })
    .post('/v1/match', async ({ request, body, set }) => {
      try {
        const contentType = request.headers.get('content-type') || '';
        const isMultipart =
          contentType.includes('multipart/form-data') ||
          body instanceof FormData ||
          (body &&
            typeof body === 'object' &&
            ('file' in (body as any) ||
              (body as any).statement instanceof Blob ||
              (body as any).invoices instanceof Blob));

        let queryFormat: string | undefined;
        try {
          const url = new URL(request.url);
          queryFormat = url.searchParams.get('format') || undefined;
        } catch {
          // ignore url parsing error
        }

        let statementContent = '';
        let invoices: NormalizedInvoice[] = [];
        let explicitFormat: string | undefined;
        let columnMapping: Record<string, string> | undefined;
        let defaultCurrency: string | undefined;
        let dateToleranceDays = 2;
        let feeToleranceCents = 2500;
        let feeTolerancePercent: number | undefined;
        let feeTolerancePercentage: number | undefined;

        if (isMultipart) {
          let formBody: Record<string, any> = {};
          if (body && typeof body === 'object') {
            formBody = body as Record<string, any>;
          } else {
            try {
              const formData = await request.formData();
              formBody = Object.fromEntries(formData.entries());
            } catch {
              // ignore
            }
          }

          const rawStatement = formBody.file ?? formBody.statement;
          if (!rawStatement) {
            set.status = 400;
            return { error: 'Missing statement file or content in request.' };
          }

          if (rawStatement instanceof Blob || (rawStatement && typeof (rawStatement as any).text === 'function')) {
            statementContent = await (rawStatement as Blob).text();
          } else if (typeof rawStatement === 'string') {
            statementContent = rawStatement;
          }

          if (!statementContent || statementContent.trim().length === 0) {
            set.status = 400;
            return { error: 'Missing statement content in request.' };
          }

          const rawInvoices = formBody.invoices;
          if (!rawInvoices) {
            set.status = 400;
            return { error: 'Missing invoices content in request.' };
          }

          if (rawInvoices instanceof Blob || (rawInvoices && typeof (rawInvoices as any).text === 'function')) {
            const invoicesText = await (rawInvoices as Blob).text();
            invoices = await parseInvoices(invoicesText);
          } else if (typeof rawInvoices === 'string') {
            invoices = await parseInvoices(rawInvoices);
          } else if (Array.isArray(rawInvoices)) {
            const parsedArray = z.array(NormalizedInvoiceSchema).safeParse(rawInvoices);
            if (!parsedArray.success) {
              set.status = 400;
              return { error: parsedArray.error.errors.map((e) => e.message).join('; ') };
            }
            invoices = parsedArray.data;
          }

          if (invoices.length === 0) {
            set.status = 400;
            return { error: 'Invoices array cannot be empty.' };
          }

          explicitFormat = formBody.format || queryFormat;
          if (formBody.options && typeof formBody.options === 'string') {
            try {
              const parsedOpts = JSON.parse(formBody.options);
              explicitFormat = explicitFormat || parsedOpts.format;
              columnMapping = parsedOpts.columnMapping;
              defaultCurrency = parsedOpts.defaultCurrency;
            } catch {
              // ignore json parse error
            }
          }

          if (formBody.dateToleranceDays !== undefined) {
            const parsed = Number(formBody.dateToleranceDays);
            if (!isNaN(parsed)) dateToleranceDays = parsed;
          }
          if (formBody.feeToleranceCents !== undefined) {
            const parsed = Number(formBody.feeToleranceCents);
            if (!isNaN(parsed)) feeToleranceCents = parsed;
          }
          if (formBody.feeTolerancePercent !== undefined) {
            const parsed = Number(formBody.feeTolerancePercent);
            if (!isNaN(parsed)) feeTolerancePercent = parsed;
          }
          if (formBody.feeTolerancePercentage !== undefined) {
            const parsed = Number(formBody.feeTolerancePercentage);
            if (!isNaN(parsed)) feeTolerancePercentage = parsed;
          }
        } else {
          // application/json (or other standard payload)
          const raw = await extractPayload(request, body);
          const payload = MatchRequestSchema.parse(raw);

          const stmtObj = payload.statement as any;
          if (stmtObj instanceof Blob || (stmtObj && typeof stmtObj.text === 'function')) {
            statementContent = await stmtObj.text();
          } else {
            statementContent = payload.statement as string;
          }

          const invObj = payload.invoices as any;
          if (Array.isArray(payload.invoices)) {
            // Strictly validated via NormalizedInvoiceSchema
            invoices = payload.invoices;
          } else if (invObj instanceof Blob || (invObj && typeof invObj.text === 'function')) {
            const invoicesText = await invObj.text();
            invoices = await parseInvoices(invoicesText);
          } else if (typeof payload.invoices === 'string') {
            invoices = await parseInvoices(payload.invoices);
          }

          explicitFormat = payload.format || payload.options?.format || queryFormat;
          columnMapping = payload.options?.columnMapping;
          defaultCurrency = payload.options?.defaultCurrency;
          dateToleranceDays = payload.dateToleranceDays ?? 2;
          feeToleranceCents = payload.feeToleranceCents ?? 2500;
          feeTolerancePercent = payload.feeTolerancePercent;
          feeTolerancePercentage = payload.feeTolerancePercentage;
        }

        const stmtResult = await parseStatement(statementContent, {
          format: explicitFormat,
          columnMapping,
          defaultCurrency,
        });

        const report = reconcile(stmtResult.transactions, invoices, {
          dateToleranceDays,
          feeToleranceCents,
          feeTolerancePercent,
          feeTolerancePercentage,
          sourceFormat: stmtResult.parserName,
        });

        return report;
      } catch (err: unknown) {
        set.status = 400;
        if (err instanceof InvalidInvoiceDataError) {
          return { error: err.message };
        }
        if (err instanceof z.ZodError) {
          return { error: err.errors.map((e) => e.message).join('; ') };
        }
        if (err instanceof Error) {
          return { error: err.message };
        }
        return { error: 'Failed to reconcile statement' };
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
    } catch (err: unknown) {
      const isAddrInUse =
        err instanceof Error &&
        ('code' in err ? err.code === 'EADDRINUSE' : err.message.includes('EADDRINUSE'));
      if (isAddrInUse && !strict) {
        port++;
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Could not find an available port after ${maxAttempts} attempts starting from ${initialPort}`);
}
