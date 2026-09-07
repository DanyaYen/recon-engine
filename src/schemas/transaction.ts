import { z } from 'zod';

export const TransactionDirectionSchema = z.enum(['INCOMING', 'OUTGOING']);
export type TransactionDirection = z.infer<typeof TransactionDirectionSchema>;

export const NormalizedTransactionSchema = z.object({
  id: z.string().min(1).describe('Unique transaction identifier (derived from bank ID, hash or UUID)'),
  bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Booking date in ISO YYYY-MM-DD format'),
  valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Value date in ISO YYYY-MM-DD format'),
  amountCents: z.number().int().nonnegative().describe('Absolute transaction amount in integer minor units (cents)'),
  currency: z.string().min(3).max(3).toUpperCase().describe('ISO 4217 3-letter currency code (e.g. EUR, USD, GBP)'),
  direction: TransactionDirectionSchema.describe('Direction of funds: INCOMING (credit) or OUTGOING (debit)'),
  counterpartyName: z.string().optional().describe('Name of the debtor (payer) or creditor (beneficiary)'),
  counterpartyIban: z.string().optional().describe('IBAN of the counterparty, if available'),
  counterpartyBic: z.string().optional().describe('BIC/SWIFT code of the counterparty bank, if available'),
  reference: z.string().optional().describe('Remittance information, description, or payment reference text'),
  bankTransactionId: z.string().optional().describe('Original bank/SWIFT transaction ID or EndToEndId'),
  sourceFormat: z.string().describe('Identifier of the parser used (e.g. revolut-csv, camt053, mt940)'),
  raw: z.record(z.unknown()).optional().describe('Original parsed row or raw data for auditing'),
});

export type NormalizedTransaction = z.infer<typeof NormalizedTransactionSchema>;
