import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination.js';
import { booleanQuery, dateInput, multiValue, objectIdSchema, optionalText } from '../../utils/schemas.js';
import { CAMPAIGN_PLATFORMS, CAMPAIGN_STATUSES, INITIAL_CAMPAIGN_STATUSES } from './campaign.model.js';

const money = z.number().int('Use a whole amount').min(0).max(100_000_000);

const utm = z
  .object({
    source: optionalText(200),
    medium: optionalText(200),
    campaign: optionalText(200),
    term: optionalText(200),
    content: optionalText(200),
  })
  .nullable()
  .optional();

const datesInOrder = (body: { startDate?: Date | null; endDate?: Date | null }) =>
  !body.startDate || !body.endDate || body.endDate >= body.startDate;
const datesMessage = { path: ['endDate'], message: 'endDate cannot be before startDate' };

/** Server-managed fields (code, statusChangedAt, archive fields, createdBy) are not accepted. */
export const createCampaignSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is too short').max(150),
    platform: z.enum(CAMPAIGN_PLATFORMS),
    objective: optionalText(300),
    description: z.string().trim().max(3000).default(''),
    courseId: objectIdSchema.nullable().optional(),
    ownerId: objectIdSchema.nullable().optional(),
    budget: money.nullable().optional(),
    spent: money.default(0),
    startDate: dateInput.nullable().optional(),
    endDate: dateInput.nullable().optional(),
    utm,
    status: z.enum(INITIAL_CAMPAIGN_STATUSES).default('DRAFT'),
  })
  .refine(datesInOrder, datesMessage);

/** Status has its own endpoint (with transition rules); it is not accepted here. */
export const updateCampaignSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is too short').max(150).optional(),
    platform: z.enum(CAMPAIGN_PLATFORMS).optional(),
    objective: optionalText(300),
    description: z.string().trim().max(3000).optional(),
    courseId: objectIdSchema.nullable().optional(),
    ownerId: objectIdSchema.nullable().optional(),
    budget: money.nullable().optional(),
    spent: money.optional(),
    startDate: dateInput.nullable().optional(),
    endDate: dateInput.nullable().optional(),
    utm,
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  })
  .refine(datesInOrder, datesMessage);

export const updateCampaignStatusSchema = z.object({ status: z.enum(CAMPAIGN_STATUSES) });

export const CAMPAIGN_SORT_FIELDS = ['createdAt', 'name', 'code', 'startDate', 'budget', 'spent'] as const;

export const listCampaignsQuerySchema = paginationQuerySchema.extend({
  /** Matches name, code or UTM campaign value (case-insensitive, partial). */
  search: z.string().trim().min(1).max(100).optional(),
  status: multiValue(z.enum(CAMPAIGN_STATUSES)),
  platform: multiValue(z.enum(CAMPAIGN_PLATFORMS)),
  course: multiValue(objectIdSchema),
  owner: multiValue(objectIdSchema),
  startFrom: dateInput.optional(),
  startTo: dateInput.optional(),
  archived: booleanQuery.default(false),
  sortBy: z.enum(CAMPAIGN_SORT_FIELDS).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;
export type ListCampaignsQuery = z.infer<typeof listCampaignsQuerySchema>;
