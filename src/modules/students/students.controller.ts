import type { Request, Response } from 'express';
import { requireAuth } from '../../middlewares/authenticate.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';
import type { ListStudentsQuery } from './students.schema.js';
import { studentsService } from './students.service.js';

// Every handler runs after `validate`, so params, query and body are already parsed.
type IdParams = { id: string };

export const studentsController = {
  async list(req: Request, res: Response) {
    const { items, meta } = await studentsService.list(requireAuth(req), req.query as unknown as ListStudentsQuery);
    sendSuccess(res, items, { meta: { ...meta } });
  },

  async getById(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await studentsService.getById(requireAuth(req), req.params.id));
  },

  async create(req: Request, res: Response) {
    const { data, warnings } = await studentsService.create(requireAuth(req), req.body);
    sendCreated(res, data, 'Student created', warnings);
  },

  async update(req: Request<IdParams>, res: Response) {
    const { data, warnings } = await studentsService.update(requireAuth(req), req.params.id, req.body);
    sendSuccess(res, data, { message: 'Student updated', warnings });
  },

  async assignAdvisor(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await studentsService.assignAdvisor(requireAuth(req), req.params.id, req.body.advisor), {
      message: req.body.advisor ? 'Advisor assigned' : 'Advisor removed',
    });
  },

  async archive(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await studentsService.archive(requireAuth(req), req.params.id), { message: 'Student archived' });
  },

  async restore(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await studentsService.restore(requireAuth(req), req.params.id), { message: 'Student restored' });
  },
};
