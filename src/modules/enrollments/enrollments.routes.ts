import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize, authorizeAny } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { idParamsSchema } from '../../utils/schemas.js';
import { PERMISSIONS } from '../roles/permissions.js';
import { enrollmentsController } from './enrollments.controller.js';
import { listEnrollmentsQuerySchema, updateEnrollmentStatusSchema } from './enrollments.schema.js';

/**
 * Enrollments are created under the student (POST /students/:id/enrollments).
 * Visibility follows the student: callers see the enrollments of the students they can see.
 */
const canRead = [
  authorize(PERMISSIONS.ENROLLMENTS_READ),
  // Trainers: only enrollments in the courses they teach, without price (see enrollments.service.ts).
  authorizeAny(PERMISSIONS.STUDENTS_READ_ALL, PERMISSIONS.STUDENTS_READ_ASSIGNED, PERMISSIONS.STUDENTS_READ_TEACHING),
];
const canWrite = [
  authorize(PERMISSIONS.ENROLLMENTS_WRITE),
  authorizeAny(PERMISSIONS.STUDENTS_UPDATE_ALL, PERMISSIONS.STUDENTS_UPDATE_ASSIGNED),
];

export const enrollmentsRouter = Router();

enrollmentsRouter.use(authenticate);

enrollmentsRouter.get('/', ...canRead, validate({ query: listEnrollmentsQuerySchema }), enrollmentsController.list);
enrollmentsRouter.get('/:id', ...canRead, validate({ params: idParamsSchema }), enrollmentsController.getById);
enrollmentsRouter.patch(
  '/:id/status',
  ...canWrite,
  validate({ params: idParamsSchema, body: updateEnrollmentStatusSchema }),
  enrollmentsController.updateStatus,
);
