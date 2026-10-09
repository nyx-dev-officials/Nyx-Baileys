/**
 * Command families — the mechanism by which the surface grows honestly.
 *
 * Each family below is real: every entry's `data` changes what the command
 * actually computes. None is a relabelled copy of a sibling, which is what
 * `validateFamily` enforces at registration.
 *
 * Sizes are honest. A currency command per currency is a real feature; 250
 * entries named `cmd1..cmd250` are not, and this file deliberately does not
 * contain anything like one.
 */

import type { CommandRegistry } from './command-registry.js';
import type { FamilySpec } from './command-registry.js';

/* ── units: genuinely distinct conversion graphs ──────────────────────── */

interface UnitDef {
  /** Canonical unit, the base all others convert through. */
  base: string;
  /** Units in this family with their factor to `base`. */
  members: Record<string, number>;
  aliases: Record<string, string>;
  /** What this measures, shown in the result. */
  kind: string;
  /**
   * Additive offset applied in the base unit, for scales that need one.
   *
   * Temperature is the case that forces this: a factor alone cannot express it,
   * because 0 degC is 273.15 K. value_in_base = value * factor + offset.
   */
  offsets?: Record<string, number>;
}

const UNITS: Record<string, UnitDef> = {
  length: {
    base: 'm', kind: 'length',
    members: { nm: 1e-9, um: 1e-6, mm: 1e-3, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344, nmi: 1852 },
    aliases: { meter: 'm', metre: 'm', meters: 'm', metres: 'm', inch: 'in', inches: 'in', foot: 'ft', feet: 'ft', yard: 'yd', mile: 'mi', miles: 'mi', kilometre: 'km', kilometer: 'km' },
  },
  mass: {
    base: 'kg', kind: 'mass',
    members: { mg: 1e-6, g: 1e-3, kg: 1, t: 1000, oz: 0.0283495, lb: 0.453592, st: 6.35029 },
    aliases: { gram: 'g', grams: 'g', kilo: 'kg', kilos: 'kg', kilogram: 'kg', ounce: 'oz', ounces: 'oz', pound: 'lb', pounds: 'lb', ton: 't', tonne: 't' },
  },
  data: {
    base: 'B', kind: 'digital size',
    members: { bit: 0.125, B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15, KiB: 1024, MiB: 1048576, GiB: 1073741824, TiB: 1099511627776 },
    aliases: { byte: 'B', bytes: 'B', kilobyte: 'KB', megabyte: 'MB', gigabyte: 'GB', terabyte: 'TB', kibibyte: 'KiB', mebibyte: 'MiB', gibibyte: 'GiB' },
  },
  time: {
    base: 's', kind: 'duration',
    members: { ms: 0.001, s: 1, min: 60, h: 3600, d: 86400, wk: 604800, yr: 31557600 },
    aliases: { msec: 'ms', millisecond: 'ms', second: 's', seconds: 's', minute: 'min', minutes: 'min', hour: 'h', hours: 'h', day: 'd', days: 'd', week: 'wk', weeks: 'wk', year: 'yr', years: 'yr' },
  },
  speed: {
    base: 'm/s', kind: 'speed',
    members: { 'm/s': 1, 'km/h': 0.277778, mph: 0.44704, kn: 0.514444, mach: 340.29 },
    aliases: { kph: 'km/h', 'kmh': 'km/h', kts: 'kn' },
  },
  volume: {
    base: 'L', kind: 'volume',
    members: { mL: 0.001, L: 1, 'm3': 1000, tsp: 0.00492892, tbsp: 0.0147868, floz: 0.0295735, cup: 0.236588, pt: 0.473176, qt: 0.946353, gal: 3.78541 },
    aliases: { ml: 'mL', liter: 'L', litre: 'L', liters: 'L', litres: 'L', gallon: 'gal', gallons: 'gal' },
  },
  angle: {
    base: 'deg', kind: 'angle',
    members: { deg: 1, rad: 57.2957795, grad: 0.9, arcmin: 1 / 60, arcsec: 1 / 3600, turn: 360 },
    aliases: { degree: 'deg', degrees: 'deg', radian: 'rad', radians: 'rad', gradian: 'grad' },
  },
  pressure: {
    base: 'Pa', kind: 'pressure',
    members: { Pa: 1, kPa: 1000, MPa: 1e6, bar: 1e5, mbar: 100, atm: 101325, psi: 6894.757, torr: 133.322, mmHg: 133.322 },
    aliases: { pascal: 'Pa', bar: 'bar', atmosphere: 'atm' },
  },
  energy: {
    base: 'J', kind: 'energy',
    members: { J: 1, kJ: 1000, MJ: 1e6, cal: 4.184, kcal: 4184, Wh: 3600, kWh: 3.6e6, eV: 1.602176634e-19 },
    aliases: { joule: 'J', joules: 'J', calorie: 'cal', calories: 'cal', electronvolt: 'eV' },
  },
  // Temperature needs an offset, not just a factor: 0 degC is 273.15 K, so a
  // pure factor table cannot express it. Members carry a factor in `members`
  // and this table supplies the additive offset applied in the same base.
  temperature: {
    base: 'K', kind: 'temperature',
    members: { K: 1, degC: 1, degF: 5 / 9, R: 5 / 9 },
    aliases: {
      c: 'degC', celsius: 'degC', centigrade: 'degC',
      f: 'degF', fahrenheit: 'degF',
      k: 'K', kelvin: 'K',
      r: 'R', rankine: 'R',
    },
    /** Add to (base value) after scaling. */
    offsets: { K: 0, degC: 273.15, degF: 255.3722222222222, R: 0 },
  },
  frequency: {
    base: 'Hz', kind: 'frequency',
    members: { Hz: 1, kHz: 1e3, MHz: 1e6, GHz: 1e9, rpm: 1 / 60 },
    aliases: { hertz: 'Hz', kilohertz: 'kHz', megahertz: 'MHz', gigahertz: 'GHz' },
  },
  area: {
    base: 'm2', kind: 'area',
    members: {
      mm2: 1e-6, cm2: 1e-4, m2: 1, ha: 1e4, km2: 1e6,
      in2: 0.00064516, ft2: 0.09290304, yd2: 0.83612736,
      acre: 4046.8564224, mi2: 2589988.110336,
    },
    aliases: { sqm: 'm2', sqkm: 'km2', sqft: 'ft2', sqin: 'in2' },
  },
};

