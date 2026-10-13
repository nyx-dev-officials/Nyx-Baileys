/**
 * The feature menu — a native `single_select` menu whose rows are the
 * interactive button types this library can actually send.
 *
 * ## The point of this file: the menu cannot lie
 *
 * A menu that offers Call / URL / Quick Reply / Copy is making a promise. If the
 * library has no sender for one of those rows, the promise is false — and the
 * failure is silent, because the row renders perfectly and the tap arrives at a
 * handler with nothing to call.
 *
 * So the rows are not written here. They are **derived**, by intersecting two
 * registries:
 *
 *   1. `NATIVE_FLOW_NAMES` — the flows WhatsApp accepts on a `native_flow` node,
 *      exported by the interactive plugin (`src/plugins/interactive.ts`).
 *   2. `FLOW_SENDERS` — which of those flows this library can actually send, and
 *      the exported sender function(s) that do it.
 *
 * A flow appears in the menu only if it is in both, and only if it also has a
 * human label in `FEATURE_LABELS`. Add a sender and a label and the row appears;
 * remove one and it disappears. There is no third list to forget to update.
 *
 * `payment` and `location_request` are the worked example: the plugin declares
 * them, WhatsApp renders them, and this library has **no sender** for either —
 * `sendPaymentRequest` emits a `requestPaymentMessage`, which is a different
 * message type, not the `payment` native flow. They are reported by
 * `unsendableFlows()` and can never reach the menu. A `Location Request` row was
 * briefly shipped here and was exactly the bug this design removes.
 *
 * `sendableFeatures()` is the only source the builders read, and
 * `resolveFeatureId()` re-checks capability on every row it is handed — so even a
 * caller-supplied feature list cannot smuggle in a button nothing can send.
 *
 * ## Delivery
 *
 * `sendFeatureMenu()` hands off to `sendCategoryMenu()`, the library's single
 * menu encoder — one place that gets the `id`-vs-`rowId` shape right. Nothing
 * here re-implements the wire format.
 *
 * The row `id` is a routing key, not display text. It comes back verbatim in
 * `readMenuSelection()`, so it is never styled and never localised.
 */

import {
  NATIVE_FLOW_NAMES,
  isNativeFlowName,
  type NativeFlowName,
} from '../plugins/interactive.js';
import {
  type CategoryMenuOptions,
  type CategoryMenuResult,
  type MenuCategory,
  sendCategoryMenu,
} from './category-menu.js';

import type { CoreSocket } from '../utils/types.js';

/* ── registry 1: the flows WhatsApp renders ───────────────────────────── */

export { NATIVE_FLOW_NAMES, isNativeFlowName };
export type NativeFlow = NativeFlowName;

/* ── registry 2: what this library can send ───────────────────────────── */

/**
 * Every flow, mapped to the exported senders that can produce it.
 *
 * Values name real functions in this codebase. `tests/feature-menu.test.js`
 * imports each module and asserts every name resolves to a callable, so a rename
 * or a deletion fails the suite rather than silently emptying a menu row.
 *
 * An empty array is a statement, not a placeholder: nothing in the library sends
 * that flow. `payment` and `location_request` are empty for that reason.
 */
export const FLOW_SENDERS: Readonly<Record<NativeFlowName, readonly string[]>> = {
  quick_reply: ['sendButtons', 'sendTemplate'],
  single_select: ['sendList', 'sendCategoryMenu', 'sendFeatureMenu'],
  cta_url: ['sendTemplate', 'sendInteractive'],
  cta_call: ['sendTemplate'],
  cta_copy: ['sendInteractive'],
  payment: [],
  location_request: [],
};

/** One route back to a sender function, for the test that proves it exists. */
export interface SenderRef {
  /** Import path, relative to `dist/`, without an extension. */
  module: string;
  /** Exported function name. */
  name: string;
}

/**
 * The modules the `FLOW_SENDERS` names live in.
 *
 * Kept next to the registry so adding a sender is one edit, not two — the test
 * walks `FLOW_SENDERS` and looks each name up here.
 */
export const SENDER_MODULES: Readonly<Record<string, string>> = {
  sendButtons: 'features/messaging',
  sendTemplate: 'features/messaging',
  sendList: 'features/messaging',
  sendInteractive: 'features/messaging',
  sendCategoryMenu: 'toolkit/category-menu',
  sendFeatureMenu: 'toolkit/feature-menu',
};

/** Resolve a sender name to its module, or `null` when it is unknown. */
export function senderRef(name: string): SenderRef | null {
  const module = SENDER_MODULES[name];
  return module ? { module, name } : null;
}

