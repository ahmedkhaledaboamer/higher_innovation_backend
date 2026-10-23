import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { PERMISSIONS } from './permissions.js';
import { rolesController } from './roles.controller.js';

export const rolesRouter = Router();

rolesRouter.get('/', authenticate, authorize(PERMISSIONS.ROLES_READ), rolesController.list);
