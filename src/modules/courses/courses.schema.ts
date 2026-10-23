import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination.js';
import { booleanQuery, dateInput, multiValue, optionalText } from '../../utils/schemas.js';
import { COURSE_LEVELS, COURSE_STATUSES } from './course.model.js';

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, 'Code must be 2-20 letters, digits or dashes, e.g. DA-101');

const fields = {
  code,
  name: z.string().trim().min(2, 'Name is too short').max(150),
  description: z.string().trim().max(5000),
  level: z.enum(COURSE_LEVELS),
  duration: optionalText(80),
  hours: z.number().int().min(0).max(10_000).nullable(),
  price: z.number().int('Price must be a whole amount').min(0).max(100_000_000),
  seats: z.number().int().min(1).max(10_000).nullable(),
  startDate: dateInput.nullable(),
  endDate: dateInput.nullable(),
  status: z.enum(COURSE_STATUSES),
};

const datesInOrder = (body: { startDate?: Date | null; endDate?: Date | null }) =>
  !body.startDate || !body.endDate || body.endDate >= body.startDate;
const datesMessage = { path: ['endDate'], message: 'endDate cannot be before startDate' };

/** Server-managed fields (enrolledCount, archive fields, createdBy, timestamps) are not accepted. */
export const createCourseSchema = z
  .object({
    ...fields,
    description: fields.description.default(''),
    hours: fields.hours.optional(),
    seats: fields.seats.optional(),
    startDate: fields.startDate.optional(),
    endDate: fields.endDate.optional(),
    status: fields.status.default('DRAFT'),
  })
  .refine(datesInOrder, datesMessage);

export const updateCourseSchema = z
  .object({
    code: fields.code.optional(),
    name: fields.name.optional(),
    description: fields.description.optional(),
    level: fields.level.optional(),
    duration: fields.duration,
    hours: fields.hours.optional(),
    price: fields.price.optional(),
    seats: fields.seats.optional(),
    startDate: fields.startDate.optional(),
    endDate: fields.endDate.optional(),
    status: fields.status.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  })
  .refine(datesInOrder, datesMessage);

export const COURSE_SORT_FIELDS = ['createdAt', 'name', 'code', 'startDate', 'price'] as const;

export const listCoursesQuerySchema = paginationQuerySchema.extend({
  /** Matches name or code (case-insensitive, partial). */
  search: z.string().trim().min(1).max(100).optional(),
  status: multiValue(z.enum(COURSE_STATUSES)),
  level: multiValue(z.enum(COURSE_LEVELS)),
  startFrom: dateInput.optional(),
  startTo: dateInput.optional(),
  /** Only courses that accept enrollments right now (UPCOMING/ACTIVE, not archived, seats left). */
  enrollable: booleanQuery.optional(),
  archived: booleanQuery.default(false),
  sortBy: z.enum(COURSE_SORT_FIELDS).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export type CreateCourseInput = z.infer<typeof createCourseSchema>;
export type UpdateCourseInput = z.infer<typeof updateCourseSchema>;
export type ListCoursesQuery = z.infer<typeof listCoursesQuerySchema>;
