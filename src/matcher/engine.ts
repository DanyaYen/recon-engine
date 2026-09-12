import { randomUUID } from 'crypto';
import type { NormalizedTransaction } from '../schemas/transaction.js';
import type { NormalizedInvoice } from '../schemas/invoice.js';
import type {
  MatchLevel,
  MatchStatus,
  MatchResult,
  ReconciliationReport,
  MatcherOptions,
} from '../schemas/reconciliation.js';
import { scoreRemittanceMatch, computeCompanySimilarity } from '../utils/fuzzy.js';
import { cleanCompanyName, stripInvoicePrefix } from '../utils/text.js';
import { formatCents } from '../utils/money.js';
import { getDayDifference } from '../utils/date.js';

export type { MatcherOptions } from '../schemas/reconciliation.js';

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

function hasExactInvoiceRef(tx: NormalizedTransaction, inv: NormalizedInvoice): boolean {
  const refText = `${tx.reference || ''} ${tx.bankTransactionId || ''}`.toLowerCase();
  const invNum = inv.invoiceNumber.toLowerCase();
  const invId = inv.id.toLowerCase();
  const cleanInvNum = invNum.replace(/[^a-z0-9]/g, '');

  return (
    (invNum.length >= 3 && refText.includes(invNum)) ||
    (invId.length >= 3 && refText.includes(invId)) ||
    (cleanInvNum.length >= 4 && refText.replace(/[^a-z0-9]/g, '').includes(cleanInvNum))
  );
}

function extractReferenceKeys(tx: NormalizedTransaction): string[] {
  const keys: string[] = [];
  const add = (k: string | undefined) => {
    if (!k) return;
    const c = k.trim().toLowerCase();
    if (c.length < 3) return;
    keys.push(c);
    const a = c.replace(/[^a-z0-9]/g, '');
    if (a.length >= 3 && a !== c) keys.push(a);
  };

  if (tx.bankTransactionId) add(tx.bankTransactionId);
  if (tx.reference) {
    add(tx.reference);
    const parts = tx.reference.split(/[\s,;/:|()]+/);
    for (let i = 0; i < parts.length; i++) {
      add(parts[i]);
    }
    const m = tx.reference.match(/[a-z]{2,}[\s_-]*\d+(?:[\s_-]*\d+)*/gi);
    if (m) {
      for (let i = 0; i < m.length; i++) {
        add(m[i]);
      }
    }
  }
  return keys;
}

function findInvoicesInAmountRange(
  sortedInvoices: NormalizedInvoice[],
  minAmount: number,
  maxAmount: number
): NormalizedInvoice[] {
  let low = 0;
  let high = sortedInvoices.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sortedInvoices[mid].amountCents < minAmount) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  const result: NormalizedInvoice[] = [];
  for (let i = low; i < sortedInvoices.length; i++) {
    if (sortedInvoices[i].amountCents > maxAmount) break;
    result.push(sortedInvoices[i]);
  }
  return result;
}

interface CandidatePair {
  tx: NormalizedTransaction;
  invoice: NormalizedInvoice;
  confidenceScore: number;
  level: MatchLevel;
  status: MatchStatus;
  discrepancies: string[];
  feeDeductionCents?: number;
  inferredFeeCents?: number;
  requiresForce?: boolean;
}

/**
 * Deterministic and Fuzzy Financial Matching Engine.
 * Optimized with two-stage bucket indexing:
 * - Stage 1 (Exact Match): Pre-indexes invoices into a Map keyed by amountCents/referenceId for O(1) matching.
 * - Stage 2 (Fuzzy Candidates): Restricts candidate search to +/- 3 days and +/- 2% amount tolerance.
 * - Excludes already matched invoices from subsequent iterations.
 */
