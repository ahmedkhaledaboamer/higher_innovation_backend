import { ApiError } from './ApiError.js';

/**
 * Phone canonicalisation for duplicate detection, contact locks and phone search on leads and
 * students. The stored `phone` keeps what the user typed; `phoneNormalized` is the canonical form.
 *
 * Without a known country (unchanged behaviour):
 *   "+20 (100) 123-4567" → "+201001234567"; "00201…" → "+201…"; "0100…" → "0100…" (digits only).
 *
 * With the country explicitly known to be the United Arab Emirates (D53):
 *   "050 123 4567"      → "+971501234567"  (leading trunk 0 replaced by +971)
 *   "971 50 123 4567"   → "+971501234567"  (country code typed without + or 00)
 *   "+971 0 50 123 4567"→ "+971501234567"  (stray trunk 0 after the country code removed)
 *   "+44 20 7946 0958"  → "+442079460958"  (other international numbers are kept as they are)
 * A local-looking UAE number that cannot be read unambiguously (no leading 0, no 971, wrong
 * length) is rejected with 400 VALIDATION_ERROR instead of being guessed.
 *
 * A local number is never assumed to be Emirati when the country is missing or another country.
 */

export const UAE_DIAL_CODE = '971';

/**
 * Country values (case, spaces and dots ignored) that mean the United Arab Emirates. The frontend
 * sends "United Arab Emirates"; the others cover common manual spellings and the ISO code.
 */
const UAE_COUNTRY_NAMES = new Set(['unitedarabemirates', 'theunitedarabemirates', 'uae', 'ae', 'الإماراتالعربيةالمتحدة', 'الاماراتالعربيةالمتحدة', 'الإمارات', 'الامارات']);

export function isUaeCountry(country: string | null | undefined): boolean {
  if (!country) return false;
  return UAE_COUNTRY_NAMES.has(country.toLowerCase().replace(/[\s.]/g, ''));
}

/** UAE national significant numbers: 8 digits (landlines, e.g. 4 xxx xxxx) or 9 digits (mobiles, 5x xxx xxxx). */
const UAE_NATIONAL_LENGTHS = new Set([8, 9]);

function invalidUaePhone(): ApiError {
  const message = 'Enter a valid UAE number, e.g. 050 123 4567 or +971 50 123 4567';
  return ApiError.badRequest(message, 'VALIDATION_ERROR', [{ path: 'phone', message }]);
}

/**
 * Canonical form of `phone` for the given country. Throws 400 VALIDATION_ERROR (path "phone") for a
 * UAE-context number that cannot be read unambiguously.
 */
export function normalizePhone(phone: string | null | undefined, country?: string | null): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  // Explicitly international input: "+…" or the "00" international prefix.
  let international: string | null = null;
  if (trimmed.startsWith('+')) international = digits;
  else if (digits.startsWith('00')) international = digits.slice(2);

  if (!isUaeCountry(country)) {
    return international !== null ? `+${international}` : digits;
  }

  if (international === null) {
    let national: string;
    if (digits.startsWith('0')) national = digits.slice(1);
    else if (digits.startsWith(UAE_DIAL_CODE)) national = digits.slice(UAE_DIAL_CODE.length);
    else throw invalidUaePhone(); // e.g. "501234567": cannot tell whether a prefix is missing
    if (national.startsWith('0')) national = national.slice(1); // "971 0 50…"
    if (!UAE_NATIONAL_LENGTHS.has(national.length)) throw invalidUaePhone();
    return `+${UAE_DIAL_CODE}${national}`;
  }

  // International number on a UAE record: drop a stray trunk 0 after +971, keep foreign numbers.
  if (international.startsWith(`${UAE_DIAL_CODE}0`)) {
    international = UAE_DIAL_CODE + international.slice(UAE_DIAL_CODE.length + 1);
  }
  return `+${international}`;
}
