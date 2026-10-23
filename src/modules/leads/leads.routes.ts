import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize, authorizeAny } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { idParamsSchema } from '../../utils/schemas.js';
import { PERMISSIONS } from '../roles/permissions.js';
import { leadsController } from './leads.controller.js';
import {
  assignLeadSchema,
  convertLeadSchema,
  createLeadNoteSchema,
  createLeadSchema,
  listLeadNotesQuerySchema,
  listLeadsQuerySchema,
  setLeadCampaignSchema,
  updateLeadSchema,
  updateLeadStatusSchema,
} from './leads.schema.js';

/**
 * Route-level checks answer "may this role do this kind of thing at all?".
 * Which leads the caller can touch (e.g. Sales: only their own) is enforced by
 * the service inside every query; see lead.access.ts.
 */
const canRead = authorizeAny(PERMISSIONS.LEADS_READ_ALL, PERMISSIONS.LEADS_READ_ASSIGNED);
const canWrite = authorizeAny(PERMISSIONS.LEADS_UPDATE_ALL, PERMISSIONS.LEADS_UPDATE_ASSIGNED);
const byId = validate({ params: idParamsSchema });

export const leadsRouter = Router();

leadsRouter.use(authenticate);

leadsRouter.get('/', canRead, validate({ query: listLeadsQuerySchema }), leadsController.list);
leadsRouter.post('/', authorize(PERMISSIONS.LEADS_CREATE), validate({ body: createLeadSchema }), leadsController.create);

leadsRouter.get('/:id', canRead, byId, leadsController.getById);
leadsRouter.patch('/:id', canWrite, validate({ params: idParamsSchema, body: updateLeadSchema }), leadsController.update);

leadsRouter.patch(
  '/:id/status',
  canWrite,
  validate({ params: idParamsSchema, body: updateLeadStatusSchema }),
  leadsController.updateStatus,
);
leadsRouter.patch(
  '/:id/assign',
  authorize(PERMISSIONS.LEADS_ASSIGN),
  validate({ params: idParamsSchema, body: assignLeadSchema }),
  leadsController.assign,
);

// Changing attribution is a deliberate act by lead managers who can see campaigns (Owner, Admin).
// PATCH /leads/:id never touches the campaign.
leadsRouter.patch(
  '/:id/campaign',
  authorize(PERMISSIONS.LEADS_UPDATE_ALL, PERMISSIONS.CAMPAIGNS_READ),
  validate({ params: idParamsSchema, body: setLeadCampaignSchema }),
  leadsController.setCampaign,
);

leadsRouter.post('/:id/archive', authorize(PERMISSIONS.LEADS_ARCHIVE), byId, leadsController.archive);
leadsRouter.post('/:id/restore', authorize(PERMISSIONS.LEADS_ARCHIVE), byId, leadsController.restore);

// Conversion = editing the lead (own leads for Sales) + creating a student. No new grants:
// Owner, Admin, and Sales for their own leads. See leadConversion.service.ts.
leadsRouter.post(
  '/:id/convert',
  canWrite,
  authorize(PERMISSIONS.STUDENTS_CREATE),
  validate({ params: idParamsSchema, body: convertLeadSchema }),
  leadsController.convert,
);

leadsRouter.get(
  '/:id/notes',
  canRead,
  validate({ params: idParamsSchema, query: listLeadNotesQuerySchema }),
  leadsController.listNotes,
);
leadsRouter.post(
  '/:id/notes',
  canWrite,
  validate({ params: idParamsSchema, body: createLeadNoteSchema }),
  leadsController.addNote,
);
