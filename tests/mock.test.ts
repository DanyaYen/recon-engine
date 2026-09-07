import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { generateMockStatement, generateSyntheticTransactions } from '../src/mock/generator.js';
import { parseStatement } from '../src/parsers/index.js';

const CLI_PATH = join(import.meta.dir, '../src/cli/index.js');

describe('Synthetic Mock Generator', () => {
  it('generates transactions with configurable noise rate', () => {
    const cleanTxs = generateSyntheticTransactions({ format: 'revolut', count: 20, noise: 0.0 });
    expect(cleanTxs.every((t) => !t.hasNoise)).toBe(true);

    const noisyTxs = generateSyntheticTransactions({ format: 'revolut', count: 30, noise: 1.0 });
    expect(noisyTxs.every((t) => t.hasNoise)).toBe(true);
  });

  it('generates valid Revolut Business CSV parseable by engine', async () => {
    const content = generateMockStatement({ format: 'revolut', count: 12, noise: 0.2 });
    expect(content).toContain('Completed Date');
    expect(content).toContain('Type');

    const result = await parseStatement(content);
    expect(result.parserId).toBe('revolut-csv');
    expect(result.transactions.length).toBe(12);
  });

  it('generates valid ISO 20022 CAMT.053 XML parseable by engine', async () => {
    const content = generateMockStatement({ format: 'camt053', count: 8, noise: 0.1 });
    expect(content).toContain('<Document');
    expect(content).toContain('camt.053');

    const result = await parseStatement(content);
    expect(result.parserId).toBe('camt053');
    expect(result.transactions.length).toBe(8);
  });

  it('generates valid SWIFT MT940 parseable by engine', async () => {
    const content = generateMockStatement({ format: 'mt940', count: 15, noise: 0.1 });
    expect(content).toContain(':20:');
    expect(content).toContain(':61:');

    const result = await parseStatement(content);
    expect(result.parserId).toBe('mt940');
    expect(result.transactions.length).toBe(15);
  });

  it('generates valid Generic European CSV parseable by engine', async () => {
    const content = generateMockStatement({ format: 'generic', count: 10, noise: 0.2 });
    expect(content).toContain('Buchungstag');

    const result = await parseStatement(content);
    expect(result.transactions.length).toBe(10);
  });

  it('generates mock statements via CLI recon mock', () => {
    const res = spawnSync('bun', [CLI_PATH, 'mock', '--format', 'revolut', '--count', '5'], {
      encoding: 'utf-8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Completed Date');
  });
});
