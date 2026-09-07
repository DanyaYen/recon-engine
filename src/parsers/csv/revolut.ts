import type { StatementParser, ParseOptions } from '../base.js';
import type { NormalizedTransaction } from '../../schemas/transaction.js';
import { parseCsv } from '../../utils/csv.js';
import { parseAmountToCents } from '../../utils/money.js';
import { parseBankDate } from '../../utils/date.js';

export class RevolutCsvParser implements StatementParser {
  readonly id = 'revolut-csv';
  readonly name = 'Revolut Business CSV';
  readonly description = 'Parser for Revolut Business and Retail account CSV exports';

  supports(content: string): boolean {
    const firstLines = content.slice(0, 1000);
    return (
      (firstLines.includes('Completed Date') || firstLines.includes('Date completed')) &&
      firstLines.includes('Description') &&
      firstLines.includes('Amount') &&
      (firstLines.includes('Balance') || firstLines.includes('State') || firstLines.includes('Fee'))
    );
  }

  async parse(content: string, _options?: ParseOptions): Promise<NormalizedTransaction[]> {
    const { rows } = parseCsv(content);
    const transactions: NormalizedTransaction[] = [];

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];

      // Filter out non-completed states if State column exists
      const state = (row['State'] || row['Status'] || 'COMPLETED').toUpperCase();
      if (state === 'REVERTED' || state === 'DECLINED' || state === 'FAILED') {
        continue;
      }

      // Date: Prefer Completed Date, fallback to Started Date
      const rawDate =
        row['Completed Date'] ||
        row['Date completed'] ||
        row['Started Date'] ||
        row['Date started'] ||
        row['Date'] ||
        '';
      const bookingDate = parseBankDate(rawDate);

      // Amount & Currency
      const rawAmount = row['Amount'] || '0';
      const currency = (row['Currency'] || 'EUR').toUpperCase();
      const { amountCents, direction } = parseAmountToCents(rawAmount);

      // Description & Counterparty & Reference
      const description = (row['Description'] || '').trim();
      const explicitReference = (row['Reference'] || row['Payment reference'] || '').trim();
      const payer = (row['Payer'] || '').trim();
      const beneficiary = (row['Beneficiary'] || '').trim();

      let counterpartyName: string | undefined = undefined;
      let reference = explicitReference;

      if (direction === 'INCOMING') {
        if (payer) {
          counterpartyName = payer;
        } else if (description.toLowerCase().startsWith('from ')) {
          counterpartyName = description.slice(5).trim();
        } else if (description) {
          counterpartyName = description;
        }
      } else {
        if (beneficiary) {
          counterpartyName = beneficiary;
        } else if (description.toLowerCase().startsWith('to ')) {
          counterpartyName = description.slice(3).trim();
        } else if (description) {
          counterpartyName = description;
        }
      }

      // If reference is empty, use description as reference
      if (!reference && description) {
        reference = description;
      }

      // Unique transaction identifier
      const id =
        row['Transaction ID'] ||
        row['ID'] ||
        `revolut-${bookingDate}-${amountCents}-${index + 1}`;

      transactions.push({
        id,
        bookingDate,
        amountCents,
        currency,
        direction,
        counterpartyName: counterpartyName || undefined,
        reference: reference || undefined,
        sourceFormat: this.id,
        raw: row,
      });
    }

    return transactions;
  }
}
