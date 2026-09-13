# AGENT.md: Machine & AI Agent Integration Guide

This document provides strict integration instructions, architectural invariants, command interfaces, schemas, and best practices for AI agents (Cursor, Claude Code, Antigravity, OpenDevin, Copilot) interacting with `recon-engine`.

---

## 1. Core Architectural Invariants for AI & Machine Agents

When modifying, extending, or debugging `recon-engine`, AI agents MUST adhere to these six inviolable rules:

### 1. Zero `process.exit()` in Library Code
Never call `process.exit()` in core logic, parsers, or matchers. Crashing the process terminates embedded callers and the HTTP server (`serve`). Always throw typed domain errors:
```typescript
import { InvalidInvoiceDataError } from './invoices.js';

// ❌ FORBIDDEN:
// if (!isValid) process.exit(1);

// ✅ REQUIRED:
if (!result.success) {
  throw new InvalidInvoiceDataError(
    `Validation error in invoices: ${result.error.message}`,
    result.error.issues
  );
}
```

### 2. Zero Float Drift Guarantee
Never use IEEE 754 floating-point arithmetic for currency calculations. All monetary amounts are integer minor units (`amountCents: number`, e.g., `1000` = €10.00). Never divide by 100 before comparisons or matching.
```typescript
import { formatCents } from '../utils/money.js';

// ❌ FORBIDDEN:
// const euros = cents / 100;
// if (Math.abs(txAmount - invAmount) < 0.05) ...

// ✅ REQUIRED:
const diffCents = inv.amountCents - tx.amountCents;
if (diffCents <= feeToleranceCents) { ... }

// Only format to decimal string for display:
const display = formatCents(diffCents, 'EUR'); // "€15.00"
```

### 3. Deterministic SHA-256 Idempotency Fingerprints
Never use row numbers or array indices as fallback transaction identifiers (e.g. `csv-0-1000`). If a statement lacks an explicit bank reference or `EndToEndId`, compute a canonical SHA-256 hash using `generateTransactionFingerprint()`:
```typescript
import { generateTransactionFingerprint } from '../utils/fingerprint.js';

// Canonical payload:
// `${accountIban?.trim().toUpperCase() || ''}|${bookingDate}|${amountCents}|${currency.toUpperCase()}|${bankRef?.trim() || ''}|${endToEndId?.trim() || ''}|${direction}`
const deterministicId = generateTransactionFingerprint({
  accountIban: tx.accountIban,
  bookingDate: tx.bookingDate,
  amountCents: tx.amountCents,
  currency: tx.currency,
  bankRef: tx.bankRef,
  endToEndId: tx.endToEndId,
  direction: tx.direction,
});
```

### 4. Strict Invoice Lifecycle Enforcement
Bank payments must only be reconciled against open, unpaid invoices. Invoices with `status !== 'OPEN'` (e.g., `PAID`, `VOID`, `DRAFT`, `UNCOLLECTIBLE`) must be filtered before matching and categorized as `skippedInvoices` with `reason: 'INVOICE_NOT_OPEN'`.
```typescript
// Filter incoming invoices:
const matchableInvoices = invoices.filter((inv) => inv.status === 'OPEN');
const skippedInvoices = invoices
  .filter((inv) => inv.status !== 'OPEN')
  .map((inv) => ({ ...inv, reason: 'INVOICE_NOT_OPEN' }));
```

### 5. Namespace-Agnostic XML Parsing & Reversals
CAMT.053 and ISO 20022 XML parsers must set `removeNSPrefix: true` in `fast-xml-parser` options to seamlessly handle arbitrary XML namespace prefixes (e.g. `<ns2:Document>`). Honor reversal indicators (`<RvslInd>true</RvslInd>`) by flipping transaction direction or marking reversal status.
```typescript
const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
});
```

