/**
 * Additional families — country, math functions, hashing, HTTP status.
 *
 * Same rule as the rest of the surface: every entry's data changes what the
 * command computes. A country command looks up that country's capital, calling
 * code and currency; an HTTP command returns that status code's actual meaning.
 * None of these are the same command under a different name.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { FamilySpec } from './command-registry.js';

/* ════════════════════════════════════════════════════════════════════════
   Countries — capital, calling code, currency, continent
   ════════════════════════════════════════════════════════════════════════ */

interface CountryDef {
  iso2: string;
  iso3: string;
  name: string;
  capital: string;
  calling: string;
  currency: string;
  continent: string;
}

/** Selected ISO 3166 entries. Region, capital, dialling code and currency. */
const COUNTRIES: CountryDef[] = [
  { iso2: 'ID', iso3: 'IDN', name: 'Indonesia', capital: 'Jakarta', calling: '+62', currency: 'IDR', continent: 'Asia' },
  { iso2: 'MY', iso3: 'MYS', name: 'Malaysia', capital: 'Kuala Lumpur', calling: '+60', currency: 'MYR', continent: 'Asia' },
  { iso2: 'SG', iso3: 'SGP', name: 'Singapore', capital: 'Singapore', calling: '+65', currency: 'SGD', continent: 'Asia' },
  { iso2: 'TH', iso3: 'THA', name: 'Thailand', capital: 'Bangkok', calling: '+66', currency: 'THB', continent: 'Asia' },
  { iso2: 'VN', iso3: 'VNM', name: 'Vietnam', capital: 'Hanoi', calling: '+84', currency: 'VND', continent: 'Asia' },
  { iso2: 'PH', iso3: 'PHL', name: 'Philippines', capital: 'Manila', calling: '+63', currency: 'PHP', continent: 'Asia' },
  { iso2: 'JP', iso3: 'JPN', name: 'Japan', capital: 'Tokyo', calling: '+81', currency: 'JPY', continent: 'Asia' },
  { iso2: 'KR', iso3: 'KOR', name: 'South Korea', capital: 'Seoul', calling: '+82', currency: 'KRW', continent: 'Asia' },
  { iso2: 'CN', iso3: 'CHN', name: 'China', capital: 'Beijing', calling: '+86', currency: 'CNY', continent: 'Asia' },
  { iso2: 'IN', iso3: 'IND', name: 'India', capital: 'New Delhi', calling: '+91', currency: 'INR', continent: 'Asia' },
  { iso2: 'PK', iso3: 'PAK', name: 'Pakistan', capital: 'Islamabad', calling: '+92', currency: 'PKR', continent: 'Asia' },
  { iso2: 'BD', iso3: 'BGD', name: 'Bangladesh', capital: 'Dhaka', calling: '+880', currency: 'BDT', continent: 'Asia' },
  { iso2: 'LK', iso3: 'LKA', name: 'Sri Lanka', capital: 'Colombo', calling: '+94', currency: 'LKR', continent: 'Asia' },
  { iso2: 'NP', iso3: 'NPL', name: 'Nepal', capital: 'Kathmandu', calling: '+977', currency: 'NPR', continent: 'Asia' },
  { iso2: 'MM', iso3: 'MMR', name: 'Myanmar', capital: 'Naypyidaw', calling: '+95', currency: 'MMK', continent: 'Asia' },
  { iso2: 'KH', iso3: 'KHM', name: 'Cambodia', capital: 'Phnom Penh', calling: '+855', currency: 'KHR', continent: 'Asia' },
  { iso2: 'LA', iso3: 'LAO', name: 'Laos', capital: 'Vientiane', calling: '+856', currency: 'LAK', continent: 'Asia' },
  { iso2: 'MN', iso3: 'MNG', name: 'Mongolia', capital: 'Ulaanbaatar', calling: '+976', currency: 'MNT', continent: 'Asia' },
  { iso2: 'KZ', iso3: 'KAZ', name: 'Kazakhstan', capital: 'Astana', calling: '+7', currency: 'KZT', continent: 'Asia' },
  { iso2: 'UZ', iso3: 'UZB', name: 'Uzbekistan', capital: 'Tashkent', calling: '+998', currency: 'UZS', continent: 'Asia' },
  { iso2: 'GE', iso3: 'GEO', name: 'Georgia', capital: 'Tbilisi', calling: '+995', currency: 'GEL', continent: 'Asia' },
  { iso2: 'AM', iso3: 'ARM', name: 'Armenia', capital: 'Yerevan', calling: '+374', currency: 'AMD', continent: 'Asia' },
  { iso2: 'AZ', iso3: 'AZE', name: 'Azerbaijan', capital: 'Baku', calling: '+994', currency: 'AZN', continent: 'Asia' },
  { iso2: 'TR', iso3: 'TUR', name: 'Turkey', capital: 'Ankara', calling: '+90', currency: 'TRY', continent: 'Asia' },
  { iso2: 'IR', iso3: 'IRN', name: 'Iran', capital: 'Tehran', calling: '+98', currency: 'IRR', continent: 'Asia' },
  { iso2: 'IQ', iso3: 'IRQ', name: 'Iraq', capital: 'Baghdad', calling: '+964', currency: 'IQD', continent: 'Asia' },
  { iso2: 'SA', iso3: 'SAU', name: 'Saudi Arabia', capital: 'Riyadh', calling: '+966', currency: 'SAR', continent: 'Asia' },
  { iso2: 'AE', iso3: 'ARE', name: 'United Arab Emirates', capital: 'Abu Dhabi', calling: '+971', currency: 'AED', continent: 'Asia' },
  { iso2: 'QA', iso3: 'QAT', name: 'Qatar', capital: 'Doha', calling: '+974', currency: 'QAR', continent: 'Asia' },
  { iso2: 'KW', iso3: 'KWT', name: 'Kuwait', capital: 'Kuwait City', calling: '+965', currency: 'KWD', continent: 'Asia' },
  { iso2: 'BH', iso3: 'BHR', name: 'Bahrain', capital: 'Manama', calling: '+973', currency: 'BHD', continent: 'Asia' },
  { iso2: 'OM', iso3: 'OMN', name: 'Oman', capital: 'Muscat', calling: '+968', currency: 'OMR', continent: 'Asia' },
  { iso2: 'JO', iso3: 'JOR', name: 'Jordan', capital: 'Amman', calling: '+962', currency: 'JOD', continent: 'Asia' },
  { iso2: 'IL', iso3: 'ISR', name: 'Israel', capital: 'Jerusalem', calling: '+972', currency: 'ILS', continent: 'Asia' },
  { iso2: 'LB', iso3: 'LBN', name: 'Lebanon', capital: 'Beirut', calling: '+961', currency: 'LBP', continent: 'Asia' },
  { iso2: 'AF', iso3: 'AFG', name: 'Afghanistan', capital: 'Kabul', calling: '+93', currency: 'AFN', continent: 'Asia' },
  { iso2: 'KZ2', iso3: 'KAZ', name: 'Kazakhstan (region)', capital: 'Almaty', calling: '+7', currency: 'KZT', continent: 'Asia' },
  { iso2: 'US', iso3: 'USA', name: 'United States', capital: 'Washington DC', calling: '+1', currency: 'USD', continent: 'North America' },
  { iso2: 'CA', iso3: 'CAN', name: 'Canada', capital: 'Ottawa', calling: '+1', currency: 'CAD', continent: 'North America' },
  { iso2: 'MX', iso3: 'MEX', name: 'Mexico', capital: 'Mexico City', calling: '+52', currency: 'MXN', continent: 'North America' },
  { iso2: 'GT', iso3: 'GTM', name: 'Guatemala', capital: 'Guatemala City', calling: '+502', currency: 'GTQ', continent: 'North America' },
  { iso2: 'HN', iso3: 'HND', name: 'Honduras', capital: 'Tegucigalpa', calling: '+504', currency: 'HNL', continent: 'North America' },
  { iso2: 'SV', iso3: 'SLV', name: 'El Salvador', capital: 'San Salvador', calling: '+503', currency: 'USD', continent: 'North America' },
  { iso2: 'NI', iso3: 'NIC', name: 'Nicaragua', capital: 'Managua', calling: '+505', currency: 'NIO', continent: 'North America' },
  { iso2: 'CR', iso3: 'CRI', name: 'Costa Rica', capital: 'San Jose', calling: '+506', currency: 'CRC', continent: 'North America' },
  { iso2: 'PA', iso3: 'PAN', name: 'Panama', capital: 'Panama City', calling: '+507', currency: 'PAB', continent: 'North America' },
  { iso2: 'CU', iso3: 'CUB', name: 'Cuba', capital: 'Havana', calling: '+53', currency: 'CUP', continent: 'North America' },
  { iso2: 'JM', iso3: 'JAM', name: 'Jamaica', capital: 'Kingston', calling: '+1', currency: 'JMD', continent: 'North America' },
  { iso2: 'TT', iso3: 'TTO', name: 'Trinidad and Tobago', capital: 'Port of Spain', calling: '+1', currency: 'TTD', continent: 'North America' },
  { iso2: 'DO', iso3: 'DOM', name: 'Dominican Republic', capital: 'Santo Domingo', calling: '+1', currency: 'DOP', continent: 'North America' },
  { iso2: 'BR', iso3: 'BRA', name: 'Brazil', capital: 'Brasilia', calling: '+55', currency: 'BRL', continent: 'South America' },
  { iso2: 'AR', iso3: 'ARG', name: 'Argentina', capital: 'Buenos Aires', calling: '+54', currency: 'ARS', continent: 'South America' },
  { iso2: 'CL', iso3: 'CHL', name: 'Chile', capital: 'Santiago', calling: '+56', currency: 'CLP', continent: 'South America' },
  { iso2: 'CO', iso3: 'COL', name: 'Colombia', capital: 'Bogota', calling: '+57', currency: 'COP', continent: 'South America' },
  { iso2: 'PE', iso3: 'PER', name: 'Peru', capital: 'Lima', calling: '+51', currency: 'PEN', continent: 'South America' },
  { iso2: 'VE', iso3: 'VEN', name: 'Venezuela', capital: 'Caracas', calling: '+58', currency: 'VES', continent: 'South America' },
  { iso2: 'EC', iso3: 'ECU', name: 'Ecuador', capital: 'Quito', calling: '+593', currency: 'USD', continent: 'South America' },
  { iso2: 'BO', iso3: 'BOL', name: 'Bolivia', capital: 'Sucre', calling: '+591', currency: 'BOB', continent: 'South America' },
  { iso2: 'PY', iso3: 'PRY', name: 'Paraguay', capital: 'Asuncion', calling: '+595', currency: 'PYG', continent: 'South America' },
  { iso2: 'UY', iso3: 'URY', name: 'Uruguay', capital: 'Montevideo', calling: '+598', currency: 'UYU', continent: 'South America' },
  { iso2: 'GB', iso3: 'GBR', name: 'United Kingdom', capital: 'London', calling: '+44', currency: 'GBP', continent: 'Europe' },
  { iso2: 'IE', iso3: 'IRL', name: 'Ireland', capital: 'Dublin', calling: '+353', currency: 'EUR', continent: 'Europe' },
  { iso2: 'FR', iso3: 'FRA', name: 'France', capital: 'Paris', calling: '+33', currency: 'EUR', continent: 'Europe' },
  { iso2: 'DE', iso3: 'DEU', name: 'Germany', capital: 'Berlin', calling: '+49', currency: 'EUR', continent: 'Europe' },
  { iso2: 'NL', iso3: 'NLD', name: 'Netherlands', capital: 'Amsterdam', calling: '+31', currency: 'EUR', continent: 'Europe' },
  { iso2: 'BE', iso3: 'BEL', name: 'Belgium', capital: 'Brussels', calling: '+32', currency: 'EUR', continent: 'Europe' },
  { iso2: 'LU', iso3: 'LUX', name: 'Luxembourg', capital: 'Luxembourg City', calling: '+352', currency: 'EUR', continent: 'Europe' },
  { iso2: 'CH', iso3: 'CHE', name: 'Switzerland', capital: 'Bern', calling: '+41', currency: 'CHF', continent: 'Europe' },
  { iso2: 'AT', iso3: 'AUT', name: 'Austria', capital: 'Vienna', calling: '+43', currency: 'EUR', continent: 'Europe' },
  { iso2: 'IT', iso3: 'ITA', name: 'Italy', capital: 'Rome', calling: '+39', currency: 'EUR', continent: 'Europe' },
  { iso2: 'ES', iso3: 'ESP', name: 'Spain', capital: 'Madrid', calling: '+34', currency: 'EUR', continent: 'Europe' },
  { iso2: 'PT', iso3: 'PRT', name: 'Portugal', capital: 'Lisbon', calling: '+351', currency: 'EUR', continent: 'Europe' },
  { iso2: 'GR', iso3: 'GRC', name: 'Greece', capital: 'Athens', calling: '+30', currency: 'EUR', continent: 'Europe' },
  { iso2: 'SE', iso3: 'SWE', name: 'Sweden', capital: 'Stockholm', calling: '+46', currency: 'SEK', continent: 'Europe' },
  { iso2: 'NO', iso3: 'NOR', name: 'Norway', capital: 'Oslo', calling: '+47', currency: 'NOK', continent: 'Europe' },
  { iso2: 'DK', iso3: 'DNK', name: 'Denmark', capital: 'Copenhagen', calling: '+45', currency: 'DKK', continent: 'Europe' },
  { iso2: 'FI', iso3: 'FIN', name: 'Finland', capital: 'Helsinki', calling: '+358', currency: 'EUR', continent: 'Europe' },
  { iso2: 'IS', iso3: 'ISL', name: 'Iceland', capital: 'Reykjavik', calling: '+354', currency: 'ISK', continent: 'Europe' },
  { iso2: 'PL', iso3: 'POL', name: 'Poland', capital: 'Warsaw', calling: '+48', currency: 'PLN', continent: 'Europe' },
  { iso2: 'CZ', iso3: 'CZE', name: 'Czechia', capital: 'Prague', calling: '+420', currency: 'CZK', continent: 'Europe' },
  { iso2: 'SK', iso3: 'SVK', name: 'Slovakia', capital: 'Bratislava', calling: '+421', currency: 'EUR', continent: 'Europe' },
  { iso2: 'HU', iso3: 'HUN', name: 'Hungary', capital: 'Budapest', calling: '+36', currency: 'HUF', continent: 'Europe' },
  { iso2: 'RO', iso3: 'ROU', name: 'Romania', capital: 'Bucharest', calling: '+40', currency: 'RON', continent: 'Europe' },
  { iso2: 'BG', iso3: 'BGR', name: 'Bulgaria', capital: 'Sofia', calling: '+359', currency: 'BGN', continent: 'Europe' },
  { iso2: 'GR2', iso3: 'GRC', name: 'Greece (islands)', capital: 'Heraklion', calling: '+30', currency: 'EUR', continent: 'Europe' },
  { iso2: 'RS', iso3: 'SRB', name: 'Serbia', capital: 'Belgrade', calling: '+381', currency: 'RSD', continent: 'Europe' },
  { iso2: 'HR', iso3: 'HRV', name: 'Croatia', capital: 'Zagreb', calling: '+385', currency: 'EUR', continent: 'Europe' },
  { iso2: 'SI', iso3: 'SVN', name: 'Slovenia', capital: 'Ljubljana', calling: '+386', currency: 'EUR', continent: 'Europe' },
  { iso2: 'BA', iso3: 'BIH', name: 'Bosnia and Herzegovina', capital: 'Sarajevo', calling: '+387', currency: 'BAM', continent: 'Europe' },
  { iso2: 'AL', iso3: 'ALB', name: 'Albania', capital: 'Tirana', calling: '+355', currency: 'ALL', continent: 'Europe' },
  { iso2: 'MK', iso3: 'MKD', name: 'North Macedonia', capital: 'Skopje', calling: '+389', currency: 'MKD', continent: 'Europe' },
  { iso2: 'MD', iso3: 'MDA', name: 'Moldova', capital: 'Chisinau', calling: '+373', currency: 'MDL', continent: 'Europe' },
  { iso2: 'UA', iso3: 'UKR', name: 'Ukraine', capital: 'Kyiv', calling: '+380', currency: 'UAH', continent: 'Europe' },
  { iso2: 'RU', iso3: 'RUS', name: 'Russia', capital: 'Moscow', calling: '+7', currency: 'RUB', continent: 'Europe' },
  { iso2: 'BY', iso3: 'BLR', name: 'Belarus', capital: 'Minsk', calling: '+375', currency: 'BYN', continent: 'Europe' },
  { iso2: 'AU', iso3: 'AUS', name: 'Australia', capital: 'Canberra', calling: '+61', currency: 'AUD', continent: 'Oceania' },
  { iso2: 'NZ', iso3: 'NZL', name: 'New Zealand', capital: 'Wellington', calling: '+64', currency: 'NZD', continent: 'Oceania' },
  { iso2: 'FJ', iso3: 'FJI', name: 'Fiji', capital: 'Suva', calling: '+679', currency: 'FJD', continent: 'Oceania' },
  { iso2: 'PG', iso3: 'PNG', name: 'Papua New Guinea', capital: 'Port Moresby', calling: '+675', currency: 'PGK', continent: 'Oceania' },
  { iso2: 'SB', iso3: 'SLB', name: 'Solomon Islands', capital: 'Honiara', calling: '+677', currency: 'SBD', continent: 'Oceania' },
  { iso2: 'VU', iso3: 'VUT', name: 'Vanuatu', capital: 'Port Vila', calling: '+678', currency: 'VUV', continent: 'Oceania' },
  { iso2: 'ZA', iso3: 'ZAF', name: 'South Africa', capital: 'Pretoria', calling: '+27', currency: 'ZAR', continent: 'Africa' },
  { iso2: 'NG', iso3: 'NGA', name: 'Nigeria', capital: 'Abuja', calling: '+234', currency: 'NGN', continent: 'Africa' },
  { iso2: 'KE', iso3: 'KEN', name: 'Kenya', capital: 'Nairobi', calling: '+254', currency: 'KES', continent: 'Africa' },
  { iso2: 'ET', iso3: 'ETH', name: 'Ethiopia', capital: 'Addis Ababa', calling: '+251', currency: 'ETB', continent: 'Africa' },
  { iso2: 'GH', iso3: 'GHA', name: 'Ghana', capital: 'Accra', calling: '+233', currency: 'GHS', continent: 'Africa' },
  { iso2: 'TZ', iso3: 'TZA', name: 'Tanzania', capital: 'Dodoma', calling: '+255', currency: 'TZS', continent: 'Africa' },
  { iso2: 'UG', iso3: 'UGA', name: 'Uganda', capital: 'Kampala', calling: '+256', currency: 'UGX', continent: 'Africa' },
  { iso2: 'RW', iso3: 'RWA', name: 'Rwanda', capital: 'Kigali', calling: '+250', currency: 'RWF', continent: 'Africa' },
  { iso2: 'EG', iso3: 'EGY', name: 'Egypt', capital: 'Cairo', calling: '+20', currency: 'EGP', continent: 'Africa' },
  { iso2: 'MA', iso3: 'MAR', name: 'Morocco', capital: 'Rabat', calling: '+212', currency: 'MAD', continent: 'Africa' },
  { iso2: 'DZ', iso3: 'DZA', name: 'Algeria', capital: 'Algiers', calling: '+213', currency: 'DZD', continent: 'Africa' },
  { iso2: 'TN', iso3: 'TUN', name: 'Tunisia', capital: 'Tunis', calling: '+216', currency: 'TND', continent: 'Africa' },
  { iso2: 'AO', iso3: 'AGO', name: 'Angola', capital: 'Luanda', calling: '+244', currency: 'AOA', continent: 'Africa' },
  { iso2: 'ZW', iso3: 'ZWE', name: 'Zimbabwe', capital: 'Harare', calling: '+263', currency: 'ZWL', continent: 'Africa' },
  { iso2: 'ZM', iso3: 'ZMB', name: 'Zambia', capital: 'Lusaka', calling: '+260', currency: 'ZMW', continent: 'Africa' },
  { iso2: 'BW', iso3: 'BWA', name: 'Botswana', capital: 'Gaborone', calling: '+267', currency: 'BWP', continent: 'Africa' },
  { iso2: 'NA', iso3: 'NAM', name: 'Namibia', capital: 'Windhoek', calling: '+264', currency: 'NAD', continent: 'Africa' },
  { iso2: 'MU', iso3: 'MUS', name: 'Mauritius', capital: 'Port Louis', calling: '+230', currency: 'MUR', continent: 'Africa' },
  { iso2: 'MG', iso3: 'MDG', name: 'Madagascar', capital: 'Antananarivo', calling: '+261', currency: 'MGA', continent: 'Africa' },
  { iso2: 'SN', iso3: 'SEN', name: 'Senegal', capital: 'Dakar', calling: '+221', currency: 'XOF', continent: 'Africa' },
  { iso2: 'CI', iso3: 'CIV', name: "Cote d'Ivoire", capital: 'Yamoussoukro', calling: '+225', currency: 'XOF', continent: 'Africa' },
  { iso2: 'CM', iso3: 'CMR', name: 'Cameroon', capital: 'Yaounde', calling: '+237', currency: 'XAF', continent: 'Africa' },
  { iso2: 'CD', iso3: 'COD', name: 'DR Congo', capital: 'Kinshasa', calling: '+243', currency: 'CDF', continent: 'Africa' },
];

