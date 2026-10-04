/**
 * A timer that resolves an awaited promise must hold the event loop.
 *
 * Three bugs of exactly this shape shipped and all presented the same way:
 *
 *   utils/queue.ts        withRetry's backoff sleep
 *   plugins/album.ts      waitForAlbum's timeout
 *   plugins/antiban.ts    readReceiptVariance's readMessages delay
 *
 * In each, the timer was `unref()`'d. That is normally the polite thing to do
 * for a background timer, but these are not background timers — they resolve a
 * promise the caller is *awaiting*, and if they are also the only thing holding
 * the loop open, Node concludes the loop is empty and exits. The caller's await
 * never returns and there is no error. It reproduces as a process exiting
 * silently mid-call.
 *
 * It never showed up locally because a dev machine always has other handles
 * open. It showed up on a bare Linux CI runner, where the album and antiban
 * suites reported their remaining tests as `cancelledByParent` with
 * `# fail 0` — node exiting mid-file, so the file's remaining tests were
 * cancelled rather than failed.
 *
 * So these tests spawn a child process whose ONLY pending work is the promise
 * under test. If the timer is unref'd, the child exits without printing and the
 * assertion fails. That is the only way to test this property — in-process it is
 * invisible, because the test runner itself holds the loop open.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Run `source` in a child with nothing else scheduled, and return its output.
 *
 * A hang means the event loop emptied before the promise settled, which is the
 * exact bug. `timeout` turns that into a failure rather than a stall.
 */
async function isolated(source, timeout = 15_000) {
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', source], {
    cwd: repoRoot,
    timeout,
  });
  return stdout.trim();
}

test('waitForAlbum resolves its timeout when nothing else holds the loop', async () => {
  const out = await isolated(`
    import { albumHandler } from './dist/plugins/album.js';
    import { fakeSocket, upsert, wmMessage } from './tests/helpers.js';

    const sock = fakeSocket();
    albumHandler().apply({ sock, state: { get: async (k, d) => d, set: async () => {} },
      options: {}, log: { child: () => ({ debug(){}, warn(){}, error(){}, info(){} }) }, onDispose(){} });

    upsert(sock, [wmMessage({ jid: '1@s.whatsapp.net', id: 'P',
      message: { albumMessage: { expectedImageCount: 3, expectedVideoCount: 0 } } })]);

    // The album never completes, so this only returns via the timeout. If that
    // timer is unref'd the process exits here and prints nothing.
    const album = await sock.waitForAlbum('P', 50);
    console.log('resolved:' + (album?.completedAt === undefined ? 'timeout' : 'completed'));
  `);

  assert.equal(out, 'resolved:timeout', 'the child printed nothing — its loop emptied first');
});

test('a completed album resolves through the event, not the timeout', async () => {
  const out = await isolated(`
    import { proto } from './dist/index.js';
    import { albumHandler } from './dist/plugins/album.js';
    import { fakeSocket, upsert, wmMessage, mediaMessage } from './tests/helpers.js';

    const MEDIA_ALBUM = proto.MessageAssociation.AssociationType.MEDIA_ALBUM;
    const sock = fakeSocket();
    albumHandler().apply({ sock, state: { get: async (k, d) => d, set: async () => {} },
      options: {}, log: { child: () => ({ debug(){}, warn(){}, error(){}, info(){} }) }, onDispose(){} });

    upsert(sock, [wmMessage({ jid: '1@s.whatsapp.net', id: 'P',
      message: { albumMessage: { expectedImageCount: 1, expectedVideoCount: 0 } } })]);
    upsert(sock, [mediaMessage({ jid: '1@s.whatsapp.net', id: 'S1',
      associationType: MEDIA_ALBUM, parentId: 'P', fileLength: 10 })]);

    // Must resolve on the nyx.album event. If it fell through to the timeout the
    // child would print 'timeout', which is what this assertion rules out.
    const album = await sock.waitForAlbum('P', 30000);
    console.log('resolved:' + (album?.completedAt ? 'completed' : 'timeout'));
  `);

  assert.equal(out, 'resolved:completed', 'it fell through to the timeout instead of the event');
});

test('readReceiptVariance runs readMessages when nothing else holds the loop', async () => {
  const out = await isolated(`
    import { readReceiptVariancePlugin } from './dist/plugins/antiban.js';
    import { fakeSocket } from './tests/helpers.js';

    const seen = [];
    const sock = fakeSocket({ readMessages: (keys) => seen.push(keys.length) });
    readReceiptVariancePlugin({ meanMs: 20, stdDevMs: 0, minMs: 20, maxMs: 20 }).apply({
      sock, state: { get: async (k, d) => d, set: async () => {} }, options: {},
      log: { child: () => ({ debug(){}, warn(){}, error(){}, info(){} }) }, onDispose(){} });

    await sock.readMessages([{ remoteJid: '1@s.whatsapp.net', id: 'm1', messageTimestamp: 1 }]);
    console.log('delivered:' + seen.length);
  `);

  assert.equal(out, 'delivered:1', 'the child printed nothing — the delay timer did not hold the loop');
});

test('withRetry completes its backoff when nothing else holds the loop', async () => {
  const out = await isolated(`
    import { withRetry } from './dist/utils/queue.js';
    let n = 0;
    const out = await withRetry(async () => {
      n += 1;
      if (n < 3) throw new Error('again');
      return 'ok';
    }, { attempts: 5, baseDelayMs: 20 });
    console.log('attempts:' + n + ' result:' + out);
  `);

  assert.equal(out, 'attempts:3 result:ok');
});

test('a background schedule stays unref-d — it must NOT hold a process open', async () => {
  // The opposite case, pinned deliberately. humanEntropy runs on a long timer to
  // look human; if that timer held the loop, importing the plugin would hang any
  // short-lived script that never disposes it. So this asserts the child exits
  // promptly *despite* a scheduled activity timer.
  const start = Date.now();
  const out = await isolated(
    `
    import { humanEntropy } from './dist/plugins/antiban.js';
    import { fakeSocket } from './tests/helpers.js';
    const sock = fakeSocket();
    humanEntropy({ enabled: true, minIntervalMs: 600000, maxIntervalMs: 600000 }).apply({
      sock, state: { get: async (k, d) => d, set: async () => {} }, options: {},
      log: { child: () => ({ debug(){}, warn(){}, error(){}, info(){} }) }, onDispose(){} });
    console.log('attached:' + (sock.entropy ? 'yes' : 'no'));
  `,
    10_000,
  );

  assert.equal(out, 'attached:yes');
  assert.ok(Date.now() - start < 9_000, 'a background schedule held the process open');
});