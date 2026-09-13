/**
 * Fast, zero-dependency string similarity algorithms (Jaro, Jaro-Winkler, Levenshtein)
 * optimized for financial remittance and invoice matching.
 */

import { cleanCompanyName, extractInvoiceCandidates, normalizeRemittance, stripInvoicePrefix } from './text.js';

/**
 * Calculates similarity between two company/counterparty names [0.0, 1.0].
 * Cleans corporate suffixes and punctuation, and avoids the high-floor issue of standard Jaro on short strings.
 */
export function computeCompanySimilarity(name1: string | undefined, name2: string | undefined): number {
  if (!name1 || !name2) return 0;
  const c1 = cleanCompanyName(name1);
  const c2 = cleanCompanyName(name2);
  if (!c1 || !c2) return 0;
  if (c1 === c2 || c1.includes(c2) || c2.includes(c1)) return 1.0;

  const maxLen = Math.max(c1.length, c2.length);
  const lenDiff = Math.abs(c1.length - c2.length);
  const maxDistance = Math.floor(maxLen * 0.5);

  // Early exit: skip Levenshtein if difference in string lengths exceeds max distance
  if (lenDiff > maxDistance) {
    return 0;
  }

  const jw = jaroWinklerSimilarity(c1, c2);
  if (jw < 0.4) return 0;

  const lev = levenshteinSimilarity(c1, c2, maxDistance);
  return Math.min(jw, (jw + lev) / 2);
}

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
 * Early exit: skips DP table computation if difference in string lengths exceeds maxDistance.
 */
export function levenshteinSimilarity(s1: string, s2: string, maxDistance?: number): number {
  if (s1 === s2) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;

  const m = s1.length;
  const n = s2.length;
  const lenDiff = Math.abs(m - n);
  const maxLen = Math.max(m, n);

  // Early exit: skip Levenshtein if difference in string lengths exceeds max distance
  if (maxDistance !== undefined && lenDiff > maxDistance) {
    return Math.max(0, 1 - lenDiff / maxLen);
  }

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
  return 1 - distance / maxLen;
}

export interface RemittanceScoreResult {
  score: number;
  reason?: string;
  matchedToken?: string;
  hasInvoiceReference: boolean;
}

/**
 * Compares an extracted candidate token against an invoice number.
 * Protects against false positives when two invoice numbers share a common prefix
 * (e.g. "INV-2024-8803" vs "INV-2024-001"), by verifying the distinct identifier suffix.
 */
function compareInvoiceTokens(candidate: string, invoiceNum: string): number {
  const c = candidate.toLowerCase().trim();
  const inv = invoiceNum.toLowerCase().trim();
  if (c === inv) return 1.0;

  // Isolate unique numeric or alphanumeric parts (stripping INV-, INV/, INV-2024-, RECH-, etc.)
  const cIsolated = stripInvoicePrefix(c).toLowerCase();
  const invIsolated = stripInvoicePrefix(inv).toLowerCase();

  // If both have isolated parts, compare the isolated unique identifiers directly
  if (cIsolated && invIsolated) {
    if (cIsolated === invIsolated) return 1.0;
    return jaroWinklerSimilarity(cIsolated, invIsolated);
  }

  const baseScore = jaroWinklerSimilarity(c, inv);
  if (baseScore < 0.75) return baseScore;

  // Extract suffix numbers (e.g. "8803" vs "001")
  const cNum = c.match(/[0-9]{2,10}[a-z]?$/)?.[0];
  const invNum = inv.match(/[0-9]{2,10}[a-z]?$/)?.[0];

  if (cNum && invNum) {
    if (cNum === invNum) return 1.0;
    const numSim = jaroSimilarity(cNum, invNum);
    if (numSim < 0.6) {
      return baseScore * 0.4;
    }
  }

  return baseScore;
}

/**
 * Scores how well a bank statement remittance/reference matches an invoice number and customer name.
 * Pre-processes remittance against banking stop-words and tags (EREF+, SVWZ+, etc.) before fuzzy comparison.
 */
