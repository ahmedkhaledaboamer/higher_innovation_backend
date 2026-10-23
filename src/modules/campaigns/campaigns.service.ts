import mongoose, { Types } from 'mongoose';
import { nextSequence } from '../../database/counter.model.js';
import type { AuthContext } from '../../types/express.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPaginationMeta, escapeRegex, type PaginationMeta, toSkip } from '../../utils/pagination.js';
import { Course } from '../courses/course.model.js';
import { USER_REF_FIELDS } from '../leads/lead.dto.js';
import { hasPermission, PERMISSIONS, type RoleKey } from '../roles/permissions.js';
import { User } from '../users/user.model.js';
import { CAMPAIGN_COURSE_FIELDS, type CampaignDto, type CampaignWithRefs, toCampaignDto } from './campaign.dto.js';
import { computeMetrics, leadCountsByCampaign } from './campaign.metrics.js';
import {
  ATTRIBUTABLE_CAMPAIGN_STATUSES,
  Campaign,
  CAMPAIGN_TRANSITIONS,
  type CampaignStatus,
} from './campaign.model.js';
import type { CreateCampaignInput, ListCampaignsQuery, UpdateCampaignInput } from './campaigns.schema.js';

/**
 * Marketing campaigns. Access is all-or-nothing per role (campaigns:read / campaigns:write):
 * campaigns are not personal records, so there is no per-record scope. Callers without
 * campaigns:read get 403 for every id, existing or not, so ids cannot be probed.
 */

const CODE_START = 1001;
const UTM_COLLATION = { locale: 'en', strength: 2 } as const;

const campaignNotFound = () => ApiError.notFound('Campaign not found', 'CAMPAIGN_NOT_FOUND');
const campaignArchived = () =>
  ApiError.conflict('This campaign is archived. Restore it before making changes.', 'CAMPAIGN_ARCHIVED');
const utmTaken = () =>
  new ApiError(409, 'Another campaign already uses this UTM campaign value', 'CAMPAIGN_UTM_TAKEN', [
    { path: 'utm.campaign', message: 'Must be unique (case-insensitive) so attribution is unambiguous' },
  ]);

function populate<T extends mongoose.Query<unknown, unknown>>(query: T): T {
  return query
    .populate('course', CAMPAIGN_COURSE_FIELDS)
    .populate('owner', USER_REF_FIELDS)
    .populate('createdBy', USER_REF_FIELDS) as T;
}

async function loadDto(id: unknown): Promise<CampaignDto> {
  const campaign = (await populate(Campaign.findById(id)).lean()) as unknown as CampaignWithRefs | null;
  if (!campaign) throw campaignNotFound();
  const counts = await leadCountsByCampaign([campaign._id]);
  return toCampaignDto(campaign, computeMetrics(counts.get(campaign._id.toString()), { spent: campaign.spent, budget: campaign.budget ?? null }));
}

/** The course must exist; a newly chosen course must also not be archived. */
async function validateCourse(courseId: string, currentCourse?: Types.ObjectId | null): Promise<Types.ObjectId> {
  const course = await Course.findById(courseId).select('archivedAt').lean();
  const detail = (message: string) => [{ path: 'courseId', message }];
  if (!course) throw ApiError.badRequest('The selected course does not exist', 'COURSE_NOT_FOUND', detail('Course not found'));
  if (course.archivedAt && String(currentCourse ?? '') !== courseId) {
    throw new ApiError(409, 'Archived courses cannot be chosen', 'COURSE_ARCHIVED', detail('Course is archived'));
  }
  return course._id;
}

/** The owner must be an active user whose role manages campaigns. */
async function validateOwner(userId: string): Promise<Types.ObjectId> {
  const user = await User.findById(userId)
    .select('status role')
    .populate<{ role: { key: RoleKey } | null }>('role', 'key')
    .lean();
  const invalid = (message: string, code: string) => ApiError.badRequest(message, code, [{ path: 'ownerId', message }]);
  if (!user || !user.role) throw invalid('The selected user does not exist', 'OWNER_NOT_FOUND');
  if (user.status !== 'ACTIVE') throw invalid('The selected user is not active', 'OWNER_INACTIVE');
  if (!hasPermission(user.role.key, PERMISSIONS.CAMPAIGNS_WRITE)) {
    throw invalid('Campaign owners must be Marketing, Admin or Owner users', 'OWNER_ROLE_NOT_ALLOWED');
  }
  return user._id;
}

