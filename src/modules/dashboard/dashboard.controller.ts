import type { Request, Response } from 'express';
import { requireAuth } from '../../middlewares/authenticate.js';
import { sendSuccess } from '../../utils/response.js';
import type { DashboardQuery } from '../reports/reports.schema.js';
import { dashboardService } from './dashboard.service.js';

export const dashboardController = {
  async summary(req: Request, res: Response) {
    const query = req.query as unknown as DashboardQuery;
    sendSuccess(res, await dashboardService.summary(requireAuth(req), query.range));
  },
};
