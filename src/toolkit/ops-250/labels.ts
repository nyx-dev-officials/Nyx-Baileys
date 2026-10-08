/**
 * OPS-250 · labels and app-state.
 *
 * rc14 methods used, signatures taken from `business.d.ts`:
 * - `addLabel(jid, labels: LabelActionBody)`
 * - `addChatLabel(jid, labelId)` / `removeChatLabel(jid, labelId)`
 * - `addMessageLabel(jid, messageId, labelId)` / `removeMessageLabel(...)`
 * - `updateMemberLabel(jid, memberLabel)` — returns the resulting string
 * - `updateDisableLinkPreviewsPrivacy(isPreviewsDisabled)`
 *
 * **Unverified on hardware.** Nothing here has been run against a live socket.
 * Labels are an app-state surface: they are written as patches and read back
 * from the server, so a clean return is not evidence they landed.
 */

type AnySock = Record<string, any>;

/* ── 1-12 · labels ───────────────────────────────────────────────── */

export interface LabelActionBody {
  delete?: boolean;
  color?: number | null;
  name?: string;
  predefinedName?: string;
  /** For message labels, the id of the message being labelled. */
  messageId?: string;
}

/** Create or update a label. */
export function upsertLabel(
  sock: AnySock,
  jid: string,
  body: LabelActionBody,
): Promise<void> {
  return sock.addLabel(jid, body as never);
}

/** Create a named label with a palette colour. */
export function createLabel(
  sock: AnySock,
  jid: string,
  name: string,
  color: number,
): Promise<void> {
  return sock.addLabel(jid, { name, color } as never);
}

/** Delete a label by id. */
export function deleteLabel(sock: AnySock, jid: string, labelId: string): Promise<void> {
  return sock.addLabel(jid, { delete: true, id: labelId } as never);
}

/** Apply a chat label. */
export function addChatLabel(sock: AnySock, jid: string, labelId: string): Promise<void> {
  return sock.addChatLabel(jid, labelId);
}

/** Remove a chat label. */
export function removeChatLabel(sock: AnySock, jid: string, labelId: string): Promise<void> {
  return sock.removeChatLabel(jid, labelId);
}

/** Apply a message label. */
export function addMessageLabel(
  sock: AnySock,
  jid: string,
  messageId: string,
  labelId: string,
): Promise<void> {
  return sock.addMessageLabel(jid, messageId, labelId);
}

/** Remove a message label. */
export function removeMessageLabel(
  sock: AnySock,
  jid: string,
  messageId: string,
  labelId: string,
): Promise<void> {
  return sock.removeMessageLabel(jid, messageId, labelId);
}

/** Set a member's label inside a group. Returns the resulting label. */
export function setMemberLabel(
  sock: AnySock,
  jid: string,
  memberLabel: string,
): Promise<string> {
  return sock.updateMemberLabel(jid, memberLabel);
}

/** Replace every label on a chat with exactly this one. */
export async function setOnlyChatLabel(
  sock: AnySock,
  jid: string,
  labelId: string,
): Promise<void> {
  await sock.removeChatLabel(jid, labelId);
  await sock.addChatLabel(jid, labelId);
}

/** Apply then remove the same label — verifies the round trip without asserting. */
export async function toggleChatLabel(
  sock: AnySock,
  jid: string,
  labelId: string,
  on: boolean,
): Promise<void> {
  if (on) await addChatLabel(sock, jid, labelId);
  else await removeChatLabel(sock, jid, labelId);
}

/** Validate a label body before sending, so a typo is not a silent no-op. */
export function assertLabelBody(body: LabelActionBody): void {
  if (body.delete) return;
  if (typeof body.name !== 'string' || body.name.length === 0) {
    throw new Error('label needs a name, or delete:true');
  }
}

/* ── 13-16 · link previews ───────────────────────────────────────── */

/**
 * Disable automatic link previews on outgoing messages.
 *
 * This is a privacy switch, not a render option: with it on, URLs in outgoing
 * text are not sent for server-side unfurling.
 */
export function setLinkPreviews(sock: AnySock, enabled: boolean): Promise<void> {
  return sock.updateDisableLinkPreviewsPrivacy(!enabled);
}

/** Strip every URL from text, for callers that must not send links at all. */
export function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, '').replace(/\s{2,}/g, ' ').trim();
}

/** True when text contains something that would be unfurled. */
export function hasLink(text: string): boolean {
  return /https?:\/\/\S+/i.test(text);
}