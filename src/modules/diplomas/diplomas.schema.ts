import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination.js';
import { booleanQuery, multiValue, objectIdSchema, optionalText } from '../../utils/schemas.js';
import { COURSE_LEVELS } from '../courses/course.model.js';
import { DIPLOMA_STATUSES, MAX_DIPLOMA_COURSES } from './diploma.model.js';

/** Ordered list of course ids (the frontend's `courseIds[]`). No repeats. */
const courseIds = z
  .array(objectIdSchema)
  .max(MAX_DIPLOMA_COURSES, `A diploma can contain at most ${MAX_DIPLOMA_COURSES} courses`)
  .refine((ids) => new Set(ids).size === ids.length, 'A course can appear only once in a diploma');

const fields = {
  name: z.string().trim().min(2, 'Name is too short').max(150),
  description: z.string().trim().max(5000),
  level: z.enum(COURSE_LEVELS),
  duration: optionalText(80),
  /** Whole AED (see config/money.ts). */
  price: z.number().int('Price must be a whole amount').min(0).max(100_000_000).nullable(),
  status: z.enum(DIPLOMA_STATUSES),
  courseIds,
};

/** Server-managed fields (archive fields, createdBy, timestamps) are not accepted. */
export const createDiplomaSchema = z.object({
  ...fields,
  description: fields.description.default(''),
  price: fields.price.optional(),
  status: fields.status.default('UPCOMING'),
  courseIds: fields.courseIds.default([]),
});

/** `courseIds`, when sent, replaces the whole list (order matters). */
export const updateDiplomaSchema = z
  .object({
    name: fields.name.optional(),
    description: fields.description.optional(),
    level: fields.level.optional(),
    duration: fields.duration,
    price: fields.price.optional(),
    status: fields.status.optional(),
    courseIds: fields.courseIds.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  });

export const listDiplomasQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().min(1).max(100).optional(),
  status: multiValue(z.enum(DIPLOMA_STATUSES)),
  level: multiValue(z.enum(COURSE_LEVELS)),
  /** Diplomas that contain any of these courses. */
  course: multiValue(objectIdSchema),
  archived: booleanQuery.default(false),
  sortBy: z.enum(['createdAt', 'name', 'price']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export type CreateDiplomaInput = z.infer<typeof createDiplomaSchema>;
export type UpdateDiplomaInput = z.infer<typeof updateDiplomaSchema>;
export type ListDiplomasQuery = z.infer<typeof listDiplomasQuerySchema>;
