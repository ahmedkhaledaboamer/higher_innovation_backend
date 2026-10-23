import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { idParamsSchema } from '../../utils/schemas.js';
import { PERMISSIONS } from '../roles/permissions.js';
import { diplomasController } from './diplomas.controller.js';
import { createDiplomaSchema, listDiplomasQuerySchema, updateDiplomaSchema } from './diplomas.schema.js';

/** Diplomas are catalog data: courses:read to read, courses:write (Owner, Admin) to change. */
const canRead = authorize(PERMISSIONS.COURSES_READ);
const canWrite = authorize(PERMISSIONS.COURSES_WRITE);
const byId = validate({ params: idParamsSchema });

export const diplomasRouter = Router();

diplomasRouter.use(authenticate);

diplomasRouter.get('/', canRead, validate({ query: listDiplomasQuerySchema }), diplomasController.list);
diplomasRouter.post('/', canWrite, validate({ body: createDiplomaSchema }), diplomasController.create);
diplomasRouter.get('/:id', canRead, byId, diplomasController.getById);
diplomasRouter.patch('/:id', canWrite, validate({ params: idParamsSchema, body: updateDiplomaSchema }), diplomasController.update);
diplomasRouter.post('/:id/archive', canWrite, byId, diplomasController.archive);
diplomasRouter.post('/:id/restore', canWrite, byId, diplomasController.restore);