/** A unit family's table plus the specific unit this entry targets. */
interface UnitEntryData extends UnitDef {
  /** The unit this command converts INTO — what makes each entry differ. */
  unit: string;
}

export const unitFamilies: FamilySpec<UnitEntryData>[] = Object.entries(UNITS).map(([id, def]) => ({
  id: `unit-${id}`,
  title: `${def.kind} conversion`,
  entries: Object.keys(def.members).map((unit) => ({
    name: `to-${unit.replace(/[^a-z0-9]/gi, '').toLowerCase()}`,
    summary: `Convert any ${def.kind} into ${unit}`,
    data: { ...def, unit },
  })),
  build: async (entry, ctx) => {
    const { members, unit, kind, aliases } = entry.data;
    const m = /^(-?[\d.]+)\s*([a-zA-Z²³/]+)\s+(?:to|in|as|>)\s+([a-zA-Z²³/]+)$/i.exec(ctx.args.trim());
    if (!m) {
      return { error: `Usage: <value> <from> to ${unit}\nKnown ${kind} units: ${Object.keys(members).join(', ')}` };
    }
    const rawFrom = m[2] ?? '';
    const rawTo = m[3] ?? '';
    const from = aliases[rawFrom.toLowerCase()] ?? rawFrom;
    const factor = members[from];
    if (factor === undefined) {
      return { error: `Unknown unit "${rawFrom}". Try one of: ${Object.keys(members).join(', ')}` };
    }
    const value = Number.parseFloat(m[1] ?? '');
    if (!Number.isFinite(value)) return { error: `"${m[1]}" is not a number` };

    const offsets = entry.data.offsets ?? {};
    const inBase = value * factor + (offsets[from] ?? 0);
    const out = (inBase - (offsets[unit] ?? 0)) / members[unit]!;
    // Significant-figure control: floating point on a 1e15 factor produces
    // 13-digit noise, which reads like a wrong answer.
    const rounded = Math.abs(out) >= 1e6 || (Math.abs(out) < 1e-4 && out !== 0)
      ? out.toExponential(6)
      : Number.parseFloat(out.toPrecision(10)).toString();
    return { text: `${value} ${from} = ${rounded} ${unit}` };
  },
}));


