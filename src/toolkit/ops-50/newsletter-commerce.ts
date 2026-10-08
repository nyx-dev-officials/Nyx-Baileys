/**
 * OPS-50 · module 3 of 6 — newsletters and commerce.
 *
 * **Signatures verified against rc14 `business.d.ts` — do not guess these:**
 * - `newsletterCreate(name, description?)` — two args, no picture.
 * - `newsletterUpdate(jid, NewsletterUpdate)` — the single update entry point.
 * - `newsletterMetadata('invite' | 'jid', key)`.
 * - `newsletterUpdatePicture(jid, WAMediaUpload)`.
 * - `productCreate(ProductCreate)`, `productUpdate(id, ProductUpdate)`,
 *   `productDelete(ids: string[])` — **none take a jid**; identity comes from creds.
 * - `getCatalog(jid, count?)`, `getCollections(jid)`, `getOrderDetails(jid, orderJid?)`.
 *
 * **Every function here is `unverified` on hardware.** Newsletter and commerce
 * surfaces are gated on account type. A call may return cleanly and still be
 * rejected. Nothing in this file has run against a real newsletter or shop.
 */

import type { AnySock } from './types.js';

/** Newsletter jids end in `@newsletter`. */
export function isNewsletterJid(jid: string): boolean {
  return jid.endsWith('@newsletter');
}

/* ── 41-45 · newsletter lifecycle ─────────────────────────────────── */

/** Create a newsletter. Returns metadata carrying the new jid. */
export function createNewsletter(
  sock: AnySock,
  name: string,
  description = '',
): Promise<unknown> {
  return sock.newsletterCreate(name, description);
}

/** Delete a newsletter. Irreversible. */
export function deleteNewsletter(sock: AnySock, jid: string): Promise<unknown> {
  return sock.newsletterDelete(jid);
}

/** Fetch newsletter metadata by jid. */
export function newsletterInfo(sock: AnySock, jid: string): Promise<unknown> {
  return sock.newsletterMetadata('jid', jid);
}

/** Fetch newsletter metadata by invite code. */
export function newsletterInfoByInvite(sock: AnySock, invite: string): Promise<unknown> {
  return sock.newsletterMetadata('invite', invite);
}

/**
 * Apply a metadata patch.
 *
 * rc14 has one `newsletterUpdate` verb taking a `NewsletterUpdate` object —
 * there is no separate `newsletterUpdateName`/`UpdateDescription` at this layer.
 */
export function updateNewsletter(sock: AnySock, jid: string, updates: Record<string, unknown>): Promise<unknown> {
  return sock.newsletterUpdate(jid, updates);
}

/** Rename a newsletter. */
export function renameNewsletter(sock: AnySock, jid: string, name: string): Promise<unknown> {
  return sock.newsletterUpdate(jid, { name });
}

/** Set a newsletter's description. */
export function describeNewsletter(
  sock: AnySock,
  jid: string,
  description: string,
): Promise<unknown> {
  return sock.newsletterUpdate(jid, { description });
}

/* ── 46-47 · pictures and subscription ────────────────────────────── */

/** Set a newsletter picture. Pass a real `WAMediaUpload`, not a bare buffer. */
export function setNewsletterPicture(sock: AnySock, jid: string, upload: unknown): Promise<unknown> {
  return sock.newsletterUpdatePicture(jid, upload);
}

/** Remove a newsletter picture. */
export function clearNewsletterPicture(sock: AnySock, jid: string): Promise<unknown> {
  return sock.newsletterRemovePicture(jid);
}

/** Follow a newsletter. */
export function followNewsletter(sock: AnySock, jid: string): Promise<unknown> {
  return sock.newsletterFollow(jid);
}

/** Unfollow a newsletter. */
export function unfollowNewsletter(sock: AnySock, jid: string): Promise<unknown> {
  return sock.newsletterUnfollow(jid);
}

/** Mute a newsletter. */
export function muteNewsletter(sock: AnySock, jid: string): Promise<unknown> {
  return sock.newsletterMute(jid);
}

/** Unmute a newsletter. */
export function unmuteNewsletter(sock: AnySock, jid: string): Promise<unknown> {
  return sock.newsletterUnmute(jid);
}

/* ── 48-50 · commerce ─────────────────────────────────────────────── */

/** Read the account's business profile. Sparse for a consumer account. */
export function businessProfile(sock: AnySock): Promise<unknown> {
  return sock.getBusinessProfile(sock.user?.id);
}

/** Fetch a shop's catalog page. */
export function shopCatalog(sock: AnySock, jid: string, count = 24): Promise<unknown> {
  return sock.getCatalog(jid, count);
}

/** Fetch product collections. */
export function shopCollections(sock: AnySock, jid: string): Promise<unknown> {
  return sock.getCollections(jid);
}

/**
 * Create, update, or delete products.
 *
 * None of these take a jid — product ownership comes from the account's own
 * creds, so this is a shop-owner operation and will fail on a consumer account.
 */
export async function productWrite(
  sock: AnySock,
  action: 'create' | 'update' | 'delete',
  payload: unknown,
  productId?: string,
): Promise<unknown> {
  switch (action) {
    case 'create':
      return sock.productCreate(payload as never);
    case 'update':
      if (!productId) throw new Error('productWrite update needs a productId');
      return sock.productUpdate(productId, payload as never);
    case 'delete':
      if (!productId) throw new Error('productWrite delete needs a productId');
      return sock.productDelete([productId]);
    default:
      throw new Error(`unknown product action: ${action}`);
  }
}

/** Fetch one order's details. */
export function orderDetails(sock: AnySock, orderJid: string, jid?: string): Promise<unknown> {
  return sock.getOrderDetails(jid ?? sock.user?.id, orderJid);
}