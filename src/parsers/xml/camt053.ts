import { XMLParser } from 'fast-xml-parser';
import type { StatementParser, ParseOptions } from '../base.js';
import type { NormalizedTransaction, TransactionDirection } from '../../schemas/transaction.js';
import { parseAmountToCents } from '../../utils/money.js';
import { parseBankDate } from '../../utils/date.js';

function extractAmountNode(node: any): { rawAmount?: string; currency?: string } | null {
  if (!node) return null;

  const amtNode =
    node.Amt ||
    node.AmtDtls?.TxAmt?.Amt ||
    node.AmtDtls?.InstdAmt?.Amt ||
    node.AmtDtls?.Amt;

  if (!amtNode) return null;

  const rawAmount = typeof amtNode === 'object' ? amtNode['#text'] : amtNode;
  const currency = typeof amtNode === 'object' ? amtNode['@_Ccy'] : undefined;

  if (rawAmount !== undefined && rawAmount !== null && String(rawAmount).trim() !== '') {
    return {
      rawAmount: String(rawAmount).trim(),
      currency: currency ? String(currency).toUpperCase() : undefined,
    };
  }
  return null;
}

function extractReferenceFromTx(tx: any, ntry?: any): string | undefined {
  const rmtInf = tx?.RmtInf;
  let ref: string | undefined = undefined;

  if (rmtInf?.Ustrd) {
    ref = Array.isArray(rmtInf.Ustrd) ? rmtInf.Ustrd.join(' ') : String(rmtInf.Ustrd);
  } else if (rmtInf?.Strd?.CdtrRefInf?.Ref) {
    ref = String(rmtInf.Strd.CdtrRefInf.Ref);
  } else if (tx?.AddtlTxInf) {
    ref = String(tx.AddtlTxInf);
  } else if (ntry?.AddtlNtryInf) {
    ref = String(ntry.AddtlNtryInf);
  }

  return ref?.trim() || undefined;
}

function extractCounterparty(tx: any, direction: TransactionDirection): { name?: string; iban?: string } {
  const rltdPties = tx?.RltdPties;
  if (!rltdPties) return {};

  const isIncoming = direction === 'INCOMING';
  const primaryParty = isIncoming ? rltdPties.Dbtr : rltdPties.Cdtr;
  const fallbackParty = isIncoming ? rltdPties.Cdtr : rltdPties.Dbtr;
  const party = primaryParty?.Nm ? primaryParty : fallbackParty;

  const primaryAcct = isIncoming ? rltdPties.DbtrAcct : rltdPties.CdtrAcct;
  const fallbackAcct = isIncoming ? rltdPties.CdtrAcct : rltdPties.DbtrAcct;
  const partyAcct = primaryAcct?.Id?.IBAN ? primaryAcct : fallbackAcct;

  return {
    name: party?.Nm || undefined,
    iban: partyAcct?.Id?.IBAN || undefined,
  };
}

export class Camt053Parser implements StatementParser {
  readonly id = 'camt053';
  readonly name = 'CAMT.053 (ISO 20022 XML)';
  readonly description = 'Standard European Open Banking XML bank statement format (camt.053.001.02/04/08)';

  supports(content: string): boolean {
    const head = content.slice(0, 1500).toLowerCase();
    return (
      (head.includes('camt.053') || head.includes('bktocstmrstmt')) &&
      /<([a-z0-9_-]+:)?document\b/i.test(head)
    );
  }

