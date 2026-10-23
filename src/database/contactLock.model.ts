import { createHash } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { model, Schema } from 'mongoose';
import { runInTransaction } from './mongoose.js';

/**
 * Serialises writes that could create duplicate contacts (D37).
 *
 * Email and phone are deliberately not unique (families share them, and managers may create
 * duplicates on purpose), so a unique index cannot prevent concurrent duplicates. Instead every
 * create/convert/contact-change transaction first writes one lock document per contact value it
 * is about to use, then runs the duplicate check, then writes the record — all in the same
 * transaction.
 *
 * Two transactions using the same value both write the same lock document. MongoDB lets only one
 * of them proceed: the other fails with a WriteConflict (a TransientTransactionError), and the
 * transaction helper re-runs it. The re-run starts a new snapshot, sees the record the first one
 * committed, and the duplicate check rejects it. If a transaction is aborted (for example by a 409
 * thrown from the check), its lock write is rolled back with it, so nothing needs cleaning up.
 *
 * Lock documents only hold a counter; one exists per distinct contact value ever used. The key holds
 * a SHA-256 hash of the canonical value, not the email/phone itself, so the collection stores no
 * contact data (same value → same key, so serialisation is unchanged).
 */
const contactLockSchema = new Schema(
  {
    /** `<entity>:<kind>:<sha256 of the normalised value>`, e.g. `student:phone:3f2a…`. */
    _id: { type: String, required: true },
    writes: { type: Number, required: true, default: 0 },
    lastWriteAt: { type: Date, required: true },
  },
  { versionKey: false, collection: 'contactlocks' },
);

export const ContactLock = model('ContactLock', contactLockSchema);

export type ContactEntity = 'lead' | 'student';

/** Lock key for one canonical contact value (hashed: the key never contains the email/phone). */
export function contactLockKey(entity: ContactEntity, kind: 'email' | 'phone', value: string): string {
  return `${entity}:${kind}:${createHash('sha256').update(value).digest('hex')}`;
}

/** Lock keys for the given contact values, in a stable order. Values must already be normalised. */
export function contactLockKeys(entity: ContactEntity, email: string | null | undefined, phoneNormalized: string | null): string[] {
  const keys: string[] = [];
  if (email) keys.push(contactLockKey(entity, 'email', email));
  if (phoneNormalized) keys.push(contactLockKey(entity, 'phone', phoneNormalized));
  return keys.sort();
}

/**
 * Takes the contact locks inside `session`'s transaction. Must be called before the duplicate
 * check of the same transaction. Writing (not just reading) the lock document is what makes
 * concurrent transactions conflict.
 */
export async function lockContacts(
  session: ClientSession,
  entity: ContactEntity,
  email: string | null | undefined,
  phoneNormalized: string | null,
): Promise<void> {
  const now = new Date();
  for (const key of contactLockKeys(entity, email, phoneNormalized)) {
    await ContactLock.updateOne(
      { _id: key },
      { $inc: { writes: 1 }, $set: { lastWriteAt: now } },
      { upsert: true, session },
    );
  }
}

/** True for the duplicate-key error two first-time upserts of the same lock key can raise. */
function isLockKeyRace(error: unknown): boolean {
  const e = error as { code?: number; message?: string } | null;
  return e?.code === 11000 && typeof e.message === 'string' && e.message.includes('contactlocks');
}

/**
 * Runs `work` in a transaction (via `run`, normally runInTransaction) and re-runs it if the first
 * insert of a lock document raced another one. Write conflicts are already retried by the driver.
 */
export async function withContactTransaction<T>(
  run: (work: (session: ClientSession) => Promise<T>) => Promise<T>,
  work: (session: ClientSession) => Promise<T>,
  attempts = 5,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run(work);
    } catch (error) {
      if (attempt >= attempts || !isLockKeyRace(error)) throw error;
    }
  }
}

/** runInTransaction with the lock-key race retry; use for every contact-writing transaction. */
export function runContactTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  return withContactTransaction(runInTransaction, work);
}
