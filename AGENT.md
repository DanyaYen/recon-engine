# AGENT.md: Machine & AI Agent Integration Guide

This document provides strict integration instructions, command interfaces, schemas, and best practices for AI agents (Cursor, Claude Code, Antigravity, OpenDevin, Copilot) interacting with `recon-engine`.

---

## 1. Execution Principles for LLM Agents

1. **Headless Execution Only**:
   Always supply `--json` and `--yes` (or `--non-interactive`) when invoking CLI commands via subshells or background tasks. Never trigger interactive prompts.
   ```bash
   bunx recon-engine match --statement <file> --invoices <file> --json --yes
   ```

2. **Zero Float Drift Guarantee**:
   All monetary amounts are strictly minor integer units (`amountCents: number`, e.g., 1000 = $10.00 / €10.00). Never convert to or from floats before matching.

3. **Format Sniffing**:
   The engine auto-detects CAMT.053 XML, SWIFT MT940, Revolut CSV, Stripe CSV, and Generic CSV automatically. Do not specify manual parser flags unless debugging obscure bank exports.

---

## 2. CLI Command Reference for Agents

### Parse a Statement
```bash
bunx recon-engine parse <statement_path> --json
```
**Output format:**
```json
{
  "parserId": "camt053",
  "parserName": "CAMT.053 (ISO 20022 XML)",
  "count": 10,
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
  ]
}
```

### Reconcile Statement with Invoices
```bash
bunx recon-engine match --statement <statement_path> --invoices <invoices_path> --json --yes
```
**Optional Flags:**
- `--date-tolerance <days>`: Allowed booking date offset (default: `2`).
- `--fee-tolerance <cents>`: Allowed wire fee underpayment deduction in cents (default: `2500` = €25.00).
- `--output <file.json>`: Write audit report to file in addition to stdout.

### Generate Synthetic Test Statements
```bash
bunx recon-engine mock --format <camt053|mt940|revolut|generic> --count <n> --noise <0.0-1.0> -o <output_file>
```

### Run HTTP Microservice
```bash
bunx recon-engine serve --port 3000
```

---

## 3. Data Schema Specifications

### `NormalizedTransaction`
```typescript
interface NormalizedTransaction {
  id: string;                      // Unique transaction identifier
  bookingDate: string;             // ISO date: YYYY-MM-DD
  valueDate?: string;              // ISO date: YYYY-MM-DD
  amountCents: number;             // Minor units (integer)
  currency: string;                // ISO 4217 (EUR, USD, GBP)
  direction: 'INCOMING' | 'OUTGOING';
  counterpartyName?: string;       // Cleaned name
  counterpartyIban?: string;       // Validated IBAN
  counterpartyBic?: string;        // BIC / SWIFT code
  reference?: string;              // Remittance text or invoice candidate
  bankTransactionId?: string;      // EndToEndId or SWIFT reference
  sourceFormat: string;            // camt053, mt940, revolut-csv, etc.
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
}
```

### `MatchResult`
```typescript
interface MatchResult {
  transaction: NormalizedTransaction;
  invoice: NormalizedInvoice | null;
  status: 'MATCHED' | 'REVIEW_NEEDED' | 'UNMATCHED';
  level: 'EXACT_REFERENCE' | 'EXACT_METRICS' | 'FUZZY_REFERENCE' | 'FEE_TOLERANCE' | 'MANUAL_REVIEW' | 'NONE';
  confidence: number;              // 0.0 to 1.0
  discrepancies: string[];         // Human and machine-readable explanation of discrepancies
}
```

---

## 4. HTTP API Endpoints

- `GET /health`: Health status (`{ status: "ok", version: "0.2.0" }`).
- `POST /v1/parse`: Accepts `{ content: string, format?: string }` or multipart `file`. Returns `{ transactions: NormalizedTransaction[] }`.
- `POST /v1/match`: Accepts `{ statement: string, invoices: NormalizedInvoice[] | string, dateToleranceDays?: number, feeToleranceCents?: number }` or multipart. Returns full `ReconciliationReport`.