### 6. O(N + M) Bucketed Matching Complexity
Never introduce nested `O(N * M)` comparison loops or `O(P^2)` candidate filtering. Candidate evaluation must be constrained using pre-indexed lookup maps:
1. **Stage 1: O(1) Exact Reference Map**: `exactRefMap: Map<string, NormalizedInvoice | 'AMBIGUOUS'>`.
2. **Stage 2: O(1) Amount & Currency Buckets**: `bucketMap: Map<string, NormalizedInvoice[]>`, keyed by `${currency}:${amountCents}`.
3. **Stage 3: Token-Pruned Scoped Fuzzy Match**: Inverted token index (`Map<token, Set<invoiceId>>`) to prune fuzzy candidate string comparisons before running Jaro-Winkler.
4. **Conflict Resolution**: Fast O(P) lookup index using `candidatesByInvoiceId` and `candidatesByTxId`.

---

## 2. Execution Principles for LLM Agents

1. **Headless Execution Only**:
   Always supply `--json` and `--yes` (or `--non-interactive`) when invoking CLI commands via subshells or background tasks. Never trigger interactive prompts.
   ```bash
   bunx @danyayen/recon-engine match --statement <file> --invoices <file> --json --yes
   ```

2. **Error Resilience & Quarantine (`rejectedRows`)**:
   Malformed or invalid rows do not fail an entire batch. Parsers use `safeParse` to isolate invalid entries into `rejectedRows` while valid entries are returned in `transactions`. Always check `result.rejectedRows`.

3. **Format Sniffing**:
   The engine auto-detects CAMT.053 XML, SWIFT MT940, Revolut CSV, Stripe CSV, and Generic CSV automatically. Do not specify manual parser flags unless debugging obscure bank exports.

---

## 3. CLI Command Reference for Agents

### Parse a Statement
```bash
bunx @danyayen/recon-engine parse <statement_path> --json
```
**Output format:**
```json
{
  "parserId": "camt053",
  "parserName": "CAMT.053 (ISO 20022 XML)",
  "count": 1,
  "transactions": [
    {
      "id": "E2E-2024-001",
      "bookingDate": "2024-09-01",
      "amountCents": 250000,
      "currency": "EUR",
      "direction": "INCOMING",
      "counterpartyName": "Acme Corp GmbH",
      "reference": "INV-2024-1000 Acme Corp GmbH",
      "sourceFormat": "camt053"
    }
  ],
  "rejectedRows": []
}
```

### Reconcile Statement with Invoices
```bash
bunx @danyayen/recon-engine match --statement <statement_path> --invoices <invoices_path> --json --yes
```
**Optional Flags:**
- `--date-tolerance <days>`: Allowed booking date offset (default: `2`).
- `--fee-tolerance <cents>`: Allowed wire fee underpayment deduction in cents (default: `2500` = €25.00).
- `--force`: Force auto-confirmation of risky counterparty matches when used with `--yes`.
- `--output <file.json>`: Write audit report to file in addition to stdout.

### Generate Synthetic Test Statements
```bash
bunx @danyayen/recon-engine mock --format <camt053|mt940|revolut|generic> --count <n> --noise <0.0-1.0> -o <output_file>
```

### Run HTTP Microservice
```bash
bunx @danyayen/recon-engine serve --port 3000
```

---

## 4. Data Schema Specifications

### `NormalizedTransaction`
```typescript
interface NormalizedTransaction {
  id: string;                      // Deterministic SHA-256 fingerprint or bank reference
  bookingDate: string;             // ISO date: YYYY-MM-DD
  valueDate?: string;              // ISO date: YYYY-MM-DD
  amountCents: number;             // Minor units (integer)
  currency: string;                // ISO 4217 (EUR, USD, GBP)
  direction: 'INCOMING' | 'OUTGOING';
  counterpartyName?: string;       // Cleaned counterparty name
  counterpartyIban?: string;       // Validated IBAN
  counterpartyBic?: string;        // BIC / SWIFT code
  reference?: string;              // Remittance text or invoice candidate
  bankTransactionId?: string;      // EndToEndId or SWIFT reference
  sourceFormat: string;            // camt053, mt940, revolut-csv, etc.
  raw?: Record<string, unknown>;   // Diagnostic payload: original unparsed row/fields
}
```

