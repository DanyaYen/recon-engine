import type { StatementParser, ParseOptions } from '../base.js';
import type { NormalizedTransaction } from '../../schemas/transaction.js';
import { parseCsv } from '../../utils/csv.js';
import { parseAmountToCents } from '../../utils/money.js';
import { parseBankDate } from '../../utils/date.js';
import { generateTransactionFingerprint } from '../../utils/fingerprint.js';

const SYNONYMS = {
  date: ['date', 'booking date', 'buchungstag', 'datum', 'transaction date', 'tx date', 'value date'],
  amount: ['amount', 'betrag', 'sum', 'total', 'value', 'gross', 'net', 'umsatz'],
  reference: ['reference', 'verwendungszweck', 'description', 'memo', 'details', 'narrative', 'payment reference', 'remittance'],
  counterparty: ['counterparty', 'payer', 'payee', 'partner', 'empfaenger', 'absender', 'auftraggeber', 'name', 'customer'],
  currency: ['currency', 'waehrung', 'ccy'],
  iban: ['iban', 'account', 'konto', 'account number', 'kontonummer', 'kontoverbindung'],
  id: ['id', 'txid', 'transaction id', 'transaktions-id', 'payment id', 'bank id', 'ref id'],
};

export class GenericCsvParser implements StatementParser {
  readonly id = 'generic-csv';
  readonly name = 'Generic CSV';
  readonly description = 'Configurable parser for arbitrary bank CSV files with custom or automatic column mapping';

  supports(content: string): boolean {
    const firstLine = content.split('\n')[0] || '';
    return firstLine.includes(',') || firstLine.includes(';') || firstLine.includes('\t');
  }

  async parse(content: string, options?: ParseOptions): Promise<NormalizedTransaction[]> {
    const { headers, rows } = parseCsv(content);
    if (rows.length === 0) return [];

    // Resolve column mappings
    const mapping = options?.columnMapping || {};
    const lowerHeaders = headers.map((h) => ({ original: h, lower: h.toLowerCase().trim() }));

    const resolveCol = (key: keyof typeof SYNONYMS): string | undefined => {
      if (mapping[key]) {
        const found = lowerHeaders.find(
          (h) => h.original === mapping[key] || h.lower === mapping[key].toLowerCase()
        );
        if (found) return found.original;
      }
      const synonyms = SYNONYMS[key];
      const match = lowerHeaders.find((h) => synonyms.some((syn) => h.lower.includes(syn)));
      return match ? match.original : undefined;
    };

    const dateCol = resolveCol('date');
    const amountCol = resolveCol('amount');
    const refCol = resolveCol('reference');
    const counterpartyCol = resolveCol('counterparty');
    const currencyCol = resolveCol('currency');
    const ibanCol = resolveCol('iban');
    const idCol = resolveCol('id');

    const defaultCurrency = options?.defaultCurrency || 'EUR';
    const transactions: NormalizedTransaction[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      const rawDate = dateCol ? row[dateCol] : undefined;
      const bookingDate = parseBankDate(rawDate);

      const rawAmount = amountCol ? row[amountCol] : '0';
      const { amountCents, direction } = parseAmountToCents(rawAmount);

      const currency = (currencyCol && row[currencyCol] ? row[currencyCol] : defaultCurrency).toUpperCase();
      const reference = refCol ? row[refCol]?.trim() : undefined;
      const counterpartyName = counterpartyCol ? row[counterpartyCol]?.trim() : undefined;
      const bankTransactionId = idCol ? row[idCol]?.trim() : undefined;
      const accountIban = ibanCol ? row[ibanCol]?.trim() : undefined;

      const id =
        bankTransactionId ||
        generateTransactionFingerprint({
          accountIban,
          bookingDate,
          amountCents,
          currency,
          bankRef: reference,
          endToEndId: undefined,
          direction,
        });

      transactions.push({
        id,
        bookingDate,
        amountCents,
        currency,
        direction,
        counterpartyName: counterpartyName || undefined,
        reference: reference || undefined,
        bankTransactionId: bankTransactionId || undefined,
        sourceFormat: this.id,
        raw: row,
      });
    }

    return transactions;
  }
}
