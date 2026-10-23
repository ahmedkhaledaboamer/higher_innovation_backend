import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import {
  forgotPasswordRateLimiter,
  loginRateLimiter,
  passwordRateLimiter,
} from '../../middlewares/rateLimiter.js';
import { validate } from '../../middlewares/validate.js';
import { authController } from './auth.controller.js';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  updateOwnProfileSchema,
} from './auth.schema.js';

/**
 * There is deliberately no /register endpoint: staff accounts are created by
 * Owner/Admin through POST /users, and the first Owner by the seed command.
 */
export const authRouter = Router();

authRouter.post('/login', loginRateLimiter, validate({ body: loginSchema }), authController.login);

// Cookie-based: the refresh token arrives in the httpOnly cookie, not the body.
authRouter.post('/refresh', authController.refresh);
authRouter.post('/logout', authController.logout);

authRouter.post('/logout-all', authenticate, authController.logoutAll);
authRouter.get('/me', authenticate, authController.me);
authRouter.patch('/me', authenticate, validate({ body: updateOwnProfileSchema }), authController.updateMe);
authRouter.post(
  '/change-password',
  authenticate,
  passwordRateLimiter,
  validate({ body: changePasswordSchema }),
  authController.changePassword,
);

authRouter.post(
  '/forgot-password',
  forgotPasswordRateLimiter,
  validate({ body: forgotPasswordSchema }),
  authController.forgotPassword,
);
authRouter.post(
  '/reset-password',
  passwordRateLimiter,
  validate({ body: resetPasswordSchema }),
  authController.resetPassword,
);