/**
 * The natural-language form: `flux convert 5 kg to lb`.
 *
 * ## Why this exists alongside the `to-<unit>` family
 *
 * The generated commands are named `to-lb`, `to-kg`, `to-yd`. Those are good
 * names for a menu — you can list them and they sort — but nobody types
 * "to-lb". People type "convert", so without this command the entire unit
 * surface is unreachable by the query a human would actually write, and a typo
 * like `convertt` matches nothing at all.
 *
 * So this is one command that dispatches over the same unit tables, rather than
 * 93 aliases nobody would guess either.
 */
const convertFamily: FamilySpec<null> = {
  id: 'convert',
  title: 'unit conversion, natural form',
  entries: [
    { name: 'convert', summary: 'Convert a value between units, e.g. convert 5 kg to lb', data: null },
  ],
  build: async (_entry, ctx) => {
    const m = /^\s*(-?[\d.,]+)\s*([a-zA-Z]+)\s+(?:to|in|as|into|>)\s+([a-zA-Z]+)\s*$/i
      .exec(ctx.args);
    if (!m) {
      const kinds = [...new Set(Object.values(UNITS).map((u) => u.kind))].join(', ');
      return { text: `Usage: convert <value> <from> to <to>\nExamples:\n  convert 5 kg to lb\n  convert 100 C to F\n  convert 2.5 m to ft\nKinds: ${kinds}` };
    }
    const rawValue = (m[1] ?? '').replace(/,/g, '');
    const rawFrom = m[2] ?? '';
    const rawTo = m[3] ?? '';
    const value = Number.parseFloat(rawValue);
    if (!Number.isFinite(value)) return { error: `"${rawValue}" is not a number` };

    for (const def of Object.values(UNITS)) {
      const from = def.aliases[rawFrom.toLowerCase()] ?? rawFrom;
      const to = def.aliases[rawTo.toLowerCase()] ?? rawTo;
      if (def.members[from] === undefined || def.members[to] === undefined) continue;

      const offsets = def.offsets ?? {};
      const inBase = value * def.members[from]! + (offsets[from] ?? 0);
      const out = (inBase - (offsets[to] ?? 0)) / def.members[to]!;
      const shown = Math.abs(out) >= 1e6 || (Math.abs(out) < 1e-4 && out !== 0)
        ? out.toExponential(6)
        : Number.parseFloat(out.toPrecision(10)).toString();
      return { text: `${rawValue} ${rawFrom} = ${shown} ${rawTo}` };
    }

    return {
      error: `Don't know how to convert "${rawFrom}" to "${rawTo}". `
        + `Both must be from the same kind, e.g. kg/lb or C/F — not kg/C.`,
    };
  },
};

/* ── maths: an expression evaluator, not a pattern table ──────────────── */

const MATH_CONSTS: Record<string, number> = {
  pi: Math.PI, e: Math.E, phi: 1.618033988749895, tau: Math.PI * 2,
};

/**
 * A shunting-yard evaluator.
 *
 * A real parser rather than a switch over "known expressions", because the
 * space of expressions is unbounded and a table of them is not a feature.
 */
