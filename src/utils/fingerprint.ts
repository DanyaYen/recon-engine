import { createHash } from 'node:crypto';
import type { TransactionDirection } from '../schemas/transaction.js';

export interface FingerprintParams {
  accountIban?: string | null;
  bookingDate: string;
  amountCents: number;
  currency: string;
  bankRef?: string | null;
  endToEndId?: string | null;
  direction: TransactionDirection | string;
}

/**
 * Computes a canonical SHA-256 idempotency fingerprint for a transaction.
 *
 * Canonical payload:
 * `${accountIban?.trim().toUpperCase() || ''}|${bookingDate}|${amountCents}|${currency.toUpperCase()}|${bankRef?.trim() || ''}|${endToEndId?.trim() || ''}|${direction}`
 */
export function generateTransactionFingerprint(params: FingerprintParams): string {
  const accountIban = params.accountIban?.trim().toUpperCase() || '';
  const bookingDate = params.bookingDate;
  const amountCents = params.amountCents;
  const currency = (params.currency || '').trim().toUpperCase();
  const bankRef = params.bankRef?.trim() || '';
  const endToEndId = params.endToEndId?.trim() || '';
  const direction = params.direction;

  const payload = `${accountIban}|${bookingDate}|${amountCents}|${currency}|${bankRef}|${endToEndId}|${direction}`;
  return createHash('sha256').update(payload).digest('hex');
}
