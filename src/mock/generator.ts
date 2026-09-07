/**
 * Synthetic bank statement generator for testing and benchmarks.
 * Generates realistic statements across CAMT.053 XML, SWIFT MT940, Revolut CSV, and Generic CSV
 * with configurable noise levels (typos, wire fees, date drift).
 */

export interface MockOptions {
  format: 'camt053' | 'mt940' | 'revolut' | 'generic';
  count?: number;
  noise?: number; // 0.0 (clean) to 1.0 (maximum noise)
  currency?: string;
  baseDate?: string; // YYYY-MM-DD
}

interface SyntheticTx {
  index: number;
  date: string;
  amount: number; // in standard currency units (e.g. 1500.00)
  amountCents: number;
  currency: string;
  direction: 'INCOMING' | 'OUTGOING';
  invoiceNumber: string;
  companyName: string;
  iban: string;
  reference: string;
  hasNoise: boolean;
  noiseType?: string;
}

const COMPANIES = [
  { name: 'Acme Corp GmbH', iban: 'DE89370400440532013000' },
  { name: 'Siemens Digital AG', iban: 'DE44500105175407324911' },
  { name: 'Delta Logistics BV', iban: 'NL91INGB0001234567' },
  { name: 'Airbus Operations SAS', iban: 'FR7630006000011234567890189' },
  { name: 'Nexus Dynamics LLC', iban: 'US123456789012345' },
  { name: 'Spotify AB', iban: 'SE4550000000058398257466' },
  { name: 'Zalando Payments GmbH', iban: 'DE99100100101234567890' },
  { name: 'BioNTech SE', iban: 'DE21500500000987654321' },
  { name: 'SAP Enterprise SE', iban: 'DE60672500200001234567' },
  { name: 'Datadog Europe SAS', iban: 'FR1420041010050500013M02606' },
];

/**
 * Generates an array of synthetic transactions with realistic attributes.
 */
export function generateSyntheticTransactions(options: MockOptions): SyntheticTx[] {
  const count = options.count ?? 10;
  const noiseRate = Math.max(0, Math.min(1, options.noise ?? 0.1));
  const currency = options.currency || 'EUR';
  const baseDate = new Date(options.baseDate || '2024-09-01');

  const txs: SyntheticTx[] = [];

  for (let i = 0; i < count; i++) {
    const company = COMPANIES[i % COMPANIES.length];
    const invoiceNum = `INV-2024-${String(1000 + i).padStart(4, '0')}`;
    const isIncoming = i % 5 !== 4; // 80% incoming, 20% outgoing expenses

    // Base amount between 250 and 8500
    let baseAmount = (250 + (i * 370) % 8000);
    baseAmount = Math.round(baseAmount * 100) / 100;

    // Date offset: increment day every few transactions
    const dateObj = new Date(baseDate.getTime() + Math.floor(i / 2) * 86400000);
    let dateStr = dateObj.toISOString().split('T')[0];

    const applyNoise = Math.random() < noiseRate;
    let reference = `${invoiceNum} ${company.name}`;
    let noiseType: string | undefined;

    if (applyNoise) {
      const noiseKind = Math.floor(Math.random() * 3);
      if (noiseKind === 0) {
        // Wire fee underpayment: €10 to €25 deducted
        const wireFee = 10 + Math.floor(Math.random() * 15);
        baseAmount = Math.max(10, baseAmount - wireFee);
        noiseType = `wire_fee_${wireFee}`;
      } else if (noiseKind === 1) {
        // Typo in reference: space instead of dash, or lowercase
        reference = reference.replace('-', ' ');
        noiseType = 'ref_typo';
      } else {
        // Date drift: +2 days
        dateObj.setDate(dateObj.getDate() + 2);
        dateStr = dateObj.toISOString().split('T')[0];
        noiseType = 'date_drift';
      }
    }

    const amountCents = Math.round(baseAmount * 100);

    txs.push({
      index: i + 1,
      date: dateStr,
      amount: baseAmount,
      amountCents,
      currency,
      direction: isIncoming ? 'INCOMING' : 'OUTGOING',
      invoiceNumber: invoiceNum,
      companyName: company.name,
      iban: company.iban,
      reference,
      hasNoise: applyNoise,
      noiseType,
    });
  }

  return txs;
}

/**
 * Serializes synthetic transactions into Revolut Business CSV format.
 */
function serializeRevolutCsv(txs: SyntheticTx[]): string {
  const headers = ['Type', 'Product', 'Started Date', 'Completed Date', 'Description', 'Amount', 'Fee', 'Currency', 'State', 'Balance'];
  let balance = 10000;
  const lines = [headers.join(',')];

  for (const tx of txs) {
    const type = tx.direction === 'INCOMING' ? 'TOPUP' : 'TRANSFER';
    const signedAmt = tx.direction === 'INCOMING' ? tx.amount.toFixed(2) : `-${tx.amount.toFixed(2)}`;
    balance += tx.direction === 'INCOMING' ? tx.amount : -tx.amount;
    const desc = tx.direction === 'INCOMING' ? `From ${tx.companyName} ${tx.reference}` : `To ${tx.companyName} ${tx.reference}`;

    lines.push(
      [
        type,
        'Current',
        `${tx.date} 10:00:00`,
        `${tx.date} 10:05:00`,
        `"${desc.replace(/"/g, '""')}"`,
        signedAmt,
        '0.00',
        tx.currency,
        'COMPLETED',
        balance.toFixed(2),
      ].join(',')
    );
  }

  return lines.join('\n');
}