/** True when the library ships at least one sender for this flow. */
export function canSend(flow: NativeFlowName): boolean {
  return FLOW_SENDERS[flow].length > 0;
}

/** Flows WhatsApp renders that this library cannot send. Never advertised. */
export function unsendableFlows(): NativeFlowName[] {
  return NATIVE_FLOW_NAMES.filter((flow) => !canSend(flow));
}

/* ── the menu rows, derived ───────────────────────────────────────────── */

/** Human-facing copy for a flow. A flow without a label is not a menu row. */
export interface FeatureLabel {
  id: string;
  title: string;
  description: string;
  /**
   * Display order in the menu. Lower first.
   *
   * Explicit because the plugin's declaration order is a wire-protocol detail
   * (`single_select` sits second there), while the menu is read by a person.
   * Membership is derived; presentation is decided.
   */
  order: number;
}

/**
 * The label each sendable flow carries in the menu.
 *
 * Only the four the screenshot shows. Deliberately not a second capability list:
 * adding a label for an unsendable flow does nothing, because `sendableFeatures()`
 * intersects with `FLOW_SENDERS` first.
 */
export const FEATURE_LABELS: Readonly<Partial<Record<NativeFlowName, FeatureLabel>>> = {
  cta_call: { id: 'call_button', title: 'Call Button', description: 'Example: Call Button', order: 10 },
  cta_url: { id: 'url_button', title: 'URL Button', description: 'Example: URL Button', order: 20 },
  quick_reply: { id: 'quick_reply_button', title: 'Quick Reply Button', description: 'Example: Quick Reply Button', order: 30 },
  cta_copy: { id: 'copy_button', title: 'Copy Button', description: 'Example: Copy Button', order: 40 },
};

/**
 * Sendable flows that are deliberately not menu rows.
 *
 * `single_select` is the menu's own genre — a row offering to open a menu is
 * recursion, not a feature. Listed explicitly so `unlabelledSendableFlows()`
 * stays empty and a genuinely forgotten flow still trips the test.
 */
export const MENU_EXCLUDED_FLOWS: readonly NativeFlowName[] = ['single_select'];

/** One selectable feature. Carries the flows it is reachable by, not a copy. */
export interface FeatureEntry {
  /** Stable routing key echoed back on selection. Never styled. */
  id: string;
  /** Label shown in the menu. */
  title: string;
  /** Sub-label under the title. */
  description: string;
  /** The `native_flow` this row sends. */
  flow: NativeFlow;
  /** The exported senders that can send it. Never empty, by construction. */
  senders: readonly string[];
  /** Display order in the menu. Lower first. */
  order: number;
}

/**
 * The menu, derived.
 *
 * A flow qualifies when it is renderable, sendable, labelled and not excluded.
 * Everything else is reported by `unsendableFlows()` or `unlabelledSendableFlows()`
 * rather than silently dropped.
 */
export function sendableFeatures(): readonly FeatureEntry[] {
  const out: FeatureEntry[] = [];
  for (const flow of NATIVE_FLOW_NAMES) {
    if (!canSend(flow)) continue;
    if (MENU_EXCLUDED_FLOWS.includes(flow)) continue;
    const label = FEATURE_LABELS[flow];
    if (!label) continue;
    out.push({
      id: label.id,
      title: label.title,
      description: label.description,
      flow,
      senders: FLOW_SENDERS[flow],
      order: label.order,
    });
  }
  // Membership is derived from the registries; presentation order is decided.
  // Sorting here rather than at every call site is what keeps the four rows
  // reading Call → URL → Quick Reply → Copy, the way the reference menu does
  // (`refs/atex-ovi__wabase-button/src/handler.js`), instead of following the
  // plugin's declaration order where `single_select` sits second.
  return out.sort((a, b) => a.order - b.order);
}

/**
 * The derived menu. Computed once at load so consumers can compare identity.
 *
 * This is the historical five-row→four-row catalog from the README screenshot,
 * minus `Location Request`, which had no sender. See the file header.
 */
export const INTERACTIVE_FEATURES: readonly FeatureEntry[] = sendableFeatures();

/**
 * Sendable flows with no label — they would be missing rows, not exclusions.
 *
 * Expected to be empty. A non-empty result means a flow was wired up but nobody
 * decided how it should read in the menu, which is a defect the suite asserts
 * against rather than a state to ship.
 */
export function unlabelledSendableFlows(): NativeFlowName[] {
  return NATIVE_FLOW_NAMES.filter(
    (flow) => canSend(flow) && !FEATURE_LABELS[flow] && !MENU_EXCLUDED_FLOWS.includes(flow),
  );
}

