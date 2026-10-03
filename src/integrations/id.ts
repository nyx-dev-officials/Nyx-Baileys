import { fx as fxRates, type FxRates } from './apis.js';

/**
 * Indonesian localisation.
 *
 * Indonesia is not one timezone and the numbers are not formatted the English
 * way, so both of those are handled here rather than left to a caller to get
 * wrong:
 *
 *   - **Three zones.** WIB (UTC+7) covers Java, Sumatra, Bali and most of
 *     Kalimantan. WITA (UTC+8) is Sulawesi and Ternate. WIT (UTC+9) is Papua
 *     and West Papua. A timestamp sent to a Makassar-based user in WIB is an
 *     hour off, which matters for anything scheduled.
 *   - **Rupiah formatting.** Indonesian convention is `Rp1.234.567,89` — dot
 *     for thousands, comma for decimal. `Intl` with `id-ID` gets this right;
 *     manual `$1,234,567.89`-style formatting gets it visibly wrong.
 */

/* ── timezones ──────────────────────────────────────────────────────── */

export type IndonesiaZone = 'WIB' | 'WITA' | 'WIT';

export const ZONE_TZ: Record<IndonesiaZone, string> = {
  WIB: 'Asia/Jakarta',
  WITA: 'Asia/Makassar',
  WIT: 'Asia/Jayapura',
};

export const ZONE_OFFSET: Record<IndonesiaZone, string> = {
  WIB: 'UTC+7',
  WITA: 'UTC+8',
  WIT: 'UTC+9',
};

/**
 * Landline area codes outside WIB — three digits after the leading `0`.
 */
const WITA_LANDLINE = [
  '411', '421', '431', // Makassar, Parepare, Kendari
  '441', '451', '461', // Palu, Gorontalo, Mamuju
  '471', '481', // Manado, Ternate
  '721', '731', '741', // Balikpapan, Banjarmasin, Tarakan
  '751', '761', // Nunukan, Balikpapan
];

const WIT_LANDLINE = [
  '961', '962', '963', '964', // Sorong, Manokwari
  '974', '975', '976', // Fakfak, Sorong, Raja Ampat
];

/**
 * Mobile regional codes outside WIB — the two digits *after* the four-digit
 * operator code, i.e. `0811 22 …` is `08` + `22`.
 *
 * Every operator (Telkomsel 0811/0812/0813, XL, Indosat, Telkom 08…) serves
 * every island, so the operator prefix says nothing about location and these
 * are the digits that actually identify the region.
 */
const WITA_MOBILE = [
  '21', '22', '23', '24', '25', '26', '27', // Makassar, Parepare, Palopo
  '31', '32', '33', // Kendari
  '41', '42', // Gorontalo
  '51', // Gorontalo / Wajo
  '61', // Mamuju
  '71', '72', // Manado, Bitung
  '74', '75', '76', // Tarakan, Nunukan
  '81', '82', // Ternate, Tidore
];

const WIT_MOBILE = [
  '96', '97', '98', '99', // Papua and West Papua
];

/**
 * The `0896`–`0899` operator blocks are Papua-only, so the number identifies
 * its region by operator alone. For these the two digits after the prefix are
 * subscriber digits, not a regional code — reading them as one misplaces every
 * Papua number into WIB.
 */
const PAPUA_ONLY_OPERATOR = new Set(['0896', '0897', '0898', '0899']);

/** The `09xx` Telkom operator is likewise a Papua-only range. */
const PAPUA_09 = new Set(['0901', '0902', '0903', '0904', '0905', '0906', '0907', '0908', '0909']);

/**
 * Zone for an Indonesian phone number, by dialling prefix.
 *
 * Two numbering shapes, and conflating them is the easy mistake:
 *
 *   - **Landline** `021 1234` — a 3-digit area code leads, `021` = Jakarta.
 *   - **Mobile** `0812 3456 7890` — a 4-digit operator code leads (`0811`
 *     Telkomsel, `0812` XL, …) and the *regional* code is the 2 digits after
 *     it. So `0811 22 …` is Makassar (WITA), not a Jakarta number.
 *
 * Reading the first four digits of a mobile number yields the operator, which
 * says nothing about location — every operator serves every island.
 *
 * Accepts `08xx…`, `+628xx…`, `628xx…`, and spaced or dashed forms.
 */
export function zoneForNumber(number: string): IndonesiaZone {
  const digits = number.replace(/\D/g, '');

  // Normalise to the local `0…` national form.
  let local = digits;
  if (local.startsWith('62')) local = `0${local.slice(2)}`;
  local = local.replace(/^0+/, '0');

  // The `09xx` Telkom operator and the `0896`–`0899` blocks are Papua-only, so
  // they resolve by operator without reading the digits that follow.
  if (PAPUA_09.has(local.slice(0, 4))) return 'WIT';
  if (local.startsWith('08') && PAPUA_ONLY_OPERATOR.has(local.slice(0, 4))) return 'WIT';

  if (local.startsWith('08')) {
    // Mobile: operator code leads, regional code is the two digits after it.
    const region = local.slice(4, 6);
    if (WIT_MOBILE.includes(region)) return 'WIT';
    if (WITA_MOBILE.includes(region)) return 'WITA';
    return 'WIB';
  }

  // Landline: three-digit area code after the leading `0`.
  const area = local.slice(1, 4);
  if (WIT_LANDLINE.includes(area)) return 'WIT';
  if (WITA_LANDLINE.includes(area)) return 'WITA';
  return 'WIB';
}