export function scoreRemittanceMatch(
  remittance: string | undefined,
  counterpartyName: string | undefined,
  invoiceNumber: string,
  customerName: string
): RemittanceScoreResult {
  const rawRemit = remittance || '';
  const normalizedRemit = rawRemit.toLowerCase().trim();
  const normalizedInvNum = invoiceNumber.toLowerCase().trim();
  const cleanInvNum = normalizedInvNum.replace(/[^a-z0-9]/g, '');

  // 1. Exact invoice number present inside remittance
  if (normalizedRemit && normalizedRemit.includes(normalizedInvNum)) {
    return {
      score: 1.0,
      reason: `Exact invoice number '${invoiceNumber}' found in remittance`,
      matchedToken: invoiceNumber,
      hasInvoiceReference: true,
    };
  }

  // 2. Exact invoice number stripped of dashes/spaces found in remittance
  const cleanRemit = normalizedRemit.replace(/[^a-z0-9]/g, '');
  if (cleanInvNum.length >= 4 && cleanRemit.includes(cleanInvNum)) {
    return {
      score: 0.98,
      reason: `Normalized invoice number '${invoiceNumber}' found in remittance`,
      matchedToken: invoiceNumber,
      hasInvoiceReference: true,
    };
  }

  // Check company compatibility if both counterparty and customer are present
  let companyConflicting = false;
  let companyCompatScore = 0;
  if (counterpartyName && customerName) {
    companyCompatScore = computeCompanySimilarity(counterpartyName, customerName);
    if (companyCompatScore < 0.40) {
      companyConflicting = true;
    }
  }

  // 3. Pre-process and sanitize remittance (strip EREF+, SVWZ+, IBAN, BIC, stop-words)
  const sanitizedRemit = normalizeRemittance(rawRemit);

  // Candidate tokens extracted from both raw remittance and sanitized remittance
  const rawCandidates = extractInvoiceCandidates(rawRemit);
  const sanitizedCandidates = extractInvoiceCandidates(sanitizedRemit);
  const allCandidates = Array.from(new Set([...rawCandidates, ...sanitizedCandidates]));

  let bestTokenScore = 0;
  let bestToken = '';

  for (const candidate of allCandidates) {
    const score = compareInvoiceTokens(
      candidate.toLowerCase(),
      normalizedInvNum
    );
    if (score > bestTokenScore) {
      bestTokenScore = score;
      bestToken = candidate;
    }
  }

  // Also test Jaro-Winkler on individual words of sanitized remittance
  const sanitizedWords = sanitizedRemit.split(/\s+/).filter((w) => w.length >= 3);
  for (const word of sanitizedWords) {
    const score = compareInvoiceTokens(word, normalizedInvNum);
    if (score > bestTokenScore) {
      bestTokenScore = score;
      bestToken = word;
    }
  }

  // If company names are known to conflict, do not accept non-exact token matches
  if (companyConflicting && bestTokenScore < 0.98) {
    bestTokenScore = bestTokenScore * 0.4;
  }

  if (bestTokenScore >= 0.85) {
    return {
      score: bestTokenScore,
      reason: `Fuzzy match on invoice token '${bestToken}' vs '${invoiceNumber}' (score: ${bestTokenScore.toFixed(2)})`,
      matchedToken: bestToken,
      hasInvoiceReference: true,
    };
  }

  // 4. Counterparty name vs Customer name similarity
  let nameScore = 0;
  if (counterpartyName && customerName) {
    nameScore = computeCompanySimilarity(counterpartyName, customerName);
  }

  // Company-only match (invoice reference or token completely absent)
  // Strictly forbid high-confidence match on company alone; demote score to <= 0.70 and require review
  if (nameScore >= 0.80) {
    return {
      score: 0.70,
      reason: `Company name matched ('${counterpartyName}' vs '${customerName}'), but invoice reference was missing`,
      hasInvoiceReference: false,
    };
  }

  const overallScore = Math.max(bestTokenScore, nameScore * 0.6);
  return {
    score: overallScore,
    reason: overallScore >= 0.6 ? `Weak textual similarity (${overallScore.toFixed(2)})` : undefined,
    hasInvoiceReference: false,
  };
}
