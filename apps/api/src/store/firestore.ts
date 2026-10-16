/**
 * The gateway's own data in Google Cloud Firestore (Firebase), so one gateway
 * can run with no disk and no PostgreSQL: saved connections, drafts, API
 * tokens, webhooks, migration history, the audit log and the change feed.
 *
 * This is NOT the customer's data. Customer records stay in their databases.
 *
 * One gateway at a time. A short lease document in Firestore keeps a second
 * gateway from starting on the same state (the same job the data-folder lock
 * does on disk). Running several gateways on shared state needs PostgreSQL
 * (see postgres.ts).
 *
 * Design choices, each to keep this simple and safe:
 *  - Every record is stored as one JSON string field. Firestore refuses some
 *    key names and `undefined` values, and the gateway's records are
 *    open-ended, so a string avoids surprises. Secrets inside records are
 *    already encrypted by the vault before they get here.
 *  - Only documents that changed are written, in batches, before the
 *    in-memory copy is replaced. A failed write leaves memory unchanged.
 *  - No composite indexes are needed: every query orders by document id.
 *  - The client is described by a small structural interface, so tests run
 *    against an in-memory fake and the real driver is loaded only when used.
 */
export * from './firestore-client.js';
export * from './firestore-state.js';
export * from './firestore-shared.js';
export * from './firestore-audit.js';
export * from './firestore-changes.js';
