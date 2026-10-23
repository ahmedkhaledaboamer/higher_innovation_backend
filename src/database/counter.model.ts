import type { ClientSession } from 'mongoose';
import { model, Schema } from 'mongoose';

/**
 * Named sequences for human-readable references such as "LD-1001".
 * Each call atomically increments one document, so two requests can never get
 * the same number. Numbers are not reused if a later step fails; gaps are fine.
 */
const counterSchema = new Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

export const Counter = model('Counter', counterSchema);

/** Returns `start` on first use, then start + 1, start + 2, ... */
export async function nextSequence(name: string, start: number, session?: ClientSession): Promise<number> {
  // $inc on a missing (upserted) document starts from 0, so the first call yields seq = 1.
  const counter = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session },
  ).lean();
  return start - 1 + counter!.seq;
}
