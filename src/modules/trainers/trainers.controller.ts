import type { Request, Response } from 'express';
import { requireAuth } from '../../middlewares/authenticate.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';
import type { ListTrainersQuery } from './trainers.schema.js';
import { trainersService } from './trainers.service.js';

// Every handler runs after `validate`, so params, query and body are already parsed.
type IdParams = { id: string };

export const trainersController = {
  async list(req: Request, res: Response) {
    const { items, meta } = await trainersService.list(req.query as unknown as ListTrainersQuery);
    sendSuccess(res, items, { meta: { ...meta } });
  },

  async me(req: Request, res: Response) {
    sendSuccess(res, await trainersService.me(requireAuth(req)));
  },

  async getById(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await trainersService.getById(req.params.id));
  },

  async create(req: Request, res: Response) {
    sendCreated(res, await trainersService.create(requireAuth(req), req.body), 'Trainer created');
  },

  async update(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await trainersService.update(req.params.id, req.body), { message: 'Trainer updated' });
  },

  async archive(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await trainersService.archive(requireAuth(req), req.params.id), {
      message: 'Trainer archived; open assignments ended',
    });
  },

  async restore(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await trainersService.restore(req.params.id), { message: 'Trainer restored' });
  },
};
