import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination.js';
import { booleanQuery, multiValue, objectIdSchema, optionalText } from '../../utils/schemas.js';
import { TRAINER_STATUSES } from './trainer.model.js';

const email = z.string().trim().toLowerCase().pipe(z.email('Invalid email address')).pipe(z.string().max(254));
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9\s().-]{6,30}$/, 'Invalid phone number')
  .nullable()
  .optional();
const joinDate = z.iso
  .date('Use YYYY-MM-DD')
  .transform((value) => new Date(value))
  .nullable()
  .optional();

const fields = {
  fullName: z.string().trim().min(2, 'Name is too short').max(120),
  email,
  phone,
  title: optionalText(120),
  specialization: optionalText(120),
  bio: z.string().trim().max(3000),
  status: z.enum(TRAINER_STATUSES),
  experienceYears: z.number().int().min(0).max(70).nullable(),
  weeklyCapacityHours: z.number().int().min(0).max(80).nullable(),
  joinDate,
  city: optionalText(80),
  country: optionalText(80),
  /** Login account to link (role TRAINER); null unlinks. */
  userId: objectIdSchema.nullable(),
};

/** Server-managed fields (code, openAssignments, archive fields, createdBy) are not accepted. */
export const createTrainerSchema = z.object({
  ...fields,
  bio: fields.bio.default(''),
  status: fields.status.default('ACTIVE'),
  experienceYears: fields.experienceYears.optional(),
  weeklyCapacityHours: fields.weeklyCapacityHours.optional(),
  userId: fields.userId.optional(),
});

export const updateTrainerSchema = z
  .object({
    fullName: fields.fullName.optional(),
    email: fields.email.optional(),
    phone: fields.phone,
    title: fields.title,
    specialization: fields.specialization,
    bio: fields.bio.optional(),
    status: fields.status.optional(),
    experienceYears: fields.experienceYears.optional(),
    weeklyCapacityHours: fields.weeklyCapacityHours.optional(),
    joinDate: fields.joinDate,
    city: fields.city,
    country: fields.country,
    userId: fields.userId.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  });

export const TRAINER_SORT_FIELDS = ['createdAt', 'fullName', 'joinDate', 'experienceYears', 'code'] as const;

export const listTrainersQuerySchema = paginationQuerySchema.extend({
  /** Matches name, email, code, title or specialization (case-insensitive, partial). */
  search: z.string().trim().min(1).max(100).optional(),
  status: multiValue(z.enum(TRAINER_STATUSES)),
  specialization: multiValue(z.string().max(120)),
  /** Trainers with an open assignment to any of these courses. */
  course: multiValue(objectIdSchema),
  archived: booleanQuery.default(false),
  sortBy: z.enum(TRAINER_SORT_FIELDS).default('fullName'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});

export type CreateTrainerInput = z.infer<typeof createTrainerSchema>;
export type UpdateTrainerInput = z.infer<typeof updateTrainerSchema>;
export type ListTrainersQuery = z.infer<typeof listTrainersQuerySchema>;