### `NormalizedInvoice`
```typescript
interface NormalizedInvoice {
  id: string;                      // System invoice ID
  invoiceNumber: string;           // Customer-visible invoice number
  amountCents: number;             // Expected payment amount in minor units
  currency: string;                // Expected currency (ISO 4217)
  issueDate: string;               // ISO date: YYYY-MM-DD
  dueDate?: string;                // ISO date: YYYY-MM-DD
  status: 'OPEN' | 'PAID' | 'VOID' | 'UNCOLLECTIBLE';
  customerName?: string;           // Debtor company or individual name
  customerIban?: string;           // Debtor IBAN if on file
  remainingCents?: number;         // Remaining unpaid amount after partial payments
  reason?: string;                 // Diagnostic reason if skipped (e.g. INVOICE_NOT_OPEN)
}
```

### `MatchResult`
```typescript
interface MatchResult {
  status: 'MATCHED' | 'EXACT_MATCH' | 'FUZZY_MATCH' | 'PARTIAL_MATCH' | 'REVIEW_NEEDED' | 'UNMATCHED';
  level: 'EXACT_REFERENCE' | 'EXACT_METRICS' | 'FUZZY_REFERENCE' | 'FEE_TOLERANCE' | 'PARTIAL_MATCH' | 'NONE';
  confidenceScore: number;         // 0.0 to 1.0
  matchedCents?: number;           // Matched amount in minor units
  remainingCents?: number;         // Remaining unpaid amount (invoice - tx)
  feeDeductionCents?: number;      // Deducted bank wire fee in minor units
  inferredFeeCents?: number;       // Inferred processing fee in minor units
  transaction: NormalizedTransaction;
  invoice?: NormalizedInvoice;
  discrepancies: string[];         // Human and machine-readable explanations
  applied: boolean;                // Whether applied to external ledger
  requiresForce?: boolean;         // True if match requires explicit --force
}
```

### `ParseStatementResult` & `RejectedRow`
```typescript
interface RejectedRow {
  index: number;                   // 0-based row index in source file
  raw: unknown;                    // Raw unparsed row content
  error: z.ZodError;               // Zod validation error details
}

interface ParseStatementResult {
  parserId: string;
  parserName: string;
  transactions: NormalizedTransaction[];
  rejectedRows: RejectedRow[];     // Quarantined invalid rows
}
```

### `ReconciliationReport`
```typescript
interface CurrencyTotal {
  matchedCents: number;
  unmatchedCents: number;
  feeCents: number;
}

interface ReconciliationReport {
  id: string;                      // UUID of reconciliation execution
  createdAt: string;               // ISO datetime
  statementFile: string;
  sourceFormat: string;
  summary: {
    totalTransactions: number;
    totalInvoices: number;
    matchedCount: number;
    reviewNeededCount: number;
    unmatchedCount: number;
    totalsByCurrency: Record<string, CurrencyTotal>; // Multi-currency totals
  };
  matches: MatchResult[];
  unmatchedInvoices: NormalizedInvoice[];
  skippedInvoices?: NormalizedInvoice[]; // Invoices with status !== 'OPEN'
}
```

---

## 5. HTTP API Endpoints

- `GET /health`: Health status (`{ status: "ok", version: "0.2.0" }`).
- `POST /v1/parse`: Accepts `{ content: string, format?: string }` or multipart `file`. Returns `ParseStatementResult` with `transactions` and `rejectedRows`.
- `POST /v1/match`: Accepts `{ statement: string, invoices: NormalizedInvoice[] | string, dateToleranceDays?: number, feeToleranceCents?: number }` or multipart. Returns full `ReconciliationReport` with `totalsByCurrency` and `skippedInvoices`.
