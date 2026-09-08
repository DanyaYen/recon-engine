/**
 * Utilities for normalizing various bank statement date formats to ISO YYYY-MM-DD.
 */

export class InvalidDateError extends Error {
  public readonly rawDate: unknown;

  constructor(rawDate: unknown, message?: string) {
    super(message ?? `Invalid date: ${JSON.stringify(rawDate)}`);
    this.name = 'InvalidDateError';
    this.rawDate = rawDate;
    Object.setPrototypeOf(this, InvalidDateError.prototype);
  }
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function getDaysInMonth(year: number, month: number): number {
  switch (month) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12:
      return 31;
    case 4: case 6: case 9: case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

export function validateDateComponents(
  year: number,
  month: number,
  day: number,
  rawInput: unknown
): string {
  if (isNaN(year) || isNaN(month) || isNaN(day)) {
    throw new InvalidDateError(rawInput, `Non-numeric date components: ${year}-${month}-${day}`);
  }
  if (year < 1000 || year > 9999) {
    throw new InvalidDateError(rawInput, `Year ${year} is out of valid range (1000-9999)`);
  }
  if (month < 1 || month > 12) {
    throw new InvalidDateError(rawInput, `Month ${month} is out of valid range (1-12)`);
  }
  const maxDays = getDaysInMonth(year, month);
  if (day < 1 || day > maxDays) {
    throw new InvalidDateError(rawInput, `Day ${day} is invalid for month ${month} and year ${year} (max ${maxDays})`);
  }

  // Cross-check with Date constructor UTC components
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    throw new InvalidDateError(rawInput, `Invalid calendar date components: ${year}-${month}-${day}`);
  }

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

export function parseBankDate(rawDate: string | Date | undefined): string {
  if (rawDate === undefined || rawDate === null || rawDate === '') {
    throw new InvalidDateError(rawDate, 'Date is missing (null, undefined, or empty)');
  }

  if (rawDate instanceof Date) {
    if (isNaN(rawDate.getTime())) {
      throw new InvalidDateError(rawDate, 'Invalid Date object');
    }
    const year = rawDate.getUTCFullYear();
    const month = rawDate.getUTCMonth() + 1;
    const day = rawDate.getUTCDate();
    return validateDateComponents(year, month, day, rawDate);
  }

  const str = rawDate.trim();
  if (!str) {
    throw new InvalidDateError(rawDate, 'Date string is empty');
  }

  // 1. SWIFT MT940 date format: YYMMDD (e.g. "240901" -> "2024-09-01")
  if (/^\d{6}$/.test(str)) {
    const yy = parseInt(str.slice(0, 2), 10);
    const mm = parseInt(str.slice(2, 4), 10);
    const dd = parseInt(str.slice(4, 6), 10);
    const year = yy >= 70 ? 1900 + yy : 2000 + yy;
    return validateDateComponents(year, mm, dd, rawDate);
  }

  // 2. ISO format YYYY-MM-DD or full timestamp
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    return validateDateComponents(year, month, day, rawDate);
  }

  // 3. European dot format DD.MM.YYYY
  const dotMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotMatch) {
    const day = parseInt(dotMatch[1], 10);
    const month = parseInt(dotMatch[2], 10);
    const year = parseInt(dotMatch[3], 10);
    return validateDateComponents(year, month, day, rawDate);
  }

  // 4. Slash format: DD/MM/YYYY vs YYYY/MM/DD
  const slashMatch = str.match(/^(\d{1,4})\/(\d{1,2})\/(\d{1,4})/);
  if (slashMatch) {
    const p1 = slashMatch[1];
    const p2 = slashMatch[2];
    const p3 = slashMatch[3];

    if (p1.length === 4) {
      // YYYY/MM/DD
      const year = parseInt(p1, 10);
      const month = parseInt(p2, 10);
      const day = parseInt(p3, 10);
      return validateDateComponents(year, month, day, rawDate);
    }
    // DD/MM/YYYY
    const day = parseInt(p1, 10);
    const month = parseInt(p2, 10);
    const year = parseInt(p3.length === 2 ? `20${p3}` : p3, 10);
    return validateDateComponents(year, month, day, rawDate);
  }

  // Fallback: Date.parse
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    const year = parsed.getUTCFullYear();
    const month = parsed.getUTCMonth() + 1;
    const day = parsed.getUTCDate();
    return validateDateComponents(year, month, day, rawDate);
  }

  // Strictly reject corrupt dates - NEVER substitute today!
  throw new InvalidDateError(rawDate, `Unable to parse bank date: "${rawDate}"`);
}

/**
 * Calculates day difference between two ISO YYYY-MM-DD date strings strictly in UTC.
 * Avoids timezone drift, DST changes, and local time discrepancies.
 */
export function getDayDifference(dateStr1: string, dateStr2: string): number {
  const [y1, m1, d1] = dateStr1.slice(0, 10).split('-').map((v) => parseInt(v, 10));
  const [y2, m2, d2] = dateStr2.slice(0, 10).split('-').map((v) => parseInt(v, 10));
  return Math.round(Math.abs(Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86400000);
}
