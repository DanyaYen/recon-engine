# ⚡ Reconciliation-as-Code (`recon-engine`)

> Stateless, Deterministic Reconciliation Engine & Parser Library (In-Memory Batch Matching for B2B SaaS).

![The Real-World Reconciliation Benchmark](./assets/benchmark.png)

[![Bun](https://img.shields.io/badge/Bun-1.3+-black.svg?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg?logo=typescript)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/Tests-83%20passed-success.svg)](./tests)
[![AI Ready](https://img.shields.io/badge/AI%20Agents-AGENT.md-purple.svg)](./AGENT.md)

> [!IMPORTANT]
> **Architectural Boundary & Positioning**: `recon-engine` is **not** a replacement for a General Ledger (GL) or core banking ledger. It is a stateless, deterministic reconciliation engine & parser library designed exclusively for pure in-memory batch calculations inside the user's own infrastructure. Double-entry bookkeeping, ledger balance mutations, and financial audit persistence remain strictly the responsibility of your primary database and GL.

![Reconciliation-as-Code Demo](./demo.gif)

---

## 💡 Why `recon-engine`?

Every B2B platform is stuck writing brittle, one-off glue scripts to parse bank statements (**CSV**, **CAMT.053 XML**, **SWIFT MT940**) and match them against invoices.

Heavy enterprise platforms cost $2,000+/mo and require months of sales calls. `recon-engine` gives you an instant, developer-first alternative that runs locally in milliseconds, runs in CI/CD, or embeds via CLI, TypeScript, and HTTP.

```
┌────────────────────────┐        ┌────────────────────────┐
│    Bank Statements     │        │  Invoices & Receivables │
│ CSV / MT940 / CAMT.053 │        │ Stripe / DB / JSON / CSV│
└───────────┬────────────┘        └───────────┬────────────┘
            │                                 │
            ▼                                 ▼
┌──────────────────────────────────────────────────────────┐
│        Universal Statement Parser (Bun / TS)             │
│        Auto-sniffs format -> NormalizedTransaction[]     │
└───────────────────────────┬──────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│          Deterministic & Fuzzy Matching Engine           │
│  Exact: Amount in Cents + Date ±2d + Reference/IBAN      │
│  Fuzzy: Jaro-Winkler Remittance + Wire Fee Tolerance     │
└───────────────────────────┬──────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│   Output: Audit Trail JSON / HTTP API / Terminal Table   │
└──────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start (Zero Setup)

No installation required. Run directly with Bun:

### 1. Match Bank Statements to Invoices
```bash
# Auto-detect format and run interactive matching
bunx @danyayen/recon-engine match --statement bank-statement.csv --invoices invoices.json

# Auto-confirm all high-confidence matches (headless / CI)
bunx @danyayen/recon-engine match --statement bank.xml --invoices invoices.csv --yes --json
```

### 2. Parse Bank Statements Only
```bash
# Auto-detects CAMT.053 XML, SWIFT MT940, Revolut, or Stripe
bunx @danyayen/recon-engine parse statement.xml

# Output clean JSON for piping into jq or downstream services
bunx @danyayen/recon-engine parse statement.csv --json | jq .
```

### 3. Generate Mock Data for Testing
```bash
# Generate 50 realistic synthetic bank transactions with wire noise
bunx @danyayen/recon-engine mock --format camt053 --count 50 --noise 0.2 -o mock.xml
```

### 4. Run Headless HTTP Microservice
```bash
bunx @danyayen/recon-engine serve --port 3000
```

---

## 🤖 For AI Agents & LLMs

`recon-engine` is designed to be executed safely by coding agents (Cursor, Claude Code, Antigravity, OpenDevin):

- Feed [`AGENT.md`](./AGENT.md) or [`llms.txt`](./llms.txt) directly into your agent's context.
- Always pass `--json --non-interactive` (or `--yes`) flags to avoid interactive terminal prompts.
- All monetary amounts strictly use integer minor units (`amountCents: number`) to prevent IEEE 754 float precision errors.
- Every normalized transaction includes a `raw?: Record<string, unknown>` diagnostic payload preserving the original unparsed row/fields for auditing and tracing.

---

## 🌍 Polyglot Integration (Python, Go, PHP)

### Python Subprocess (Atomic CLI)
```python
import subprocess, json

result = subprocess.run(
    ["bunx", "@danyayen/recon-engine", "match", "--statement", "bank.xml", "--invoices", "invoices.json", "--json", "--yes"],
    capture_output=True, text=True, check=True
)
report = json.loads(result.stdout)
print(f"Matched {report['summary']['matchedCount']} invoices!")
```

### HTTP Microservice (`POST /v1/match`)
```bash
curl -X POST http://localhost:3000/v1/match \
  -H "Content-Type: application/json" \
  -d '{"statement": "...", "invoices": [...] }'
```

---

## ⚡ Performance Benchmarks

Executed on Bun v1.3+ (1,000 transactions per batch):

| Component / Format | Throughput | Latency (1k txs) | Precision Guarantee |
| :--- | :--- | :--- | :--- |
| **SWIFT MT940 Parser** | **~37,200 tx/sec** | **26.9 ms** | Zero Float Drift (Cents) |
| **Revolut Business CSV** | **~31,000 tx/sec** | **32.2 ms** | Auto-filters declined charges |
| **CAMT.053 XML Parser** | **~5,000 tx/sec** | **199.4 ms** | ISO 20022 compliant |
| **1:1 Matching Engine** | **~47,500 pairs/sec** | **21.0 ms** | Jaro-Winkler + Fee tolerance |

---

## 🗺️ Upcoming Roadmap

- [ ] **DATEV & Accounting Export**: Automatic conversion of matched pairs into standard German DATEV CSV.
- [ ] **ECB Multi-Currency Tolerance**: On-the-fly EUR/USD conversion via ECB daily reference rates for FX reconciliation.
- [ ] **Append-Only Double-Entry Ledger**: Native immutable ledger plugin for BaaS platforms and escrow compliance.

---

## 🎯 Design Scope & Intentional Boundaries

`recon-engine` is purpose-built as a **fast, lightweight B2B statement reconciliation tool** to replace fragile ad-hoc scripts. It is not an enterprise clearinghouse like Modern Treasury or Visa DPS.

### Core Invariants & Decisions
- **100% Integer Minor Units**: To eliminate IEEE 754 float drift (`0.1 + 0.2 = 0.30000000000000004`), every monetary value is parsed, calculated, and exported strictly in integer minor units (`amountCents`).
- **Collision-Safe Fee Deductions**: Intermediary bank wire fees (e.g. €15 deduction on a €1,000 wire) are tracked explicitly via `feeDeductionCents` in the audit trail. When multiple invoices qualify for the same delta, matches are safely demoted to `REVIEW_NEEDED` instead of naively auto-confirming.
- **Deterministic Over Heuristic**: Tokenization and reference regex extraction always run before fuzzy fallbacks. Jaro-Winkler distance is strictly reserved for typo-tolerance in sanitized remittance strings.

### What `recon-engine` Is NOT (Current Limitations & Non-Goals)
- **Not an Aggregated 1:N Card Settlement Engine**: Currently optimized for 1:1 B2B invoice-to-transfer matching. Multi-transaction payout splits (1 payout closing 400 micro-orders) are on the upcoming roadmap.
- **In-Memory Batch Architecture**: Designed for sub-second parsing of standard daily/monthly bank files (<50,000 transactions / ~50 MB). Massive multi-gigabyte XML ledger exports require external chunking.
- **General Ledger Agnostic**: The engine outputs structured audit-trail JSON with status, match confidence, and fee delta. It does not enforce double-entry chart-of-accounts postings inside the engine itself.

---

## 📄 License

MIT © 2026