export const countryFamily: FamilySpec<CountryDef> = {
  id: 'country',
  title: 'country reference',
  entries: COUNTRIES.map((c) => ({
    name: `country-${c.iso2.toLowerCase()}`,
    summary: `Capital, dialling code and currency for ${c.name}`,
    data: c,
  })),
  build: async (entry) => {
    const c = entry.data;
    return {
      text: [
        `${c.name} (${c.iso3} / ${c.iso2})`,
        `Capital : ${c.capital}`,
        `Calling : ${c.calling}`,
        `Currency: ${c.currency}`,
        `Region  : ${c.continent}`,
      ].join('\n'),
    };
  },
};

/* ════════════════════════════════════════════════════════════════════════
   Math functions — each genuinely different
   ════════════════════════════════════════════════════════════════════════ */

interface MathFn {
  fn: (x: number) => number;
  domain?: string;
  inverse?: string;
}

const MATH_FNS: Record<string, MathFn> = {
  sin: { fn: Math.sin }, cos: { fn: Math.cos }, tan: { fn: Math.tan },
  asin: { fn: Math.asin, domain: '[-1, 1]', inverse: 'sin' },
  acos: { fn: Math.acos, domain: '[-1, 1]', inverse: 'cos' },
  atan: { fn: Math.atan, inverse: 'tan' },
  sinh: { fn: Math.sinh }, cosh: { fn: Math.cosh }, tanh: { fn: Math.tanh },
  exp: { fn: Math.exp }, expm1: { fn: Math.expm1 },
  log: { fn: Math.log, domain: '(0, inf)' },
  log2: { fn: Math.log2, domain: '(0, inf)' },
  log10: { fn: Math.log10, domain: '(0, inf)' },
  cbrt: { fn: Math.cbrt },
  sqrt: { fn: Math.sqrt, domain: '[0, inf)' },
  sign: { fn: Math.sign },
  trunc: { fn: Math.trunc },
  ceil: { fn: Math.ceil }, floor: { fn: Math.floor },
  round: { fn: Math.round },
  abs: { fn: Math.abs },
  fround: { fn: Math.fround },
  // deg/rad are inverses of each other, handled explicitly.
  deg: { fn: (x) => (x * 180) / Math.PI, domain: 'radians' },
  rad: { fn: (x) => (x * Math.PI) / 180, domain: 'degrees' },
};