async function utmCampaignTaken(value: string | null | undefined, exceptId?: string): Promise<boolean> {
  if (!value) return false;
  const filter: Record<string, unknown> = { 'utm.campaign': value };
  if (exceptId) filter._id = { $ne: exceptId };
  return Boolean(await Campaign.findOne(filter).collation(UTM_COLLATION).select('_id').lean());
}

function uniqueConflict(error: unknown): ApiError | null {
  if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) return null;
  const keys = Object.keys((error.keyPattern as Record<string, unknown> | undefined) ?? {});
  return keys.includes('utm.campaign') ? utmTaken() : null;
}

/**
 * For lead attribution: the campaign must exist, not be archived, and be RUNNING, PAUSED or
 * COMPLETED. Used only when an attribution is set or changed; existing attributions are kept.
 */
export async function resolveAttributableCampaign(campaignId: string): Promise<Types.ObjectId> {
  const campaign = await Campaign.findById(campaignId).select('status archivedAt').lean();
  const detail = (message: string) => [{ path: 'campaignId', message }];
  if (!campaign) throw ApiError.badRequest('The selected campaign does not exist', 'CAMPAIGN_NOT_FOUND', detail('Campaign not found'));
  if (campaign.archivedAt) {
    throw new ApiError(409, 'Archived campaigns cannot receive new leads', 'CAMPAIGN_ARCHIVED', detail('Campaign is archived'));
  }
  if (!ATTRIBUTABLE_CAMPAIGN_STATUSES.includes(campaign.status)) {
    throw new ApiError(409, `A ${campaign.status} campaign has not run and cannot receive leads`, 'CAMPAIGN_NOT_STARTED', detail('Campaign has not started'));
  }
  return campaign._id;
}

function listFilter(query: ListCampaignsQuery): Record<string, unknown> {
  const conditions: Array<Record<string, unknown>> = [{ archivedAt: query.archived ? { $ne: null } : null }];
  if (query.status) conditions.push({ status: { $in: query.status } });
  if (query.platform) conditions.push({ platform: { $in: query.platform } });
  if (query.course) conditions.push({ course: { $in: query.course.map((id) => new Types.ObjectId(id)) } });
  if (query.owner) conditions.push({ owner: { $in: query.owner.map((id) => new Types.ObjectId(id)) } });
  if (query.startFrom || query.startTo) {
    conditions.push({
      startDate: {
        ...(query.startFrom ? { $gte: query.startFrom } : {}),
        ...(query.startTo ? { $lte: query.startTo } : {}),
      },
    });
  }
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i');
    conditions.push({ $or: [{ name: pattern }, { code: pattern }, { 'utm.campaign': pattern }] });
  }
  return { $and: conditions };
}

