import type { Request, Response } from 'express';
import { requireAuth } from '../../middlewares/authenticate.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/response.js';
import type { ListUsersQuery } from './users.schema.js';
import { usersService } from './users.service.js';

// Every handler here runs after `validate`, so params, query and body are already parsed.
type IdParams = { id: string };

export const usersController = {
  async list(req: Request, res: Response) {
    const { items, meta } = await usersService.list(req.query as unknown as ListUsersQuery);
    sendSuccess(res, items, { meta: { ...meta } });
  },

  async getById(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await usersService.getById(req.params.id));
  },

  async create(req: Request, res: Response) {
    const { user, inviteSent } = await usersService.create(requireAuth(req), req.body);
    sendSuccess(res, { ...user, inviteSent }, {
      statusCode: 201,
      message: inviteSent
        ? 'User created and invitation sent'
        : 'User created, but the invitation email could not be sent. Use "resend invite".',
    });
  },

  async update(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await usersService.update(requireAuth(req), req.params.id, req.body), {
      message: 'User updated',
    });
  },

  async assignRole(req: Request<IdParams>, res: Response) {
    sendSuccess(res, await usersService.assignRole(requireAuth(req), req.params.id, req.body.role), {
      message: 'Role updated',
    });
  },

  async resendInvite(req: Request<IdParams>, res: Response) {
    const { inviteSent } = await usersService.resendInvite(requireAuth(req), req.params.id);
    if (!inviteSent) {
      throw new ApiError(502, 'The invitation email could not be sent', 'EMAIL_DELIVERY_FAILED');
    }
    sendSuccess(res, { inviteSent }, { message: 'Invitation sent' });
  },
};