function evaluate(expr: string): number {
  const src = expr.replace(/\s+/g, '').replace(/\^/g, '**');
  if (!/^[\d.+\-*/()a-z*]+$/i.test(src)) throw new Error('unsupported characters');

  // `**` must precede the single-character operator class in this alternation,
  // or `pi^2` tokenises as two `*` tokens and the evaluator reports "malformed".
  // Found by running it, not by reading it — the regex looked correct.
  const tokens = src.match(/(\d+\.?\d*|\.\d+|\*\*|[a-z]+|[+\-*/()])/gi) ?? [];
  const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '**': 3, 'u': 3 };
  const NEG = '~';               // prefix-minus marker, reduced as a unary negate
  const output: string[] = [];
  const stack: string[] = [];
  /** True when the previous token cannot end an operand, so `-` is unary. */
  let expectOperand = true;

  for (const t of tokens) {
    if (/^\d/.test(t) || /^\.\d/.test(t)) { output.push(t); expectOperand = false; continue; }
    if (/^[a-z]+$/i.test(t)) {
      const key = t.toLowerCase();
      if (key in MATH_CONSTS) { output.push(String(MATH_CONSTS[key])); expectOperand = false; continue; }
      if (key === 'sqrt') { stack.push('u'); expectOperand = true; continue; }
      throw new Error(`unknown name "${t}"`);
    }
    if (t === '(') { stack.push(t); expectOperand = true; continue; }
    if (t === ')') {
      while (stack.length && stack[stack.length - 1] !== '(') output.push(stack.pop()!);
      if (!stack.pop()) throw new Error('unbalanced parentheses');
      // A prefix operator stays pending until its operand is consumed, so pop
      // any immediately, but only one: `- -1` is two negations, not one.
      if (stack[stack.length - 1] === NEG) output.push(stack.pop()!);
      expectOperand = false;
      continue;
    }

    // Unary minus only in operand position. Rewriting it as `(0-x)` in the
    // source was tried first and broke precedence: `2*-3` becomes `2*0-3`,
    // which is -3 rather than -6.
    if (t === '-' && expectOperand) {
      stack.push(NEG);
      continue;
    }

    const p = prec[t] ?? prec['u'];
    if (p === undefined) throw new Error(`unknown operator "${t}"`);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      if (top === '(') break;
      if ((prec[top] ?? 0) < p) break;
      output.push(stack.pop()!);
    }
    stack.push(t);
    expectOperand = true;
  }
  while (stack.length) {
    const top = stack.pop()!;
    if (top === '(') throw new Error('unbalanced parentheses');
    output.push(top);
  }

  const vals: number[] = [];
  for (const t of output) {
    if (/^\d/.test(t) || /^\.\d/.test(t)) { vals.push(Number.parseFloat(t)); continue; }
    if (t === NEG) {
      const a = vals.pop();
      if (a === undefined) throw new Error('malformed expression');
      vals.push(-a);
      continue;
    }
    if (t === 'u') {
      const a = vals.pop();
      if (a === undefined || a < 0) throw new Error('sqrt of a negative or missing value');
      vals.push(Math.sqrt(a));
      continue;
    }
    const b = vals.pop();
    const a = vals.pop();
    if (a === undefined || b === undefined) throw new Error('malformed expression');
    switch (t) {
      case '+': vals.push(a + b); break;
      case '-': vals.push(a - b); break;
      case '*': vals.push(a * b); break;
      case '/':
        if (b === 0) throw new Error('division by zero');
        vals.push(a / b); break;
      case '**': vals.push(a ** b); break;
      default: throw new Error(`unknown operator "${t}"`);
    }
  }
  const only = vals[0];
  if (vals.length !== 1 || only === undefined || !Number.isFinite(only)) {
    throw new Error('not a finite result');
  }
  return only;
}

export const mathFamily: FamilySpec<null> = {
  id: 'math',
  title: 'expression evaluation',
  entries: [
    // One entry only. `math` is registered as an alias below. Two names carrying
    // identical data is one command wearing two hats, and the registry's
    // duplicate-data check rejects it at registration rather than shipping it.
    { name: 'calc', summary: 'Evaluate an arithmetic expression', data: null },
  ],
  build: async (_entry, ctx) => {
    if (!ctx.args.trim()) {
      return { text: 'Usage: calc <expression>\nSupports + - * / ^ ** sqrt(), and pi, e, phi, tau.\nExample: calc sqrt(16)*2 + pi' };
    }
    try {
      const v = evaluate(ctx.args);
      const shown = Number.isInteger(v) ? String(v) : String(Number.parseFloat(v.toPrecision(12)));
      return { text: `${ctx.args.trim()} = ${shown}` };
    } catch (err) {
      return { error: `calc: ${(err as Error).message}` };
    }
  },
};

/* ── install ──────────────────────────────────────────────────────────── */

export function installCoreFamilies(reg: CommandRegistry): CommandRegistry {
  for (const f of unitFamilies) reg.family(f);
  reg.family(convertFamily);
  reg.family(mathFamily);
  reg.alias('math', 'calc');
  return reg;
}