#!/usr/bin/env bun
import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import * as readline from 'readline/promises';
import pc from 'picocolors';
import Table from 'cli-table3';
import { parseStatement } from '../parsers/index.js';
import { loadInvoices } from '../matcher/invoices.js';
import { reconcile } from '../matcher/engine.js';
import { startHttpServer } from '../server/api.js';
import { generateMockStatement } from '../mock/generator.js';
import { formatCents } from '../utils/money.js';

const program = new Command();

program
  .name('recon')
  .description('Reconciliation-as-Code: Universal bank statement parser and matching engine')
  .version('0.2.0');

// Command 1: parse
program
  .command('parse')
  .description('Parse a bank statement (CSV, CAMT.053 XML, SWIFT MT940) into normalized JSON or a formatted table')
  .argument('<file>', 'Path to statement file')
  .option('-f, --format <preset>', 'Force statement format: camt053, mt940, revolut-csv, stripe-csv, generic-csv')
  .option('--json', 'Output strictly as JSON (ideal for piping or programmatic use)')
  .option('--pretty', 'Pretty-print JSON output when used with --json')
  .option('-m, --map <mapping>', 'Custom column mapping for generic CSV (e.g. "date=TxDate,amount=Sum,ref=Memo")')
  .option('-c, --currency <curr>', 'Default fallback currency if not present in statement', 'EUR')
  .option('-l, --limit <number>', 'Limit rows displayed in terminal table', '25')
  .action(async (filePath, options) => {
    try {
      if (!existsSync(filePath)) {
        console.error(pc.red(`Error: File not found at '${filePath}'`));
        process.exit(1);
      }

      const content = readFileSync(filePath, 'utf-8');

      const columnMapping: Record<string, string> = {};
      if (options.map) {
        const pairs = options.map.split(',');
        for (const pair of pairs) {
          const [k, v] = pair.split('=').map((s: string) => s.trim());
          if (k && v) columnMapping[k] = v;
        }
      }

      const startTime = performance.now();
      const result = await parseStatement(content, {
        format: options.format,
        columnMapping: Object.keys(columnMapping).length > 0 ? columnMapping : undefined,
        defaultCurrency: options.currency,
      });
      const durationMs = Math.round((performance.now() - startTime) * 100) / 100;

      if (options.json) {
        const output = {
          parserId: result.parserId,
          parserName: result.parserName,
          count: result.transactions.length,
          transactions: result.transactions,
        };
        const outputStr = options.pretty
          ? JSON.stringify(output, null, 2)
          : JSON.stringify(output);
        console.log(outputStr);
        return;
      }

      // Pretty Terminal UI
      console.log();
      console.log(pc.bold(pc.cyan('  Reconciliation-as-Code (recon-engine)')));
      console.log(
        pc.dim(`  File: `) +
          pc.bold(filePath) +
          pc.dim(` | Format: `) +
          pc.green(result.parserName) +
          pc.dim(` | Parsed: `) +
          pc.yellow(`${result.transactions.length} transactions`) +
          pc.dim(` in ${durationMs}ms`)
      );
      console.log();

      if (result.transactions.length === 0) {
        console.log(pc.yellow('  No transactions found in statement.'));
        console.log();
        return;
      }

      const table = new Table({
        head: [
          pc.bold('Date'),
          pc.bold('Direction'),
          pc.bold('Amount'),
          pc.bold('Counterparty'),
          pc.bold('Reference / Remittance'),
        ],
        style: { head: [], border: [] },
      });

      const limit = parseInt(options.limit, 10) || 25;
      const displayRows = result.transactions.slice(0, limit);

      let totalIncomingCents = 0;
      let totalOutgoingCents = 0;

      for (const tx of result.transactions) {
        if (tx.direction === 'INCOMING') {
          totalIncomingCents += tx.amountCents;
        } else {
          totalOutgoingCents += tx.amountCents;
        }
      }

      for (const tx of displayRows) {
        const isIncoming = tx.direction === 'INCOMING';
        const dirBadge = isIncoming ? pc.green('+ INFLOW') : pc.red('- OUTFLOW');
        const formattedAmt = isIncoming
          ? pc.green(formatCents(tx.amountCents, tx.currency))
          : pc.red(formatCents(tx.amountCents, tx.currency));

        table.push([
          pc.dim(tx.bookingDate),
          dirBadge,
          formattedAmt,
          tx.counterpartyName ? pc.white(tx.counterpartyName) : pc.dim('—'),
          tx.reference ? pc.dim(tx.reference.slice(0, 50)) : pc.dim('—'),
        ]);
      }

      console.log(table.toString());

      if (result.transactions.length > limit) {
        console.log(
          pc.dim(
            `  ... and ${result.transactions.length - limit} more rows. Use --limit to show more or --json for raw output.`
          )
        );
      }

      console.log();
      console.log(
        pc.bold('  Summary: ') +
          pc.green(`Total Inflow: ${formatCents(totalIncomingCents)}`) +
          pc.dim(' | ') +
          pc.red(`Total Outflow: ${formatCents(totalOutgoingCents)}`)
      );
      console.log();
    } catch (err: any) {
      console.error(pc.red(`\nError parsing statement: ${err.message}\n`));
      process.exit(1);
    }
  });

