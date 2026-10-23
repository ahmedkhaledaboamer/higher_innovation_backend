import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination.js';
import { booleanQuery, dateInput, multiValue, objectIdSchema, optionalText } from '../../utils/schemas.js';
import { STUDENT_STATUSES } from './student.model.js';

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
const dateOfBirth = z.iso
  .date('Use YYYY-MM-DD')
  .transform((value) => new Date(value))
  .refine((date) => date < new Date(), 'Date of birth must be in the past')
  .nullable()
  .optional();

const hasContact = (body: { email?: string | null; phone?: string | null }) => Boolean(body.email || body.phone);

/**
 * Not accepted (stripped if sent): studentNumber, activeEnrollments, archive fields, createdBy,
 * timestamps. `advisor` is only honoured for callers with students:assign. The link to a lead
 * is set by lead conversion (Phase 5), not here.
 */
export const createStudentSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Name is too short').max(120),
    email,
    phone,
    country: optionalText(80),
    city: optionalText(80),
    profession: optionalText(120),
    dateOfBirth,
    status: z.enum(STUDENT_STATUSES).default('ACTIVE'),
    advisor: objectIdSchema.nullable().optional(),
    /** Create even if an active student with the same email/phone exists (students:update_all only). */
    allowDuplicate: z.boolean().default(false),
  })
  .refine(hasContact, { path: ['phone'], message: 'Provide a phone number or an email address' });

/** Advisor changes have their own endpoint; archiving too. */
export const updateStudentSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Name is too short').max(120).optional(),
    email,
    phone,
    country: optionalText(80),
    city: optionalText(80),
    profession: optionalText(120),
    dateOfBirth,
    status: z.enum(STUDENT_STATUSES).optional(),
    /**
     * Keep the change even if another active student already has this email/phone (D55). Only
     * students:update_all holders (Owner, Admin); others get 403 FORBIDDEN_FIELD when it is true.
     */
    allowDuplicate: z.boolean().default(false),
  })
  .refine(({ allowDuplicate: _allowDuplicate, ...fields }) => Object.values(fields).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  });

export const assignAdvisorSchema = z.object({
  /** User to make the advisor; null removes the advisor. */
  advisor: objectIdSchema.nullable(),
});

export const STUDENT_SORT_FIELDS = ['createdAt', 'updatedAt', 'fullName', 'studentNumber', 'country'] as const;

export const listStudentsQuerySchema = paginationQuerySchema.extend({
  /** Matches name, email, phone digits or student number (case-insensitive, partial). */
  search: z.string().trim().min(1).max(100).optional(),
  status: multiValue(z.enum(STUDENT_STATUSES)),
  country: multiValue(z.string().max(80)),
  /** User ids, or "unassigned". Narrowed to the caller for roles that only see their own students. */
  advisor: multiValue(z.union([objectIdSchema, z.literal('unassigned')])),
  /** Students with a non-withdrawn enrollment in any of these courses. */
  course: multiValue(objectIdSchema),
  createdFrom: dateInput.optional(),
  createdTo: dateInput.optional(),
  archived: booleanQuery.default(false),
  sortBy: z.enum(STUDENT_SORT_FIELDS).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export type CreateStudentInput = z.infer<typeof createStudentSchema>;
export type UpdateStudentInput = z.infer<typeof updateStudentSchema>;
export type ListStudentsQuery = z.infer<typeof listStudentsQuerySchema>;