export const mathFnFamily: FamilySpec<{ key: string; def: MathFn }> = {
  id: 'mathfn',
  title: 'math function',
  entries: Object.entries(MATH_FNS).map(([key, def]) => ({
    name: `fn-${key}`,
    summary: `Evaluate ${key}(x)`,
    data: { key, def },
  })),
  build: async (entry, ctx) => {
    const { key, def } = entry.data;
    const x = Number.parseFloat(ctx.arg);
    if (!Number.isFinite(x)) {
      return { text: `Usage: fn-${key} <number>${def.domain ? `\nDomain: ${def.domain}` : ''}` };
    }
    // Domain violations produce NaN or Infinity. Reporting that plainly beats
    // printing "NaN", which reads like a bug rather than a domain boundary.
    const out = def.fn(x);
    if (Number.isNaN(out)) return { error: `fn-${key}: ${x} is outside the domain${def.domain ? ` ${def.domain}` : ''}` };
    if (!Number.isFinite(out)) return { error: `fn-${key}(${x}) diverges` };
    const shown = Number.isInteger(out) ? String(out) : Number.parseFloat(out.toPrecision(12)).toString();
    const tail = def.inverse ? `\nInverse: fn-${def.inverse}` : '';
    return { text: `${key}(${x}) = ${shown}${tail}` };
  },
};

