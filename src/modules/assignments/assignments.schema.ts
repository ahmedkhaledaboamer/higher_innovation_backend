import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination.js';
import { booleanQuery, dateInput, multiValue, objectIdSchema } from '../../utils/schemas.js';
import { ASSIGNMENT_ROLES, ASSIGNMENT_STATUSES } from './assignment.model.js';

const datesInOrder = (body: { startDate?: Date | null; endDate?: Date | null }) =>
  !body.startDate || !body.endDate || body.endDate >= body.startDate;
const datesMessage = { path: ['endDate'], message: 'endDate cannot be before startDate' };

/** Statuses an assignment can be created in or moved between while open. */
const openStatus = z.enum(['SCHEDULED', 'ACTIVE']);

/** Server-managed fields (isOpen, ended*, assignedBy) are not accepted. */
export const createAssignmentSchema = z
  .object({
    trainerId: objectIdSchema,
    courseId: objectIdSchema,
    role: z.enum(ASSIGNMENT_ROLES),
    status: openStatus.default('ACTIVE'),
    startDate: dateInput.nullable().optional(),
    endDate: dateInput.nullable().optional(),
    teachingHours: z.number().int().min(0).max(10_000).nullable().optional(),
  })
  .refine(datesInOrder, datesMessage);

/** Only open assignments can be edited; trainer and course are fixed (end and re-assign instead). */
export const updateAssignmentSchema = z
  .object({
    role: z.enum(ASSIGNMENT_ROLES).optional(),
    status: openStatus.optional(),
    startDate: dateInput.nullable().optional(),
    endDate: dateInput.nullable().optional(),
    teachingHours: z.number().int().min(0).max(10_000).nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  })
  .refine(datesInOrder, datesMessage);

/** Ending is final; the assignment stays as history. */
export const endAssignmentSchema = z.object({
  status: z.enum(['COMPLETED', 'CANCELLED']),
});

export const listAssignmentsQuerySchema = paginationQuerySchema.extend({
  trainer: multiValue(objectIdSchema),
  course: multiValue(objectIdSchema),
  status: multiValue(z.enum(ASSIGNMENT_STATUSES)),
  role: multiValue(z.enum(ASSIGNMENT_ROLES)),
  /** true: SCHEDULED/ACTIVE only; false: ended only. */
  open: booleanQuery.optional(),
  sortBy: z.enum(['createdAt', 'startDate']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type UpdateAssignmentInput = z.infer<typeof updateAssignmentSchema>;
export type ListAssignmentsQuery = z.infer<typeof listAssignmentsQuerySchema>;