// Command 2: match
program
  .command('match')
  .description('Match bank statement transactions against invoices with exact and fuzzy matching')
  .requiredOption('-s, --statement <file>', 'Path to bank statement file (CSV, CAMT.053 XML, MT940)')
  .requiredOption('-i, --invoices <file>', 'Path to invoices file (JSON or CSV conforming to NormalizedInvoice)')
  .option('-d, --date-tolerance <days>', 'Date tolerance window in days (default: 2)', '2')
  .option('--fee-tolerance <cents>', 'Max allowed wire fee discrepancy in cents (default: 2500 / 25.00 EUR)', '2500')
  .option('-y, --yes', 'Automatically confirm all suggested REVIEW_NEEDED matches without prompting')
  .option('--force', 'Force auto-confirmation of risky counterparty matches when used with --yes')
  .option('--non-interactive', 'Do not run interactive prompts; leave REVIEW_NEEDED items as is')
  .option('-o, --output <file>', 'Save reconciliation audit report to JSON file')
  .option('--json', 'Output full reconciliation report directly as JSON')
  .option('--pretty', 'Pretty-print JSON output')
  .action(async (options) => {
    try {
      if (!existsSync(options.statement)) {
        console.error(pc.red(`Error: Statement file not found at '${options.statement}'`));
        process.exit(1);
      }
      if (!existsSync(options.invoices)) {
        console.error(pc.red(`Error: Invoices file not found at '${options.invoices}'`));
        process.exit(1);
      }

      // 1. Parse statement
      const statementContent = readFileSync(options.statement, 'utf-8');
      const stmtResult = await parseStatement(statementContent);

      // 2. Load invoices
      const invoices = await loadInvoices(options.invoices);

      const dateToleranceDays = parseInt(options.dateTolerance, 10) || 2;
      const feeToleranceCents = parseInt(options.feeTolerance, 10) || 2500;

      // 3. Reconcile
      const startTime = performance.now();
      const report = reconcile(stmtResult.transactions, invoices, {
        dateToleranceDays,
        feeToleranceCents,
        statementFile: options.statement,
        sourceFormat: stmtResult.parserName,
      });
      const durationMs = Math.round((performance.now() - startTime) * 100) / 100;

      // 4. Interactive review if applicable
      const isInteractive =
        !options.json &&
        !options.yes &&
        !options.nonInteractive &&
        Boolean(process.stdin.isTTY);

      const reviewMatches = report.matches.filter((m) => m.status === 'REVIEW_NEEDED');

      const updateSummaryMetrics = () => {
        report.summary.matchedCount = report.matches.filter((m) => m.status === 'MATCHED').length;
        report.summary.reviewNeededCount = report.matches.filter(
          (m) => m.status === 'REVIEW_NEEDED'
        ).length;
        report.summary.totalMatchedCents = report.matches
          .filter((m) => m.status === 'MATCHED' && m.invoice)
          .reduce((sum, m) => sum + m.invoice!.amountCents, 0);
      };

      if (options.yes) {
        // Auto-approve unambiguous REVIEW_NEEDED suggestions
        // Ambiguous matches (multiple candidates within fee tolerance) remain REVIEW_NEEDED for safety
        // Risky counterparty matches require explicit --force
        for (const m of reviewMatches) {
          if (m.discrepancies.some((d) => d.includes('Ambiguous match'))) {
            continue;
          }
          const isRisky =
            Boolean(m.requiresForce) ||
            m.discrepancies.some(
              (d) =>
                d.includes('Risky counterparty mismatch') ||
                d.includes('requires explicit --force')
            );
          if (isRisky && !options.force) {
            continue;
          }
          m.status = 'MATCHED';
          m.discrepancies.push('[Auto-confirmed via --yes]');
        }
        updateSummaryMetrics();
      } else if (isInteractive && reviewMatches.length > 0) {
        console.log();
        console.log(
          pc.yellow(
            pc.bold(`  ⚠️  ${reviewMatches.length} match(es) require human review.`)
          )
        );
        console.log();

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        let acceptAllRemaining = false;

        for (let i = 0; i < reviewMatches.length; i++) {
          const m = reviewMatches[i];
          const tx = m.transaction;
          const inv = m.invoice!;

          if (acceptAllRemaining) {
            m.status = 'MATCHED';
            m.discrepancies.push('[Confirmed by user]');
            continue;
          }

          console.log(pc.bold(pc.cyan(`  ── Review Item [${i + 1}/${reviewMatches.length}] ──`)));
          console.log(
            pc.dim('  Transaction: ') +
              pc.green(`+${formatCents(tx.amountCents, tx.currency)}`) +
              pc.dim(` on ${tx.bookingDate}`) +
              (tx.counterpartyName ? ` from ${pc.bold(tx.counterpartyName)}` : '')
          );
          if (tx.reference) {
            console.log(pc.dim('  Remittance:  ') + pc.italic(tx.reference));
          }
          console.log(
            pc.dim('  Candidate:   ') +
              pc.yellow(`${inv.invoiceNumber} (${formatCents(inv.amountCents, inv.currency)})`) +
              ` for ${pc.bold(inv.customerName)}`
          );
          console.log(
            pc.dim('  Reason:      ') +
              pc.magenta(m.discrepancies.join('; ')) +
              pc.dim(` (Confidence: ${(m.confidenceScore * 100).toFixed(0)}%)`)
          );

          const answer = await rl.question(
            pc.bold('\n  Accept this match? [y/N/a(all)/q(quit)]: ')
          );
          const normalizedAns = answer.trim().toLowerCase();

          if (normalizedAns === 'y' || normalizedAns === 'yes') {
            m.status = 'MATCHED';
            m.discrepancies.push('[Confirmed by user]');
            console.log(pc.green('  ✓ Accepted\n'));
          } else if (normalizedAns === 'a' || normalizedAns === 'all') {
            acceptAllRemaining = true;
            m.status = 'MATCHED';
            m.discrepancies.push('[Confirmed by user]');
            console.log(pc.green('  ✓ Accepted this and all remaining\n'));
          } else if (normalizedAns === 'q' || normalizedAns === 'quit') {
            console.log(pc.yellow('  Review aborted. Remaining items left as REVIEW_NEEDED.\n'));
            break;
          } else {
            console.log(pc.dim('  - Kept for manual review\n'));
          }
        }

        rl.close();
        updateSummaryMetrics();
      }

      // JSON output mode
      if (options.json) {
        const output = options.pretty
          ? JSON.stringify(report, null, 2)
          : JSON.stringify(report);
        console.log(output);

        if (options.output) {
          writeFileSync(options.output, JSON.stringify(report, null, 2));
        }
        return;
      }

      // Terminal Table UI
      console.log();
      console.log(pc.bold(pc.cyan('  ⚡ Reconciliation Results (recon-engine)')));
      console.log(
        pc.dim(`  Statement: `) +
          pc.bold(options.statement) +
          pc.dim(` (${stmtResult.parserName})`) +
          pc.dim(` | Invoices: `) +
          pc.bold(options.invoices) +
          pc.dim(` in ${durationMs}ms`)
      );
      console.log();

      const table = new Table({
        head: [
          pc.bold('Date'),
          pc.bold('Status'),
          pc.bold('Level'),
          pc.bold('Tx Amount'),
          pc.bold('Invoice Amount'),
          pc.bold('Invoice / Customer'),
          pc.bold('Details / Discrepancy'),
        ],
        style: { head: [], border: [] },
      });

      for (const m of report.matches) {
        const tx = m.transaction;
        const inv = m.invoice;

        let statusBadge = pc.red('UNMATCHED');
        if (m.status === 'MATCHED') statusBadge = pc.green('✓ MATCHED');
        else if (m.status === 'REVIEW_NEEDED') statusBadge = pc.yellow('⚠️ REVIEW');

        const txAmtFormatted =
          tx.direction === 'INCOMING'
            ? pc.green(`+${formatCents(tx.amountCents, tx.currency)}`)
            : pc.red(`-${formatCents(tx.amountCents, tx.currency)}`);

        const invAmtFormatted = inv
          ? formatCents(inv.amountCents, inv.currency)
          : pc.dim('—');

        const customerInfo = inv
          ? `${pc.bold(inv.invoiceNumber)}\n${pc.dim(inv.customerName)}`
          : tx.counterpartyName
          ? pc.dim(tx.counterpartyName)
          : pc.dim('—');

        const details =
          m.discrepancies.length > 0
            ? m.discrepancies.join('\n')
            : tx.reference
            ? pc.dim(tx.reference.slice(0, 45))
            : pc.dim('—');

        table.push([
          tx.bookingDate,
          statusBadge,
          pc.dim(m.level),
          txAmtFormatted,
          invAmtFormatted,
          customerInfo,
          details,
        ]);
      }

      console.log(table.toString());
      console.log();

      // Summary Card
      console.log(pc.bold('  Summary:'));
      console.log(
        pc.green(`  • Reconciled (MATCHED):   ${report.summary.matchedCount}`) +
          pc.dim(` (${formatCents(report.summary.totalMatchedCents, report.summary.currency)})`)
      );
      if (report.summary.reviewNeededCount > 0) {
        console.log(
          pc.yellow(`  • Needs Review (REVIEW):  ${report.summary.reviewNeededCount}`)
        );
      }
      console.log(
        pc.red(`  • Unmatched Transactions: ${report.summary.unmatchedCount}`)
      );
      console.log(
        pc.dim(`  • Unpaid Invoices:        ${report.unmatchedInvoices.length}`)
      );
      console.log();

      if (options.output) {
        writeFileSync(options.output, JSON.stringify(report, null, 2));
        console.log(pc.green(`  ✓ Audit report saved to '${options.output}'\n`));
      }
    } catch (err: any) {
      console.error(pc.red(`\nError during reconciliation: ${err.message}\n`));
      process.exit(1);
    }
  });

