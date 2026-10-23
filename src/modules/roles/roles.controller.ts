import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/response.js';
import { rolesService } from './roles.service.js';

export const rolesController = {
  async list(_req: Request, res: Response) {
    sendSuccess(res, await rolesService.list());
  },
};
