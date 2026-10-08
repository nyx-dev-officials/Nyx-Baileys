// src/upgrade/security.ts
/**
 * Token signing and verification on Node built-ins.
 *
 * ## What was wrong, and why it mattered
 *
 * The previous implementation called
 * `crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))` without a
 * length guard. **`timingSafeEqual` throws when the two buffers differ in
 * length.** Every attacker can trigger it by sending a token whose signature is
 * the wrong size — so a malformed token took down the caller rather than being
 * rejected. A verifier whose failure mode is "crashes the process" is not a
 * verifier.
 *
 * Two more corrections, both from the same class of mistake:
 *
 * - The `alg` header was written but **never read**. A token asserting
 *   `alg: none` signed with an empty key was accepted on a string compare.
 * - `JSON.parse` ran on the payload **after** the signature check with no try
 *   around it, so a validly-signed but non-JSON body threw.
 *
 * ## Constant-time comparison, properly
 *
 * `safeEqual` hashes both sides to a fixed 32 bytes before comparing, so length
 * can never be an input to `timingSafeEqual`. Comparing hashes rather than raw
 * bytes keeps the timing property while removing the throw.
 */

import * as crypto from 'node:crypto';

/** Maximum accepted token length. Rejects the memory-CPU burn of a huge body. */
const MAX_TOKEN_LENGTH = 8192;

/**
 * Compare two strings without leaking their contents through timing.
 *
 * Both sides are SHA-256'd first. That fixes the length problem *and* means the
 * comparison is over a constant-size value regardless of input size, so neither
 * the length nor the content of a candidate signature is observable.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** base64url encode a JSON value. */
function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** base64url decode to JSON, or null. Never throws. */
function decode(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export interface SignOptions {
  /** Lifetime in seconds. Omit for a token that does not expire. */
  expiresInSec?: number;
}

/**
 * Sign a payload as a compact JWS with HS256.
 *
 * The `alg` header is fixed to HS256 and written into the token, and
 * `verifyToken` checks it. A caller cannot pass an algorithm — there is exactly
 * one, which is what makes "alg confusion" impossible rather than merely guarded.
 */
export function signToken(payload: object, secret: string, options: SignOptions = {}): string {
  if (!secret) throw new Error('signToken requires a secret');

  const header = encode({ alg: 'HS256', typ: 'JWT' });

  const claims: Record<string, unknown> = { ...payload };
  if (options.expiresInSec !== undefined) {
    claims['exp'] = Math.floor(Date.now() / 1000) + options.expiresInSec;
  }

  const body = encode(claims);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`, 'utf8')
    .digest('base64url');

  return `${header}.${body}.${signature}`;
}

export interface VerifyOptions {
  /** Enforce `exp` when present. Default true. */
  checkExpiry?: boolean;
  /** Clock skew allowance in seconds. Default 0. */
  leewaySec?: number;
}

/**
 * Verify a token, or return null.
 *
 * Every failure path returns `null` — malformed base64, wrong shape, wrong
 * algorithm, bad signature, expired, non-JSON body. **Nothing here throws**, so
 * a caller cannot be crashed with a crafted token.
 */
export function verifyToken(
  token: string,
  secret: string,
  options: VerifyOptions = {},
): Record<string, unknown> | null {
  if (!token || typeof token !== 'string') return null;
  if (token.length > MAX_TOKEN_LENGTH) return null;
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts as [string, string, string];

  // The header is parsed *before* the signature and its alg is checked, because
  // `alg: none` is the classic bypass: skip verification and trust the body.
  const decodedHeader = decode(header) as { alg?: string } | null;
  if (!decodedHeader || decodedHeader.alg !== 'HS256') return null;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`, 'utf8')
    .digest('base64url');

  if (!safeEqual(signature, expected)) return null;

  const claims = decode(body) as Record<string, unknown> | null;
  if (!claims || typeof claims !== 'object') return null;

  if (options.checkExpiry !== false && typeof claims['exp'] === 'number') {
    const now = Math.floor(Date.now() / 1000);
    if (now > claims['exp'] + (options.leewaySec ?? 0)) return null;
  }

  return claims;
}

/** Read the claims without verifying. For diagnostics only — never for auth. */
export function peekToken(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  return decode(parts[1] as string) as Record<string, unknown> | null;
}

/** Is this token past its expiry? Does not verify the signature. */
export function isExpired(token: string, leewaySec = 0): boolean {
  const claims = peekToken(token);
  if (!claims || typeof claims['exp'] !== 'number') return false;
  return Math.floor(Date.now() / 1000) > claims['exp'] + leewaySec;
}

/** How long until expiry, in seconds. Negative when already expired. */
export function secondsUntilExpiry(token: string): number | null {
  const claims = peekToken(token);
  if (!claims || typeof claims['exp'] !== 'number') return null;
  return claims['exp'] - Math.floor(Date.now() / 1000);
}

/** Constant-time compare for any secret, not just tokens. */
export function safeCompare(a: string, b: string): boolean {
  return safeEqual(a, b);
}