/**
 * Serializes synthetic transactions into ISO 20022 CAMT.053 XML format.
 */
function serializeCamt053Xml(txs: SyntheticTx[]): string {
  const entriesXml = txs
    .map((tx, idx) => {
      const cdtDbt = tx.direction === 'INCOMING' ? 'CRDT' : 'DBIT';
      const partyTag = tx.direction === 'INCOMING' ? 'Dbtr' : 'Cdtr';
      const acctTag = tx.direction === 'INCOMING' ? 'DbtrAcct' : 'CdtrAcct';

      return `      <Ntry>
        <Amt Ccy="${tx.currency}">${tx.amount.toFixed(2)}</Amt>
        <CdtDbtInd>${cdtDbt}</CdtDbtInd>
        <BookgDt><Dt>${tx.date}</Dt></BookgDt>
        <ValDt><Dt>${tx.date}</Dt></ValDt>
        <NtryDtls>
          <TxDtls>
            <Refs>
              <EndToEndId>SYNTH-E2E-${idx + 1}</EndToEndId>
            </Refs>
            <RltdPties>
              <${partyTag}><Nm>${tx.companyName}</Nm></${partyTag}>
              <${acctTag}><Id><IBAN>${tx.iban}</IBAN></Id></${acctTag}>
            </RltdPties>
            <RmtInf>
              <Ustrd>${tx.reference}</Ustrd>
            </RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <GrpHdr>
      <MsgId>SYNTH-MSG-${Date.now()}</MsgId>
      <CreDtTm>${new Date().toISOString()}</CreDtTm>
    </GrpHdr>
    <Stmt>
      <Id>SYNTH-STMT-001</Id>
      <Acct>
        <Id><IBAN>DE89370400440532013000</IBAN></Id>
      </Acct>
${entriesXml}
    </Stmt>
  </BkToCstmrStmt>
</Document>`;
}

/**
 * Serializes synthetic transactions into SWIFT MT940 format.
 */
function serializeMt940(txs: SyntheticTx[]): string {
  const currency = txs[0]?.currency || 'EUR';
  const lines = [
    ':20:SYNTH940',
    ':25:DE89370400440532013000',
    ':28C:00001/001',
    `:60F:C240901${currency}50000,00`,
  ];

  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];
    // YYMMDD date format
    const yy = tx.date.slice(2, 4);
    const mm = tx.date.slice(5, 7);
    const dd = tx.date.slice(8, 10);
    const swiftDate = `${yy}${mm}${dd}`;

    const dc = tx.direction === 'INCOMING' ? 'CR' : 'DR';
    const amountStr = tx.amount.toFixed(2).replace('.', ',');

    lines.push(`:61:${swiftDate}0901${dc}${amountStr}NTRFNONREF//SYNTH-REF-${i + 1}`);
    lines.push(`:86:?00160?20${tx.reference}?32${tx.companyName}`);
  }

  lines.push(`:62F:C240930${currency}75000,00`);
  lines.push('-');

  return lines.join('\n');
}

/**
 * Serializes synthetic transactions into European semicolon Generic CSV.
 */
function serializeGenericCsv(txs: SyntheticTx[]): string {
  const headers = ['Buchungstag;Wertstellung;Auftraggeber / Begünstigter;Verwendungszweck;Betrag;Währung'];
  const lines = [headers[0]];

  for (const tx of txs) {
    // Format date as DD.MM.YYYY
    const [y, m, d] = tx.date.split('-');
    const dotDate = `${d}.${m}.${y}`;

    const signedAmt = tx.direction === 'INCOMING' ? tx.amount : -tx.amount;
    const amountStr = signedAmt.toFixed(2).replace('.', ',');

    lines.push(`${dotDate};${dotDate};${tx.companyName};${tx.reference};${amountStr};${tx.currency}`);
  }

  return lines.join('\n');
}

/**
 * Main generator API: produces formatted statement string for the requested bank format.
 */
export function generateMockStatement(options: MockOptions): string {
  const txs = generateSyntheticTransactions(options);

  switch (options.format.toLowerCase()) {
    case 'revolut':
    case 'revolut-csv':
      return serializeRevolutCsv(txs);
    case 'camt053':
    case 'xml':
      return serializeCamt053Xml(txs);
    case 'mt940':
    case 'swift':
      return serializeMt940(txs);
    case 'generic':
    case 'generic-csv':
    case 'csv':
      return serializeGenericCsv(txs);
    default:
      throw new Error(`Unsupported mock format '${options.format}'. Supported: camt053, mt940, revolut, generic`);
  }
}
