import { Router } from 'express';
import { assignmentsRouter } from '../modules/assignments/assignments.routes.js';
import { authRouter } from '../modules/auth/auth.routes.js';
import { campaignsRouter } from '../modules/campaigns/campaigns.routes.js';
import { coursesRouter } from '../modules/courses/courses.routes.js';
import { dashboardRouter } from '../modules/dashboard/dashboard.routes.js';
import { diplomasRouter } from '../modules/diplomas/diplomas.routes.js';
import { enrollmentsRouter } from '../modules/enrollments/enrollments.routes.js';
import { healthRouter } from '../modules/health/health.routes.js';
import { leadsRouter } from '../modules/leads/leads.routes.js';
import { reportsRouter } from '../modules/reports/reports.routes.js';
import { rolesRouter } from '../modules/roles/roles.routes.js';
import { studentsRouter } from '../modules/students/students.routes.js';
import { trainersRouter } from '../modules/trainers/trainers.routes.js';
import { usersRouter } from '../modules/users/users.routes.js';

/**
 * Version 1 of the API, mounted at /api/v1.
 * Each module owns its router; register new modules here as they are built.
 */
export const v1Router = Router();

v1Router.use('/health', healthRouter);
v1Router.use('/auth', authRouter);
v1Router.use('/users', usersRouter);
v1Router.use('/roles', rolesRouter);
v1Router.use('/leads', leadsRouter);
v1Router.use('/courses', coursesRouter);
v1Router.use('/students', studentsRouter);
v1Router.use('/enrollments', enrollmentsRouter);
v1Router.use('/trainers', trainersRouter);
v1Router.use('/trainer-assignments', assignmentsRouter);
v1Router.use('/diplomas', diplomasRouter);
v1Router.use('/campaigns', campaignsRouter);
v1Router.use('/dashboard', dashboardRouter);
v1Router.use('/reports', reportsRouter);
