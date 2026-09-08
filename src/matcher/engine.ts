import { randomUUID } from 'crypto';
import type { NormalizedTransaction } from '../schemas/transaction.js';
import type { NormalizedInvoice } from '../schemas/invoice.js';
import type {
  MatchResult,
  ReconciliationReport,
} from '../schemas/reconciliation.js';
import { scoreRemittanceMatch } from '../utils/fuzzy.js';
import { cleanCompanyName } from '../utils/text.js';
import { formatCents } from '../utils/money.js';

export interface MatcherOptions {
  dateToleranceDays?: number; // default: 2 days (as specified in requirements)
  feeToleranceCents?: number; // default: 2500 cents (25.00 EUR/USD)
  feeTolerancePercent?: number; // default: 2%
  statementFile?: string;
  sourceFormat?: string;
}

/**
 * Calculates day difference between two ISO YYYY-MM-DD date strings.
 */
function getDayDifference(dateStr1: string, dateStr2: string): number {
  const d1 = new Date(dateStr1).getTime();
  const d2 = new Date(dateStr2).getTime();
  const diffMs = Math.abs(d1 - d2);
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Deterministic and Fuzzy Financial Matching Engine.
 * Reconciles bank transactions against open invoices in a multi-pass 1:1 matching pipeline.
 */
export function reconcile(
  transactions: NormalizedTransaction[],
  invoices: NormalizedInvoice[],
  options?: MatcherOptions
): ReconciliationReport {
  const dateTolerance = options?.dateToleranceDays ?? 2;
  const feeToleranceCents = options?.feeToleranceCents ?? 2500;
  const feeTolerancePercent = options?.feeTolerancePercent ?? 0.02;

  // Track matched invoices to enforce 1:1 matching
  const matchedInvoiceIds = new Set<string>();
  const matches: MatchResult[] = [];

  // Working copy of invoices
  const availableInvoices = [...invoices];

  // Helper to find available invoice by ID
  const isInvoiceAvailable = (id: string) => !matchedInvoiceIds.has(id);

  // Focus primarily on INCOMING transactions for invoice reconciliation
  const incomingTxs = transactions.filter((tx) => tx.direction === 'INCOMING');
  const outgoingTxs = transactions.filter((tx) => tx.direction === 'OUTGOING');

  // Transactions pending matching
  const remainingTxs: NormalizedTransaction[] = [...incomingTxs];

  // =========================================================================
  // PASS 1: Exact Match (Exact Reference ID + Amount in cents + Date ±2 days)
  // =========================================================================
  for (let i = remainingTxs.length - 1; i >= 0; i--) {
    const tx = remainingTxs[i];
    const refText = `${tx.reference || ''} ${tx.bankTransactionId || ''}`.toLowerCase();

    for (const inv of availableInvoices) {
      if (!isInvoiceAvailable(inv.id)) continue;

      // Currency must match
      if (tx.currency !== inv.currency) continue;

      // Exact amount in cents
      if (tx.amountCents !== inv.amountCents) continue;

      // Date within tolerance (relative to issueDate or dueDate)
      const dayDiffIssue = getDayDifference(tx.bookingDate, inv.issueDate);
      const dayDiffDue = inv.dueDate
        ? getDayDifference(tx.bookingDate, inv.dueDate)
        : Infinity;
      const dayDiff = Math.min(dayDiffIssue, dayDiffDue);

      if (dayDiff > dateTolerance) continue;

      // Exact invoice number or ID token present in remittance
      const invNum = inv.invoiceNumber.toLowerCase();
      const invId = inv.id.toLowerCase();
      const cleanInvNum = invNum.replace(/[^a-z0-9]/g, '');

      const hasExactRef =
        (invNum.length >= 3 && refText.includes(invNum)) ||
        (invId.length >= 3 && refText.includes(invId)) ||
        (cleanInvNum.length >= 4 && refText.replace(/[^a-z0-9]/g, '').includes(cleanInvNum));

      if (hasExactRef) {
        matchedInvoiceIds.add(inv.id);
        remainingTxs.splice(i, 1);

        matches.push({
          status: 'MATCHED',
          level: 'EXACT_REFERENCE',
          confidenceScore: 1.0,
          transaction: tx,
          invoice: inv,
          discrepancies: [],
          applied: false,
        });
        break;
      }
    }
  }

  // =========================================================================
  // PASS 2: Exact Metrics (Exact Amount + Date ±2 days + IBAN / Exact Company Name)
  // =========================================================================
  for (let i = remainingTxs.length - 1; i >= 0; i--) {
    const tx = remainingTxs[i];

    for (const inv of availableInvoices) {
      if (!isInvoiceAvailable(inv.id)) continue;
      if (tx.currency !== inv.currency) continue;
      if (tx.amountCents !== inv.amountCents) continue;

      const dayDiffIssue = getDayDifference(tx.bookingDate, inv.issueDate);
      const dayDiffDue = inv.dueDate
        ? getDayDifference(tx.bookingDate, inv.dueDate)
        : Infinity;
      if (Math.min(dayDiffIssue, dayDiffDue) > dateTolerance) continue;

      // Check counterparty IBAN or exact cleaned company name
      const ibanMatch =
        tx.counterpartyIban &&
        inv.customerIban &&
        tx.counterpartyIban.replace(/\s/g, '').toUpperCase() ===
          inv.customerIban.replace(/\s/g, '').toUpperCase();

      const txCompany = cleanCompanyName(tx.counterpartyName || '');
      const invCompany = cleanCompanyName(inv.customerName);
      const companyExactMatch =
        txCompany.length >= 3 &&
        invCompany.length >= 3 &&
        (txCompany === invCompany ||
          txCompany.includes(invCompany) ||
          invCompany.includes(txCompany));

      if (ibanMatch || companyExactMatch) {
        matchedInvoiceIds.add(inv.id);
        remainingTxs.splice(i, 1);

        matches.push({
          status: 'MATCHED',
          level: 'EXACT_METRICS',
          confidenceScore: 0.98,
          transaction: tx,
          invoice: inv,
          discrepancies: ibanMatch
            ? ['Matched via counterparty IBAN and exact amount']
            : ['Matched via counterparty name and exact amount'],
          applied: false,
        });
        break;
      }
    }
  }

  // =========================================================================
  // PASS 3: Fuzzy Text Match (Jaro-Winkler on Remittance & Customer Name)
  // =========================================================================
  for (let i = remainingTxs.length - 1; i >= 0; i--) {
    const tx = remainingTxs[i];

    let bestInvoice: NormalizedInvoice | null = null;
    let bestScore = 0;
    let bestReason = '';
    let bestHasInvoiceRef = false;

    for (const inv of availableInvoices) {
      if (!isInvoiceAvailable(inv.id)) continue;
      if (tx.currency !== inv.currency) continue;

      // Allow slightly wider date window for fuzzy check (e.g. dateTolerance + 3)
      const dayDiffIssue = getDayDifference(tx.bookingDate, inv.issueDate);
      const dayDiffDue = inv.dueDate
        ? getDayDifference(tx.bookingDate, inv.dueDate)
        : Infinity;
      if (Math.min(dayDiffIssue, dayDiffDue) > dateTolerance + 3) continue;

      // Amount must be exact in this pass
      if (tx.amountCents !== inv.amountCents) continue;

      const { score, reason, hasInvoiceReference } = scoreRemittanceMatch(
        tx.reference,
        tx.counterpartyName,
        inv.invoiceNumber,
        inv.customerName
      );

      if (score > bestScore && score >= 0.70) {
        bestScore = score;
        bestInvoice = inv;
        bestReason = reason || 'High textual similarity on remittance';
        bestHasInvoiceRef = hasInvoiceReference;
      }
    }

    if (bestInvoice && bestScore >= 0.70) {
      matchedInvoiceIds.add(bestInvoice.id);
      remainingTxs.splice(i, 1);

      // Ban matching solely on company name as MATCHED; force REVIEW_NEEDED
      const isCompanyOnly = !bestHasInvoiceRef;
      const status = !isCompanyOnly && bestScore >= 0.95 ? 'MATCHED' : 'REVIEW_NEEDED';
      const confidence = isCompanyOnly
        ? Math.min(0.70, bestScore)
        : Math.round(bestScore * 100) / 100;

      const discrepancies = [bestReason];
      if (isCompanyOnly) {
        discrepancies.push('Missing invoice reference in remittance: matched solely on company name');
      }

      matches.push({
        status,
        level: 'FUZZY_REFERENCE',
        confidenceScore: confidence,
        transaction: tx,
        invoice: bestInvoice,
        discrepancies,
        applied: false,
      });
    }
  }

  // =========================================================================
  // PASS 4: Fee & Wire Commission Tolerance Match (Collision-Safe)
  // =========================================================================
  for (let i = remainingTxs.length - 1; i >= 0; i--) {
    const tx = remainingTxs[i];

    interface QualifyingCandidate {
      inv: NormalizedInvoice;
      amountDiffCents: number;
      score: number;
      reason: string;
      hasInvoiceReference: boolean;
    }

    const qualifying: QualifyingCandidate[] = [];

    for (const inv of availableInvoices) {
      if (!isInvoiceAvailable(inv.id)) continue;
      if (tx.currency !== inv.currency) continue;

      // Check date tolerance
      const dayDiffIssue = getDayDifference(tx.bookingDate, inv.issueDate);
      const dayDiffDue = inv.dueDate
        ? getDayDifference(tx.bookingDate, inv.dueDate)
        : Infinity;
      if (Math.min(dayDiffIssue, dayDiffDue) > dateTolerance + 2) continue;

      // In fee deduction: amount received is less than invoice amount
      const amountDiffCents = inv.amountCents - tx.amountCents;

      // Only check if amount received is less (underpayment/fee)
      if (amountDiffCents > 0) {
        const diffPercent = amountDiffCents / inv.amountCents;
        const withinFeeLimit =
          amountDiffCents <= feeToleranceCents || diffPercent <= feeTolerancePercent;

        if (withinFeeLimit) {
          // Verify counterparty or reference match
          const { score, reason, hasInvoiceReference } = scoreRemittanceMatch(
            tx.reference,
            tx.counterpartyName,
            inv.invoiceNumber,
            inv.customerName
          );

          if (score >= 0.70) {
            qualifying.push({
              inv,
              amountDiffCents,
              score,
              reason: reason || 'reference matched',
              hasInvoiceReference,
            });
          }
        }
      }
    }

    if (qualifying.length === 1) {
      const cand = qualifying[0];
      matchedInvoiceIds.add(cand.inv.id);
      remainingTxs.splice(i, 1);

      const feeFormatted = formatCents(cand.amountDiffCents, tx.currency);
      const discNote = `Amount discrepancy of ${feeFormatted} within fee tolerance (${cand.reason})`;

      matches.push({
        status: 'REVIEW_NEEDED',
        level: 'FEE_TOLERANCE',
        confidenceScore: Math.round(cand.score * 0.9 * 100) / 100,
        feeDeductionCents: cand.amountDiffCents,
        transaction: tx,
        invoice: cand.inv,
        discrepancies: [discNote],
        applied: false,
      });
    } else if (qualifying.length > 1) {
      // GREEDY COLLISION TRAP PROTECTED:
      // Multiple invoices qualify within fee tolerance window.
      // Strictly prevent greedy auto-match (MATCHED).
      // Force REVIEW_NEEDED, degrade confidenceScore to 0.65, and record warning.
      qualifying.sort(
        (a, b) => b.score - a.score || a.amountDiffCents - b.amountDiffCents
      );
      const best = qualifying[0];

      matchedInvoiceIds.add(best.inv.id);
      remainingTxs.splice(i, 1);

      const feeFormatted = formatCents(best.amountDiffCents, tx.currency);
      const candidateList = qualifying
        .map((q) => `${q.inv.invoiceNumber} (${formatCents(q.inv.amountCents, q.inv.currency)})`)
        .join(', ');

      matches.push({
        status: 'REVIEW_NEEDED',
        level: 'FEE_TOLERANCE',
        confidenceScore: 0.65,
        feeDeductionCents: best.amountDiffCents,
        transaction: tx,
        invoice: best.inv,
        discrepancies: [
          'Ambiguous match: multiple invoices qualify within fee tolerance window',
          `Conflicting candidates: ${candidateList}`,
          `Suggested candidate: ${best.inv.invoiceNumber} with fee deduction of ${feeFormatted}`,
        ],
        applied: false,
      });
    }
  }

  // =========================================================================
  // PASS 5: Remaining Unmatched Transactions (and Outgoing Transactions)
  // =========================================================================
  for (const tx of remainingTxs) {
    matches.push({
      status: 'UNMATCHED',
      level: 'NONE',
      confidenceScore: 0.0,
      transaction: tx,
      discrepancies: ['No matching invoice found for incoming transfer'],
      applied: false,
    });
  }

  for (const tx of outgoingTxs) {
    matches.push({
      status: 'UNMATCHED',
      level: 'NONE',
      confidenceScore: 0.0,
      transaction: tx,
      discrepancies: ['Outgoing bank debit / payout'],
      applied: false,
    });
  }

  // Identify unmatched invoices
  const unmatchedInvoices = availableInvoices.filter(
    (inv) => !matchedInvoiceIds.has(inv.id)
  );

  // Compute summary metrics
  const matchedCount = matches.filter((m) => m.status === 'MATCHED').length;
  const reviewNeededCount = matches.filter((m) => m.status === 'REVIEW_NEEDED').length;
  const unmatchedCount = matches.filter((m) => m.status === 'UNMATCHED').length;

  let totalMatchedCents = 0;
  for (const m of matches) {
    if (m.status === 'MATCHED' && m.invoice) {
      totalMatchedCents += m.invoice.amountCents;
    }
  }

  const defaultCurrency =
    transactions[0]?.currency || invoices[0]?.currency || 'EUR';

  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    statementFile: options?.statementFile || 'unknown-statement',
    sourceFormat: options?.sourceFormat || 'auto',
    summary: {
      totalTransactions: transactions.length,
      totalInvoices: invoices.length,
      matchedCount,
      reviewNeededCount,
      unmatchedCount,
      totalMatchedCents,
      currency: defaultCurrency,
    },
    matches,
    unmatchedInvoices,
  };
}
