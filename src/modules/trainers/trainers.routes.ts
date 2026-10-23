import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { idParamsSchema } from '../../utils/schemas.js';
import { PERMISSIONS } from '../roles/permissions.js';
import { trainersController } from './trainers.controller.js';
import { createTrainerSchema, listTrainersQuerySchema, updateTrainerSchema } from './trainers.schema.js';

/**
 * Trainer profiles. Read: trainers:read (Owner, Admin, HR, Viewer). Write: trainers:write
 * (Owner, Admin). A trainer sees their own profile through /trainers/me (trainers:read_own).
 */
const canRead = authorize(PERMISSIONS.TRAINERS_READ);
const canWrite = authorize(PERMISSIONS.TRAINERS_WRITE);
const byId = validate({ params: idParamsSchema });

export const trainersRouter = Router();

trainersRouter.use(authenticate);

trainersRouter.get('/', canRead, validate({ query: listTrainersQuerySchema }), trainersController.list);
trainersRouter.post('/', canWrite, validate({ body: createTrainerSchema }), trainersController.create);
// Registered before '/:id' so "me" is not parsed as an id.
trainersRouter.get('/me', authorize(PERMISSIONS.TRAINERS_READ_OWN), trainersController.me);
trainersRouter.get('/:id', canRead, byId, trainersController.getById);
trainersRouter.patch('/:id', canWrite, validate({ params: idParamsSchema, body: updateTrainerSchema }), trainersController.update);
trainersRouter.post('/:id/archive', canWrite, byId, trainersController.archive);
trainersRouter.post('/:id/restore', canWrite, byId, trainersController.restore);
