import { proto } from '@whiskeysockets/baileys';

import { createFormFlow, createTableFlow, radioRow, infoRow } from '../core/nodes.js';

/**
 * Formatting helpers.
 *
 * WhatsApp's own text dialect: `*bold*`, `_italic_`, `~strike~`, ````code````.
 * These build the protocol messages, not styled text — the client renders it.
 * Inline code and pre are deliberately preserved because code inside a list is
 * one of the main reasons a bot's output looks wrong.
 */

/** Fixed-width escape so monospace survives the client's layout. */
const pre = (s: string): string => `\`\`\`${s}\`\`\``;

const bold = (s: string): string => `*${s}*`;
const italic = (s: string): string => `_${s}_`;
const strike = (s: string): string => `~${s}~`;
const mono = (s: string): string => `\`${s}\``;

/** Plain paragraph + optional sections. */
export interface ComposeOptions {
  sections?: Array<{ title: string; rows: string[] }>;
  list?: { title: string; items: string[] };
  footer?: string;
  /** Thumbnail url for a preview. */
  thumbnail?: string;
}

export function compose(options: ComposeOptions): string {
  const out: string[] = [];

  if (options.list) {
    out.push(bold(options.list.title));
    out.push('');
    options.list.items.forEach((item, i) => out.push(`${mono(`${i + 1}.`)} ${item}`));
  }

  for (const section of options.sections ?? []) {
    if (out.length) out.push('');
    out.push(bold(section.title));
    for (const row of section.rows) out.push(`• ${row}`);
  }

  if (options.footer) {
    if (out.length) out.push('');
    out.push(`_${options.footer}_`);
  }

  return out.join('\n');
}

/** Inline-code callout. */
export function code(text: string, lang = ''): string {
  return pre(lang ? `${lang}\n${text}` : text);
}

/** Fenced block that preserves blank lines — the usual way text gets mangled. */
export function preformatted(text: string): string {
  return pre(text);
}

/** Monospace table. Markdown tables render as literal pipes in WA. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))),
  );

  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => pad(cell ?? '', widths[i]!))
      .join('  ')
      .trimEnd();

  const rule = widths.map((w) => '─'.repeat(w)).join('  ');

  return [line(headers), rule, ...rows.map(line)].join('\n');
}

/** Width accounting for CJK and emoji, which occupy two terminal columns. */
function displayWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff);
    width += wide ? 2 : 1;
  }
  return width;
}

function pad(s: string, width: number): string {
  const gap = width - displayWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

export interface FormSpec {
  title: string;
  body?: string;
  sections: Array<{
    title?: string;
    rows: Array<{ title: string; description?: string; id: string }>;
  }>;
}

/** A form native flow, from a spec object. */
export function formFlow(spec: FormSpec) {
  return createFormFlow({
    title: spec.title,
    body: spec.body,
    sections: spec.sections.map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => radioRow(r.title, r.id, r.description)),
    })),
  });
}

/** A read-only data sheet. */
export function tableFlow(title: string, columns: string[], rows: string[][]) {
  return createTableFlow({ title, columns, rows });
}

export { infoRow, radioRow, proto, bold, italic, strike, mono };
