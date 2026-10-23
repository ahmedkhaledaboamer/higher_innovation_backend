import type { Request, Response } from 'express';
import { requireAuth } from '../../middlewares/authenticate.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';
import type { ListAssignmentsQuery } from './assignments.schema.js';
import { assignmentsService } from './assignments.service.js';

// Every handler runs after `validate`, so params, query and body are already parsed.
type IdParams = { id: string };

export const assignmentsController = {
  async list(req: Request, res: Response) {
    const { items, meta } = await assignmentsService.list(requireAuth(req), req.query as unknown as ListAssignmentsQuery);
    sendSuccess(res, items, { meta: { ...meta } });
  },

  async getById(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await assignmentsService.getById(requireAuth(req), req.params.id));
  },

  async create(req: Request, res: Response) {
    sendCreated(res, await assignmentsService.create(requireAuth(req), req.body), 'Trainer assigned');
  },

  async update(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await assignmentsService.update(req.params.id, req.body), { message: 'Assignment updated' });
  },

  async end(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await assignmentsService.end(requireAuth(req), req.params.id, req.body.status), {
      message: 'Assignment ended',
    });
  },
};
