import { type InferSchemaType, model, Schema } from 'mongoose';

/**
 * A note on a lead (call summary, objection, follow-up plan...). Kept in its own
 * collection rather than an array inside the lead, because notes grow without limit
 * and are listed page by page.
 */
const leadNoteSchema = new Schema(
  {
    lead: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    pinned: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Pinned first, then newest first, per lead.
leadNoteSchema.index({ lead: 1, pinned: -1, createdAt: -1 });

export type LeadNoteFields = InferSchemaType<typeof leadNoteSchema>;

export const LeadNote = model('LeadNote', leadNoteSchema);
