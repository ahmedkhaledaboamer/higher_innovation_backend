import { z } from 'zod';

const email = z.string().trim().toLowerCase().pipe(z.email('Invalid email address'));

/**
 * Password policy for new passwords: 10+ characters with at least one letter and one digit.
 * bcrypt only uses the first 72 bytes, so longer passwords are rejected rather than
 * silently truncated.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be at most 72 bytes')
  .refine((value) => /\p{L}/u.test(value) && /\p{N}/u.test(value), 'Password must contain a letter and a digit');

export const loginSchema = z.object({
  email,
  // No policy check on login: existing passwords are verified, not re-validated.
  password: z.string().min(1, 'Password is required').max(200),
});

/**
 * Self-service profile edit (PATCH /auth/me). Only personal display fields: email (the login
 * identifier), role, status and department stay under administrator control (PATCH /users/:id).
 */
export const updateOwnProfileSchema = z
  .object({
    firstName: z.string().trim().min(1, 'Required').max(60).optional(),
    lastName: z.string().trim().min(1, 'Required').max(60).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9\s().-]{6,30}$/, 'Invalid phone number')
      .nullable()
      .optional(),
    location: z
      .string()
      .trim()
      .max(80)
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  });

export type UpdateOwnProfileInput = z.infer<typeof updateOwnProfileSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required').max(200),
    newPassword: passwordSchema,
  })
  .refine((body) => body.currentPassword !== body.newPassword, {
    path: ['newPassword'],
    message: 'New password must be different from the current one',
  });

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(20, 'Invalid token').max(200, 'Invalid token'),
  password: passwordSchema,
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