// Command 3: serve (HTTP API via Elysia)
program
  .command('serve')
  .description('Start the Reconciliation-as-Code HTTP microservice for Python, Go, Java, PHP integration')
  .option('-p, --port <number>', 'HTTP server port', process.env.PORT || '3000')
  .option('--strict-port', 'Do not attempt next port if chosen port is occupied', false)
  .action(async (options) => {
    try {
      const initialPort = parseInt(options.port, 10) || 3000;
      const { port, wasFallback } = startHttpServer(initialPort, {
        strictPort: Boolean(options.strictPort),
      });

      console.log();
      console.log(pc.bold(pc.cyan('  ⚡ Reconciliation-as-Code HTTP Microservice (Elysia)')));

      if (wasFallback) {
        console.log(
          pc.yellow(
            `  ⚠️  Port ${initialPort} is already in use by another process. Automatically switched to port ${pc.bold(String(port))}.`
          )
        );
      }

      console.log(pc.green(`  🚀 Server listening on http://localhost:${port}`));
      console.log();
      console.log(pc.dim('  Endpoints:'));
      console.log(`    ${pc.green('POST')} ${pc.bold('/v1/parse')}   ${pc.dim('Parse statement from JSON or file upload')}`);
      console.log(`    ${pc.green('POST')} ${pc.bold('/v1/match')}   ${pc.dim('Reconcile bank statement with invoices')}`);
      console.log(`    ${pc.green('GET')}  ${pc.bold('/health')}     ${pc.dim('Microservice healthcheck')}`);
      console.log();
      console.log(pc.dim('  Press Ctrl+C to stop the server'));
      console.log();
    } catch (err: any) {
      console.error(pc.red(`\nError starting server: ${err.message}\n`));
      process.exit(1);
    }
  });

