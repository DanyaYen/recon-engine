import type { StatementParser, ParseOptions } from '../base.js';
import type { NormalizedTransaction } from '../../schemas/transaction.js';
import { parseAmountToCents } from '../../utils/money.js';
import { parseBankDate } from '../../utils/date.js';
import { generateTransactionFingerprint } from '../../utils/fingerprint.js';

interface RawMt940Transaction {
  statementLine: string; // :61:
  infoLine?: string; // :86:
}

export class Mt940Parser implements StatementParser {
  readonly id = 'mt940';
  readonly name = 'SWIFT MT940';
  readonly description = 'SWIFT MT940 Customer Statement Message standard';

  supports(content: string): boolean {
    const head = content.slice(0, 1500);
    return (
      (head.includes(':20:') || head.includes(':25:')) &&
      (head.includes(':60F:') || head.includes(':60M:')) &&
      head.includes(':61:')
    );
  }

  async parse(content: string, options?: ParseOptions): Promise<NormalizedTransaction[]> {
    const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    let currentTag = '';
    let currentTagContent: string[] = [];

    // Extract default currency from :60F: opening balance if available
    let statementCurrency = options?.defaultCurrency || 'EUR';
    let accountIban: string | undefined;
    const rawTransactions: RawMt940Transaction[] = [];
    let currentTx: RawMt940Transaction | null = null;

    const commitTag = (tag: string, contentLines: string[]) => {
      const fullText = contentLines.join('\n').trim();

      if (tag === '25' || tag === '25P') {
        accountIban = fullText.replace(/\s+/g, '');
      } else if (tag === '60F' || tag === '60M') {
        // Example: :60F:C240901EUR10000,00
        const match = fullText.match(/[CD]\d{6}([A-Z]{3})/);
        if (match) {
          statementCurrency = match[1];
        }
      } else if (tag === '61') {
        if (currentTx) {
          rawTransactions.push(currentTx);
        }
        currentTx = { statementLine: fullText };
      } else if (tag === '86') {
        if (currentTx) {
          currentTx.infoLine = fullText;
        }
      } else if (tag === '62F' || tag === '62M') {
        if (currentTx) {
          rawTransactions.push(currentTx);
          currentTx = null;
        }
      }
    };

    for (const line of lines) {
      const tagMatch = line.match(/^:([0-9]{2}[A-Z]?):(.*)$/);
      if (tagMatch) {
        if (currentTag) {
          commitTag(currentTag, currentTagContent);
        }
        currentTag = tagMatch[1];
        currentTagContent = [tagMatch[2]];
      } else if (currentTag) {
        // Tag continuation line
        currentTagContent.push(line);
      }
    }

    if (currentTag) {
      commitTag(currentTag, currentTagContent);
    }
    if (currentTx && !rawTransactions.includes(currentTx)) {
      rawTransactions.push(currentTx);
    }

    const transactions: NormalizedTransaction[] = [];

    for (let i = 0; i < rawTransactions.length; i++) {
      const item = rawTransactions[i];
      const parsed = this.parseStatementLine(item.statementLine, statementCurrency);
      if (!parsed) continue;

      const { bookingDate, amountCents, currency, direction, bankRef } = parsed;

      // Parse :86: Information to Account Owner
      const { reference, counterpartyName, counterpartyIban } = this.parseInfoLine(
        item.infoLine || ''
      );

      const hasBankId = Boolean(bankRef && bankRef !== 'NONREF' && bankRef.trim() !== '');
      const id = hasBankId
        ? bankRef!
        : generateTransactionFingerprint({
            accountIban: accountIban || undefined,
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
        counterpartyIban: counterpartyIban || undefined,
        reference: reference || undefined,
        bankTransactionId: bankRef || undefined,
        sourceFormat: this.id,
        raw: {
          statementLine: item.statementLine,
          infoLine: item.infoLine,
        },
      });
    }

    return transactions;
  }

  /**
   * Parses SWIFT MT940 tag :61:
   * Format: YYMMDD[MMDD](C|D|RC|RD)[A-Z](Amount,Dec)(N|F)[3-char-type](CustomerRef)[//BankRef]
   */
  private parseStatementLine(
    line: string,
    fallbackCurrency: string
  ): {
    bookingDate: string;
    amountCents: number;
    currency: string;
    direction: 'INCOMING' | 'OUTGOING';
    bankRef?: string;
  } | null {
    // Basic regex capturing Date, D/C flag, Amount, and the remainder
    const match = line.match(/^(\d{6})(\d{4})?(C|D|RC|RD)([A-Za-z])?([0-9]+[.,][0-9]{1,2})(.*?)$/);
    if (!match) return null;

    const rawDate = match[1];
    const bookingDate = parseBankDate(rawDate);

    const dcMark = match[3];
    const isCredit = dcMark === 'C' || dcMark === 'RC';
    const direction: 'INCOMING' | 'OUTGOING' = isCredit ? 'INCOMING' : 'OUTGOING';

    const rawAmount = match[5];
    const { amountCents } = parseAmountToCents(rawAmount, direction);

    const remainder = match[6] || '';
    let bankRef: string | undefined = undefined;

    const refSplit = remainder.split('//');
    if (refSplit.length > 1) {
      bankRef = refSplit[1].trim();
    }

    return {
      bookingDate,
      amountCents,
      currency: fallbackCurrency,
      direction,
      bankRef,
    };
  }

  /**
   * Parses MT940 tag :86: remittance and counterparty information.
   * Can be subfield tagged (?20, ?21, ?32 etc.) or unstructured.
   */
  private parseInfoLine(info: string): {
    reference?: string;
    counterpartyName?: string;
    counterpartyIban?: string;
  } {
    if (!info) return {};

    // Check for German/Austrian subfield codes: ?00 (transaction code), ?20-29 (remittance), ?32 (counterparty)
    if (info.includes('?')) {
      const subfields: Record<string, string> = {};
      const parts = info.split('?');

      for (const part of parts) {
        if (part.length >= 2) {
          const code = part.slice(0, 2);
          const val = part.slice(2).trim();
          subfields[code] = (subfields[code] ? subfields[code] + ' ' : '') + val;
        }
      }

      const counterpartyName = subfields['32'] || subfields['33'] || undefined;
      const counterpartyIban = subfields['38'] || undefined;

      const refParts = [
        subfields['20'],
        subfields['21'],
        subfields['22'],
        subfields['23'],
        subfields['24'],
        subfields['25'],
      ].filter(Boolean);

      const reference = refParts.join(' ').trim() || undefined;

      return { reference, counterpartyName, counterpartyIban };
    }

    // Check for slash tags: /EREF/, /BENM/, /IBAN/
    if (info.includes('/')) {
      const refMatch = info.match(/\/EREF\/([^\/]+)/);
      const benmMatch = info.match(/\/BENM\/([^\/]+)/);
      const ibanMatch = info.match(/\/IBAN\/([^\/]+)/);

      return {
        reference: refMatch ? refMatch[1].trim() : info.replace(/\n/g, ' ').trim(),
        counterpartyName: benmMatch ? benmMatch[1].trim() : undefined,
        counterpartyIban: ibanMatch ? ibanMatch[1].trim() : undefined,
      };
    }

    // Plain unstructured text
    return {
      reference: info.replace(/\n/g, ' ').trim(),
    };
  }
}
