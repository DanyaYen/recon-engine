/**
 * Zero-dependency robust CSV parser supporting:
 * - Comma (,), semicolon (;), and tab (\t) auto-detection
 * - Quoted fields with escaped quotes ("")
 * - Embedded newlines inside quoted cells
 * - Flexible row trimming
 */

export interface CsvParseResult {
  headers: string[];
  rows: Record<string, string>[];
}

export function detectDelimiter(headerLine: string): string {
  const commas = (headerLine.match(/,/g) || []).length;
  const semicolons = (headerLine.match(/;/g) || []).length;
  const tabs = (headerLine.match(/\t/g) || []).length;

  if (semicolons > commas && semicolons > tabs) return ';';
  if (tabs > commas && tabs > semicolons) return '\t';
  return ',';
}

export function parseCsv(content: string, customDelimiter?: string): CsvParseResult {
  const lines: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let insideQuotes = false;

  const rawText = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Detect delimiter from the first non-empty line
  const firstLine = rawText.split('\n').find((l) => l.trim().length > 0) || '';
  const delimiter = customDelimiter || detectDelimiter(firstLine);

  for (let i = 0; i < rawText.length; i++) {
    const char = rawText[i];
    const nextChar = rawText[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        // Escaped double quote
        currentCell += '"';
        i++;
      } else {
        // Toggle quote state
        insideQuotes = !insideQuotes;
      }
    } else if (char === delimiter && !insideQuotes) {
      currentRow.push(currentCell.trim());
      currentCell = '';
    } else if (char === '\n' && !insideQuotes) {
      currentRow.push(currentCell.trim());
      currentCell = '';
      if (currentRow.some((c) => c.length > 0)) {
        lines.push(currentRow);
      }
      currentRow = [];
    } else {
      currentCell += char;
    }
  }

  // Final cell
  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some((c) => c.length > 0)) {
      lines.push(currentRow);
    }
  }

  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const rawHeaders = lines[0];
  const headers = rawHeaders.map((h) => h.replace(/^["']|["']$/g, '').trim());

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = line[j] !== undefined ? line[j] : '';
    }
    rows.push(row);
  }

  return { headers, rows };
}