// Command 4: mock (Synthetic statement generator)
program
  .command('mock')
  .description('Generate synthetic test bank statements with realistic noise (fees, typos, date drift)')
  .requiredOption('-f, --format <preset>', 'Format to generate: camt053, mt940, revolut, generic')
  .option('-n, --count <number>', 'Number of transactions to generate', '10')
  .option('--noise <float>', 'Noise probability between 0.0 and 1.0 (typos, fee deductions)', '0.1')
  .option('-c, --currency <curr>', 'Statement currency', 'EUR')
  .option('-o, --output <file>', 'Save output to file instead of stdout')
  .action(async (options) => {
    try {
      const count = parseInt(options.count, 10) || 10;
      const noise = parseFloat(options.noise);
      const outputContent = generateMockStatement({
        format: options.format as any,
        count,
        noise: isNaN(noise) ? 0.1 : noise,
        currency: options.currency,
      });

      if (options.output) {
        writeFileSync(options.output, outputContent);
        console.log(
          pc.green(`  ✓ Generated ${count} synthetic transactions (${options.format}) to '${options.output}'`)
        );
      } else {
        process.stdout.write(outputContent + '\n');
      }
    } catch (err: any) {
      console.error(pc.red(`\nError generating mock statement: ${err.message}\n`));
      process.exit(1);
    }
  });

program.parse(process.argv);
