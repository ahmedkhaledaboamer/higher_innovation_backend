import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { PERMISSIONS } from '../roles/permissions.js';
import { reportsController } from './reports.controller.js';
import {
  academyReportQuerySchema,
  campaignReportQuerySchema,
  leadBreakdownQuerySchema,
  leadSummaryQuerySchema,
  leadTimeseriesQuerySchema,
} from './reports.schema.js';

/**
 * Academy-wide reports. Each requires reports:read plus read-all access to the data it
 * aggregates, so a report never reveals totals over records the caller could not list:
 *   leads     – leads:read_all                                  (Owner, Admin, Marketing, Viewer)
 *   campaigns – campaigns:read                                  (Owner, Admin, Marketing, Viewer)
 *   academy   – students:read_all + enrollments:read + courses:read (Owner, Admin, Viewer)
 * Sales and Trainers use the scoped /dashboard/summary instead.
 */
const leadReports = authorize(PERMISSIONS.REPORTS_READ, PERMISSIONS.LEADS_READ_ALL);

export const reportsRouter = Router();

reportsRouter.use(authenticate);

reportsRouter.get('/leads/summary', leadReports, validate({ query: leadSummaryQuerySchema }), reportsController.leadSummary);
reportsRouter.get('/leads/timeseries', leadReports, validate({ query: leadTimeseriesQuerySchema }), reportsController.leadTimeseries);
reportsRouter.get('/leads/breakdown', leadReports, validate({ query: leadBreakdownQuerySchema }), reportsController.leadBreakdown);
reportsRouter.get(
  '/campaigns',
  authorize(PERMISSIONS.REPORTS_READ, PERMISSIONS.CAMPAIGNS_READ),
  validate({ query: campaignReportQuerySchema }),
  reportsController.campaigns,
);
reportsRouter.get(
  '/academy',
  authorize(PERMISSIONS.REPORTS_READ, PERMISSIONS.STUDENTS_READ_ALL, PERMISSIONS.ENROLLMENTS_READ, PERMISSIONS.COURSES_READ),
  validate({ query: academyReportQuerySchema }),
  reportsController.academy,
);
