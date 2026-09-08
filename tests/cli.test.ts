import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';

const CLI_PATH = join(import.meta.dir, '../src/cli/index.ts');
const FIXTURES_DIR = join(import.meta.dir, 'fixtures');

describe('CLI Commands', () => {
  it('prints version with --version', () => {
    const res = spawnSync('bun', [CLI_PATH, '--version'], { encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/0\.[12]\.0/);
  });

  it('parses statement to JSON with --json', () => {
    const file = join(FIXTURES_DIR, 'revolut/revolut-business-modern.csv');
    const res = spawnSync('bun', [CLI_PATH, 'parse', file, '--json'], { encoding: 'utf-8' });
    expect(res.status).toBe(0);

    const data = JSON.parse(res.stdout);
    expect(data.parserId).toBe('revolut-csv');
    expect(data.count).toBe(5);
    expect(data.transactions.length).toBe(5);
    expect(data.transactions[0].amountCents).toBe(150000);
  });

  it('prints formatted terminal table by default', () => {
    const file = join(FIXTURES_DIR, 'camt053/camt053-standard-v2.xml');
    const res = spawnSync('bun', [CLI_PATH, 'parse', file], { encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('CAMT.053');
    expect(res.stdout).toContain('Siemens Digital GmbH');
    expect(res.stdout).toContain('Total Inflow');
  });

  it('supports custom --map parameter', () => {
    const file = join(FIXTURES_DIR, 'generic/generic-custom-headers.csv');
    const res = spawnSync(
      'bun',
      [
        CLI_PATH,
        'parse',
        file,
        '--map',
        'date=col_when,amount=col_val,ref=col_note,counterparty=col_who',
        '--json',
      ],
      { encoding: 'utf-8' }
    );
    expect(res.status).toBe(0);
    const data = JSON.parse(res.stdout);
    expect(data.transactions[0].counterpartyName).toBe('FinTech Client A');
  });

  it('displays matching engine help with recon match --help', () => {
    const res = spawnSync('bun', [CLI_PATH, 'match', '--help'], { encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('--statement <file>');
    expect(res.stdout).toContain('--invoices <file>');
  });
});
