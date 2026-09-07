/**
 * Fast, zero-dependency string similarity algorithms (Jaro, Jaro-Winkler, Levenshtein)
 * optimized for financial remittance and invoice matching.
 */

import { cleanCompanyName, extractInvoiceCandidates } from './text.js';

/**
 * Calculates standard Jaro similarity between two strings.
 * Returns a score between 0.0 (no similarity) and 1.0 (exact match).
 */
export function jaroSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;

  const matchWindow = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Identify matching characters
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (!s2Matches[j] && s1[i] === s2[j]) {
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches++;
        break;
      }
    }
  }

  if (matches === 0) return 0.0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) {
      k++;
    }
    if (s1[i] !== s2[k]) {
      transpositions++;
    }
    k++;
  }

  return (
    (matches / s1.length +
      matches / s2.length +
      (matches - transpositions / 2) / matches) /
    3
  );
}

/**
 * Calculates Jaro-Winkler similarity.
 * Adds a prefix scaling boost (up to 4 matching prefix characters)
 * which strongly benefits invoice numbers and corporate identifiers.
 */
export function jaroWinklerSimilarity(
  s1: string,
  s2: string,
  prefixScale = 0.1
): number {
  const jaro = jaroSimilarity(s1, s2);
  if (jaro < 0.7) return jaro;

  let prefixLength = 0;
  const maxPrefix = Math.min(4, Math.min(s1.length, s2.length));

  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) {
      prefixLength++;
    } else {
      break;
    }
  }

  return jaro + prefixLength * prefixScale * (1 - jaro);
}

/**
 * Normalized Levenshtein similarity between two strings: [0.0, 1.0].
 */
export function levenshteinSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;

  const m = s1.length;
  const n = s2.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      if (s1[i - 1] === s2[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      }
      prev = temp;
    }
  }

  const distance = dp[n];
  const maxLen = Math.max(m, n);
  return 1 - distance / maxLen;
}

export interface RemittanceScoreResult {
  score: number;
  reason?: string;
  matchedToken?: string;
}

/**
 * Scores how well a bank statement remittance/reference matches an invoice number and customer name.
 */
export function scoreRemittanceMatch(
  remittance: string | undefined,
  counterpartyName: string | undefined,
  invoiceNumber: string,
  customerName: string
): RemittanceScoreResult {
  const normalizedRemit = (remittance || '').toLowerCase().trim();
  const normalizedInvNum = invoiceNumber.toLowerCase().trim();
  const cleanInvNum = normalizedInvNum.replace(/[^a-z0-9]/g, '');

  // 1. Exact invoice number present inside remittance
  if (normalizedRemit && normalizedRemit.includes(normalizedInvNum)) {
    return {
      score: 1.0,
      reason: `Exact invoice number '${invoiceNumber}' found in remittance`,
      matchedToken: invoiceNumber,
    };
  }

  // 2. Exact invoice number stripped of dashes/spaces found in remittance
  const cleanRemit = normalizedRemit.replace(/[^a-z0-9]/g, '');
  if (cleanInvNum.length >= 4 && cleanRemit.includes(cleanInvNum)) {
    return {
      score: 0.98,
      reason: `Normalized invoice number '${invoiceNumber}' found in remittance`,
      matchedToken: invoiceNumber,
    };
  }

  // 3. Candidate tokens extracted from remittance tested against invoice number
  const candidates = extractInvoiceCandidates(remittance || '');
  let bestTokenScore = 0;
  let bestToken = '';

  for (const candidate of candidates) {
    const score = jaroWinklerSimilarity(
      candidate.toLowerCase(),
      normalizedInvNum
    );
    if (score > bestTokenScore) {
      bestTokenScore = score;
      bestToken = candidate;
    }
  }

  if (bestTokenScore >= 0.85) {
    return {
      score: bestTokenScore,
      reason: `Fuzzy match on invoice token '${bestToken}' vs '${invoiceNumber}' (score: ${bestTokenScore.toFixed(2)})`,
      matchedToken: bestToken,
    };
  }

  // 4. Counterparty name vs Customer name similarity
  let nameScore = 0;
  if (counterpartyName && customerName) {
    const cleanCounterparty = cleanCompanyName(counterpartyName);
    const cleanCustomer = cleanCompanyName(customerName);

    if (cleanCounterparty && cleanCustomer) {
      if (
        cleanCounterparty.includes(cleanCustomer) ||
        cleanCustomer.includes(cleanCounterparty)
      ) {
        nameScore = 0.95;
      } else {
        nameScore = jaroWinklerSimilarity(cleanCounterparty, cleanCustomer);
      }
    }
  }

  if (nameScore >= 0.80) {
    return {
      score: nameScore * 0.9, // Slight discount when matching only company name without invoice ID
      reason: `Fuzzy match on company name: '${counterpartyName}' vs '${customerName}' (score: ${nameScore.toFixed(2)})`,
    };
  }

  const overallScore = Math.max(bestTokenScore, nameScore * 0.85);
  return {
    score: overallScore,
    reason: overallScore > 0.6 ? `Weak textual similarity (${overallScore.toFixed(2)})` : undefined,
  };
}
