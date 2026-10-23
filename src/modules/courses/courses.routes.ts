import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { idParamsSchema } from '../../utils/schemas.js';
import { PERMISSIONS } from '../roles/permissions.js';
import { coursesController } from './courses.controller.js';
import { createCourseSchema, listCoursesQuerySchema, updateCourseSchema } from './courses.schema.js';

const canRead = authorize(PERMISSIONS.COURSES_READ);
const canWrite = authorize(PERMISSIONS.COURSES_WRITE);
const byId = validate({ params: idParamsSchema });

export const coursesRouter = Router();

coursesRouter.use(authenticate);

coursesRouter.get('/', canRead, validate({ query: listCoursesQuerySchema }), coursesController.list);
coursesRouter.post('/', canWrite, validate({ body: createCourseSchema }), coursesController.create);
coursesRouter.get('/:id', canRead, byId, coursesController.getById);
coursesRouter.patch('/:id', canWrite, validate({ params: idParamsSchema, body: updateCourseSchema }), coursesController.update);
coursesRouter.post('/:id/archive', canWrite, byId, coursesController.archive);
coursesRouter.post('/:id/restore', canWrite, byId, coursesController.restore);
