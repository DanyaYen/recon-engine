import type { StatementParser, ParseOptions } from '../base.js';
import type { NormalizedTransaction } from '../../schemas/transaction.js';
import { parseCsv, detectDelimiter } from '../../utils/csv.js';
import { parseAmountToCents } from '../../utils/money.js';
import { parseBankDate } from '../../utils/date.js';

export class StripeCsvParser implements StatementParser {
  readonly id = 'stripe-csv';
  readonly name = 'Stripe Export CSV';
  readonly description = 'Parser for Stripe Balance transactions, Payouts, and Payments CSV exports';

  supports(content: string): boolean {
    if (!content || typeof content !== 'string') return false;

    // Fast reject non-CSV formats
    const trimmed = content.trim();
    if (
      trimmed.startsWith('<?xml') ||
      trimmed.startsWith('<') ||
      trimmed.startsWith('{1:') ||
      trimmed.startsWith(':20:')
    ) {
      return false;
    }

    // Strictly inspect CSV header line, NOT cell contents or full text
    const cleaned = content.replace(/^\uFEFF/, '');
    const firstLine = cleaned.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (!firstLine) return false;

    const delimiter = detectDelimiter(firstLine);
    const headers = firstLine
      .split(delimiter)
      .map((col) => col.replace(/^["']|["']$/g, '').trim())
      .filter((col) => col.length > 0);

    if (headers.length < 2) return false;

    const normalizedHeaders = new Set(
      headers.map((h) =>
        h
          .toLowerCase()
          .trim()
          .replace(/[\s\-_()]+/g, '_')
          .replace(/^_+|_+$/g, '')
      )
    );

    // Characteristic Stripe header indicators
    const hasBalanceTxnId =
      normalizedHeaders.has('balance_transaction_id') ||
      normalizedHeaders.has('balance_transaction_id_utc');
    const hasReportingCategory = normalizedHeaders.has('reporting_category');
    const hasGrossFeeNet =
      normalizedHeaders.has('gross') &&
      normalizedHeaders.has('fee') &&
      normalizedHeaders.has('net');
    const hasCustomerFacing =
      normalizedHeaders.has('customer_facing_amount') ||
      normalizedHeaders.has('customer_facing_currency');
    const hasArrivalDate =
      (normalizedHeaders.has('arrival_date_utc') || normalizedHeaders.has('arrival_date')) &&
      (normalizedHeaders.has('created_utc') || normalizedHeaders.has('created'));
    const hasAvailableOn =
      (normalizedHeaders.has('available_on_utc') || normalizedHeaders.has('available_on')) &&
      normalizedHeaders.has('fee') &&
      normalizedHeaders.has('net');

    return (
      hasBalanceTxnId ||
      hasReportingCategory ||
      hasGrossFeeNet ||
      hasCustomerFacing ||
      hasArrivalDate ||
      hasAvailableOn
    );
  }

  async parse(content: string, _options?: ParseOptions): Promise<NormalizedTransaction[]> {
    const { rows } = parseCsv(content);
    const transactions: NormalizedTransaction[] = [];

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];

      // ID
      const id =
        row['Balance transaction ID'] ||
        row['id'] ||
        row['Transaction ID'] ||
        `stripe-tx-${index + 1}`;

      // Date: 'Created (UTC)' or 'Created' or 'Available on (UTC)'
      const rawDate =
        row['Created (UTC)'] ||
        row['Created'] ||
        row['Available on (UTC)'] ||
        row['Date'] ||
        '';
      let bookingDate: string;
      try {
        bookingDate = parseBankDate(rawDate);
      } catch {
        bookingDate = String(rawDate || '');
      }

      // Gross Amount (or Amount)
      const rawAmount = row['Gross'] || row['Amount'] || row['amount'] || '0';
      const currency = (row['Currency'] || row['currency'] || 'USD').toUpperCase();
      let amountCents = 0;
      let direction: 'INCOMING' | 'OUTGOING' = 'INCOMING';
      try {
        const parsed = parseAmountToCents(rawAmount);
        amountCents = parsed.amountCents;
        direction = parsed.direction;
      } catch {
        amountCents = -1;
      }

      // Customer info
      const counterpartyName =
        row['Customer Name'] ||
        row['customer_name'] ||
        row['Customer Email'] ||
        undefined;

      // Description & Reference
      const description =
        row['Description'] ||
        row['description'] ||
        row['Invoice Number'] ||
        row['Customer Facing Description'] ||
        '';

      const type = row['Type'] || row['Reporting category'] || '';
      const reference = description || (type ? `Stripe ${type}` : undefined);

      transactions.push({
        id,
        bookingDate,
        amountCents,
        currency,
        direction,
        counterpartyName,
        reference,
        bankTransactionId: id,
        sourceFormat: this.id,
        raw: row,
      });
    }

    return transactions;
  }
}
