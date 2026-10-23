import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { idParamsSchema } from '../../utils/schemas.js';
import { PERMISSIONS } from '../roles/permissions.js';
import { usersController } from './users.controller.js';
import { assignRoleSchema, createUserSchema, listUsersQuerySchema, updateUserSchema } from './users.schema.js';

export const usersRouter = Router();

// Every users endpoint requires a signed-in, active account.
usersRouter.use(authenticate);

usersRouter.get(
  '/',
  authorize(PERMISSIONS.USERS_READ),
  validate({ query: listUsersQuerySchema }),
  usersController.list,
);

usersRouter.post(
  '/',
  authorize(PERMISSIONS.USERS_CREATE),
  validate({ body: createUserSchema }),
  usersController.create,
);

usersRouter.get(
  '/:id',
  authorize(PERMISSIONS.USERS_READ),
  validate({ params: idParamsSchema }),
  usersController.getById,
);

usersRouter.patch(
  '/:id',
  authorize(PERMISSIONS.USERS_UPDATE),
  validate({ params: idParamsSchema, body: updateUserSchema }),
  usersController.update,
);

usersRouter.patch(
  '/:id/role',
  authorize(PERMISSIONS.USERS_ASSIGN_ROLE),
  validate({ params: idParamsSchema, body: assignRoleSchema }),
  usersController.assignRole,
);

usersRouter.post(
  '/:id/resend-invite',
  authorize(PERMISSIONS.USERS_CREATE),
  validate({ params: idParamsSchema }),
  usersController.resendInvite,
);