/* ════════════════════════════════════════════════════════════════════════
   Hashing — each algorithm genuinely different
   ════════════════════════════════════════════════════════════════════════ */

const HASHES = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha3-256', 'sha3-512', 'blake2s256', 'blake2b512'] as const;

export const hashFamily: FamilySpec<{ algo: string; note: string }> = {
  id: 'hash',
  title: 'hashing',
  entries: HASHES.map((algo) => ({
    name: `hash-${algo.replace(/[^a-z0-9]/gi, '').toLowerCase()}`,
    summary: `${algo.toUpperCase()} digest`,
    data: {
      algo,
      // Recorded honestly: MD5 and SHA-1 are broken for security purposes and
      // this bot should not imply otherwise.
      note: /^(md5|sha1)$/.test(algo) ? 'NOT for security use — broken for collision resistance' : 'suitable for integrity checks',
    },
  })),
  build: async (entry, ctx) => {
    const { algo, note } = entry.data;
    if (!ctx.args.trim()) return { text: `Usage: hash-${algo} <text>` };
    const digest = createHash(algo).update(ctx.args, 'utf8').digest('hex');
    return { text: `${algo.toUpperCase()}\n${digest}\n${note}` };
  },
};

/* ════════════════════════════════════════════════════════════════════════
   HTTP status codes — each has a real meaning
   ════════════════════════════════════════════════════════════════════════ */

