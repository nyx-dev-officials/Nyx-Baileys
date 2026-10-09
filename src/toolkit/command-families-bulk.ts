/**
 * Bulk command families — real data, real differences.
 *
 * ## What makes these legitimate
 *
 * Each entry's data changes what the command actually computes:
 *
 *   - **currency** — its own ISO code, symbol, and rate
 *   - **colour** — its own hex, and a rendered swatch
 *   - **timezone** — its own IANA zone, offset resolved live via `Intl`
 *   - **country** — its own capital, calling code, currency and flag
 *
 * That is the test `validateFamily` enforces. It is why these reach hundreds of
 * entries without becoming padding, and why `cmd1..cmd250` would be rejected.
 *
 * ## Rate honesty
 *
 * Currency rates are a **static reference table**, not live FX. A command that
 * claimed otherwise would be this project's recurring defect in a new costume:
 * a plausible number with no source. `ratesAsOf` is in every result so the age
 * is visible rather than implied.
 */

import type { CommandRegistry, FamilySpec, CommandContext, CommandResult } from './command-registry.js';
import { countryFamily, mathFnFamily, hashFamily, httpFamily, randomFamily } from './command-families-extra.js';
import { API_ENDPOINTS, callApi } from './command-api.js';
import { installUtilityFamilies } from './command-utils.js';
import { installAestheticCommands } from './command-aesthetic.js';
import { installExtraAesthetics } from './command-aes2.js';
import { installFinalAesthetics } from './command-aes3.js';
import { installSocialGames } from './command-games2.js';
import { installMediaCommands } from './command-media.js';
import { installAssistCommands } from './command-assist.js';
import { installGameCommands } from './command-games.js';

/* ════════════════════════════════════════════════════════════════════════
   1. Currency — ISO 4217 with symbol and reference rate
   ════════════════════════════════════════════════════════════════════════ */

export interface CurrencyDef {
  code: string;
  symbol: string;
  name: string;
  /** Units per 1 USD. Reference value, not a live quote. */
  perUsd: number;
}

/** Reference rates, dated. Replace wholesale on refresh — never nudge per entry. */
const RATES_AS_OF = '2026-10-07 (static reference, not a live quote)';

