import type { Request, Response } from 'express';
import { requireAuth } from '../../middlewares/authenticate.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';
import type { ListCampaignsQuery } from './campaigns.schema.js';
import { campaignsService } from './campaigns.service.js';

// Every handler runs after `validate`, so params, query and body are already parsed.
type IdParams = { id: string };

export const campaignsController = {
  async list(req: Request, res: Response) {
    const { items, meta } = await campaignsService.list(req.query as unknown as ListCampaignsQuery);
    sendSuccess(res, items, { meta: { ...meta } });
  },

  async getById(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await campaignsService.getById(req.params.id));
  },

  async create(req: Request, res: Response) {
    sendCreated(res, await campaignsService.create(requireAuth(req), req.body), 'Campaign created');
  },

  async update(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await campaignsService.update(req.params.id, req.body), { message: 'Campaign updated' });
  },

  async changeStatus(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await campaignsService.changeStatus(req.params.id, req.body.status), {
      message: 'Campaign status updated',
    });
  },

  async archive(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await campaignsService.archive(requireAuth(req), req.params.id), { message: 'Campaign archived' });
  },

  async restore(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await campaignsService.restore(req.params.id), { message: 'Campaign restored' });
  },
};
