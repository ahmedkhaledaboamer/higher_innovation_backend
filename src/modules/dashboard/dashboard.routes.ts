import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { validate } from '../../middlewares/validate.js';
import { dashboardQuerySchema } from '../reports/reports.schema.js';
import { dashboardController } from './dashboard.controller.js';

/**
 * Every signed-in user may call the dashboard; what it contains is decided per section by the
 * caller's permissions and scopes (see dashboard.service.ts). No extra filters are accepted,
 * so a caller cannot widen a section's scope through the query string.
 */
export const dashboardRouter = Router();

dashboardRouter.get('/summary', authenticate, validate({ query: dashboardQuerySchema }), dashboardController.summary);
