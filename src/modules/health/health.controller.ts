import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/response.js';
import { healthService } from './health.service.js';

export const healthController = {
  liveness(_req: Request, res: Response) {
    sendSuccess(res, healthService.getLiveness(), { message: 'Service is running' });
  },

  async readiness(_req: Request, res: Response) {
    const report = await healthService.getReadiness();
    const ready = report.status === 'ok';

    // 503 tells load balancers / orchestrators to stop routing traffic here for now.
    res.status(ready ? 200 : 503).json({
      success: ready,
      message: ready ? 'Service is ready' : 'Service is not ready',
      data: report,
    });
  },
};