export const campaignsService = {
  async list(query: ListCampaignsQuery): Promise<{ items: CampaignDto[]; meta: PaginationMeta }> {
    const filter = listFilter(query);
    const direction = query.sortDir === 'asc' ? 1 : -1;
    const [campaigns, total] = await Promise.all([
      populate(
        Campaign.find(filter)
          .sort({ [query.sortBy]: direction, _id: direction })
          .collation({ locale: 'en', strength: 2 })
          .skip(toSkip(query))
          .limit(query.limit),
      ).lean() as unknown as Promise<CampaignWithRefs[]>,
      Campaign.countDocuments(filter),
    ]);
    // One aggregation for the whole page's metrics.
    const counts = await leadCountsByCampaign(campaigns.map((c) => c._id));
    return {
      items: campaigns.map((c) =>
        toCampaignDto(c, computeMetrics(counts.get(c._id.toString()), { spent: c.spent, budget: c.budget ?? null })),
      ),
      meta: buildPaginationMeta(query, total),
    };
  },

  async getById(id: string): Promise<CampaignDto> {
    return loadDto(id);
  },

  async create(actor: AuthContext, input: CreateCampaignInput): Promise<CampaignDto> {
    if (await utmCampaignTaken(input.utm?.campaign)) throw utmTaken();
    const { courseId, ownerId, ...fields } = input;
    const course = courseId ? await validateCourse(courseId) : null;
    const owner = ownerId ? await validateOwner(ownerId) : null;

    try {
      const campaign = await Campaign.create({
        ...fields,
        objective: fields.objective ?? null,
        budget: fields.budget ?? null,
        startDate: fields.startDate ?? null,
        endDate: fields.endDate ?? null,
        utm: fields.utm ?? null,
        course,
        owner,
        statusChangedAt: fields.status === 'DRAFT' ? null : new Date(),
        code: `CMP-${await nextSequence('campaign', CODE_START)}`,
        createdBy: actor.userId,
      });
      return loadDto(campaign._id);
    } catch (error) {
      throw uniqueConflict(error) ?? error;
    }
  },

  async update(id: string, input: UpdateCampaignInput): Promise<CampaignDto> {
    const campaign = await Campaign.findById(id).lean();
    if (!campaign) throw campaignNotFound();
    if (campaign.archivedAt) throw campaignArchived();

    const startDate = input.startDate !== undefined ? input.startDate : campaign.startDate;
    const endDate = input.endDate !== undefined ? input.endDate : campaign.endDate;
    if (startDate && endDate && endDate < startDate) {
      throw ApiError.badRequest('endDate cannot be before startDate', 'VALIDATION_ERROR', [
        { path: 'endDate', message: 'endDate cannot be before startDate' },
      ]);
    }

    const { courseId, ownerId, ...fields } = input;
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) set[key] = value;
    }
    if (courseId !== undefined) set.course = courseId ? await validateCourse(courseId, campaign.course) : null;
    if (ownerId !== undefined) set.owner = ownerId ? await validateOwner(ownerId) : null;
    if (input.utm !== undefined && (await utmCampaignTaken(input.utm?.campaign, id))) throw utmTaken();

    try {
      const result = await Campaign.updateOne({ _id: id, archivedAt: null }, { $set: set }, { runValidators: true });
      if (result.matchedCount === 0) throw campaignArchived();
    } catch (error) {
      throw uniqueConflict(error) ?? error;
    }
    return loadDto(id);
  },

  /**
   * Moves along CAMPAIGN_TRANSITIONS. The update matches only the status that was read, so two
   * concurrent transitions cannot both apply (the second gets 409).
   */
  async changeStatus(id: string, status: CampaignStatus): Promise<CampaignDto> {
    const campaign = await Campaign.findById(id).lean();
    if (!campaign) throw campaignNotFound();
    if (campaign.archivedAt) throw campaignArchived();
    if (campaign.status === status) return loadDto(id);

    const allowed = CAMPAIGN_TRANSITIONS[campaign.status];
    if (!allowed.includes(status)) {
      throw new ApiError(
        409,
        `A ${campaign.status} campaign cannot become ${status}${allowed.length ? ` (allowed: ${allowed.join(', ')})` : ' (final status)'}`,
        'INVALID_STATUS_TRANSITION',
        [{ path: 'status', message: `Allowed from ${campaign.status}: ${allowed.join(', ') || 'none'}` }],
      );
    }

    const result = await Campaign.updateOne(
      { _id: id, archivedAt: null, status: campaign.status },
      { $set: { status, statusChangedAt: new Date() } },
    );
    if (result.matchedCount === 0) {
      throw ApiError.conflict('The campaign was changed by someone else; reload and try again', 'CONFLICT');
    }
    return loadDto(id);
  },

  /** Archived campaigns accept no new leads and are read-only; existing lead attributions are kept. */
  async archive(actor: AuthContext, id: string): Promise<CampaignDto> {
    const result = await Campaign.updateOne(
      { _id: id, archivedAt: null },
      { $set: { archivedAt: new Date(), archivedBy: actor.userId } },
    );
    if (result.matchedCount === 0) {
      if (!(await Campaign.exists({ _id: id }))) throw campaignNotFound();
      throw ApiError.conflict('This campaign is already archived', 'CAMPAIGN_ALREADY_ARCHIVED');
    }
    return loadDto(id);
  },

  async restore(id: string): Promise<CampaignDto> {
    const result = await Campaign.updateOne(
      { _id: id, archivedAt: { $ne: null } },
      { $set: { archivedAt: null, archivedBy: null } },
    );
    if (result.matchedCount === 0) {
      if (!(await Campaign.exists({ _id: id }))) throw campaignNotFound();
      throw ApiError.conflict('This campaign is not archived', 'CAMPAIGN_NOT_ARCHIVED');
    }
    return loadDto(id);
  },
};
