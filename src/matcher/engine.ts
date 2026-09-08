import { randomUUID } from 'crypto';
import type { NormalizedTransaction } from '../schemas/transaction.js';
import type { NormalizedInvoice } from '../schemas/invoice.js';
import type {
  MatchLevel,
  MatchStatus,
  MatchResult,
  ReconciliationReport,
} from '../schemas/reconciliation.js';
import { scoreRemittanceMatch, computeCompanySimilarity } from '../utils/fuzzy.js';
import { cleanCompanyName, stripInvoicePrefix } from '../utils/text.js';
import { formatCents } from '../utils/money.js';
import { getDayDifference } from '../utils/date.js';

export interface MatcherOptions {
  dateToleranceDays?: number; // default: 2 days (as specified in requirements)
  feeToleranceCents?: number; // default: 2500 cents (25.00 EUR/USD)
  feeTolerancePercent?: number; // default: 2%
  statementFile?: string;
  sourceFormat?: string;
}

/**
 * Checks if the remittance reference contains an exact match of the invoice number
 * or its unique isolated identifier.
 */
function hasExactInvoiceNumberMatch(reference: string | undefined, invoiceNumber: string): boolean {
  if (!reference || !invoiceNumber) return false;
  const ref = reference.toLowerCase();
  const inv = invoiceNumber.toLowerCase().trim();
  if (ref.includes(inv)) return true;

  const cleanRef = ref.replace(/[^a-z0-9]/g, '');
  const cleanInv = inv.replace(/[^a-z0-9]/g, '');
  if (cleanInv.length >= 4 && cleanRef.includes(cleanInv)) return true;

  const isolated = stripInvoicePrefix(inv).toLowerCase();
  if (isolated && isolated.length >= 3) {
    const wordRegex = new RegExp(`(^|[^a-z0-9])${isolated}([^a-z0-9]|$)`, 'i');
    if (wordRegex.test(ref)) return true;
  }
  return false;
}

interface CandidatePair {
  tx: NormalizedTransaction;
  invoice: NormalizedInvoice;
  confidenceScore: number;
  level: MatchLevel;
  status: MatchStatus;
  discrepancies: string[];
  feeDeductionCents?: number;
  requiresForce?: boolean;
}

/**
 * Deterministic and Fuzzy Financial Matching Engine.
 * Reconciles bank transactions against open invoices using matrix scoring:
 * 1. Generates all candidate pairs (Ti, Ij) with confidence scores
 * 2. Globally sorts the candidate pool descending by confidenceScore
 * 3. Claims invoices from most reliable (1.00) down to borderline (0.70)
 * 4. Flags competing transactions with close scores as REVIEW_NEEDED
 */
