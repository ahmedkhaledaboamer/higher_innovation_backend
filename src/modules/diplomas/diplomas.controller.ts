import type { Request, Response } from 'express';
import { requireAuth } from '../../middlewares/authenticate.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';
import type { ListDiplomasQuery } from './diplomas.schema.js';
import { diplomasService } from './diplomas.service.js';

// Every handler runs after `validate`, so params, query and body are already parsed.
type IdParams = { id: string };

export const diplomasController = {
  async list(req: Request, res: Response) {
    const { items, meta } = await diplomasService.list(req.query as unknown as ListDiplomasQuery);
    sendSuccess(res, items, { meta: { ...meta } });
  },

  async getById(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await diplomasService.getById(req.params.id));
  },

  async create(req: Request, res: Response) {
    sendCreated(res, await diplomasService.create(requireAuth(req), req.body), 'Diploma created');
  },

  async update(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await diplomasService.update(req.params.id, req.body), { message: 'Diploma updated' });
  },

  async archive(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await diplomasService.archive(requireAuth(req), req.params.id), { message: 'Diploma archived' });
  },

  async restore(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await diplomasService.restore(req.params.id), { message: 'Diploma restored' });
  },
};
