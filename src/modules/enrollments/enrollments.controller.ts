import type { Request, Response } from 'express';
import { requireAuth } from '../../middlewares/authenticate.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';
import type { ListEnrollmentsQuery } from './enrollments.schema.js';
import { enrollmentsService } from './enrollments.service.js';

// Every handler runs after `validate`, so params, query and body are already parsed.
type IdParams = { id: string };

export const enrollmentsController = {
  async list(req: Request, res: Response) {
    const { items, meta } = await enrollmentsService.list(requireAuth(req), req.query as unknown as ListEnrollmentsQuery);
    sendSuccess(res, items, { meta: { ...meta } });
  },

  async getById(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await enrollmentsService.getById(requireAuth(req), req.params.id));
  },

  /** POST /students/:id/enrollments: `id` is the student. */
  async create(req: Request<IdParams>, res: Response) {
    sendCreated(res, await enrollmentsService.create(requireAuth(req), req.params.id, req.body), 'Student enrolled');
  },

  async updateStatus(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await enrollmentsService.updateStatus(requireAuth(req), req.params.id, req.body.status), {
      message: 'Enrollment status updated',
    });
  },
};