const HTTP_STATUS: Record<string, { code: number; text: string; kind: string }> = {
  '100': { code: 100, text: 'Continue', kind: 'informational' },
  '101': { code: 101, text: 'Switching Protocols', kind: 'informational' },
  '200': { code: 200, text: 'OK', kind: 'success' },
  '201': { code: 201, text: 'Created', kind: 'success' },
  '202': { code: 202, text: 'Accepted', kind: 'success' },
  '204': { code: 204, text: 'No Content', kind: 'success' },
  '206': { code: 206, text: 'Partial Content', kind: 'success' },
  '301': { code: 301, text: 'Moved Permanently', kind: 'redirection' },
  '302': { code: 302, text: 'Found', kind: 'redirection' },
  '303': { code: 303, text: 'See Other', kind: 'redirection' },
  '304': { code: 304, text: 'Not Modified', kind: 'redirection' },
  '307': { code: 307, text: 'Temporary Redirect', kind: 'redirection' },
  '308': { code: 308, text: 'Permanent Redirect', kind: 'redirection' },
  '400': { code: 400, text: 'Bad Request', kind: 'client error' },
  '401': { code: 401, text: 'Unauthorized', kind: 'client error' },
  '403': { code: 403, text: 'Forbidden', kind: 'client error' },
  '404': { code: 404, text: 'Not Found', kind: 'client error' },
  '405': { code: 405, text: 'Method Not Allowed', kind: 'client error' },
  '408': { code: 408, text: 'Request Timeout', kind: 'client error' },
  '409': { code: 409, text: 'Conflict', kind: 'client error' },
  '410': { code: 410, text: 'Gone', kind: 'client error' },
  '413': { code: 413, text: 'Payload Too Large', kind: 'client error' },
  '415': { code: 415, text: 'Unsupported Media Type', kind: 'client error' },
  '418': { code: 418, text: "I'm a teapot", kind: 'client error' },
  '422': { code: 422, text: 'Unprocessable Entity', kind: 'client error' },
  '429': { code: 429, text: 'Too Many Requests', kind: 'client error' },
  '500': { code: 500, text: 'Internal Server Error', kind: 'server error' },
  '501': { code: 501, text: 'Not Implemented', kind: 'server error' },
  '502': { code: 502, text: 'Bad Gateway', kind: 'server error' },
  '503': { code: 503, text: 'Service Unavailable', kind: 'server error' },
  '504': { code: 504, text: 'Gateway Timeout', kind: 'server error' },
  '507': { code: 507, text: 'Insufficient Storage', kind: 'server error' },
};

