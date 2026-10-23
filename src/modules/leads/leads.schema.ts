import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination.js';
import { booleanQuery, dateInput, multiValue, objectIdSchema, optionalText } from '../../utils/schemas.js';
import { STUDENT_STATUSES } from '../students/student.model.js';
import { LEAD_PRIORITIES, LEAD_SOURCES, LEAD_STATUSES, LEAD_TAGS } from './lead.model.js';

/** Statuses a user may set directly. REGISTERED is reserved for lead-to-student conversion. */
export const SETTABLE_LEAD_STATUSES = LEAD_STATUSES.filter((status) => status !== 'REGISTERED') as [
  Exclude<(typeof LEAD_STATUSES)[number], 'REGISTERED'>,
  ...Exclude<(typeof LEAD_STATUSES)[number], 'REGISTERED'>[],
];

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Invalid email address'))
  .pipe(z.string().max(254))
  .nullable()
  .optional();
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9\s().-]{6,30}$/, 'Invalid phone number')
  .nullable()
  .optional();

const utm = z
  .object({
    source: optionalText(200),
    medium: optionalText(200),
    campaign: optionalText(200),
    term: optionalText(200),
    content: optionalText(200),
  })
  .nullable()
  .optional();

/** Fields describing the person and their interest; shared by create and update. */
const profileFields = {
  fullName: z.string().trim().min(2, 'Name is too short').max(120),
  email,
  phone,
  country: optionalText(80),
  city: optionalText(80),
  profession: optionalText(120),
  source: z.enum(LEAD_SOURCES),
  utm,
  priority: z.enum(LEAD_PRIORITIES),
  tags: z
    .array(z.enum(LEAD_TAGS))
    .max(LEAD_TAGS.length)
    .transform((tags) => [...new Set(tags)]),
  budget: z.number().min(0).max(1_000_000_000).nullable(),
  nextFollowUpAt: dateInput.nullable(),
};

const hasContact = (body: { email?: string | null; phone?: string | null }) => Boolean(body.email || body.phone);

/**
 * Creating a lead. Not accepted (stripped if sent): reference, notesCount, archive fields,
 * createdBy, timestamps. `assignedTo` is only honoured for callers allowed to assign leads.
 */
export const createLeadSchema = z
  .object({
    ...profileFields,
    priority: profileFields.priority.default('MEDIUM'),
    tags: profileFields.tags.default([]),
    budget: profileFields.budget.optional(),
    nextFollowUpAt: profileFields.nextFollowUpAt.optional(),
    status: z.enum(SETTABLE_LEAD_STATUSES).default('NEW'),
    assignedTo: objectIdSchema.nullable().optional(),
    /** Campaign that produced the lead. Only honoured for callers with campaigns:read. */
    campaignId: objectIdSchema.nullable().optional(),
    /** Create even if an active lead with the same email/phone exists (managers only). */
    allowDuplicate: z.boolean().default(false),
  })
  .refine(hasContact, { path: ['phone'], message: 'Provide a phone number or an email address' });

/**
 * Editing the lead's details. Status, assignment and archiving have their own endpoints
 * (with their own rules), so they are not accepted here.
 */
export const updateLeadSchema = z
  .object({
    fullName: profileFields.fullName.optional(),
    email: profileFields.email,
    phone: profileFields.phone,
    country: profileFields.country,
    city: profileFields.city,
    profession: profileFields.profession,
    source: profileFields.source.optional(),
    utm: profileFields.utm,
    priority: profileFields.priority.optional(),
    tags: profileFields.tags.optional(),
    budget: profileFields.budget.optional(),
    nextFollowUpAt: profileFields.nextFollowUpAt.optional(),
    /**
     * Keep the change even if another active lead already has this email/phone (D55). Only
     * leads:update_all holders (Owner, Admin); others get 403 FORBIDDEN_FIELD when it is true.
     */
    allowDuplicate: z.boolean().default(false),
  })
  .refine(({ allowDuplicate: _allowDuplicate, ...fields }) => Object.values(fields).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  });