export function reconcile(
  transactions: NormalizedTransaction[],
  invoices: NormalizedInvoice[],
  options?: MatcherOptions
): ReconciliationReport {
  const dateTolerance = options?.dateToleranceDays ?? 2;
  const feeToleranceCents =
    options?.feeToleranceCents !== undefined
      ? options.feeToleranceCents
      : options?.feeTolerancePercentage !== undefined
        ? 0
        : 2500;
  const feeTolerancePercent =
    options?.feeTolerancePercentage !== undefined
      ? options.feeTolerancePercentage
      : options?.feeTolerancePercent !== undefined
        ? options.feeTolerancePercent
        : 0.02;

  // Separate incoming and outgoing transactions
  const incomingTxs = transactions.filter((tx) => tx.direction === 'INCOMING');
  const outgoingTxs = transactions.filter((tx) => tx.direction === 'OUTGOING');

  const matchedInvoiceIds = new Set<string>();
  const matchedTxIds = new Set<string>();
  const matches: MatchResult[] = [];

  // =========================================================================
  // INDEXING: Invoices Pre-indexing
  // - exact reference index: Map<normalizedReference, NormalizedInvoice | 'AMBIGUOUS'>
  // - bucket map for amounts: Map<currency_amountCents, NormalizedInvoice[]>
  // =========================================================================
  const exactRefIndex = new Map<string, NormalizedInvoice | 'AMBIGUOUS'>();
  const invoicesByAmount = new Map<string, NormalizedInvoice[]>();

  function registerRef(key: string | undefined, inv: NormalizedInvoice) {
    if (!key) return;
    const clean = key.trim().toLowerCase();
    if (clean.length < 3) return;

    const add = (k: string) => {
      const existing = exactRefIndex.get(k);
      if (!existing) {
        exactRefIndex.set(k, inv);
      } else if (existing !== 'AMBIGUOUS' && existing.id !== inv.id) {
        exactRefIndex.set(k, 'AMBIGUOUS');
      }
    };

    add(clean);
    const alphaNum = clean.replace(/[^a-z0-9]/g, '');
    if (alphaNum.length >= 3 && alphaNum !== clean) {
      add(alphaNum);
    }
    const isolated = stripInvoicePrefix(clean).replace(/[^a-z0-9]/g, '');
    if (isolated.length >= 4 && isolated !== alphaNum) {
      add(isolated);
    }
  }

  for (const inv of invoices) {
    registerRef(inv.invoiceNumber, inv);
    registerRef(inv.id, inv);

    const key = `${inv.currency}:${inv.amountCents}`;
    const list = invoicesByAmount.get(key);
    if (list) {
      list.push(inv);
    } else {
      invoicesByAmount.set(key, [inv]);
    }
  }

  // =========================================================================
  // STAGE 1: EXACT REFERENCE MATCH (O(1) per transaction)
  // If reference matches, claim immediately.
  // =========================================================================
  for (const tx of incomingTxs) {
    const keys = extractReferenceKeys(tx);
    for (const key of keys) {
      const inv = exactRefIndex.get(key);
      if (!inv || inv === 'AMBIGUOUS' || matchedInvoiceIds.has(inv.id)) {
        continue;
      }

      if (tx.currency !== inv.currency || tx.amountCents !== inv.amountCents) {
        continue;
      }

      const dayDiffIssue = getDayDifference(tx.bookingDate, inv.issueDate);
      const dayDiffDue = inv.dueDate ? getDayDifference(tx.bookingDate, inv.dueDate) : Infinity;
      const dayDiff = Math.min(dayDiffIssue, dayDiffDue);

      if (dayDiff <= dateTolerance) {
        matchedTxIds.add(tx.id);
        matchedInvoiceIds.add(inv.id);
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
  // STAGE 2: EXACT AMOUNT + DATE BUCKET MATCH &
  // STAGE 3: FUZZY CANDIDATES (Restricted window & excluded matched invoices)
  // Date tolerance: +/- 3 days from dateTolerance
  // Amount tolerance: +/- feeTolerance
  // =========================================================================
  const remainingTxs = incomingTxs.filter((tx) => !matchedTxIds.has(tx.id));
  const remainingInvoices = invoices.filter((inv) => !matchedInvoiceIds.has(inv.id));

  if (remainingTxs.length > 0 && remainingInvoices.length > 0) {
    // Index remaining invoices by currency:amountCents for O(1) exact amount lookup
    const remainingByAmount = new Map<string, NormalizedInvoice[]>();
    // Group remaining invoices by currency sorted by amountCents for range lookups
    const remainingSortedByCurrency = new Map<string, NormalizedInvoice[]>();

    for (const inv of remainingInvoices) {
      const key = `${inv.currency}:${inv.amountCents}`;
      const list = remainingByAmount.get(key);
      if (list) {
        list.push(inv);
      } else {
        remainingByAmount.set(key, [inv]);
      }

      const cList = remainingSortedByCurrency.get(inv.currency);
      if (cList) {
        cList.push(inv);
      } else {
        remainingSortedByCurrency.set(inv.currency, [inv]);
      }
    }

    for (const list of remainingSortedByCurrency.values()) {
      list.sort((a, b) => a.amountCents - b.amountCents);
    }

    const stage2CandidatePool: CandidatePair[] = [];
    const isFeeToleranceActive = feeToleranceCents > 0 || feeTolerancePercent > 0;

    for (const tx of remainingTxs) {
      const txCandidates: CandidatePair[] = [];
      let maxCandidateScore = 0;

      // STAGE 2: Exact amount candidates
      const exactAmountInvoices = remainingByAmount.get(`${tx.currency}:${tx.amountCents}`) || [];

      for (const inv of exactAmountInvoices) {
        if (matchedInvoiceIds.has(inv.id)) continue;

        const dayDiffIssue = getDayDifference(tx.bookingDate, inv.issueDate);
        const dayDiffDue = inv.dueDate ? getDayDifference(tx.bookingDate, inv.dueDate) : Infinity;
        const dayDiff = Math.min(dayDiffIssue, dayDiffDue);

        if (dayDiff > dateTolerance + 3) {
          continue;
        }

        // Exact Reference fallback
        if (dayDiff <= dateTolerance && hasExactInvoiceRef(tx, inv)) {
          const c: CandidatePair = {
            tx,
            invoice: inv,
            confidenceScore: 1.0,
            level: 'EXACT_REFERENCE',
            status: 'MATCHED',
            discrepancies: [],
          };
          txCandidates.push(c);
          if (c.confidenceScore > maxCandidateScore) maxCandidateScore = c.confidenceScore;
          continue;
        }

        // 2. Exact Metrics (IBAN / Exact Company Name) (0.98)
        if (dayDiff <= dateTolerance) {
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
            const c: CandidatePair = {
              tx,
              invoice: inv,
              confidenceScore: 0.98,
              level: 'EXACT_METRICS',
              status: 'MATCHED',
              discrepancies: ibanMatch
                ? ['Matched via counterparty IBAN and exact amount']
                : ['Matched via counterparty name and exact amount'],
            };
            txCandidates.push(c);
            if (c.confidenceScore > maxCandidateScore) maxCandidateScore = c.confidenceScore;
            continue;
          }
        }

        // 3. STAGE 3A: Fuzzy Text Match (Jaro-Winkler) (>= 0.70)
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

          const c: CandidatePair = {
            tx,
            invoice: inv,
            confidenceScore: confidence,
            level: 'FUZZY_REFERENCE',
            status,
            discrepancies,
            requiresForce: isRiskyCounterparty ? true : undefined,
          };
          txCandidates.push(c);
          if (c.confidenceScore > maxCandidateScore) maxCandidateScore = c.confidenceScore;
        }
      }

      // STAGE 3B: Fee & Wire Commission Tolerance Match
      if (isFeeToleranceActive && maxCandidateScore < 0.95) {
        // Direct reference check first
        const directCandidates = new Set<NormalizedInvoice>();
        const keys = extractReferenceKeys(tx);
        for (const k of keys) {
          const inv = exactRefIndex.get(k);
          if (inv && inv !== 'AMBIGUOUS' && !matchedInvoiceIds.has(inv.id) && inv.currency === tx.currency) {
            directCandidates.add(inv);
          }
        }

        let evaluatedDirect = false;
        if (directCandidates.size > 0) {
          for (const inv of directCandidates) {
            const amountDiffCents = inv.amountCents - tx.amountCents;
            if (amountDiffCents <= 0) continue;

            const minAllowedAmount = feeTolerancePercent > 0
              ? Math.floor(inv.amountCents * (1 - feeTolerancePercent))
              : 0;
            const withinFeeLimit =
              (feeToleranceCents > 0 && amountDiffCents <= feeToleranceCents) ||
              (feeTolerancePercent > 0 && tx.amountCents >= minAllowedAmount);

            if (!withinFeeLimit) continue;

            const dayDiffIssue = getDayDifference(tx.bookingDate, inv.issueDate);
            const dayDiffDue = inv.dueDate ? getDayDifference(tx.bookingDate, inv.dueDate) : Infinity;
            const dayDiff = Math.min(dayDiffIssue, dayDiffDue);
            if (dayDiff > dateTolerance + 2) continue;

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

              const c: CandidatePair = {
                tx,
                invoice: inv,
                confidenceScore: Math.round(score * 0.9 * 100) / 100,
                level: 'FEE_TOLERANCE',
                status: 'REVIEW_NEEDED',
                feeDeductionCents: amountDiffCents,
                inferredFeeCents: amountDiffCents,
                discrepancies,
                requiresForce: isRiskyCounterparty ? true : undefined,
              };
              txCandidates.push(c);
              if (c.confidenceScore > maxCandidateScore) maxCandidateScore = c.confidenceScore;
              evaluatedDirect = true;
            }
          }
        }

        if (!evaluatedDirect) {
          const sortedCurrencyInvs = remainingSortedByCurrency.get(tx.currency) || [];
          if (sortedCurrencyInvs.length > 0) {
            const maxFeeDelta =
              feeTolerancePercent > 0
                ? Math.ceil(tx.amountCents / (1 - feeTolerancePercent)) - tx.amountCents
                : feeToleranceCents;
            const allowedDelta = Math.max(feeToleranceCents, maxFeeDelta);
            const maxInvoiceAmount = tx.amountCents + allowedDelta;

            const feeCandidateInvoices = findInvoicesInAmountRange(
              sortedCurrencyInvs,
              tx.amountCents + 1,
              maxInvoiceAmount
            );

            for (const inv of feeCandidateInvoices) {
              if (matchedInvoiceIds.has(inv.id)) continue;

              const dayDiffIssue = getDayDifference(tx.bookingDate, inv.issueDate);
              const dayDiffDue = inv.dueDate ? getDayDifference(tx.bookingDate, inv.dueDate) : Infinity;
              const dayDiff = Math.min(dayDiffIssue, dayDiffDue);

              if (dayDiff > dateTolerance + 2) continue;

              const amountDiffCents = inv.amountCents - tx.amountCents;
              const minAllowedAmount = feeTolerancePercent > 0
                ? Math.floor(inv.amountCents * (1 - feeTolerancePercent))
                : 0;
              const withinFeeLimit =
                (feeToleranceCents > 0 && amountDiffCents <= feeToleranceCents) ||
                (feeTolerancePercent > 0 && tx.amountCents >= minAllowedAmount);

              if (!withinFeeLimit) continue;

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

                const c: CandidatePair = {
                  tx,
                  invoice: inv,
                  confidenceScore: Math.round(score * 0.9 * 100) / 100,
                  level: 'FEE_TOLERANCE',
                  status: 'REVIEW_NEEDED',
                  feeDeductionCents: amountDiffCents,
                  inferredFeeCents: amountDiffCents,
                  discrepancies,
                  requiresForce: isRiskyCounterparty ? true : undefined,
                };
                txCandidates.push(c);
                if (c.confidenceScore > maxCandidateScore) maxCandidateScore = c.confidenceScore;
              }
            }
          }
        }
      }

      for (const c of txCandidates) {
        if (c.confidenceScore >= maxCandidateScore - 0.05) {
          stage2CandidatePool.push(c);
        }
      }
    }

    // Sort candidate pool descending by confidence score
    stage2CandidatePool.sort((a, b) => {
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

    // Build fast lookup maps for collision checks
    const candidatesByInvoice = new Map<string, CandidatePair[]>();
    const candidatesByTx = new Map<string, CandidatePair[]>();
    for (const c of stage2CandidatePool) {
      const invList = candidatesByInvoice.get(c.invoice.id);
      if (invList) invList.push(c);
      else candidatesByInvoice.set(c.invoice.id, [c]);

      const txList = candidatesByTx.get(c.tx.id);
      if (txList) txList.push(c);
      else candidatesByTx.set(c.tx.id, [c]);
    }

    const SCORE_CLOSE_THRESHOLD = 0.05;

    for (const cand of stage2CandidatePool) {
      if (matchedTxIds.has(cand.tx.id) || matchedInvoiceIds.has(cand.invoice.id)) {
        continue;
      }

      // Check if another transaction claims this invoice with close score
      const invCandidates = candidatesByInvoice.get(cand.invoice.id) || [];
      const competingForInvoice = invCandidates.filter(
        (c) =>
          c.tx.id !== cand.tx.id &&
          !matchedTxIds.has(c.tx.id) &&
          Math.abs(cand.confidenceScore - c.confidenceScore) <= SCORE_CLOSE_THRESHOLD
      );

      if (competingForInvoice.length > 0) {
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
          inferredFeeCents: cand.inferredFeeCents,
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
            inferredFeeCents: comp.inferredFeeCents,
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
      const txCandidates = candidatesByTx.get(cand.tx.id) || [];
      const competingForTx = txCandidates.filter(
        (c) =>
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
          inferredFeeCents: cand.inferredFeeCents,
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
        inferredFeeCents: cand.inferredFeeCents,
        transaction: cand.tx,
        invoice: cand.invoice,
        discrepancies: cand.discrepancies,
        applied: false,
        requiresForce: cand.requiresForce,
      });
    }
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

  // Collect all currencies encountered
  const currencies = new Set<string>();
  for (const tx of transactions) {
    if (tx.currency) currencies.add(tx.currency);
  }
  for (const inv of invoices) {
    if (inv.currency) currencies.add(inv.currency);
  }
  if (currencies.size === 0) {
    currencies.add('EUR');
  }

  const totalsByCurrency: Record<
    string,
    { matchedCents: number; unmatchedCents: number; feeCents: number }
  > = {};

  for (const curr of currencies) {
    totalsByCurrency[curr] = {
      matchedCents: 0,
      unmatchedCents: 0,
      feeCents: 0,
    };
  }

  for (const m of matches) {
    const curr = m.transaction.currency || m.invoice?.currency || 'EUR';
    if (!totalsByCurrency[curr]) {
      totalsByCurrency[curr] = { matchedCents: 0, unmatchedCents: 0, feeCents: 0 };
    }

    if (m.status === 'MATCHED') {
      totalsByCurrency[curr].matchedCents += m.invoice
        ? m.invoice.amountCents
        : m.transaction.amountCents;
      if (m.inferredFeeCents || m.feeDeductionCents) {
        totalsByCurrency[curr].feeCents += m.inferredFeeCents || m.feeDeductionCents || 0;
      }
    } else if (m.status === 'UNMATCHED') {
      totalsByCurrency[curr].unmatchedCents += m.transaction.amountCents;
    } else if (m.status === 'REVIEW_NEEDED') {
      if (m.inferredFeeCents || m.feeDeductionCents) {
        totalsByCurrency[curr].feeCents += m.inferredFeeCents || m.feeDeductionCents || 0;
      }
    }
  }

  const defaultCurrency =
    transactions[0]?.currency || invoices[0]?.currency || 'EUR';
  const totalMatchedCents = totalsByCurrency[defaultCurrency]?.matchedCents || 0;

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
      totalsByCurrency,
    },
    matches,
    unmatchedInvoices,
  };
}
