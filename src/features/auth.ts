/**
 * @file auth.ts
 * @description Comprehensive authentication, authorisation, and cryptography
 * utilities for the Nyx-Baileys project. Covers JWT-style tokens, sessions,
 * API keys, rate limiting, audit logging, RBAC, AES-256-GCM encryption,
 * PBKDF2 hashing, TOTP/HOTP OTP generation, and more.
 *
 * Dependencies: node:crypto, node:fs, node:path — ZERO external packages.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  pbkdf2Sync,
  privateDecrypt,
  privateEncrypt,
  publicEncrypt,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface JWTPayload {
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  [key: string]: unknown;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface Session {
  id: string;
  userId: string;
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface ApiKey {
  id: string;
  keyHash: string;
  prefix: string;
  userId: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

export interface AuditEvent {
  id: string;
  timestamp: number;
  userId: string;
  action: string;
  resource: string;
  result: 'allow' | 'deny' | 'error';
  metadata?: Record<string, unknown>;
}

export interface Role {
  name: string;
  permissions: string[];
}

export interface OTPOptions {
  digits?: number;
  algorithm?: 'sha1' | 'sha256' | 'sha512';
  period?: number; // TOTP only, seconds
}

export interface EncryptedPayload {
  iv: string;
  tag: string;
  ciphertext: string;
  algorithm: string;
}

export interface DerivedKeyResult {
  key: Buffer;
  salt: string;
  iterations: number;
  keyLength: number;
  digest: string;
}

export interface BruteForceEntry {
  count: number;
  firstAttempt: number;
  lastAttempt: number;
  lockedUntil: number | null;
}

export interface PasswordStrength {
  score: number; // 0-4
  label: 'very-weak' | 'weak' | 'fair' | 'strong' | 'very-strong';
  issues: string[];
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

// ---------------------------------------------------------------------------
// TokenManager — sign, verify, refresh, revoke JWT-like tokens (HMAC-SHA256)
// ---------------------------------------------------------------------------

export class TokenManager {
  readonly #secret: Buffer;
  readonly #accessTtl: number;
  readonly #refreshTtl: number;
  readonly #revokedSet = new Set<string>();

  constructor(options: {
    secret: string | Buffer;
    accessTtlMs?: number;
    refreshTtlMs?: number;
  }) {
    this.#secret =
      typeof options.secret === 'string'
        ? Buffer.from(options.secret, 'utf8')
        : options.secret;
    this.#accessTtl = options.accessTtlMs ?? 15 * 60 * 1000; // 15 min
    this.#refreshTtl = options.refreshTtlMs ?? 7 * 24 * 60 * 60 * 1000; // 7d
  }

  /** Encode header.payload.signature (base64url, no padding). */
  sign(payload: Omit<JWTPayload, 'iat' | 'exp' | 'jti'> & { sub: string }, ttlMs?: number): string {
    const now = Date.now();
    const full: JWTPayload = {
      ...payload,
      iat: Math.floor(now / 1000),
      exp: Math.floor((now + (ttlMs ?? this.#accessTtl)) / 1000),
      jti: randomUUID(),
    };
    const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64u(JSON.stringify(full));
    const sig = computeHmac(this.#secret, `${header}.${body}`, 'sha256');
    return `${header}.${body}.${sig}`;
  }

  /** Verify signature + expiry. Returns parsed payload or null. */
  verify(token: string): JWTPayload | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts as [string, string, string];
    const expected = computeHmac(this.#secret, `${header}.${body}`, 'sha256');
    if (!timingSafeCompare(sig, expected)) return null;
    let payload: JWTPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JWTPayload;
    } catch {
      return null;
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (this.#revokedSet.has(payload.jti)) return null;
    return payload;
  }

  /** Issue a new access + refresh token pair. */
  refresh(refreshToken: string): TokenPair | null {
    const payload = this.verify(refreshToken);
    if (!payload) return null;
    this.revoke(refreshToken);
    const accessToken = this.sign({ sub: payload.sub }, this.#accessTtl);
    const newRefresh = this.sign({ sub: payload.sub }, this.#refreshTtl);
    return {
      accessToken,
      refreshToken: newRefresh,
      expiresAt: Date.now() + this.#accessTtl,
    };
  }

  /** Add jti to revocation set. */
  revoke(token: string): void {
    const parts = token.split('.');
    if (parts.length !== 3) return;
    const body = parts[1] as string;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JWTPayload;
      this.#revokedSet.add(payload.jti);
    } catch {
      // ignore malformed tokens
    }
  }

  /** Generate a full access+refresh token pair. */
  issueTokenPair(sub: string): TokenPair {
    return {
      accessToken: this.sign({ sub }, this.#accessTtl),
      refreshToken: this.sign({ sub }, this.#refreshTtl),
      expiresAt: Date.now() + this.#accessTtl,
    };
  }

  /** Check if a jti is revoked. */
  isRevoked(jti: string): boolean {
    return this.#revokedSet.has(jti);
  }
}

// ---------------------------------------------------------------------------
// SessionManager — CRUD + list + expire sessions
// ---------------------------------------------------------------------------

export class SessionManager {
  readonly #store = new Map<string, Session>();
  #sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly defaultTtlMs = 30 * 60 * 1000) {
    // sweep expired sessions every minute
    this.#sweepTimer = setInterval(() => this.#sweep(), 60_000);
    if (typeof this.#sweepTimer.unref === 'function') this.#sweepTimer.unref();
  }

  /** Create a new session and return it. */
  create(userId: string, data: Record<string, unknown> = {}, ttlMs?: number): Session {
    const now = Date.now();
    const session: Session = {
      id: generateSessionId(),
      userId,
      data,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + (ttlMs ?? this.defaultTtlMs),
    };
    this.#store.set(session.id, session);
    return session;
  }

  /** Read a session by id. Returns null if missing or expired. */
  read(id: string): Session | null {
    const s = this.#store.get(id);
    if (!s || s.expiresAt < Date.now()) {
      this.#store.delete(id);
      return null;
    }
    return s;
  }

  /** Merge data into a session and bump updatedAt. */
  update(id: string, patch: Record<string, unknown>): Session | null {
    const s = this.read(id);
    if (!s) return null;
    s.data = { ...s.data, ...patch };
    s.updatedAt = Date.now();
    this.#store.set(id, s);
    return s;
  }

  /** Delete a session. */
  delete(id: string): boolean {
    return this.#store.delete(id);
  }

  /** List all non-expired sessions, optionally filtered by userId. */
  list(userId?: string): Session[] {
    const now = Date.now();
    const result: Session[] = [];
    for (const s of this.#store.values()) {
      if (s.expiresAt < now) {
        this.#store.delete(s.id);
        continue;
      }
      if (!userId || s.userId === userId) result.push(s);
    }
    return result;
  }

  /** Force-expire (but keep tombstone-like) a session immediately. */
  expire(id: string): boolean {
    const s = this.#store.get(id);
    if (!s) return false;
    s.expiresAt = Date.now() - 1;
    this.#store.set(id, s);
    return true;
  }

  /** How many active sessions exist. */
  get size(): number {
    return this.list().length;
  }

  /** Stop the background sweep timer. */
  destroy(): void {
    if (this.#sweepTimer) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
  }

  #sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.#store) {
      if (s.expiresAt < now) this.#store.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// ApiKeyManager — generate, hash, verify, rotate, revoke API keys
// ---------------------------------------------------------------------------

export class ApiKeyManager {
  readonly #keys = new Map<string, ApiKey>();

  /** Generate a new API key for a user. Returns the raw key (show once). */
  generate(userId: string, scopes: string[] = [], expiresAt: number | null = null): { raw: string; record: ApiKey } {
    const raw = generateApiKey();
    const prefix = raw.slice(0, 8);
    const record: ApiKey = {
      id: randomUUID(),
      keyHash: hashApiKey(raw),
      prefix,
      userId,
      scopes,
      createdAt: Date.now(),
      expiresAt,
      revokedAt: null,
    };
    this.#keys.set(record.id, record);
    return { raw, record };
  }

  /** Verify a raw API key. Returns the record or null. */
  verify(raw: string): ApiKey | null {
    const hash = hashApiKey(raw);
    for (const k of this.#keys.values()) {
      if (k.revokedAt !== null) continue;
      if (k.expiresAt !== null && k.expiresAt < Date.now()) continue;
      if (timingSafeCompare(k.keyHash, hash)) return k;
    }
    return null;
  }

  /** Rotate: revoke old key and issue a new one with the same scopes. */
  rotate(id: string): { raw: string; record: ApiKey } | null {
    const existing = this.#keys.get(id);
    if (!existing || existing.revokedAt !== null) return null;
    this.revoke(id);
    return this.generate(existing.userId, existing.scopes, existing.expiresAt);
  }

  /** Revoke a key by id. */
  revoke(id: string): boolean {
    const k = this.#keys.get(id);
    if (!k) return false;
    k.revokedAt = Date.now();
    return true;
  }

  /** List keys for a user (metadata only, no raw key). */
  list(userId: string): ApiKey[] {
    return [...this.#keys.values()].filter((k) => k.userId === userId);
  }
}

// ---------------------------------------------------------------------------
// RateLimiter — sliding window, token bucket, leaky bucket
// ---------------------------------------------------------------------------

interface WindowEntry {
  timestamps: number[];
}

interface BucketEntry {
  tokens: number;
  lastRefill: number;
}

interface LeakyEntry {
  queue: number;
  lastDrain: number;
}

export class RateLimiter {
  // Sliding window state
  readonly #windows = new Map<string, WindowEntry>();
  // Token bucket state
  readonly #buckets = new Map<string, BucketEntry>();
  // Leaky bucket state
  readonly #leaky = new Map<string, LeakyEntry>();

  /**
   * Sliding-window rate limit.
   * @param key      Identifier (e.g. IP + route)
   * @param limit    Max requests
   * @param windowMs Window size in ms
   */
  slidingWindow(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = Date.now();
    const entry = this.#windows.get(key) ?? { timestamps: [] };
    entry.timestamps = entry.timestamps.filter((t) => t > now - windowMs);
    if (entry.timestamps.length >= limit) {
      const oldest = entry.timestamps[0] ?? now;
      const resetAt = oldest + windowMs;
      this.#windows.set(key, entry);
      return { allowed: false, remaining: 0, resetAt, retryAfter: resetAt - now };
    }
    entry.timestamps.push(now);
    this.#windows.set(key, entry);
    return { allowed: true, remaining: limit - entry.timestamps.length, resetAt: now + windowMs };
  }

  /**
   * Token-bucket rate limit.
   * @param key      Identifier
   * @param capacity Max tokens
   * @param refillRate Tokens added per ms
   * @param cost     Tokens consumed per request (default 1)
   */
  tokenBucket(key: string, capacity: number, refillRate: number, cost = 1): RateLimitResult {
    const now = Date.now();
    const entry = this.#buckets.get(key) ?? { tokens: capacity, lastRefill: now };
    const elapsed = now - entry.lastRefill;
    entry.tokens = Math.min(capacity, entry.tokens + elapsed * refillRate);
    entry.lastRefill = now;

    if (entry.tokens < cost) {
      const waitMs = Math.ceil((cost - entry.tokens) / refillRate);
      this.#buckets.set(key, entry);
      return { allowed: false, remaining: 0, resetAt: now + waitMs, retryAfter: waitMs };
    }
    entry.tokens -= cost;
    this.#buckets.set(key, entry);
    const resetAt = now + Math.ceil((capacity - entry.tokens) / refillRate);
    return { allowed: true, remaining: Math.floor(entry.tokens), resetAt };
  }

  /**
   * Leaky-bucket rate limit.
   * @param key       Identifier
   * @param capacity  Max queue size
   * @param drainRate Requests drained per ms
   */
  leakyBucket(key: string, capacity: number, drainRate: number): RateLimitResult {
    const now = Date.now();
    const entry = this.#leaky.get(key) ?? { queue: 0, lastDrain: now };
    const elapsed = now - entry.lastDrain;
    entry.queue = Math.max(0, entry.queue - elapsed * drainRate);
    entry.lastDrain = now;

    if (entry.queue >= capacity) {
      const waitMs = Math.ceil((entry.queue - capacity + 1) / drainRate);
      this.#leaky.set(key, entry);
      return { allowed: false, remaining: 0, resetAt: now + waitMs, retryAfter: waitMs };
    }
    entry.queue += 1;
    this.#leaky.set(key, entry);
    const resetAt = now + Math.ceil(entry.queue / drainRate);
    return { allowed: true, remaining: Math.floor(capacity - entry.queue), resetAt };
  }

  /** Reset all state for a key across all algorithms. */
  reset(key: string): void {
    this.#windows.delete(key);
    this.#buckets.delete(key);
    this.#leaky.delete(key);
  }
}

// ---------------------------------------------------------------------------
// AuditLogger — append security events to a log file and in-memory ring
// ---------------------------------------------------------------------------

export class AuditLogger {
  readonly #events: AuditEvent[] = [];
  readonly #maxRing: number;
  readonly #logFile: string | null;

  constructor(options: { logFile?: string; maxRingSize?: number } = {}) {
    this.#logFile = options.logFile ?? null;
    this.#maxRing = options.maxRingSize ?? 10_000;
    if (this.#logFile) {
      mkdirSync(dirname(this.#logFile), { recursive: true });
    }
  }

  /** Record a security event. */
  log(event: Omit<AuditEvent, 'id' | 'timestamp'>): AuditEvent {
    const full: AuditEvent = {
      id: randomUUID(),
      timestamp: Date.now(),
      ...event,
    };
    this.#events.push(full);
    if (this.#events.length > this.#maxRing) this.#events.shift();
    if (this.#logFile) {
      try {
        appendFileSync(this.#logFile, JSON.stringify(full) + '\n', 'utf8');
      } catch {
        // best-effort
      }
    }
    return full;
  }

  /** Query in-memory events. */
  query(filter?: Partial<Pick<AuditEvent, 'userId' | 'action' | 'resource' | 'result'>>): AuditEvent[] {
    if (!filter) return [...this.#events];
    return this.#events.filter((e) =>
      Object.entries(filter).every(([k, v]) => e[k as keyof AuditEvent] === v),
    );
  }

  /** Clear in-memory ring. */
  clear(): void {
    this.#events.length = 0;
  }

  get size(): number {
    return this.#events.length;
  }
}

// ---------------------------------------------------------------------------
// PermissionManager — roles, permissions, RBAC checks
// ---------------------------------------------------------------------------

export class PermissionManager {
  readonly #roles = new Map<string, Set<string>>();
  readonly #userRoles = new Map<string, Set<string>>();

  /** Define (or overwrite) a role with a set of permissions. */
  defineRole(name: string, permissions: string[]): void {
    this.#roles.set(name, new Set(permissions));
  }

  /** Grant a role to a user. */
  grantRole(userId: string, role: string): void {
    const set = this.#userRoles.get(userId) ?? new Set<string>();
    set.add(role);
    this.#userRoles.set(userId, set);
  }

  /** Revoke a role from a user. */
  revokeRole(userId: string, role: string): void {
    this.#userRoles.get(userId)?.delete(role);
  }

  /** Return all roles assigned to a user. */
  getRoles(userId: string): string[] {
    return [...(this.#userRoles.get(userId) ?? [])];
  }

  /** Return all permissions a user has (union across roles). */
  getPermissions(userId: string): string[] {
    const roles = this.#userRoles.get(userId) ?? new Set<string>();
    const perms = new Set<string>();
    for (const role of roles) {
      const ps = this.#roles.get(role);
      if (ps) for (const p of ps) perms.add(p);
    }
    return [...perms];
  }

  /**
   * Check whether a user has a specific permission.
   * Supports wildcard role `*` (superadmin).
   */
  can(userId: string, permission: string): boolean {
    const roles = this.#userRoles.get(userId) ?? new Set<string>();
    for (const role of roles) {
      if (role === '*') return true;
      const perms = this.#roles.get(role);
      if (!perms) continue;
      if (perms.has('*') || perms.has(permission)) return true;
      // prefix wildcard: 'users:*' matches 'users:read'
      for (const p of perms) {
        if (p.endsWith(':*') && permission.startsWith(p.slice(0, -1))) return true;
      }
    }
    return false;
  }

  /** Return all defined roles. */
  listRoles(): Role[] {
    return [...this.#roles.entries()].map(([name, ps]) => ({ name, permissions: [...ps] }));
  }
}

// ---------------------------------------------------------------------------
// EncryptionHelper — AES-256-GCM encrypt/decrypt using node:crypto
// ---------------------------------------------------------------------------

export class EncryptionHelper {
  readonly #key: Buffer;

  /**
   * @param keyMaterial A 32-byte Buffer or a hex/base64 string of 32 bytes.
   */
  constructor(keyMaterial: Buffer | string) {
    if (typeof keyMaterial === 'string') {
      const buf = Buffer.from(keyMaterial, keyMaterial.length === 64 ? 'hex' : 'base64');
      if (buf.length !== 32) throw new RangeError('Key must be 32 bytes for AES-256-GCM');
      this.#key = buf;
    } else {
      if (keyMaterial.length !== 32) throw new RangeError('Key must be 32 bytes for AES-256-GCM');
      this.#key = keyMaterial;
    }
  }

  /** Encrypt plaintext. Returns a portable EncryptedPayload. */
  encrypt(plaintext: string | Buffer): EncryptedPayload {
    return encryptAES(this.#key, plaintext);
  }

  /** Decrypt a payload produced by encrypt(). */
  decrypt(payload: EncryptedPayload): Buffer {
    return decryptAES(this.#key, payload);
  }

  /** Convenience: decrypt and return as UTF-8 string. */
  decryptString(payload: EncryptedPayload): string {
    return this.decrypt(payload).toString('utf8');
  }
}

// ---------------------------------------------------------------------------
// HashHelper — bcrypt-style PBKDF2 using node:crypto
// ---------------------------------------------------------------------------

export class HashHelper {
  readonly #iterations: number;
  readonly #keyLength: number;
  readonly #digest: string;

  constructor(options: { iterations?: number; keyLength?: number; digest?: string } = {}) {
    this.#iterations = options.iterations ?? 310_000;
    this.#keyLength = options.keyLength ?? 64;
    this.#digest = options.digest ?? 'sha512';
  }

  /** Hash a password. Returns a storable string: `<iterations>$<digest>$<salt>$<hash>`. */
  hash(password: string): string {
    const result = deriveKey(password, {
      iterations: this.#iterations,
      keyLength: this.#keyLength,
      digest: this.#digest,
    });
    return `${result.iterations}$${result.digest}$${result.salt}$${result.key.toString('hex')}`;
  }

  /** Verify a password against a stored hash string. */
  verify(password: string, stored: string): boolean {
    const parts = stored.split('$');
    if (parts.length !== 4) return false;
    const [iterStr, digest, salt, expectedHex] = parts as [string, string, string, string];
    const iterations = parseInt(iterStr, 10);
    const keyLength = Buffer.from(expectedHex, 'hex').length;
    const result = deriveKey(password, { salt: Buffer.from(salt, 'hex'), iterations, keyLength, digest });
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = result.key;
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }
}

// ---------------------------------------------------------------------------
// OTPGenerator — TOTP (RFC 6238) and HOTP (RFC 4226) using node:crypto
// ---------------------------------------------------------------------------

export class OTPGenerator {
  readonly #digits: number;
  readonly #algorithm: string;
  readonly #period: number;

  constructor(options: OTPOptions = {}) {
    this.#digits = options.digits ?? 6;
    this.#algorithm = options.algorithm ?? 'sha1';
    this.#period = options.period ?? 30;
  }

  /** Generate HOTP for a given counter value. */
  hotp(secret: Buffer | string, counter: number): string {
    const key = typeof secret === 'string' ? Buffer.from(secret, 'base32' as BufferEncoding) : secret;
    const msg = Buffer.alloc(8);
    // Write 64-bit big-endian counter
    const hi = Math.floor(counter / 0x100000000);
    const lo = counter >>> 0;
    msg.writeUInt32BE(hi, 0);
    msg.writeUInt32BE(lo, 4);
    const hmac = createHmac(this.#algorithm, key).update(msg).digest();
    const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
    const code =
      (((hmac[offset] ?? 0) & 0x7f) << 24) |
      (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
      (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
      ((hmac[offset + 3] ?? 0) & 0xff);
    const otp = code % Math.pow(10, this.#digits);
    return String(otp).padStart(this.#digits, '0');
  }

  /** Generate TOTP for the current (or provided) timestamp. */
  totp(secret: Buffer | string, atMs?: number): string {
    const counter = Math.floor((atMs ?? Date.now()) / 1000 / this.#period);
    return this.hotp(secret, counter);
  }

  /** Verify TOTP allowing ±window periods. */
  verifyTotp(secret: Buffer | string, token: string, window = 1): boolean {
    const counter = Math.floor(Date.now() / 1000 / this.#period);
    for (let i = -window; i <= window; i++) {
      if (this.hotp(secret, counter + i) === token) return true;
    }
    return false;
  }

  /** Verify HOTP for a specific counter. */
  verifyHotp(secret: Buffer | string, token: string, counter: number): boolean {
    return this.hotp(secret, counter) === token;
  }

  /** Generate a cryptographically random base32 TOTP secret. */
  generateSecret(bytes = 20): string {
    return base32Encode(randomBytes(bytes));
  }
}

// ---------------------------------------------------------------------------
// SessionStore — in-memory generic KV store with TTL cleanup
// ---------------------------------------------------------------------------

export interface SessionStoreEntry<T> {
  value: T;
  expiresAt: number;
}

export class SessionStore<T = unknown> {
  readonly #map = new Map<string, SessionStoreEntry<T>>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly defaultTtlMs = 30 * 60 * 1000, sweepIntervalMs = 60_000) {
    this.#timer = setInterval(() => this.#sweep(), sweepIntervalMs);
    if (typeof this.#timer.unref === 'function') this.#timer.unref();
  }

  set(key: string, value: T, ttlMs?: number): void {
    this.#map.set(key, { value, expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs) });
  }

  get(key: string): T | undefined {
    const entry = this.#map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.#map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): boolean {
    return this.#map.delete(key);
  }

  /** Return all non-expired entries as [key, value] pairs. */
  entries(): [string, T][] {
    const now = Date.now();
    const result: [string, T][] = [];
    for (const [k, v] of this.#map) {
      if (v.expiresAt < now) { this.#map.delete(k); continue; }
      result.push([k, v.value]);
    }
    return result;
  }

  clear(): void {
    this.#map.clear();
  }

  get size(): number {
    return this.entries().length;
  }

  destroy(): void {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null; }
  }

  #sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.#map) {
      if (v.expiresAt < now) this.#map.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone functions
// ---------------------------------------------------------------------------

/** Generate a cryptographically random API key with a `nyx_` prefix. */
export function generateApiKey(bytes = 32): string {
  return `nyx_${randomBytes(bytes).toString('base64url')}`;
}

/** HMAC-SHA256 hash of a raw API key (hex). */
export function hashApiKey(raw: string): string {
  return createHmac('sha256', 'nyx-api-key-hmac').update(raw, 'utf8').digest('hex');
}

/** Verify a raw key against a stored hash (timing-safe). */
export function verifyApiKey(raw: string, storedHash: string): boolean {
  const actual = hashApiKey(raw);
  return timingSafeCompare(actual, storedHash);
}

/** Generate a cryptographically random session ID (hex). */
export function generateSessionId(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Compute HMAC over data.
 * @param secret  Key as Buffer or string (UTF-8)
 * @param data    Data as string or Buffer
 * @param algo    Digest algorithm, default sha256
 * @returns hex-encoded HMAC
 */
export function computeHmac(
  secret: Buffer | string,
  data: string | Buffer,
  algo: string = 'sha256',
): string {
  return createHmac(algo, secret).update(data).digest('base64url');
}

/** Verify an HMAC signature (timing-safe). */
export function verifyHmac(
  secret: Buffer | string,
  data: string | Buffer,
  signature: string,
  algo: string = 'sha256',
): boolean {
  return timingSafeCompare(computeHmac(secret, data, algo), signature);
}

/** Generate a random nonce (base64url). */
export function generateNonce(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

/** Generate cryptographically secure random bytes, returned as a Buffer. */
export function generateSecureRandom(bytes: number): Buffer {
  return randomBytes(bytes);
}

/** Generate a v4-compatible UUID using node:crypto. */
export function generateUUID(): string {
  return randomUUID();
}

/** Mask sensitive data, leaving only the first and last N chars visible. */
export function maskSensitiveData(value: string, visibleChars = 4, mask = '****'): string {
  if (value.length <= visibleChars * 2) return mask;
  return `${value.slice(0, visibleChars)}${mask}${value.slice(-visibleChars)}`;
}

/** Basic HTML/SQL injection sanitisation — strips dangerous characters. */
export function sanitizeInput(input: string): string {
  return input
    .replace(/[<>'"`;\\]/g, '')
    .replace(/--/g, '')
    .replace(/\/\*/g, '')
    .replace(/\*\//g, '')
    .trim();
}

/** Validate a password against common rules. Returns an array of violations. */
export function validatePassword(password: string, options: {
  minLength?: number;
  requireUppercase?: boolean;
  requireLowercase?: boolean;
  requireDigit?: boolean;
  requireSpecial?: boolean;
} = {}): string[] {
  const {
    minLength = 12,
    requireUppercase = true,
    requireLowercase = true,
    requireDigit = true,
    requireSpecial = true,
  } = options;
  const errors: string[] = [];
  if (password.length < minLength) errors.push(`Minimum length is ${minLength}`);
  if (requireUppercase && !/[A-Z]/.test(password)) errors.push('Must contain an uppercase letter');
  if (requireLowercase && !/[a-z]/.test(password)) errors.push('Must contain a lowercase letter');
  if (requireDigit && !/\d/.test(password)) errors.push('Must contain a digit');
  if (requireSpecial && !/[!@#$%^&*()_\-+=[\]{};:'",.<>?/\\|`~]/.test(password)) {
    errors.push('Must contain a special character');
  }
  return errors;
}

/** Compute a password strength score (0-4) and label. */
export function computePasswordStrength(password: string): PasswordStrength {
  const issues: string[] = [];
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 16) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  else issues.push('Mix upper and lowercase');
  if (/\d/.test(password)) score++;
  else issues.push('Add digits');
  if (/[^A-Za-z0-9]/.test(password)) score++;
  else issues.push('Add special characters');
  const capped = Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
  const labels: PasswordStrength['label'][] = ['very-weak', 'weak', 'fair', 'strong', 'very-strong'];
  return { score: capped, label: labels[capped] as PasswordStrength['label'], issues };
}

/** Simple in-memory brute-force tracker (call after each failed attempt). */
const _bruteForceMap = new Map<string, BruteForceEntry>();

export function detectBruteForce(
  key: string,
  options: { maxAttempts?: number; windowMs?: number; lockoutMs?: number } = {},
): { blocked: boolean; entry: BruteForceEntry } {
  const { maxAttempts = 5, windowMs = 15 * 60 * 1000, lockoutMs = 30 * 60 * 1000 } = options;
  const now = Date.now();
  let entry = _bruteForceMap.get(key) ?? { count: 0, firstAttempt: now, lastAttempt: now, lockedUntil: null };

  if (entry.lockedUntil !== null && now < entry.lockedUntil) {
    return { blocked: true, entry };
  }
  // Reset window
  if (now - entry.firstAttempt > windowMs) {
    entry = { count: 0, firstAttempt: now, lastAttempt: now, lockedUntil: null };
  }

  entry.count++;
  entry.lastAttempt = now;
  if (entry.count >= maxAttempts) {
    entry.lockedUntil = now + lockoutMs;
  }
  _bruteForceMap.set(key, entry);
  return { blocked: entry.lockedUntil !== null, entry };
}

/** Reset brute-force tracking for a key (e.g. after successful auth). */
export function resetBruteForce(key: string): void {
  _bruteForceMap.delete(key);
}

/** Generate a CSRF token bound to a session id. */
export function generateCsrfToken(sessionId: string, secret: string): string {
  const nonce = randomBytes(16).toString('hex');
  const sig = computeHmac(secret, `${sessionId}:${nonce}`);
  return `${nonce}.${sig}`;
}

/** Verify a CSRF token for a session. */
export function verifyCsrfToken(sessionId: string, token: string, secret: string): boolean {
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const nonce = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = computeHmac(secret, `${sessionId}:${nonce}`);
  return timingSafeCompare(sig, expected);
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * @param key   32-byte Buffer
 * @param plain Plaintext string or Buffer
 */
export function encryptAES(key: Buffer, plain: string | Buffer): EncryptedPayload {
  if (key.length !== 32) throw new RangeError('AES-256 requires a 32-byte key');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain;
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    algorithm: 'aes-256-gcm',
  };
}

/** Decrypt an AES-256-GCM payload produced by encryptAES(). */
export function decryptAES(key: Buffer, payload: EncryptedPayload): Buffer {
  if (key.length !== 32) throw new RangeError('AES-256 requires a 32-byte key');
  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');
  const ciphertext = Buffer.from(payload.ciphertext, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Encrypt data with an RSA public key (OAEP-SHA256). */
export function encryptRSA(publicKeyPem: string, data: Buffer | string): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return publicEncrypt(
    { key: publicKeyPem, padding: 4 /* RSA_PKCS1_OAEP_PADDING */ },
    buf,
  );
}

/** Decrypt data with an RSA private key (OAEP-SHA256). */
export function decryptRSA(privateKeyPem: string, data: Buffer): Buffer {
  return privateDecrypt(
    { key: privateKeyPem, padding: 4 /* RSA_PKCS1_OAEP_PADDING */ },
    data,
  );
}

/** Sign data with an RSA private key. Returns base64 signature. */
export function signData(privateKeyPem: string, data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return privateEncrypt(privateKeyPem, buf).toString('base64');
}

/** Verify an RSA signature. */
export function verifySignature(publicKeyPem: string, data: Buffer | string, signature: string): boolean {
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const decrypted = publicEncrypt(publicKeyPem, Buffer.from(signature, 'base64'));
    return timingSafeEqual(decrypted, buf);
  } catch {
    return false;
  }
}

/**
 * Derive a key using PBKDF2.
 * @param password  Plaintext password
 * @param options   PBKDF2 options
 */
export function deriveKey(
  password: string | Buffer,
  options: {
    salt?: Buffer | string;
    iterations?: number;
    keyLength?: number;
    digest?: string;
  } = {},
): DerivedKeyResult {
  const salt =
    options.salt != null
      ? typeof options.salt === 'string'
        ? Buffer.from(options.salt, 'hex')
        : options.salt
      : randomBytes(32);
  const iterations = options.iterations ?? 310_000;
  const keyLength = options.keyLength ?? 64;
  const digest = options.digest ?? 'sha512';
  const pwd = typeof password === 'string' ? password : password.toString('utf8');
  const key = pbkdf2Sync(pwd, salt, iterations, keyLength, digest);
  return { key, salt: salt.toString('hex'), iterations, keyLength, digest };
}

/** Generate an RSA key pair (2048-bit by default). */
export function generateKeyPair(
  modulusLength = 2048,
): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

// ---------------------------------------------------------------------------
// Internal helpers (not exported — used above)
// ---------------------------------------------------------------------------

/** base64url-encode a string (no padding). */
function b64u(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** Timing-safe string comparison (converts to Buffer internally). */
function timingSafeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // Still run the comparison to avoid timing leak on length
    timingSafeEqual(ba, Buffer.alloc(ba.length));
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Minimal base32 encoder (RFC 4648, no padding). */
function base32Encode(buf: Buffer): string {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | (buf[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += ALPHA[(value >>> bits) & 31];
    }
  }
  if (bits > 0) output += ALPHA[(value << (5 - bits)) & 31];
  return output;
}