export const assignLeadSchema = z.object({
  /** User to assign; null removes the assignment. */
  assignedTo: objectIdSchema.nullable(),
});

export const updateLeadStatusSchema = z
  .object({
    status: z.enum(SETTABLE_LEAD_STATUSES, {
      error: `Status must be one of ${SETTABLE_LEAD_STATUSES.join(', ')} (REGISTERED is set by converting the lead)`,
    }),
    lostReason: z.string().trim().min(1).max(500).optional(),
  })
  .refine((body) => body.status === 'LOST' || body.lostReason === undefined, {
    path: ['lostReason'],
    message: 'lostReason is only allowed when status is LOST',
  });

export const createLeadNoteSchema = z.object({
  body: z.string().trim().min(1, 'Note cannot be empty').max(5000),
  pinned: z.boolean().default(false),
});

export const LEAD_SORT_FIELDS = ['createdAt', 'updatedAt', 'fullName', 'status', 'country', 'nextFollowUpAt'] as const;

export const listLeadsQuerySchema = paginationQuerySchema.extend({
  /** Matches name, email, phone digits or reference (case-insensitive, partial). */
  search: z.string().trim().min(1).max(100).optional(),
  status: multiValue(z.enum(LEAD_STATUSES)),
  source: multiValue(z.enum(LEAD_SOURCES)),
  priority: multiValue(z.enum(LEAD_PRIORITIES)),
  tags: multiValue(z.enum(LEAD_TAGS)),
  country: multiValue(z.string().max(80)),
  /** User ids, or "unassigned". Narrowed to the caller for roles that only see their own leads. */
  assignedTo: multiValue(z.union([objectIdSchema, z.literal('unassigned')])),
  /** Campaign ids, or "none" for leads without a campaign. Narrowed to the caller's lead scope. */
  campaign: multiValue(z.union([objectIdSchema, z.literal('none')])),
  createdFrom: dateInput.optional(),
  createdTo: dateInput.optional(),
  /** Leads whose next follow-up is due before this moment. */
  followUpBefore: dateInput.optional(),
  /** false (default): active leads; true: archived leads only. */
  archived: booleanQuery.default(false),
  sortBy: z.enum(LEAD_SORT_FIELDS).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export const listLeadNotesQuerySchema = paginationQuerySchema;

/** Explicitly (re)attribute a lead to a campaign; null removes the attribution. */
export const setLeadCampaignSchema = z.object({
  campaignId: objectIdSchema.nullable(),
});

/**
 * Converting a lead into a student. Everything is optional: by default the student's details
 * are copied from the lead. Values sent here correct the student's details only; the lead
 * itself is never changed (it is kept as history).
 *
 * Not accepted (stripped if sent): advisor, studentNumber, conversion/attribution fields,
 * createdBy, lead status. Those are decided by the server.
 */
export const convertLeadSchema = z.object({
  fullName: z.string().trim().min(2, 'Name is too short').max(120).optional(),
  email,
  phone,
  country: optionalText(80),
  city: optionalText(80),
  profession: optionalText(120),
  dateOfBirth: z.iso
    .date('Use YYYY-MM-DD')
    .transform((value) => new Date(value))
    .refine((date) => date < new Date(), 'Date of birth must be in the past')
    .nullable()
    .optional(),
  status: z.enum(STUDENT_STATUSES).default('ACTIVE'),
  /** Create the student even if an active student has the same email/phone (students:update_all only). */
  allowDuplicate: z.boolean().default(false),
});

export type ConvertLeadInput = z.infer<typeof convertLeadSchema>;
export type CreateLeadInput = z.infer<typeof createLeadSchema>;
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;
export type UpdateLeadStatusInput = z.infer<typeof updateLeadStatusSchema>;
export type CreateLeadNoteInput = z.infer<typeof createLeadNoteSchema>;
export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;
