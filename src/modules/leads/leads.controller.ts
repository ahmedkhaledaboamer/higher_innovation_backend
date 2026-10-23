import type { Request, Response } from 'express';
import { requireAuth } from '../../middlewares/authenticate.js';
import type { PaginationQuery } from '../../utils/pagination.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';
import type { ListLeadsQuery } from './leads.schema.js';
import { convertLead } from './leadConversion.service.js';
import { leadsService } from './leads.service.js';

// Every handler runs after `validate`, so params, query and body are already parsed.
type IdParams = { id: string };

export const leadsController = {
  async list(req: Request, res: Response) {
    const { items, meta } = await leadsService.list(requireAuth(req), req.query as unknown as ListLeadsQuery);
    sendSuccess(res, items, { meta: { ...meta } });
  },

  async getById(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await leadsService.getById(requireAuth(req), req.params.id));
  },

  async create(req: Request, res: Response) {
    const { data, warnings } = await leadsService.create(requireAuth(req), req.body);
    sendCreated(res, data, 'Lead created', warnings);
  },

  async update(req: Request<IdParams>, res: Response) {
    const { data, warnings } = await leadsService.update(requireAuth(req), req.params.id, req.body);
    sendSuccess(res, data, { message: 'Lead updated', warnings });
  },

  async updateStatus(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await leadsService.updateStatus(requireAuth(req), req.params.id, req.body), {
      message: 'Lead status updated',
    });
  },

  async assign(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await leadsService.assign(requireAuth(req), req.params.id, req.body.assignedTo), {
      message: req.body.assignedTo ? 'Lead assigned' : 'Lead unassigned',
    });
  },

  async setCampaign(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await leadsService.setCampaign(requireAuth(req), req.params.id, req.body.campaignId), {
      message: req.body.campaignId ? 'Lead attributed to campaign' : 'Campaign attribution removed',
    });
  },

  async archive(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await leadsService.archive(requireAuth(req), req.params.id), { message: 'Lead archived' });
  },

  async restore(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await leadsService.restore(requireAuth(req), req.params.id), { message: 'Lead restored' });
  },

  async addNote(req: Request<IdParams>, res: Response) {
    sendCreated(res, await leadsService.addNote(requireAuth(req), req.params.id, req.body), 'Note added');
  },

  async convert(req: Request<IdParams>, res: Response) {
    const { data, warnings } = await convertLead(requireAuth(req), req.params.id, req.body);
    sendCreated(res, data, `Lead converted to student ${data.student.studentNumber}`, warnings);
  },

  async listNotes(req: Request<IdParams>, res: Response) {
    const { items, meta } = await leadsService.listNotes(
      requireAuth(req),
      req.params.id,
      req.query as unknown as PaginationQuery,
    );
    sendSuccess(res, items, { meta: { ...meta } });
  },
};
