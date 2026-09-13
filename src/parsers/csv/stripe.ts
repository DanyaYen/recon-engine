import type { StatementParser, ParseOptions } from '../base.js';
import type { NormalizedTransaction } from '../../schemas/transaction.js';
import { parseCsv } from '../../utils/csv.js';
import { parseAmountToCents } from '../../utils/money.js';
import { parseBankDate } from '../../utils/date.js';

export class StripeCsvParser implements StatementParser {
  readonly id = 'stripe-csv';
  readonly name = 'Stripe Export CSV';
  readonly description = 'Parser for Stripe Balance transactions, Payouts, and Payments CSV exports';

  supports(content: string): boolean {
    const firstLines = content.slice(0, 1000);
    const lower = firstLines.toLowerCase();
    return (
      (firstLines.includes('Balance transaction ID') ||
        (firstLines.includes('id') && firstLines.includes('Gross') && firstLines.includes('Fee')) ||
        (firstLines.includes('id') && firstLines.includes('Reporting category')) ||
        (firstLines.includes('Customer Facing Amount') && firstLines.includes('Source')) ||
        (firstLines.includes('Arrival Date') && firstLines.includes('Created (UTC)')) ||
        lower.includes('stripe payout')) &&
      (firstLines.includes('Currency') || firstLines.includes('currency'))
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