export function reconcile(
  transactions: NormalizedTransaction[],
  invoices: NormalizedInvoice[],
  options?: MatcherOptions
): ReconciliationReport {
  const dateTolerance = options?.dateToleranceDays ?? 2;
  const feeToleranceCents = options?.feeToleranceCents ?? 2500;
  const feeTolerancePercent = options?.feeTolerancePercent ?? 0.02;

  // Separate incoming and outgoing transactions
  const incomingTxs = transactions.filter((tx) => tx.direction === 'INCOMING');
  const outgoingTxs = transactions.filter((tx) => tx.direction === 'OUTGOING');

  // =========================================================================
  // STEP 1: GENERATE ALL CANDIDATE PAIRS (Ti, Ij) WITH CONFIDENCE SCORES
  // =========================================================================
  const candidatePool: CandidatePair[] = [];

  for (const tx of incomingTxs) {
    for (const inv of invoices) {
      if (tx.currency !== inv.currency) continue;

      const dayDiffIssue = getDayDifference(tx.bookingDate, inv.issueDate);
      const dayDiffDue = inv.dueDate ? getDayDifference(tx.bookingDate, inv.dueDate) : Infinity;
      const dayDiff = Math.min(dayDiffIssue, dayDiffDue);

      let bestCandidate: CandidatePair | null = null;

      // 1. Exact Reference Match (1.0)
      if (tx.amountCents === inv.amountCents && dayDiff <= dateTolerance) {
        const refText = `${tx.reference || ''} ${tx.bankTransactionId || ''}`.toLowerCase();
        const invNum = inv.invoiceNumber.toLowerCase();
        const invId = inv.id.toLowerCase();
        const cleanInvNum = invNum.replace(/[^a-z0-9]/g, '');

        const hasExactRef =
          (invNum.length >= 3 && refText.includes(invNum)) ||
          (invId.length >= 3 && refText.includes(invId)) ||
          (cleanInvNum.length >= 4 && refText.replace(/[^a-z0-9]/g, '').includes(cleanInvNum));

        if (hasExactRef) {
          bestCandidate = {
            tx,
            invoice: inv,
            confidenceScore: 1.0,
            level: 'EXACT_REFERENCE',
            status: 'MATCHED',
            discrepancies: [],
          };
        }
      }

      // 2. Exact Metrics (IBAN / Exact Company Name) (0.98)
      if (!bestCandidate && tx.amountCents === inv.amountCents && dayDiff <= dateTolerance) {
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
          bestCandidate = {
            tx,
            invoice: inv,
            confidenceScore: 0.98,
            level: 'EXACT_METRICS',
            status: 'MATCHED',
            discrepancies: ibanMatch
              ? ['Matched via counterparty IBAN and exact amount']
              : ['Matched via counterparty name and exact amount'],
          };
        }
      }

      // 3. Fuzzy Text Match (Jaro-Winkler) (>= 0.70)
      if (!bestCandidate && tx.amountCents === inv.amountCents && dayDiff <= dateTolerance + 3) {
        const { score, reason, hasInvoiceReference } = scoreRemittanceMatch(
          tx.reference,
          tx.counterpartyName,
          inv.invoiceNumber,
          inv.customerName
        );

        if (score >= 0.70) {
          const isCompanyOnly = !hasInvoiceReference;

          const ibanMatch = Boolean(
            tx.counterpartyIban &&
            inv.customerIban &&
            tx.counterpartyIban.replace(/\s/g, '').toUpperCase() ===
              inv.customerIban.replace(/\s/g, '').toUpperCase()
          );

          const companySim = computeCompanySimilarity(tx.counterpartyName, inv.customerName);
          const hasExactInvNum = hasExactInvoiceNumberMatch(tx.reference, inv.invoiceNumber);

          // Foreign counterparty protection:
          // If match found only by fuzzy reference (without exact invoice number match),
          // and counterparty similarity < 0.40, and IBAN does not match:
          // strictly forbid MATCHED, enforce REVIEW_NEEDED, and require explicit --force
          const isRiskyCounterparty = !hasExactInvNum && companySim < 0.40 && !ibanMatch;

          const status: MatchStatus =
            !isCompanyOnly && !isRiskyCounterparty && score >= 0.95 ? 'MATCHED' : 'REVIEW_NEEDED';
          const confidence = isCompanyOnly
            ? Math.min(0.70, score)
            : Math.round(score * 100) / 100;

          const discrepancies = [reason || 'High textual similarity on remittance'];
          if (isCompanyOnly) {
            discrepancies.push('Missing invoice reference in remittance: matched solely on company name');
          }
          if (isRiskyCounterparty) {
            discrepancies.push(
              'Risky counterparty mismatch: counterparty similarity < 0.40 and differing IBAN (requires explicit --force)'
            );
          }

          bestCandidate = {
            tx,
            invoice: inv,
            confidenceScore: confidence,
            level: 'FUZZY_REFERENCE',
            status,
            discrepancies,
            requiresForce: isRiskyCounterparty ? true : undefined,
          };
        }
      }

      // 4. Fee & Wire Commission Tolerance Match
      if (!bestCandidate && dayDiff <= dateTolerance + 2) {
        const amountDiffCents = inv.amountCents - tx.amountCents;
        if (amountDiffCents > 0) {
          const diffPercent = amountDiffCents / inv.amountCents;
          const withinFeeLimit =
            amountDiffCents <= feeToleranceCents || diffPercent <= feeTolerancePercent;

          if (withinFeeLimit) {
            const { score, reason } = scoreRemittanceMatch(
              tx.reference,
              tx.counterpartyName,
              inv.invoiceNumber,
              inv.customerName
            );

            if (score >= 0.65) {
              const ibanMatch = Boolean(
                tx.counterpartyIban &&
                inv.customerIban &&
                tx.counterpartyIban.replace(/\s/g, '').toUpperCase() ===
                  inv.customerIban.replace(/\s/g, '').toUpperCase()
              );

              const companySim = computeCompanySimilarity(tx.counterpartyName, inv.customerName);
              const hasExactInvNum = hasExactInvoiceNumberMatch(tx.reference, inv.invoiceNumber);
              const isRiskyCounterparty = !hasExactInvNum && companySim < 0.40 && !ibanMatch;

              const feeFormatted = formatCents(amountDiffCents, tx.currency);
              const discNote = `Amount discrepancy of ${feeFormatted} within fee tolerance (${reason || 'reference matched'})`;
              const discrepancies = [discNote];
              if (isRiskyCounterparty) {
                discrepancies.push(
                  'Risky counterparty mismatch: counterparty similarity < 0.40 and differing IBAN (requires explicit --force)'
                );
              }

              bestCandidate = {
                tx,
                invoice: inv,
                confidenceScore: Math.round(score * 0.9 * 100) / 100,
                level: 'FEE_TOLERANCE',
                status: 'REVIEW_NEEDED',
                feeDeductionCents: amountDiffCents,
                discrepancies,
                requiresForce: isRiskyCounterparty ? true : undefined,
              };
            }
          }
        }
      }

      if (bestCandidate && (bestCandidate.confidenceScore >= 0.70 || bestCandidate.level === 'FEE_TOLERANCE')) {
        candidatePool.push(bestCandidate);
      }
    }
  }

  // =========================================================================
  // STEP 2: SORT CANDIDATE POOL DESCENDING BY CONFIDENCE SCORE
  // =========================================================================
  candidatePool.sort((a, b) => {
    if (b.confidenceScore !== a.confidenceScore) {
      return b.confidenceScore - a.confidenceScore;
    }
    const levelPriority: Record<MatchLevel, number> = {
      EXACT_REFERENCE: 4,
      EXACT_METRICS: 3,
      FUZZY_REFERENCE: 2,
      FEE_TOLERANCE: 1,
      NONE: 0,
    };
    return (levelPriority[b.level] || 0) - (levelPriority[a.level] || 0);
  });

  // =========================================================================
  // STEP 3: CLAIM INVOICES STRICTLY FROM 1.00 TO 0.70 (CLOSE SCORE PROTECTION)
  // =========================================================================
  const matchedInvoiceIds = new Set<string>();
  const matchedTxIds = new Set<string>();
  const matches: MatchResult[] = [];
  const SCORE_CLOSE_THRESHOLD = 0.05;

  for (const cand of candidatePool) {
    if (matchedTxIds.has(cand.tx.id) || matchedInvoiceIds.has(cand.invoice.id)) {
      continue;
    }

    // High confidence exact reference match (1.00) claims invoice immediately
    if (cand.confidenceScore === 1.0 && cand.level === 'EXACT_REFERENCE') {
      matchedTxIds.add(cand.tx.id);
      matchedInvoiceIds.add(cand.invoice.id);
      matches.push({
        status: 'MATCHED',
        level: 'EXACT_REFERENCE',
        confidenceScore: 1.0,
        transaction: cand.tx,
        invoice: cand.invoice,
        discrepancies: cand.discrepancies,
        applied: false,
      });
      continue;
    }

    // For non-exact matches (< 1.00): check if another transaction claims this invoice with close score
    const competingForInvoice = candidatePool.filter(
      (c) =>
        c.invoice.id === cand.invoice.id &&
        c.tx.id !== cand.tx.id &&
        !matchedTxIds.has(c.tx.id) &&
        Math.abs(cand.confidenceScore - c.confidenceScore) <= SCORE_CLOSE_THRESHOLD
    );

    if (competingForInvoice.length > 0) {
      // Multiple transactions contend for the same invoice with close scores: mark all as REVIEW_NEEDED
      matchedInvoiceIds.add(cand.invoice.id);
      matchedTxIds.add(cand.tx.id);

      const compSummary = competingForInvoice
        .map((c) => `${c.tx.id} (score: ${c.confidenceScore.toFixed(2)})`)
        .join(', ');

      matches.push({
        status: 'REVIEW_NEEDED',
        level: cand.level,
        confidenceScore: cand.confidenceScore,
        feeDeductionCents: cand.feeDeductionCents,
        transaction: cand.tx,
        invoice: cand.invoice,
        discrepancies: [
          `Ambiguous match: multiple transactions claim invoice ${cand.invoice.invoiceNumber} with close confidence scores (${cand.tx.id}, ${compSummary})`,
          ...cand.discrepancies,
        ],
        applied: false,
        requiresForce: cand.requiresForce,
      });

      for (const comp of competingForInvoice) {
        matchedTxIds.add(comp.tx.id);
        matches.push({
          status: 'REVIEW_NEEDED',
          level: comp.level,
          confidenceScore: comp.confidenceScore,
          feeDeductionCents: comp.feeDeductionCents,
          transaction: comp.tx,
          invoice: comp.invoice,
          discrepancies: [
            `Ambiguous match: multiple transactions claim invoice ${comp.invoice.invoiceNumber} with close confidence scores (${comp.tx.id}, ${cand.tx.id})`,
            ...comp.discrepancies,
          ],
          applied: false,
          requiresForce: comp.requiresForce,
        });
      }
      continue;
    }

    // Check if this transaction claims multiple invoices with close score
    const competingForTx = candidatePool.filter(
      (c) =>
        c.tx.id === cand.tx.id &&
        c.invoice.id !== cand.invoice.id &&
        !matchedInvoiceIds.has(c.invoice.id) &&
        Math.abs(cand.confidenceScore - c.confidenceScore) <= SCORE_CLOSE_THRESHOLD
    );

    if (competingForTx.length > 0) {
      matchedTxIds.add(cand.tx.id);
      matchedInvoiceIds.add(cand.invoice.id);

      const feeFormatted = formatCents(cand.feeDeductionCents || 0, cand.tx.currency);
      const allCompetingInvs = [cand, ...competingForTx];
      const candidateList = allCompetingInvs
        .map((q) => `${q.invoice.invoiceNumber} (${formatCents(q.invoice.amountCents, q.invoice.currency)})`)
        .join(', ');

      const isFeeTolerance = cand.level === 'FEE_TOLERANCE';
      const discrepancies = isFeeTolerance
        ? [
            'Ambiguous match: multiple invoices qualify within fee tolerance window',
            `Conflicting candidates: ${candidateList}`,
            `Suggested candidate: ${cand.invoice.invoiceNumber} with fee deduction of ${feeFormatted}`,
          ]
        : [
            `Ambiguous match: payment matches multiple invoices with close confidence scores`,
            ...cand.discrepancies,
          ];

      matches.push({
        status: 'REVIEW_NEEDED',
        level: cand.level,
        confidenceScore: isFeeTolerance ? 0.65 : cand.confidenceScore,
        feeDeductionCents: cand.feeDeductionCents,
        transaction: cand.tx,
        invoice: cand.invoice,
        discrepancies,
        applied: false,
        requiresForce: cand.requiresForce,
      });
      continue;
    }

    // Unambiguous match at this confidence tier
    matchedTxIds.add(cand.tx.id);
    matchedInvoiceIds.add(cand.invoice.id);
    matches.push({
      status: cand.status,
      level: cand.level,
      confidenceScore: cand.confidenceScore,
      feeDeductionCents: cand.feeDeductionCents,
      transaction: cand.tx,
      invoice: cand.invoice,
      discrepancies: cand.discrepancies,
      applied: false,
      requiresForce: cand.requiresForce,
    });
  }

  // =========================================================================
  // UNMATCHED TRANSACTIONS
  // =========================================================================
  for (const tx of incomingTxs) {
    if (!matchedTxIds.has(tx.id)) {
      matches.push({
        status: 'UNMATCHED',
        level: 'NONE',
        confidenceScore: 0.0,
        transaction: tx,
        discrepancies: ['No matching invoice found for incoming transfer'],
        applied: false,
      });
    }
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
  const unmatchedInvoices = invoices.filter(
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
