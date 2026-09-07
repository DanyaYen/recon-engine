import { z } from 'zod';

export const InvoiceStatusSchema = z.enum(['DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE']);
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;

export const NormalizedInvoiceSchema = z.object({
  id: z.string().min(1).describe('Internal invoice ID or Stripe invoice ID (e.g. in_1ABC...)'),
  invoiceNumber: z.string().min(1).describe('Human-facing invoice number (e.g. INV-2024-001)'),
  amountCents: z.number().int().nonnegative().describe('Total invoice amount in integer minor units (cents)'),
  currency: z.string().min(3).max(3).toUpperCase().describe('ISO 4217 currency code'),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Issue date in ISO YYYY-MM-DD format'),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Due date in ISO YYYY-MM-DD format'),
  status: InvoiceStatusSchema.default('OPEN').describe('Current invoice lifecycle state'),
  customerName: z.string().describe('Customer or company name'),
  customerEmail: z.string().email().optional().describe('Customer contact email address'),
  customerIban: z.string().optional().describe('Saved customer bank account IBAN, if available'),
  metadata: z.record(z.string()).optional().describe('Arbitrary metadata (e.g. Stripe customer_id, subscription_id)'),
});

export type NormalizedInvoice = z.infer<typeof NormalizedInvoiceSchema>;
