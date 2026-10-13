import test from 'node:test';
import assert from 'node:assert/strict';

import { Browsers, getCompanionPlatformId } from '@whiskeysockets/baileys';

import { DEFAULT_BROWSER, assertBrowserIsSafe, desktopUserAgent } from '../dist/core/socket.js';

test('the default identity is Baileys canonical Ubuntu Chrome tuple', () => {
  assert.deepEqual(
    [...DEFAULT_BROWSER],
    [...Browsers.ubuntu('Chrome')],
    'hand-rolled tuples drift; the helper tracks upstream',
  );
});

test('the default identity produces a canonical companion display', () => {
  // The pairing-code handshake sends companion_platform_display derived from
  // this tuple as `${browser[1]} (${browser[0]})`. A hand-written
  // ['Chrome','120','0'] sent display='120 (Chrome)' with platform id 9, and
  // WhatsApp's stricter companion_hello validator answered with an async 400
  // AFTER Baileys had already returned the 8-digit code — so codes generated
  // cleanly and the phone rejected every one. Upstream PR #2559, issue #1761.
  const display = `${DEFAULT_BROWSER[1]} (${DEFAULT_BROWSER[0]})`;
  assert.equal(display, 'Chrome (Ubuntu)');
  assert.equal(
    getCompanionPlatformId([...DEFAULT_BROWSER]),
    '1',
    'platform id must be CHROME (1), not OTHER_WEB_CLIENT (9)',
  );
});

test('the default identity keeps WEB_BROWSER even with history sync', () => {
  // 'Ubuntu' is not a PLATFORM_MAP key, so webSubPlatform cannot become WIN32
  // and the 428 handshake death stays impossible from this default.
  assert.doesNotThrow(() => assertBrowserIsSafe(DEFAULT_BROWSER, true));
  assert.doesNotThrow(() => assertBrowserIsSafe(DEFAULT_BROWSER, false));
});

test('the desktop user agent still renders from the new tuple', () => {
  const ua = desktopUserAgent(DEFAULT_BROWSER);
  assert.match(ua, /Mozilla\/5\.0 \(X11; Linux x86_64\)/);
  assert.match(ua, /Chrome\/120\.0\.0\.0/);
  assert.doesNotMatch(ua, /Ubuntu\/Chrome/, 'the OS must never appear in the engine slot');
});