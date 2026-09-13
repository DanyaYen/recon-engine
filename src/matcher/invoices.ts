import { readFileSync, existsSync } from 'fs';
import { z } from 'zod';
import { NormalizedInvoiceSchema, type NormalizedInvoice } from '../schemas/invoice.js';
import { parseCsv } from '../utils/csv.js';
import { parseAmountToCents } from '../utils/money.js';
import { parseBankDate } from '../utils/date.js';

const INVOICE_SYNONYMS = {
  id: ['id', 'invoice_id', 'invoice id', 'uuid'],
  invoiceNumber: ['invoice number', 'number', 'invoicenumber', 'invoice_number', 'invoice_no', 'ref', 'inv'],
  amount: ['amount', 'amountcents', 'amount_cents', 'total', 'sum', 'gross', 'value'],
  currency: ['currency', 'ccy', 'curr'],
  issueDate: ['issue date', 'issue_date', 'date', 'created', 'created date', 'invoice date', 'invoicedate'],
  dueDate: ['due date', 'due_date', 'due', 'duedate'],
  status: ['status', 'state'],
  customerName: ['customer name', 'customer_name', 'customer', 'company', 'client', 'bill to', 'name'],
  customerEmail: ['customer email', 'customer_email', 'email', 'contact'],
  customerIban: ['customer iban', 'customer_iban', 'iban', 'account'],
};

export class InvalidInvoiceDataError extends Error {
  public details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'InvalidInvoiceDataError';
    this.details = details;
    Object.setPrototypeOf(this, InvalidInvoiceDataError.prototype);
  }
}

/**
 * Loads and validates invoices from a JSON file, CSV file, or raw string content.
 */
export async function loadInvoices(pathOrContent: string): Promise<NormalizedInvoice[]> {
  let content = pathOrContent;
  let isPath = false;

  if (existsSync(pathOrContent)) {
    content = readFileSync(pathOrContent, 'utf-8');
    isPath = true;
  }

  let parsedJson: unknown = null;
  let isJson = false;

  try {
    parsedJson = JSON.parse(content);
    isJson = true;
  } catch {
    // This is not JSON, proceed to CSV below
  }

  if (isJson) {
    // Validate JSON strictly without falling back to CSV
    const result = z.array(NormalizedInvoiceSchema).safeParse(parsedJson);
    if (!result.success) {
      console.error(`Validation error in invoices JSON:`, result.error.format());
      throw new InvalidInvoiceDataError(
        `Validation error in invoices JSON: ${result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
        result.error.format()
      );
    }
    return result.data;
  }

  // 2. CSV handling
  const trimmed = content.trim();
  const { headers, rows } = parseCsv(trimmed);
  if (rows.length === 0) {
    throw new Error('No invoice records found in input.');
  }

  const lowerHeaders = headers.map((h) => ({ original: h, lower: h.toLowerCase().trim() }));

  const findCol = (keys: string[]): string | undefined => {
    const match = lowerHeaders.find((h) => keys.some((k) => h.lower === k || h.lower.includes(k)));
    return match ? match.original : undefined;
  };

  const idCol = findCol(INVOICE_SYNONYMS.id);
  const numberCol = findCol(INVOICE_SYNONYMS.invoiceNumber);
  const amountCol = findCol(INVOICE_SYNONYMS.amount);
  const currencyCol = findCol(INVOICE_SYNONYMS.currency);
  const issueDateCol = findCol(INVOICE_SYNONYMS.issueDate);
  const dueDateCol = findCol(INVOICE_SYNONYMS.dueDate);
  const statusCol = findCol(INVOICE_SYNONYMS.status);
  const customerCol = findCol(INVOICE_SYNONYMS.customerName);
  const emailCol = findCol(INVOICE_SYNONYMS.customerEmail);
  const ibanCol = findCol(INVOICE_SYNONYMS.customerIban);

  const invoices: NormalizedInvoice[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    const invoiceNumber = (numberCol ? row[numberCol] : undefined) || `INV-${i + 1}`;
    const id = (idCol ? row[idCol] : undefined) || `inv-${i + 1}`;

    const rawAmount = amountCol ? row[amountCol] : '0';
    const { amountCents } = parseAmountToCents(rawAmount);

    const currency = (currencyCol && row[currencyCol] ? row[currencyCol] : 'EUR').toUpperCase();
    const issueDate = parseBankDate(issueDateCol ? row[issueDateCol] : undefined);
    const dueDate = dueDateCol && row[dueDateCol] ? parseBankDate(row[dueDateCol]) : undefined;

    const rawStatus = (statusCol && row[statusCol] ? row[statusCol] : 'OPEN').toUpperCase();
    const status = ['DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE'].includes(rawStatus)
      ? (rawStatus as 'DRAFT' | 'OPEN' | 'PAID' | 'VOID' | 'UNCOLLECTIBLE')
      : 'OPEN';

    const customerName = (customerCol && row[customerCol] ? row[customerCol] : undefined) || 'Unknown Customer';
    const customerEmail = emailCol && row[emailCol] ? row[emailCol] : undefined;
    const customerIban = ibanCol && row[ibanCol] ? row[ibanCol] : undefined;

    const invoice: NormalizedInvoice = {
      id,
      invoiceNumber,
      amountCents,
      currency,
      issueDate,
      dueDate,
      status,
      customerName,
      customerEmail: customerEmail?.includes('@') ? customerEmail : undefined,
      customerIban: customerIban || undefined,
    };

    invoices.push(NormalizedInvoiceSchema.parse(invoice));
  }

  return invoices;
}

/**
 * Alias for loadInvoices to parse invoice content directly from text or files.
 */
export const parseInvoices = loadInvoices;

