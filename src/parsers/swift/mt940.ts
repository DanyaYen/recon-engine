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
    const head = content.slice(0, 3000);
    const envelopeStart = head.indexOf('{4:');
    const searchTarget = envelopeStart !== -1 ? content.slice(envelopeStart, envelopeStart + 3000) : head;
    return (
      (searchTarget.includes(':20:') || searchTarget.includes(':25:')) &&
      (searchTarget.includes(':60F:') || searchTarget.includes(':60M:')) &&
      searchTarget.includes(':61:')
    );
  }

  async parse(content: string, options?: ParseOptions): Promise<NormalizedTransaction[]> {
    // Detect and unwrap SWIFT envelope (Block 4) if present
    const envelopeMatch = content.match(/\{4:\r?\n([\s\S]*?)(?:\r?\n-\})/);
    const effectiveContent = envelopeMatch ? envelopeMatch[1] : content;

    const lines = effectiveContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
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
        const trimmed = line.trim();
        if (trimmed === '-}' || trimmed === '-') {
          commitTag(currentTag, currentTagContent);
          currentTag = '';
          currentTagContent = [];
        } else {
          // Tag continuation line
          currentTagContent.push(line);
        }
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
    const match = line.trim().match(/^(\d{6})(\d{4})?(C|D|RC|RD)([A-Za-z])?([0-9]+(?:[.,][0-9]{1,2})?)(.*?)$/);
    if (!match) return null;

    const rawDate = match[1];
    let bookingDate: string;
    try {
      bookingDate = parseBankDate(rawDate);
    } catch {
      bookingDate = String(rawDate || '');
    }

    const dcMark = match[3];
    const isCredit = dcMark === 'C' || dcMark === 'RC';
    const direction: 'INCOMING' | 'OUTGOING' = isCredit ? 'INCOMING' : 'OUTGOING';

    const rawAmount = match[5];
    let amountCents = 0;
    try {
      const parsedAmount = parseAmountToCents(rawAmount, direction);
      amountCents = parsedAmount.amountCents;
    } catch {
      amountCents = -1;
    }

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

    // Check for German/Austrian ZKA subfield codes: ?00 (transaction code), ?20-29 / ?60-63 (remittance), ?32-33 (counterparty), ?38 (IBAN)
    if (/\?\d{2}/.test(info)) {
      const subfields: Record<string, string> = {};
      const parts = info.split(/\?(\d{2})/);
      const prefixText = parts[0]?.trim();

      for (let i = 1; i < parts.length; i += 2) {
        const code = parts[i];
        const val = (parts[i + 1] || '').replace(/[\r\n]+/g, ' ').trim();
        if (code) {
          subfields[code] = (subfields[code] ? subfields[code] + ' ' : '') + val;
        }
      }

      const counterpartyName =
        [subfields['32'], subfields['33']].filter(Boolean).join(' ').trim() || undefined;
      const counterpartyIban = subfields['38'] ? subfields['38'].replace(/\s+/g, '') : undefined;

      const refParts = [
        subfields['20'],
        subfields['21'],
        subfields['22'],
        subfields['23'],
        subfields['24'],
        subfields['25'],
        subfields['26'],
        subfields['27'],
        subfields['28'],
        subfields['29'],
        subfields['60'],
        subfields['61'],
        subfields['62'],
        subfields['63'],
      ].filter(Boolean);

      let reference = refParts.join(' ').trim() || undefined;

      if (!reference) {
        reference = prefixText || info.replace(/[\r\n]+/g, ' ').trim();
      }

      return { reference, counterpartyName, counterpartyIban };
    }

    // Check for slash tags: /SVWZ/, /EREF/, /BENM/, /IBAN/, /KREF/
    if (info.includes('/')) {
      const svwzMatch = info.match(/\/SVWZ\/([^\/]+)/);
      const erefMatch = info.match(/\/EREF\/([^\/]+)/);
      const krefMatch = info.match(/\/KREF\/([^\/]+)/);
      const benmMatch = info.match(/\/(?:BENM|ABWE|ABWA)\/([^\/]+)/);
      const ibanMatch = info.match(/\/IBAN\/([^\/]+)/);

      let reference: string | undefined;
      const cleanEref = erefMatch && erefMatch[1].trim() !== 'NONREF' ? erefMatch[1].trim() : undefined;
      const cleanSvwz = svwzMatch ? svwzMatch[1].replace(/[\r\n]+/g, ' ').trim() : undefined;
      const cleanKref = krefMatch && krefMatch[1].trim() !== 'NONREF' ? krefMatch[1].trim() : undefined;

      if (cleanSvwz && cleanEref) {
        reference = `${cleanEref} ${cleanSvwz}`;
      } else if (cleanSvwz) {
        reference = cleanSvwz;
      } else if (cleanEref) {
        reference = cleanEref;
      } else if (cleanKref) {
        reference = cleanKref;
      }

      const counterpartyName = benmMatch
        ? benmMatch[1].replace(/[\r\n]+/g, ' ').trim()
        : undefined;
      const counterpartyIban = ibanMatch
        ? ibanMatch[1].replace(/[\s\r\n]+/g, '')
        : undefined;

      return {
        reference: reference || info.replace(/[\r\n]+/g, ' ').trim(),
        counterpartyName,
        counterpartyIban,
      };
    }

    // Plain unstructured text
    return {
      reference: info.replace(/[\r\n]+/g, ' ').trim(),
    };
  }
}