  async parse(content: string, _options?: ParseOptions): Promise<NormalizedTransaction[]> {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      trimValues: true,
      parseTagValue: false, // Keep raw strings to preserve precision
      removeNSPrefix: true,
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
        const rawNtryDate =
          ntry?.BookgDt?.Dt ||
          ntry?.BookgDt?.DtTm ||
          ntry?.ValDt?.Dt ||
          ntry?.ValDt?.DtTm;
        const ntryBookingDate = parseBankDate(rawNtryDate);

        // Value date
        const rawNtryValDate = ntry?.ValDt?.Dt || ntry?.ValDt?.DtTm;
        const ntryValueDate = rawNtryValDate ? parseBankDate(rawNtryValDate) : undefined;

        // Parent Entry Amount and Currency
        const parentAmt = extractAmountNode(ntry);
        const parentRawAmount = parentAmt?.rawAmount || '0';
        const parentCurrency = parentAmt?.currency || 'EUR';

        // Direction: CRDT (credit = incoming) vs DBIT (debit = outgoing)
        const ntryCdtDbtInd = (ntry?.CdtDbtInd || 'CRDT').toUpperCase();
        const baseNtryDirection: TransactionDirection = ntryCdtDbtInd.includes('CRDT') ? 'INCOMING' : 'OUTGOING';

        // Reversal Indicator: <RvslInd>true</RvslInd>
        const ntryIsReversal =
          String(ntry?.RvslInd).toLowerCase() === 'true' || String(ntry?.RvslInd) === '1';

        // Transaction Details (<NtryDtls> -> <TxDtls>)
        const ntryDtls = ntry?.NtryDtls;
        const rawTxDtls = ntryDtls?.TxDtls;
        const txDtlsList: any[] = rawTxDtls
          ? Array.isArray(rawTxDtls)
            ? rawTxDtls
            : [rawTxDtls]
          : [];

        // Check whether multiple TxDtls exist and whether any has its own Amt
        const hasIndividualAmounts =
          txDtlsList.length > 0 && txDtlsList.some((tx) => extractAmountNode(tx) !== null);

        if (txDtlsList.length > 1 && !hasIndividualAmounts) {
          // Multiple TxDtls without individual amounts:
          // Treat Ntry as a single transaction to prevent duplicating the parent Ntry amount across all of them
          const direction: TransactionDirection = ntryIsReversal
            ? baseNtryDirection === 'INCOMING'
              ? 'OUTGOING'
              : 'INCOMING'
            : baseNtryDirection;

          const { amountCents } = parseAmountToCents(parentRawAmount, direction);

          // Combine references from all TxDtls
          const refs: string[] = [];
          for (const tx of txDtlsList) {
            const ref = extractReferenceFromTx(tx);
            if (ref && !refs.includes(ref)) {
              refs.push(ref);
            }
          }
          if (ntry?.AddtlNtryInf) {
            const ntryRef = String(ntry.AddtlNtryInf).trim();
            if (ntryRef && !refs.includes(ntryRef)) {
              refs.push(ntryRef);
            }
          }
          const reference = refs.join(' / ') || undefined;

          // Counterparty from first TxDtls that has it
          let counterpartyName: string | undefined;
          let counterpartyIban: string | undefined;
          for (const tx of txDtlsList) {
            const cp = extractCounterparty(tx, direction);
            if (cp.name && !counterpartyName) counterpartyName = cp.name;
            if (cp.iban && !counterpartyIban) counterpartyIban = cp.iban;
          }

          const firstTx = txDtlsList[0];
          const bankTransactionId =
            firstTx?.Refs?.EndToEndId !== 'NOTPROVIDED' && firstTx?.Refs?.EndToEndId
              ? String(firstTx.Refs.EndToEndId)
              : firstTx?.Refs?.InstrId || ntry?.AcctSvcrRef || undefined;

          const id =
            bankTransactionId ||
            `camt053-${ntryBookingDate}-${amountCents}-${stmtIdx + 1}-${ntryIdx + 1}-1`;

          transactions.push({
            id,
            bookingDate: ntryBookingDate,
            valueDate: ntryValueDate,
            amountCents,
            currency: parentCurrency,
            direction,
            counterpartyName,
            counterpartyIban,
            reference,
            bankTransactionId,
            sourceFormat: this.id,
            raw: ntry,
          });
        } else if (txDtlsList.length > 0) {
          // 1 TxDtls, or multiple TxDtls with individual amounts
          for (let txIdx = 0; txIdx < txDtlsList.length; txIdx++) {
            const tx = txDtlsList[txIdx];

            // Direction & Reversal check
            const txCdtDbtInd = tx?.CdtDbtInd ? String(tx.CdtDbtInd).toUpperCase() : ntryCdtDbtInd;
            const baseDir: TransactionDirection = txCdtDbtInd.includes('CRDT') ? 'INCOMING' : 'OUTGOING';
            const isReversal =
              ntryIsReversal ||
              String(tx?.RvslInd).toLowerCase() === 'true' ||
              String(tx?.RvslInd) === '1';
            const direction: TransactionDirection = isReversal
              ? baseDir === 'INCOMING'
                ? 'OUTGOING'
                : 'INCOMING'
              : baseDir;

            // Amount: use individual TxDtls Amt if present, else fall back to parent Ntry Amt
            const txAmt = extractAmountNode(tx);
            const rawAmount = txAmt?.rawAmount || parentRawAmount;
            const currency = txAmt?.currency || parentCurrency;
            const { amountCents } = parseAmountToCents(rawAmount, direction);

            // Dates
            const txRawDate = tx?.BookgDt?.Dt || tx?.BookgDt?.DtTm || rawNtryDate;
            const bookingDate = parseBankDate(txRawDate);
            const txRawValDate = tx?.ValDt?.Dt || tx?.ValDt?.DtTm || rawNtryValDate;
            const valueDate = txRawValDate ? parseBankDate(txRawValDate) : undefined;

            // Counterparty
            const { name: counterpartyName, iban: counterpartyIban } = extractCounterparty(tx, direction);

            // Reference
            const reference = extractReferenceFromTx(tx, ntry);

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
              reference,
              bankTransactionId,
              sourceFormat: this.id,
              raw: tx,
            });
          }
        } else {
          // No TxDtls sub-details: use parent Ntry level
          const direction: TransactionDirection = ntryIsReversal
            ? baseNtryDirection === 'INCOMING'
              ? 'OUTGOING'
              : 'INCOMING'
            : baseNtryDirection;

          const { amountCents } = parseAmountToCents(parentRawAmount, direction);
          const bankTransactionId = ntry?.AcctSvcrRef ? String(ntry.AcctSvcrRef) : undefined;
          const id =
            bankTransactionId ||
            `camt053-${ntryBookingDate}-${amountCents}-${stmtIdx + 1}-${ntryIdx + 1}-1`;

          transactions.push({
            id,
            bookingDate: ntryBookingDate,
            valueDate: ntryValueDate,
            amountCents,
            currency: parentCurrency,
            direction,
            counterpartyName: undefined,
            counterpartyIban: undefined,
            reference: ntry?.AddtlNtryInf ? String(ntry.AddtlNtryInf).trim() : undefined,
            bankTransactionId,
            sourceFormat: this.id,
            raw: ntry,
          });
        }
      }
    }

    return transactions;
  }
}
