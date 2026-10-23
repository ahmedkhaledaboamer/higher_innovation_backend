import type { Request, Response } from 'express';
import { requireAuth } from '../../middlewares/authenticate.js';
import { sendSuccess } from '../../utils/response.js';
import type {
  AcademyReportQuery,
  CampaignReportQuery,
  LeadBreakdownQuery,
  LeadSummaryQuery,
  LeadTimeseriesQuery,
} from './reports.schema.js';
import { reportsService } from './reports.service.js';

// Every handler runs after `validate`, so the query (including the resolved `range`) is parsed.
export const reportsController = {
  async leadSummary(req: Request, res: Response) {
    sendSuccess(res, await reportsService.leadSummary(requireAuth(req), req.query as unknown as LeadSummaryQuery));
  },

  async leadTimeseries(req: Request, res: Response) {
    sendSuccess(res, await reportsService.leadTimeseries(requireAuth(req), req.query as unknown as LeadTimeseriesQuery));
  },

  async leadBreakdown(req: Request, res: Response) {
    const { data, meta } = await reportsService.leadBreakdown(requireAuth(req), req.query as unknown as LeadBreakdownQuery);
    sendSuccess(res, data, { meta: { ...meta } });
  },

  async campaigns(req: Request, res: Response) {
    sendSuccess(res, await reportsService.campaigns(req.query as unknown as CampaignReportQuery));
  },

  async academy(req: Request, res: Response) {
    sendSuccess(res, await reportsService.academy(req.query as unknown as AcademyReportQuery));
  },
};
