/**
 * Utilities for normalizing various bank statement date formats to ISO YYYY-MM-DD.
 */

export function parseBankDate(rawDate: string | Date | undefined): string {
  if (!rawDate) {
    return new Date().toISOString().split('T')[0];
  }

  if (rawDate instanceof Date) {
    return rawDate.toISOString().split('T')[0];
  }

  const str = rawDate.trim();

  // 1. SWIFT MT940 date format: YYMMDD (e.g. "240901" -> "2024-09-01")
  if (/^\d{6}$/.test(str)) {
    const yy = parseInt(str.slice(0, 2), 10);
    const mm = str.slice(2, 4);
    const dd = str.slice(4, 6);
    const year = yy >= 70 ? 1900 + yy : 2000 + yy;
    return `${year}-${mm}-${dd}`;
  }

  // 2. ISO format YYYY-MM-DD or full timestamp
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  // 3. European dot format DD.MM.YYYY
  const dotMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotMatch) {
    const dd = dotMatch[1].padStart(2, '0');
    const mm = dotMatch[2].padStart(2, '0');
    const yyyy = dotMatch[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  // 4. Slash format: DD/MM/YYYY vs YYYY/MM/DD
  const slashMatch = str.match(/^(\d{1,4})\/(\d{1,2})\/(\d{1,4})/);
  if (slashMatch) {
    const p1 = slashMatch[1];
    const p2 = slashMatch[2].padStart(2, '0');
    const p3 = slashMatch[3].padStart(2, '0');

    if (p1.length === 4) {
      // YYYY/MM/DD
      return `${p1}-${p2}-${p3}`;
    }
    // DD/MM/YYYY (assuming European/UK default)
    const yyyy = p3.length === 2 ? `20${p3}` : p3;
    return `${yyyy}-${p2}-${p1.padStart(2, '0')}`;
  }

  // Fallback: Date.parse
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }

  return new Date().toISOString().split('T')[0];
}
