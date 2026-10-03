/**
 * Persistence adapters.
 *
 * Every adapter implements the framework's `SessionStore`, so any of them drops
 * into `SuperOptions.sessionStore` with no other change:
 *
 *   import { MongoSessionStore } from 'super-baileys/adapters/session-mongo.js';
 *
 *   createSuperBaileys({ sessionStore: new MongoSessionStore({ sessionId, db }) });
 *
 * None of these import a database driver. Each declares the narrow client
 * surface it calls and you supply the real client, so the choice of driver (and
 * its version) stays yours and no peer dependency is forced on you.
 *
 *   adapter      stores creds as          stores keys as              best for
 *   ───────────  ───────────────────────  ─────────────────────────  ─────────────────
 *   sqlite       one JSON document        inside that document        single node
 *   mongo        one document             one document per key        fleets on Mongo
 *   prisma       one row                  one row per key             fleets on SQL
 *   redis        one string key           one string key per key      L1 cache layer
 *
 * The dividing line is `keys`. Baileys' Signal key store grows for the life of
 * the account — one `sender-key` per chat, one `tctoken` per chat — so anything
 * past a single node wants one row per `(session, type, keyId)` rather than one
 * blob. `session-prisma` and `session-mongo` do that; `session-sqlite` and
 * `session-redis` deliberately do not, because at their scale the blob is
 * cheaper and a single get/set is one round trip.
 */

export {
  SqliteSessionStore,
  createFilePersistence,
  type FilePersistenceOptions,
  type KeyStoreData,
  type SignalKeyStoreLike,
  type SqlitePersistence,
  type SqliteSessionStoreOptions,
} from './session-sqlite.js';

export {
  MongoSessionStore,
  type MongoCollectionLike,
  type MongoDbLike,
  type MongoSessionDoc,
  type MongoSessionKeyDoc,
  type MongoSessionStoreOptions,
  type MongoWriteResult,
} from './session-mongo.js';

export {
  PrismaSessionStore,
  type PrismaLikeClient,
  type PrismaSessionDelegate,
  type PrismaSessionKeyDelegate,
  type PrismaSessionRow,
  type PrismaSessionStoreOptions,
  type PrismaTransactionClient,
} from './session-prisma.js';

export {
  RedisSessionStore,
  type RedisLikeClient,
  type RedisSessionStoreOptions,
  type RedisSetOptions,
  type RedisWriteResult,
} from './session-redis.js';