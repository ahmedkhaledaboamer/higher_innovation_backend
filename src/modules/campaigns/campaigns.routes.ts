import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { idParamsSchema } from '../../utils/schemas.js';
import { PERMISSIONS } from '../roles/permissions.js';
import { campaignsController } from './campaigns.controller.js';
import {
  createCampaignSchema,
  listCampaignsQuerySchema,
  updateCampaignSchema,
  updateCampaignStatusSchema,
} from './campaigns.schema.js';

/**
 * Read: campaigns:read (Owner, Admin, Marketing, Viewer).
 * Write (create, edit, status, archive, restore): campaigns:write (Owner, Admin, Marketing).
 * The permission check runs before the id is looked up, so callers without access get the
 * same 403 for existing and nonexistent campaigns.
 */
const canRead = authorize(PERMISSIONS.CAMPAIGNS_READ);
const canWrite = authorize(PERMISSIONS.CAMPAIGNS_WRITE);
const byId = validate({ params: idParamsSchema });

export const campaignsRouter = Router();

campaignsRouter.use(authenticate);

campaignsRouter.get('/', canRead, validate({ query: listCampaignsQuerySchema }), campaignsController.list);
campaignsRouter.post('/', canWrite, validate({ body: createCampaignSchema }), campaignsController.create);
campaignsRouter.get('/:id', canRead, byId, campaignsController.getById);
campaignsRouter.patch('/:id', canWrite, validate({ params: idParamsSchema, body: updateCampaignSchema }), campaignsController.update);
campaignsRouter.patch(
  '/:id/status',
  canWrite,
  validate({ params: idParamsSchema, body: updateCampaignStatusSchema }),
  campaignsController.changeStatus,
);
campaignsRouter.post('/:id/archive', canWrite, byId, campaignsController.archive);
campaignsRouter.post('/:id/restore', canWrite, byId, campaignsController.restore);
