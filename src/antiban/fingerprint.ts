/**
 * Device fingerprint.
 *
 * ⚠️ EVASION MODULE. See `docs/ANTIBAN.md`.
 *
 * WhatsApp receives a client fingerprint (`appVersion`, OS build, device model)
 * as part of the handshake. A stock, identical fingerprint across many sessions
 * links them. This derives a stable-but-varied fingerprint per session — the
 * same session id always produces the same device, different sessions differ.
 *
 * Ported and adapted from the reference forks' `deviceFingerprint`.
 */

export interface FingerprintOptions {
  /** Master switch. Default `false` — nothing is varied unless enabled. */
  enabled?: boolean;
  randomizeAppVersion?: boolean;
  randomizeOsVersion?: boolean;
  randomizeDeviceModel?: boolean;
  /** Explicit seed. Defaults to the session id. */
  seed?: string;
  appVersionPool?: ReadonlyArray<readonly number[]>;
  osVersionPool?: readonly string[];
  deviceModelPool?: readonly string[];
}

export interface DeviceFingerprint {
  appVersion: number[];
  osVersion: string;
  deviceModel: string;
  sessionId: string;
}

/** App versions observed in the wild; the patch number is what varies most. */
export const DEFAULT_APP_VERSIONS: ReadonlyArray<readonly number[]> = [
  [2, 24, 5, 18],
  [2, 24, 5, 17],
  [2, 24, 4, 77],
  [2, 24, 5, 15],
  [2, 24, 3, 91],
  [2, 24, 5, 20],
];

export const DEFAULT_OS_VERSIONS: readonly string[] = ['10', '11', '12', '13', '14'];

export const DEFAULT_DEVICE_MODELS: readonly string[] = [
  'Pixel 6', 'Pixel 7', 'Pixel 8', 'Galaxy S22', 'Galaxy S23', 'Galaxy A54',
  'Xiaomi 13', 'Xiaomi 12', 'OnePlus 11', 'Moto G84', 'Realme 11', 'Vivo V29',
];

/** Deterministic PRNG (mulberry32) seeded from a string hash. */
export class SeededRandom {
  #state: number;

  constructor(seed: string) {
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
      hash = (hash << 5) - hash + seed.charCodeAt(i);
      hash |= 0;
    }
    this.#state = Math.abs(hash) || 1;
  }

  next(): number {
    let t = (this.#state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  pick<T>(array: readonly T[]): T {
    return array[Math.floor(this.next() * array.length)]!;
  }
}

/** Build a fingerprint. Deterministic for a given session id. */
export function generateFingerprint(options: FingerprintOptions = {}, sessionId?: string): DeviceFingerprint {
  const enabled = options.enabled ?? false;
  const id = sessionId ?? `session-${Date.now()}-${Math.random()}`;
  const rng = new SeededRandom(options.seed ?? id);

  const appPool = options.appVersionPool ?? DEFAULT_APP_VERSIONS;
  const osPool = options.osVersionPool ?? DEFAULT_OS_VERSIONS;
  const modelPool = options.deviceModelPool ?? DEFAULT_DEVICE_MODELS;

  const appVersion = [...(enabled && (options.randomizeAppVersion ?? true) ? rng.pick(appPool) : appPool[0]!)];
  const osVersion = enabled && (options.randomizeOsVersion ?? true) ? rng.pick(osPool) : osPool[0]!;
  const deviceModel = enabled && (options.randomizeDeviceModel ?? true) ? rng.pick(modelPool) : modelPool[0]!;

  return { appVersion, osVersion, deviceModel, sessionId: id };
}

/**
 * Merge a fingerprint into a `makeWASocket` config. Returns a copy; the input is
 * untouched. Only `version` and `browser` are set, so any other config survives.
 */
export function applyFingerprint<T extends object>(config: T, fingerprint: DeviceFingerprint): T {
  return {
    ...config,
    version: fingerprint.appVersion,
    browser: [
      fingerprint.deviceModel,
      fingerprint.osVersion,
      `WhatsApp/${fingerprint.appVersion.join('.')}`,
    ],
  } as T;
}