/** The section heading the menu rows sit under. */
export const FEATURE_MENU_SECTION_TITLE = 'Available Features';

/** Look up a catalog entry by its routing key. */
export function featureById(id: string): FeatureEntry | null {
  return INTERACTIVE_FEATURES.find((f) => f.id === id) ?? null;
}

/**
 * Resolve a row id to a feature, refusing anything that is not sendable.
 *
 * The capability check here is what makes the guarantee hold for *callers* as
 * well as for the default list: a hand-built `FeatureEntry` naming an unsendable
 * flow is rejected at build time, not rendered and then dropped on tap.
 */
export function resolveFeatureId(id: string): FeatureEntry {
  const hit = featureById(id);
  if (!hit) throw new Error(`featureMenu: unknown row id "${id}"`);
  return hit;
}

/* ── the button a row actually sends ──────────────────────────────────── */

/**
 * Worked example params for each flow, one per feature.
 *
 * The shapes come from the reference implementation
 * (`refs/atex-ovi__wabase-button/src/features/*.js`) — the four files behind the
 * screenshot, and the only place these payloads were exercised against a phone.
 * The values are deliberately placeholders: a library must not ship someone
 * else's phone number or URL as if it were a default.
 *
 * This is also where the reference's own `handler.js` gets its structure: one
 * concrete sender per flow, reachable from a row id.
 */
const EXAMPLE_PARAMS: Readonly<Partial<Record<NativeFlow, Record<string, string>>>> = {
  cta_call: { display_text: 'Call the Owner', phone_number: '15551234567' },
  cta_url: {
    display_text: 'Visit the Docs',
    url: 'https://github.com',
    merchant_url: 'https://github.com',
  },
  quick_reply: { display_text: 'Send Quick Reply', id: 'quick_reply_demo' },
  cta_copy: { display_text: 'Copy the Link', copy_code: 'https://github.com' },
};

/** Build the `{ name, buttonParamsJson }` entry a feature's row sends. */
export function featureButton(
  id: string,
  params?: Record<string, string>,
): { name: NativeFlow; buttonParamsJson: string } {
  const feature = resolveFeatureId(id);
  const values = params ?? EXAMPLE_PARAMS[feature.flow] ?? { display_text: feature.title };
  return { name: feature.flow, buttonParamsJson: JSON.stringify(values) };
}

/**
 * Send one feature's example, the way the reference does it.
 *
 * ```ts
 * await sock.sendMessage(jid, { text, interactiveButtons: [featureButton(id)] })
 * ```
 *
 * That calling convention is the reference's
 * (`refs/atex-ovi__wabase-button/src/features/callButton.js`) and is supported
 * because `interactiveButtons` is a content key the interactive plugin now
 * handles — including naming the `native_flow` stanza after the button, which is
 * what makes a `cta_call` row render as a call button rather than nothing.
 */
export async function sendFeatureExample(
  sock: CoreSocket,
  jid: string,
  id: string,
  options: { params?: Record<string, string>; text?: string } = {},
): Promise<unknown> {
  const feature = resolveFeatureId(id);
  const message = {
    text: options.text ?? `Example: ${feature.title}`,
    footer: DEFAULTS.footer,
    interactiveButtons: [featureButton(id, options.params)],
  };
  return (sock as unknown as {
    sendMessage: (jid: string, content: unknown) => Promise<unknown>;
  }).sendMessage(jid, message);
}

/** Build the menu row object for a feature — the feature's own fields. */
export function featureRow(f: FeatureEntry): {
  rowId: string;
  title: string;
  description?: string;
} {
  return {
    rowId: f.id,
    title: f.title,
    ...(f.description ? { description: f.description } : {}),
  };
}

/* ── builders ─────────────────────────────────────────────────────────── */

export interface FeatureMenuOptions {
  /** Text above the menu button. */
  text?: string;
  /** Menu button label. */
  buttonTitle?: string;
  /** Header title. */
  title?: string;
  /** Footer line. */
  footer?: string;
  /** Section heading. Defaults to `Available Features`. */
  sectionTitle?: string;
  /**
   * Use this list instead of `INTERACTIVE_FEATURES`.
   *
   * Still capability-checked: an entry whose flow has no sender is refused, so
   * overriding the list cannot advertise a button nothing can send.
   */
  features?: readonly FeatureEntry[];
}

