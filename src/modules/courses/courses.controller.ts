import type { Request, Response } from 'express';
import { requireAuth } from '../../middlewares/authenticate.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';
import type { ListCoursesQuery } from './courses.schema.js';
import { coursesService } from './courses.service.js';

// Every handler runs after `validate`, so params, query and body are already parsed.
type IdParams = { id: string };

export const coursesController = {
  async list(req: Request, res: Response) {
    const { items, meta } = await coursesService.list(req.query as unknown as ListCoursesQuery);
    sendSuccess(res, items, { meta: { ...meta } });
  },

  async getById(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await coursesService.getById(req.params.id));
  },

  async create(req: Request, res: Response) {
    sendCreated(res, await coursesService.create(requireAuth(req), req.body), 'Course created');
  },

  async update(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await coursesService.update(req.params.id, req.body), { message: 'Course updated' });
  },

  async archive(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await coursesService.archive(requireAuth(req), req.params.id), { message: 'Course archived' });
  },

  async restore(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await coursesService.restore(req.params.id), { message: 'Course restored' });
  },
};
