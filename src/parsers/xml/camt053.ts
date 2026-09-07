import { XMLParser } from 'fast-xml-parser';
import type { StatementParser, ParseOptions } from '../base.js';
import type { NormalizedTransaction } from '../../schemas/transaction.js';
import { parseAmountToCents } from '../../utils/money.js';
import { parseBankDate } from '../../utils/date.js';

export class Camt053Parser implements StatementParser {
  readonly id = 'camt053';
  readonly name = 'CAMT.053 (ISO 20022 XML)';
  readonly description = 'Standard European Open Banking XML bank statement format (camt.053.001.02/04/08)';

  supports(content: string): boolean {
    const head = content.slice(0, 1500).toLowerCase();
    return (
      (head.includes('camt.053') || head.includes('bktocstmrstmt')) &&
      head.includes('<document')
    );
  }

  async parse(content: string, _options?: ParseOptions): Promise<NormalizedTransaction[]> {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      trimValues: true,
      parseTagValue: false, // Keep raw strings to preserve precision
    });

    const parsed = parser.parse(content);
    const documentNode = parsed?.Document || parsed;
    const bkStmt = documentNode?.BkToCstmrStmt;

    if (!bkStmt) {
      throw new Error('Invalid CAMT.053 format: missing BkToCstmrStmt node');
    }

    const stmts = Array.isArray(bkStmt.Stmt) ? bkStmt.Stmt : bkStmt.Stmt ? [bkStmt.Stmt] : [];
    const transactions: NormalizedTransaction[] = [];

    for (let stmtIdx = 0; stmtIdx < stmts.length; stmtIdx++) {
      const stmt = stmts[stmtIdx];
      const entries = Array.isArray(stmt.Ntry) ? stmt.Ntry : stmt.Ntry ? [stmt.Ntry] : [];

      for (let ntryIdx = 0; ntryIdx < entries.length; ntryIdx++) {
        const ntry = entries[ntryIdx];

        // Booking date: <BookgDt><Dt>2024-09-01</Dt></BookgDt>
        const rawDate =
          ntry?.BookgDt?.Dt ||
          ntry?.BookgDt?.DtTm ||
          ntry?.ValDt?.Dt ||
          ntry?.ValDt?.DtTm;
        const bookingDate = parseBankDate(rawDate);

        // Value date
        const rawValDate = ntry?.ValDt?.Dt || ntry?.ValDt?.DtTm;
        const valueDate = rawValDate ? parseBankDate(rawValDate) : undefined;

        // Amount and Currency
        const amtNode = ntry?.Amt;
        const rawAmount = typeof amtNode === 'object' ? amtNode['#text'] : amtNode;
        const currency = (
          (typeof amtNode === 'object' ? amtNode['@_Ccy'] : undefined) || 'EUR'
        ).toUpperCase();

        // Direction: CRDT (credit = incoming) vs DBIT (debit = outgoing)
        const cdtDbtInd = (ntry?.CdtDbtInd || 'CRDT').toUpperCase();
        const direction = cdtDbtInd.includes('CRDT') ? 'INCOMING' : 'OUTGOING';
        const { amountCents } = parseAmountToCents(rawAmount || '0', direction);

        // Transaction Details (<NtryDtls> -> <TxDtls>)
        const ntryDtls = ntry?.NtryDtls;
        const txDtlsList = ntryDtls?.TxDtls
          ? Array.isArray(ntryDtls.TxDtls)
            ? ntryDtls.TxDtls
            : [ntryDtls.TxDtls]
          : [{}];

        for (let txIdx = 0; txIdx < txDtlsList.length; txIdx++) {
          const tx = txDtlsList[txIdx];

          // Counterparty name and IBAN
          const rltdPties = tx?.RltdPties;
          const isIncoming = direction === 'INCOMING';

          const party = isIncoming ? rltdPties?.Dbtr : rltdPties?.Cdtr;
          const partyAcct = isIncoming ? rltdPties?.DbtrAcct : rltdPties?.CdtrAcct;

          const counterpartyName = party?.Nm || undefined;
          const counterpartyIban = partyAcct?.Id?.IBAN || undefined;

          // Reference and Remittance Info
          const rmtInf = tx?.RmtInf;
          let reference: string | undefined = undefined;

          if (rmtInf?.Ustrd) {
            reference = Array.isArray(rmtInf.Ustrd)
              ? rmtInf.Ustrd.join(' ')
              : String(rmtInf.Ustrd);
          } else if (rmtInf?.Strd?.CdtrRefInf?.Ref) {
            reference = String(rmtInf.Strd.CdtrRefInf.Ref);
          } else if (tx?.AddtlTxInf) {
            reference = String(tx.AddtlTxInf);
          } else if (ntry?.AddtlNtryInf) {
            reference = String(ntry.AddtlNtryInf);
          }

          // Bank / SWIFT Reference ID
          const bankTransactionId =
            tx?.Refs?.EndToEndId !== 'NOTPROVIDED' && tx?.Refs?.EndToEndId
              ? String(tx.Refs.EndToEndId)
              : tx?.Refs?.InstrId || ntry?.AcctSvcrRef || undefined;

          const id =
            bankTransactionId ||
            `camt053-${bookingDate}-${amountCents}-${stmtIdx + 1}-${ntryIdx + 1}-${txIdx + 1}`;

          transactions.push({
            id,
            bookingDate,
            valueDate,
            amountCents,
            currency,
            direction,
            counterpartyName,
            counterpartyIban,
            reference: reference?.trim() || undefined,
            bankTransactionId,
            sourceFormat: this.id,
            raw: tx,
          });
        }
      }
    }

    return transactions;
  }
}
