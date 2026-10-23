import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination.js';
import { dateInput, multiValue, objectIdSchema } from '../../utils/schemas.js';
import { ENROLLMENT_STATUSES } from './enrollment.model.js';

/**
 * Enrolling a student (the student comes from the URL). Server-managed fields
 * (price, status timestamps, enrolledBy) are not accepted. New enrollments start
 * as NOT_STARTED; use the status endpoint afterwards.
 */
export const createEnrollmentSchema = z.object({
  courseId: objectIdSchema,
  /** Defaults to now. May be in the past (recording an earlier registration), not in the future. */
  enrolledAt: dateInput
    .refine((date) => date.getTime() <= Date.now() + 60_000, 'enrolledAt cannot be in the future')
    .optional(),
});

export const updateEnrollmentStatusSchema = z.object({
  status: z.enum(ENROLLMENT_STATUSES),
});

export const ENROLLMENT_SORT_FIELDS = ['enrolledAt', 'createdAt', 'updatedAt'] as const;

export const listEnrollmentsQuerySchema = paginationQuerySchema.extend({
  student: multiValue(objectIdSchema),
  course: multiValue(objectIdSchema),
  status: multiValue(z.enum(ENROLLMENT_STATUSES)),
  enrolledFrom: dateInput.optional(),
  enrolledTo: dateInput.optional(),
  sortBy: z.enum(ENROLLMENT_SORT_FIELDS).default('enrolledAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export type CreateEnrollmentInput = z.infer<typeof createEnrollmentSchema>;
export type UpdateEnrollmentStatusInput = z.infer<typeof updateEnrollmentStatusSchema>;
export type ListEnrollmentsQuery = z.infer<typeof listEnrollmentsQuerySchema>;
