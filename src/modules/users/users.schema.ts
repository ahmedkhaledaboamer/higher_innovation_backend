import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination.js';
import { multiValue, optionalText } from '../../utils/schemas.js';
import { ROLE_KEYS } from '../roles/permissions.js';
import { USER_STATUSES } from './user.model.js';

const name = z.string().trim().min(1, 'Required').max(60);
const email = z.string().trim().toLowerCase().pipe(z.email('Invalid email address')).pipe(z.string().max(254));
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9\s().-]{6,30}$/, 'Invalid phone number')
  .nullable()
  .optional();

/**
 * Creating a staff account. No password field on purpose: the new user receives an
 * invitation email and chooses their own password.
 */
export const createUserSchema = z.object({
  firstName: name,
  lastName: name,
  email,
  phone,
  role: z.enum(ROLE_KEYS),
  department: optionalText(80),
  location: optionalText(80),
});

/** Profile and status changes. Role changes have their own endpoint and checks. */
export const updateUserSchema = z
  .object({
    firstName: name.optional(),
    lastName: name.optional(),
    phone,
    department: optionalText(80),
    location: optionalText(80),
    // INVITED is not settable: an account leaves it only by accepting the invitation.
    status: z.enum(['ACTIVE', 'SUSPENDED', 'INACTIVE']).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one field to update' });

export const assignRoleSchema = z.object({ role: z.enum(ROLE_KEYS) });

export const listUsersQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  /** One or more roles: `?role=SALES,MARKETING` or repeated keys. */
  role: multiValue(z.enum(ROLE_KEYS)),
  status: multiValue(z.enum(USER_STATUSES)),
  sortBy: z.enum(['createdAt', 'lastName', 'email', 'lastLoginAt']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
