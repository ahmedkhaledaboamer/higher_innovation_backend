import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize, authorizeAny } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { idParamsSchema } from '../../utils/schemas.js';
import { enrollmentsController } from '../enrollments/enrollments.controller.js';
import { createEnrollmentSchema } from '../enrollments/enrollments.schema.js';
import { PERMISSIONS } from '../roles/permissions.js';
import { studentsController } from './students.controller.js';
import { assignAdvisorSchema, createStudentSchema, listStudentsQuerySchema, updateStudentSchema } from './students.schema.js';

/**
 * Route checks answer "may this role do this kind of thing at all?". Which students the
 * caller can touch (Sales: only those they advise) is enforced in every service query.
 */
const canRead = authorizeAny(
  PERMISSIONS.STUDENTS_READ_ALL,
  PERMISSIONS.STUDENTS_READ_ASSIGNED,
  // Trainers: only students of the courses they teach, reduced fields (see student.access.ts).
  PERMISSIONS.STUDENTS_READ_TEACHING,
);
const canWrite = authorizeAny(PERMISSIONS.STUDENTS_UPDATE_ALL, PERMISSIONS.STUDENTS_UPDATE_ASSIGNED);
const byId = validate({ params: idParamsSchema });

export const studentsRouter = Router();

studentsRouter.use(authenticate);

studentsRouter.get('/', canRead, validate({ query: listStudentsQuerySchema }), studentsController.list);
studentsRouter.post('/', authorize(PERMISSIONS.STUDENTS_CREATE), validate({ body: createStudentSchema }), studentsController.create);
studentsRouter.get('/:id', canRead, byId, studentsController.getById);
studentsRouter.patch('/:id', canWrite, validate({ params: idParamsSchema, body: updateStudentSchema }), studentsController.update);
studentsRouter.patch(
  '/:id/advisor',
  authorize(PERMISSIONS.STUDENTS_ASSIGN),
  validate({ params: idParamsSchema, body: assignAdvisorSchema }),
  studentsController.assignAdvisor,
);
studentsRouter.post('/:id/archive', authorize(PERMISSIONS.STUDENTS_ARCHIVE), byId, studentsController.archive);
studentsRouter.post('/:id/restore', authorize(PERMISSIONS.STUDENTS_ARCHIVE), byId, studentsController.restore);

// Enrolling a student in a course (blueprint: POST /students/:id/enrollments).
studentsRouter.post(
  '/:id/enrollments',
  authorize(PERMISSIONS.ENROLLMENTS_WRITE),
  canWrite,
  validate({ params: idParamsSchema, body: createEnrollmentSchema }),
  enrollmentsController.create,
);