const DEFAULTS = {
  text: 'Hello! Choose an option from the menu below:',
  buttonTitle: 'Menu',
  title: 'Menu',
  footer: '© Nyx-Baileys — MIT License',
} as const;

function resolveFeatures(options: FeatureMenuOptions): readonly FeatureEntry[] {
  const features = options.features ?? INTERACTIVE_FEATURES;
  if (features.length === 0) {
    throw new Error('featureMenu needs at least one feature');
  }
  for (const feature of features) {
    if (!isNativeFlowName(feature.flow)) {
      throw new Error(`featureMenu: "${feature.flow}" is not a native flow WhatsApp renders`);
    }
    if (!canSend(feature.flow)) {
      throw new Error(
        `featureMenu: "${feature.flow}" has no sender in this library, ` +
          `so the menu cannot offer it (see FLOW_SENDERS)`,
      );
    }
    if (!feature.title.trim()) {
      throw new Error(`featureMenu: "${feature.id}" has no title`);
    }
  }
  return features;
}

/**
 * Build the menu as a `ListParams`-compatible object.
 *
 * Returned rather than sent so callers can pass it straight to `sendList()`
 * (which applies a `featureFont` and styles labels while leaving the ids
 * verbatim), or inspect it in a test.
 */
export function featureMenu(options: FeatureMenuOptions = {}): {
  title: string;
  text: string;
  buttonText: string;
  footer: string;
  sections: Array<{
    title: string;
    rows: Array<{ rowId: string; title: string; description?: string }>;
  }>;
} {
  const features = resolveFeatures(options);
  return {
    title: options.title ?? DEFAULTS.title,
    text: options.text ?? DEFAULTS.text,
    buttonText: options.buttonTitle ?? DEFAULTS.buttonTitle,
    footer: options.footer ?? DEFAULTS.footer,
    sections: [
      {
        title: options.sectionTitle ?? FEATURE_MENU_SECTION_TITLE,
        rows: features.map((f) => featureRow(f)),
      },
    ],
  };
}

/** The same menu in the `CategoryMenu` shape `sendCategoryMenu` consumes. */
export function featureMenuCategories(options: FeatureMenuOptions = {}): MenuCategory[] {
  const { sections } = featureMenu(options);
  return sections.map((section) => ({
    title: section.title,
    rows: section.rows.map((row) => {
      const feature = resolveFeatureId(row.rowId);
      return {
        id: row.rowId,
        title: row.title,
        ...(row.description !== undefined ? { description: row.description } : {}),
      };
    }),
  }));
}

/**
 * Render the menu as a numbered plaintext message.
 *
 * The fallback for clients (and accounts) that do not render native flow: every
 * feature stays reachable, numbered across the section so "reply 3" is
 * unambiguous. Mirrors `formatListAsText`'s dialect — bold headings, plain box
 * drawing — without importing the plugin.
 */
export function featureMenuText(options: FeatureMenuOptions = {}): string {
  const menu = featureMenu(options);
  const lines: string[] = [`*┌── [ ${menu.title.toUpperCase()} ]*`, `│ ${menu.text}`];

  let n = 0;
  for (const section of menu.sections) {
    lines.push(`├─ *${section.title.toUpperCase()}*`);
    for (const row of section.rows) {
      n += 1;
      lines.push(`│  [${n}] *${row.title}*`);
      if (row.description) lines.push(`│      └─ ${row.description}`);
    }
    lines.push('│');
  }

  lines.push(`│ ${menu.footer}`);
  lines.push('*└── Reply with a number to select*');
  return lines.join('\n');
}

/**
 * Send the feature menu.
 *
 * Delegates to `sendCategoryMenu` — the one encoder that gets the opaque
 * `single_select` schema right — so there is a single menu implementation to keep
 * correct. Returns the selectable ids, so a caller can match a reply with
 * `resolveFeatureMenuSelection()`.
 */
export async function sendFeatureMenu(
  sock: CoreSocket,
  jid: string,
  options: FeatureMenuOptions = {},
): Promise<CategoryMenuResult> {
  const menu = featureMenu(options);
  const menuOptions: CategoryMenuOptions = {
    body: menu.text,
    footer: menu.footer,
    buttonTitle: menu.buttonText,
  };
  return sendCategoryMenu(sock, jid, featureMenuCategories(options), menuOptions);
}

/**
 * Map a selection id back to its catalog entry, or `null`.
 *
 * `readMenuSelection()` returns a raw id; this is the one call that turns it into
 * the feature the user picked.
 */
export function resolveFeatureMenuSelection(id: string | null): FeatureEntry | null {
  return id ? featureById(id) : null;
}