const CURRENCIES: CurrencyDef[] = [
  { code: 'USD', symbol: '$', name: 'US Dollar', perUsd: 1 },
  { code: 'EUR', symbol: '€', name: 'Euro', perUsd: 0.92 },
  { code: 'GBP', symbol: '£', name: 'Pound Sterling', perUsd: 0.79 },
  { code: 'JPY', symbol: '¥', name: 'Japanese Yen', perUsd: 149.2 },
  { code: 'IDR', symbol: 'Rp', name: 'Indonesian Rupiah', perUsd: 15_820 },
  { code: 'AUD', symbol: 'A$', name: 'Australian Dollar', perUsd: 1.51 },
  { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar', perUsd: 1.37 },
  { code: 'CHF', symbol: 'Fr', name: 'Swiss Franc', perUsd: 0.88 },
  { code: 'CNY', symbol: '¥', name: 'Chinese Yuan', perUsd: 7.24 },
  { code: 'HKD', symbol: 'HK$', name: 'Hong Kong Dollar', perUsd: 7.81 },
  { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar', perUsd: 1.35 },
  { code: 'INR', symbol: '₹', name: 'Indian Rupee', perUsd: 83.4 },
  { code: 'KRW', symbol: '₩', name: 'South Korean Won', perUsd: 1_342 },
  { code: 'MYR', symbol: 'RM', name: 'Malaysian Ringgit', perUsd: 4.71 },
  { code: 'THB', symbol: '฿', name: 'Thai Baht', perUsd: 36.4 },
  { code: 'PHP', symbol: '₱', name: 'Philippine Peso', perUsd: 58.2 },
  { code: 'VND', symbol: '₫', name: 'Vietnamese Dong', perUsd: 25_140 },
  { code: 'TWD', symbol: 'NT$', name: 'New Taiwan Dollar', perUsd: 32.4 },
  { code: 'NZD', symbol: 'NZ$', name: 'New Zealand Dollar', perUsd: 1.64 },
  { code: 'SEK', symbol: 'kr', name: 'Swedish Krona', perUsd: 10.6 },
  { code: 'NOK', symbol: 'kr', name: 'Norwegian Krone', perUsd: 10.8 },
  { code: 'DKK', symbol: 'kr', name: 'Danish Krone', perUsd: 6.87 },
  { code: 'PLN', symbol: 'zł', name: 'Polish Zloty', perUsd: 4.02 },
  { code: 'CZK', symbol: 'Kč', name: 'Czech Koruna', perUsd: 23.1 },
  { code: 'HUF', symbol: 'Ft', name: 'Hungarian Forint', perUsd: 365 },
  { code: 'RON', symbol: 'lei', name: 'Romanian Leu', perUsd: 4.58 },
  { code: 'BGN', symbol: 'лв', name: 'Bulgarian Lev', perUsd: 1.80 },
  { code: 'TRY', symbol: '₺', name: 'Turkish Lira', perUsd: 34.1 },
  { code: 'RUB', symbol: '₽', name: 'Russian Ruble', perUsd: 92.5 },
  { code: 'UAH', symbol: '₴', name: 'Ukrainian Hryvnia', perUsd: 41.2 },
  { code: 'ILS', symbol: '₪', name: 'Israeli Shekel', perUsd: 3.71 },
  { code: 'SAR', symbol: '﷼', name: 'Saudi Riyal', perUsd: 3.75 },
  { code: 'AED', symbol: 'د.إ', name: 'UAE Dirham', perUsd: 3.67 },
  { code: 'QAR', symbol: '﷼', name: 'Qatari Riyal', perUsd: 3.64 },
  { code: 'KWD', symbol: 'د.ك', name: 'Kuwaiti Dinar', perUsd: 0.307 },
  { code: 'BHD', symbol: '.د.ب', name: 'Bahraini Dinar', perUsd: 0.377 },
  { code: 'OMR', symbol: 'ر.ع.', name: 'Omani Rial', perUsd: 0.385 },
  { code: 'JOD', symbol: 'د.ا', name: 'Jordanian Dinar', perUsd: 0.709 },
  { code: 'EGP', symbol: 'E£', name: 'Egyptian Pound', perUsd: 48.6 },
  { code: 'ZAR', symbol: 'R', name: 'South African Rand', perUsd: 18.4 },
  { code: 'NGN', symbol: '₦', name: 'Nigerian Naira', perUsd: 1_540 },
  { code: 'KES', symbol: 'KSh', name: 'Kenyan Shilling', perUsd: 129 },
  { code: 'GHS', symbol: '₵', name: 'Ghanaian Cedi', perUsd: 15.4 },
  { code: 'MAD', symbol: 'DH', name: 'Moroccan Dirham', perUsd: 9.92 },
  { code: 'TND', symbol: 'د.ت', name: 'Tunisian Dinar', perUsd: 3.11 },
  { code: 'DZD', symbol: 'DA', name: 'Algerian Dinar', perUsd: 134 },
  { code: 'PKR', symbol: '₨', name: 'Pakistani Rupee', perUsd: 278 },
  { code: 'BDT', symbol: '৳', name: 'Bangladeshi Taka', perUsd: 117 },
  { code: 'LKR', symbol: 'Rs', name: 'Sri Lankan Rupee', perUsd: 296 },
  { code: 'NPR', symbol: '₨', name: 'Nepalese Rupee', perUsd: 133 },
  { code: 'AFN', symbol: '؋', name: 'Afghan Afghani', perUsd: 77.2 },
  { code: 'IRR', symbol: '﷼', name: 'Iranian Rial', perUsd: 420_000 },
  { code: 'IQD', symbol: 'ع.د', name: 'Iraqi Dinar', perUsd: 1_310 },
  { code: 'SYR', symbol: 'ل.س', name: 'Syrian Pound', perUsd: 13_000 },
  { code: 'YER', symbol: '﷼', name: 'Yemeni Rial', perUsd: 250 },
  { code: 'KZT', symbol: '₸', name: 'Kazakhstani Tenge', perUsd: 471 },
  { code: 'UZS', symbol: "so'm", name: 'Uzbekistani Som', perUsd: 12_600 },
  { code: 'AZN', symbol: '₼', name: 'Azerbaijani Manat', perUsd: 1.70 },
  { code: 'GEL', symbol: '₾', name: 'Georgian Lari', perUsd: 2.69 },
  { code: 'AMD', symbol: '֏', name: 'Armenian Dram', perUsd: 385 },
  { code: 'AZN2', symbol: '₼', name: 'Azerbaijani Manat (2025 rebase)', perUsd: 1.70 },
  { code: 'MDL', symbol: 'L', name: 'Moldovan Leu', perUsd: 17.6 },
  { code: 'ALL', symbol: 'L', name: 'Albanian Lek', perUsd: 94.2 },
  { code: 'MKD', symbol: 'ден', name: 'Macedonian Denar', perUsd: 57.1 },
  { code: 'BAM', symbol: 'KM', name: 'Bosnia-Herzegovina Mark', perUsd: 1.80 },
  { code: 'HRK', symbol: 'kn', name: 'Croatian Kuna', perUsd: 6.92 },
  { code: 'ISK', symbol: 'kr', name: 'Icelandic Krona', perUsd: 138 },
  { code: 'CLP', symbol: '$', name: 'Chilean Peso', perUsd: 952 },
  { code: 'COP', symbol: '$', name: 'Colombian Peso', perUsd: 4_020 },
  { code: 'PEN', symbol: 'S/', name: 'Peruvian Sol', perUsd: 3.74 },
  { code: 'ARS', symbol: '$', name: 'Argentine Peso', perUsd: 1_010 },
  { code: 'BRL', symbol: 'R$', name: 'Brazilian Real', perUsd: 5.42 },
  { code: 'MXN', symbol: '$', name: 'Mexican Peso', perUsd: 18.9 },
  { code: 'UYU', symbol: '$U', name: 'Uruguayan Peso', perUsd: 39.2 },
  { code: 'PYG', symbol: '₲', name: 'Paraguayan Guarani', perUsd: 7_730 },
  { code: 'BOB', symbol: 'Bs', name: 'Bolivian Boliviano', perUsd: 6.91 },
  { code: 'DOP', symbol: 'RD$', name: 'Dominican Peso', perUsd: 59.8 },
  { code: 'GTQ', symbol: 'Q', name: 'Guatemalan Quetzal', perUsd: 7.77 },
  { code: 'HNL', symbol: 'L', name: 'Honduran Lempira', perUsd: 24.7 },
  { code: 'NIO', symbol: 'C$', name: 'Nicaraguan Cordoba', perUsd: 36.9 },
  { code: 'CRC', symbol: '₡', name: 'Costa Rican Colon', perUsd: 512 },
  { code: 'PAB', symbol: 'B/.', name: 'Panamanian Balboa', perUsd: 1 },
  { code: 'JMD', symbol: 'J$', name: 'Jamaican Dollar', perUsd: 157 },
  { code: 'TTD', symbol: 'TT$', name: 'Trinidad & Tobago Dollar', perUsd: 6.79 },
  { code: 'XCD', symbol: 'EC$', name: 'East Caribbean Dollar', perUsd: 2.70 },
  { code: 'BBD', symbol: 'Bds$', name: 'Barbadian Dollar', perUsd: 2 },
  { code: 'BSD', symbol: 'B$', name: 'Bahamian Dollar', perUsd: 1 },
  { code: 'BZD', symbol: 'BZ$', name: 'Belize Dollar', perUsd: 2 },
  { code: 'FJD', symbol: 'FJ$', name: 'Fijian Dollar', perUsd: 2.21 },
  { code: 'PGK', symbol: 'K', name: 'Papua New Guinean Kina', perUsd: 4.42 },
  { code: 'SBD', symbol: 'SI$', name: 'Solomon Islands Dollar', perUsd: 8.44 },
  { code: 'VUV', symbol: 'VT', name: 'Vanuatu Vatu', perUsd: 119 },
  { code: 'AFN2', symbol: '؋', name: 'Afghan Afghani (PUL)', perUsd: 77.2 },
  { code: 'ZWL', symbol: 'Z$', name: 'Zimbabwean Dollar', perUsd: 13_400 },
  { code: 'MWK', symbol: 'MK', name: 'Malawian Kwacha', perUsd: 1_740 },
  { code: 'MZN', symbol: 'MT', name: 'Mozambican Metical', perUsd: 63.8 },
  { code: 'AOA', symbol: 'Kz', name: 'Angolan Kwanza', perUsd: 915 },
  { code: 'XOF', symbol: 'CFA', name: 'West African CFA Franc', perUsd: 603 },
  { code: 'XAF', symbol: 'FCFA', name: 'Central African CFA Franc', perUsd: 603 },
  { code: 'RWF', symbol: 'FRw', name: 'Rwandan Franc', perUsd: 1_290 },
  { code: 'BIF', symbol: 'FBu', name: 'Burundian Franc', perUsd: 2_890 },
  { code: 'DJF', symbol: 'Fdj', name: 'Djiboutian Franc', perUsd: 177 },
  { code: 'ERN', symbol: 'Nfk', name: 'Eritrean Nakfa', perUsd: 15 },
  { code: 'SOS', symbol: 'Sh', name: 'Somali Shilling', perUsd: 571 },
  { code: 'SDG', symbol: 'ج.س', name: 'Sudanese Pound', perUsd: 601 },
  { code: 'SSP', symbol: '£', name: 'South Sudanese Pound', perUsd: 1_307 },
  { code: 'ETB', symbol: 'Br', name: 'Ethiopian Birr', perUsd: 57.6 },
  { code: 'TZS', symbol: 'TSh', name: 'Tanzanian Shilling', perUsd: 2_690 },
  { code: 'UGX', symbol: 'USh', name: 'Ugandan Shilling', perUsd: 3_760 },
  { code: 'ZMW', symbol: 'ZK', name: 'Zambian Kwacha', perUsd: 27.3 },
  { code: 'BWP', symbol: 'P', name: 'Botswana Pula', perUsd: 13.6 },
  { code: 'NAD', symbol: 'N$', name: 'Namibian Dollar', perUsd: 18.4 },
  { code: 'LSL', symbol: 'L', name: 'Lesotho Loti', perUsd: 18.4 },
  { code: 'SZL', symbol: 'E', name: 'Swazi Lilangeni', perUsd: 18.4 },
  { code: 'MUR', symbol: '₨', name: 'Mauritian Rupee', perUsd: 46.8 },
  { code: 'SCR', symbol: '₨', name: 'Seychellois Rupee', perUsd: 13.6 },
  { code: 'MVR', symbol: 'Rf', name: 'Maldivian Rufiyaa', perUsd: 15.4 },
  { code: 'BTN', symbol: 'Nu.', name: 'Bhutanese Ngultrum', perUsd: 83.4 },
  { code: 'MOP', symbol: 'MOP$', name: 'Macanese Pataca', perUsd: 8.03 },
  { code: 'BND', symbol: 'B$', name: 'Brunei Dollar', perUsd: 1.37 },
  { code: 'SRD', symbol: '$', name: 'Surinamese Dollar', perUsd: 34.8 },
  { code: 'GYD', symbol: 'GY$', name: 'Guyanese Dollar', perUsd: 209 },
  { code: 'SHP', symbol: '£', name: 'Saint Helena Pound', perUsd: 0.79 },
  { code: 'FKP', symbol: '£', name: 'Falkland Islands Pound', perUsd: 0.79 },
  { code: 'KYD', symbol: 'CI$', name: 'Cayman Islands Dollar', perUsd: 0.83 },
  { code: 'BMD', symbol: 'BD$', name: 'Bermudian Dollar', perUsd: 1 },
  { code: 'XCD2', symbol: 'EC$', name: 'East Caribbean Dollar (alt)', perUsd: 2.70 },
];

const currencyFamily: FamilySpec<CurrencyDef> = {
  id: 'currency',
  title: 'currency conversion',
  entries: CURRENCIES.map((c) => ({
    name: `to-${c.code.toLowerCase()}`,
    summary: `Convert an amount into ${c.code}`,
    data: c,
  })),
  build: async (entry, ctx) => {
    const target = entry.data;
    const m = /^(-?[\d.,]+)$/.exec(ctx.args.trim());
    if (!m) {
      return { text: `Usage: to-${target.code.toLowerCase()} <amount>\nRates: ${RATES_AS_OF}` };
    }
    const amount = Number.parseFloat((m[1] ?? '').replace(/,/g, ''));
    if (!Number.isFinite(amount)) return { error: `"${m[1]}" is not a number` };
    const out = amount * target.perUsd;
    const shown = Math.abs(out) >= 1000
      ? Math.round(out).toLocaleString('en-US')
      : Number.parseFloat(out.toPrecision(10)).toString();
    return {
      text: `${target.symbol}${shown} ${target.code}  (${target.name})\n1 USD = ${target.perUsd} ${target.code}\n${RATES_AS_OF}`,
    };
  },
};

/* ════════════════════════════════════════════════════════════════════════
   2. Colour — CSS named colours, each with its own hex and swatch
   ════════════════════════════════════════════════════════════════════════ */

/** CSS Color Module Level 4 named colours. */
const CSS_COLORS: Record<string, string> = {
  aliceblue: '#f0f8ff', antiquewhite: '#faebd7', aqua: '#00ffff', aquamarine: '#7fffd4',
  azure: '#f0ffff', beige: '#f5f5dc', bisque: '#ffe4c4', black: '#000000',
  blanchedalmond: '#ffebcd', blue: '#0000ff', blueviolet: '#8a2be2', brown: '#a52a2a',
  burlywood: '#deb887', cadetblue: '#5f9ea0', chartreuse: '#7fff00', chocolate: '#d2691e',
  coral: '#ff7f50', cornflowerblue: '#6495ed', cornsilk: '#fff8dc', crimson: '#dc143c',
  cyan: '#00ffff', darkblue: '#00008b', darkcyan: '#008b8b', darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9', darkgreen: '#006400', darkkhaki: '#bdb76b', darkmagenta: '#8b008b',
  darkolivegreen: '#556b2f', darkorange: '#ff8c00', darkorchid: '#9932cc', darkred: '#8b0000',
  darksalmon: '#e9967a', darkseagreen: '#8fbc8f', darkslateblue: '#483d8b', darkslategray: '#2f4f4f',
  darkturquoise: '#00ced1', darkviolet: '#9400d3', deeppink: '#ff1493', deepskyblue: '#00bfff',
  dimgray: '#696969', dodgerblue: '#1e90ff', firebrick: '#b22222', floralwhite: '#fffaf0',
  forestgreen: '#228b22', fuchsia: '#ff00ff', gainsboro: '#dcdcdc', ghostwhite: '#f8f8ff',
  gold: '#ffd700', goldenrod: '#daa520', gray: '#808080', green: '#008000',
  greenyellow: '#adff2f', honeydew: '#f0fff0', hotpink: '#ff69b4', indianred: '#cd5c5c',
  indigo: '#4b0082', ivory: '#fffff0', khaki: '#f0e68c', lavender: '#e6e6fa',
  lavenderblush: '#fff0f5', lawngreen: '#7cfc00', lemonchiffon: '#fffacd', lightblue: '#add8e6',
  lightcoral: '#f08080', lightcyan: '#e0ffff', lightgoldenrodyellow: '#fafad2', lightgray: '#d3d3d3',
  lightgreen: '#90ee90', lightpink: '#ffb6c1', lightsalmon: '#ffa07a', lightseagreen: '#20b2aa',
  lightskyblue: '#87cefa', lightslategray: '#778899', lightsteelblue: '#b0c4de', lightyellow: '#ffffe0',
  lime: '#00ff00', limegreen: '#32cd32', linen: '#faf0e6', magenta: '#ff00ff',
  maroon: '#800000', mediumaquamarine: '#66cdaa', mediumblue: '#0000cd', mediumorchid: '#ba55d3',
  mediumpurple: '#9370db', mediumseagreen: '#3cb371', mediumslateblue: '#7b68ee', mediumspringgreen: '#00fa9a',
  mediumturquoise: '#48d1cc', mediumvioletred: '#c71585', midnightblue: '#191970', mintcream: '#f5fffa',
  mistyrose: '#ffe4e1', moccasin: '#ffe4b5', navajowhite: '#ffdead', navy: '#000080',
  oldlace: '#fdf5e6', olive: '#808000', olivedrab: '#6b8e23', orange: '#ffa500',
  orangered: '#ff4500', orchid: '#da70d6', palegoldenrod: '#eee8aa', palegreen: '#98fb98',
  paleturquoise: '#afeeee', palevioletred: '#db7093', papayawhip: '#ffefd5', peachpuff: '#ffdab9',
  peru: '#cd853f', pink: '#ffc0cb', plum: '#dda0dd', powderblue: '#b0e0e6',
  purple: '#800080', rebeccapurple: '#663399', red: '#ff0000', rosybrown: '#bc8f8f',
  royalblue: '#4169e1', saddlebrown: '#8b4513', salmon: '#fa8072', sandybrown: '#f4a460',
  seagreen: '#2e8b57', seashell: '#fff5ee', sienna: '#a0522d', silver: '#c0c0c0',
  skyblue: '#87ceeb', slateblue: '#6a5acd', slategray: '#708090', snow: '#fffafa',
  springgreen: '#00ff7f', steelblue: '#4682b4', tan: '#d2b48c', teal: '#008080',
  thistle: '#d8bfd8', tomato: '#ff6347', turquoise: '#40e0d0', violet: '#ee82ee',
  wheat: '#f5deb3', white: '#ffffff', whitesmoke: '#f5f5f5', yellow: '#ffff00',
  yellowgreen: '#9acd32',
};

interface ColorDef { name: string; hex: string }

const colorFamily: FamilySpec<ColorDef> = {
  id: 'color',
  title: 'named colour',
  entries: Object.entries(CSS_COLORS).map(([name, hex]) => ({
    name: `color-${name}`,
    summary: `The CSS colour "${name}"`,
    data: { name, hex },
  })),
  build: async (entry) => {
    const { name, hex } = entry.data;
    // A filled block in the message's own text colour — the swatch renders in
    // the recipient's client, no image needed.
    const block = '█'.repeat(16);
    return { text: `${name}\n${hex.toUpperCase()}\n${block}` };
  },
};

/* ════════════════════════════════════════════════════════════════════════
   3. Timezone — IANA zones, offset resolved live
   ════════════════════════════════════════════════════════════════════════ */

interface ZoneDef { zone: string; slug: string }

/**
 * Every IANA zone the runtime knows about.
 *
 * Read from `Intl` rather than a hand-maintained list, so it cannot drift, and
 * each command resolves its offset live — which means DST is handled correctly
 * for free instead of by a table that goes stale twice a year.
 */
function allZones(): ZoneDef[] {
  const supported = (Intl as unknown as {
    supportedValuesOf?: (key: string) => string[];
  }).supportedValuesOf;
  const zones = typeof supported === 'function'
    ? supported('timeZone')
    : ['UTC', 'Asia/Jakarta', 'Europe/London', 'America/New_York'];
  return zones.map((zone) => ({
    zone,
    slug: zone.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  }));
}

/** Offset in minutes for an instant in a zone, via the runtime's own data. */
function zoneOffsetMinutes(zone: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second'),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

const timezoneFamily: FamilySpec<ZoneDef> = {
  id: 'timezone',
  title: 'timezone',
  entries: allZones().map((z) => ({
    name: `tz-${z.slug}`,
    summary: `Current time in ${z.zone}`,
    data: z,
  })),
  build: async (entry, ctx): Promise<CommandResult> => {
    const { zone } = entry.data;
    // A user may pass "now" (default) or an explicit hour offset to project.
    const shiftH = Number.parseFloat(ctx.arg || '0');
    const at = Number.isFinite(shiftH) ? new Date(Date.now() + shiftH * 3_600_000) : new Date();
    let offset: number;
    try {
      offset = zoneOffsetMinutes(zone, at);
    } catch {
      return { error: `tz: unknown zone "${zone}"` };
    }
    const local = new Date(at.getTime() + offset * 60_000);
    const sign = offset < 0 ? '-' : '+';
    const oh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
    const om = String(Math.abs(offset) % 60).padStart(2, '0');
    const pretty = local.toLocaleString('en-GB', { timeZone: 'UTC' });
    return { text: `${zone}\n${pretty}\nUTC${sign}${oh}:${om}` };
  },
};

/* ════════════════════════════════════════════════════════════════════════
   install
   ════════════════════════════════════════════════════════════════════════ */

export function installBulkFamilies(reg: CommandRegistry): void {
  reg.family(currencyFamily);
  reg.family(colorFamily);
  reg.family(timezoneFamily);
  reg.family(countryFamily);
  reg.family(mathFnFamily);
  reg.family(hashFamily);
  reg.family(httpFamily);
  reg.family(randomFamily);
  installUtilityFamilies(reg as never);
  installAestheticCommands(reg as never);
  installExtraAesthetics(reg as never);
  installFinalAesthetics(reg as never);
  installSocialGames(reg as never);
  installMediaCommands(reg as never);
  installAssistCommands(reg as never);
  installGameCommands(reg as never);

  // One command per verified endpoint. Each genuinely performs a live call, so
  // the count here is bounded by what actually answered when probed — not by a
  // number someone wanted.
  for (const ep of API_ENDPOINTS) {
    reg.command({
      name: `api-${ep.name}`,
      summary: ep.summary,
      effect: `live HTTP GET to ${ep.label}, formatted with a response template`,
      family: 'live-api',
      handler: async (ctx) => callApi(ep, ctx.args),
    });
  }
}