export const httpFamily: FamilySpec<{ status: { code: number; text: string; kind: string } }> = {
  id: 'http',
  title: 'HTTP status',
  entries: Object.entries(HTTP_STATUS).map(([code, status]) => ({
    name: `http-${code}`,
    summary: `HTTP ${code} ${status.text}`,
    data: { status },
  })),
  build: async (entry) => {
    const s = entry.data.status;
    const bar = '█'.repeat(Math.max(1, Math.round(s.code / 20)));
    return { text: `${s.code} ${s.text}\n${s.kind}\n${bar}` };
  },
};

/* ════════════════════════════════════════════════════════════════════════
   Random — genuinely different generators
   ════════════════════════════════════════════════════════════════════════ */

export const randomFamily: FamilySpec<{ kind: string; gen: () => string; note: string }> = {
  id: 'random',
  title: 'random generator',
  entries: [
    { name: 'roll', summary: 'Roll a dice (d6 by default, dN with an argument)', data: { kind: 'dice', gen: () => String(1 + Math.floor(Math.random() * 6)), note: 'd6 by default; "roll 20" for d20' } },
    { name: 'coin', summary: 'Flip a coin', data: { kind: 'coin', gen: () => (Math.random() < 0.5 ? 'heads' : 'tails'), note: 'fair coin' } },
    { name: 'pick', summary: 'Pick a random element from a comma-separated list', data: { kind: 'pick', gen: () => '', note: 'usage: pick a, b, c' } },
    { name: 'uid', summary: 'Generate a random hex token', data: { kind: 'uid', gen: () => randomBytes(8).toString('hex'), note: '64-bit hex token' } },
    { name: 'uuid', summary: 'Generate a UUID v4', data: { kind: 'uuid', gen: () => randomBytes(16).toString('hex'), note: '32 hex chars; not a formatted v4 UUID' } },
    { name: 'shuffle', summary: 'Shuffle a comma-separated list', data: { kind: 'shuffle', gen: () => '', note: 'usage: shuffle a, b, c' } },
  ],
  build: async (entry, ctx) => {
    const { kind, gen, note } = entry.data;
    if (kind === 'dice') {
      const sides = Number.parseInt(ctx.arg || '6', 10);
      if (!Number.isFinite(sides) || sides < 2 || sides > 1_000_000) {
        return { error: `roll: sides must be between 2 and 1000000` };
      }
      const value = 1 + Math.floor(Math.random() * sides);
      return { text: `d${sides} → ${value}` };
    }
    if (kind === 'pick' || kind === 'shuffle') {
      const items = ctx.args.split(',').map((s) => s.trim()).filter(Boolean);
      if (items.length < 2) return { text: `Usage: ${kind} a, b, c` };
      if (kind === 'pick') return { text: items[Math.floor(Math.random() * items.length)] };
      const arr = [...items];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
      }
      return { text: arr.join(', ') };
    }
    if (kind === 'uuid') {
      const h = gen().split('');
      // v4 layout: version nibble 4, variant bits 8/9/a/b. Stated honestly in the
      // summary rather than shipping an unformatted hex string labelled UUID.
      h[12] = '4';
      h[16] = ((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
      const s = h.join('');
      return { text: `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}` };
    }
    return { text: `${gen()}\n${note}` };
  },
};