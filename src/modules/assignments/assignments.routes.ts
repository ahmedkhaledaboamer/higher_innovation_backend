import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize, authorizeAny } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { idParamsSchema } from '../../utils/schemas.js';
import { PERMISSIONS } from '../roles/permissions.js';
import { assignmentsController } from './assignments.controller.js';
import {
  createAssignmentSchema,
  endAssignmentSchema,
  listAssignmentsQuerySchema,
  updateAssignmentSchema,
} from './assignments.schema.js';

/**
 * Trainer ↔ course assignments. Read: trainers:read (all) or trainers:read_own (a trainer's own,
 * enforced in the service). Write: trainers:write (Owner, Admin).
 */
const canRead = authorizeAny(PERMISSIONS.TRAINERS_READ, PERMISSIONS.TRAINERS_READ_OWN);
const canWrite = authorize(PERMISSIONS.TRAINERS_WRITE);

export const assignmentsRouter = Router();

assignmentsRouter.use(authenticate);

assignmentsRouter.get('/', canRead, validate({ query: listAssignmentsQuerySchema }), assignmentsController.list);
assignmentsRouter.post('/', canWrite, validate({ body: createAssignmentSchema }), assignmentsController.create);
assignmentsRouter.get('/:id', canRead, validate({ params: idParamsSchema }), assignmentsController.getById);
assignmentsRouter.patch(
  '/:id',
  canWrite,
  validate({ params: idParamsSchema, body: updateAssignmentSchema }),
  assignmentsController.update,
);
assignmentsRouter.post(
  '/:id/end',
  canWrite,
  validate({ params: idParamsSchema, body: endAssignmentSchema }),
  assignmentsController.end,
);