export function tzForNumber(number: string): string {
  return ZONE_TZ[zoneForNumber(number)];
}

/* ── formatting ─────────────────────────────────────────────────────── */

/**
 * Rupiah, in Indonesian convention: `Rp1.234.567`.
 *
 * Zero decimals by default — IDR is not quoted in cents in everyday use, and
 * showing `Rp0` where a user expects `Rp0` matters less than not showing a
 * spurious fraction.
 */
export function rupiah(amount: number, options: { decimals?: boolean; symbol?: string } = {}): string {
  const value = Number.isFinite(amount) ? amount : 0;
  const withDecimals = options.decimals === true;
  const symbol = options.symbol ?? 'Rp';

  // `id-ID` gives dot grouping and comma decimal, which is what we want.
  const formatted = new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: withDecimals ? 2 : 0,
    maximumFractionDigits: withDecimals ? 2 : 0,
  }).format(value);

  // Intl emits a non-breaking space in some locales; normalise to the ASCII one
  // so string comparisons and tests do not trip over it.
  return `${symbol}${formatted.replace(/ /g, ' ').trim()}`.trim();
}

/** Parse `Rp1.234.567,89` or `1234567.89` back to a number. */
export function parseRupiah(input: string): number {
  const cleaned = input
    .replace(/[^\d,.-]/g, '')
    .replace(/\./g, '') // dot grouping
    .replace(',', '.') // comma decimal
    .replace(/-/g, '');
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : Number.NaN;
}

/**
 * Long date + time in Indonesian, e.g. `Sabtu, 3 Oktober 2026 pukul 14.59`.
 *
 * `Intl` with `timeStyle: 'long'` already appends the zone abbreviation
 * (`WIB`), so appending our own would print it twice — the trailing token is
 * stripped before the explicit label is added.
 */
export function formatDateTime(
  date: Date,
  zone: IndonesiaZone = 'WIB',
  style: 'long' | 'short' = 'long',
): string {
  const iso = style === 'long'
    ? { dateStyle: 'full', timeStyle: 'long' } as const
    : { dateStyle: 'medium', timeStyle: 'short' } as const;

  const raw = new Intl.DateTimeFormat('id-ID', { timeZone: ZONE_TZ[zone], ...iso }).format(date);

  // Strip a trailing ` WIB` / `WITA` / `WIT` (or `GMT+7` fallback) if present.
  const cleaned = raw.replace(/\s+(WIB|WITA|WIT|GMT[+\-]\d{1,2}(:\d{2})?)\s*$/, '').trim();

  return `${cleaned} ${zone}`;
}

/** `2 jam lalu`, `3 hari lagi` — Indonesian has distinct past and future forms. */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const deltaMs = date.getTime() - now.getTime();
  const rtf = new Intl.RelativeTimeFormat('id-ID', { numeric: 'auto' });

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000_000],
    ['month', 2_592_000_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
    ['second', 1_000],
  ];

  for (const [unit, ms] of units) {
    if (Math.abs(deltaMs) >= ms) return rtf.format(Math.round(deltaMs / ms), unit);
  }
  return rtf.format(0, 'second');
}

/**
 * Spell out an Indonesian phone number: `+62 812-3456-7890`.
 *
 * Handles all three input forms — `0812…` national, `+62812…` and `62812…`
 * international — because WhatsApp jids arrive as the last two and Indonesian
 * users type the first.
 */
export function formatMsisdn(number: string): string {
  const digits = number.replace(/\D/g, '');
  if (!digits) return number;

  // Strip the country code, whether or not a `+` was present.
  let local = digits;
  if (local.startsWith('62')) local = local.slice(2);
  else if (local.startsWith('0')) local = local.slice(1);

  if (!local) return `+62 `;

  const head = local.slice(0, 3);
  const tail = local.slice(3);
  const grouped = tail.match(/.{1,4}/g)?.join('-') ?? tail;

  return `+62 ${head}-${grouped}`;
}

/* ── currency ───────────────────────────────────────────────────────── */

/**
 * Exchange rate into rupiah.
 *
 * Frankfurter serves ECB reference rates and does carry IDR — verified live,
 * currently ~17,950 per USD. ECB rates are a reference fixing, not a
 * street rate, so a few percent either side of what a money changer quotes.
 */
export async function toRupiah(amount: number, from = 'USD'): Promise<number> {
  const rates: FxRates = await fxRates(from, ['IDR']);
  const rate = rates.rates?.IDR;
  if (typeof rate !== 'number') throw new Error(`no IDR rate available from ${from}`);
  return amount * rate;
}

export async function rupiahRate(from = 'USD'): Promise<number> {
  const rates: FxRates = await fxRates(from, ['IDR']);
  const rate = rates.rates?.IDR;
  if (typeof rate !== 'number') throw new Error(`no IDR rate available from ${from}`);
  return rate;
}
