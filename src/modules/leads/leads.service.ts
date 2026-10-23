import { type ClientSession, Types } from 'mongoose';
import { lockContacts, runContactTransaction } from '../../database/contactLock.model.js';
import { nextSequence } from '../../database/counter.model.js';
import { runInTransaction } from '../../database/mongoose.js';
import type { AuthContext } from '../../types/express.js';
import { ApiError, type ErrorDetail } from '../../utils/ApiError.js';
import { logger } from '../../utils/logger.js';
import { normalizePhone } from '../../utils/phone.js';
import { CAMPAIGN_REF_FIELDS } from '../campaigns/campaign.ref.js';
import { resolveAttributableCampaign } from '../campaigns/campaigns.service.js';
import { buildPaginationMeta, escapeRegex, type PaginationMeta, type PaginationQuery, toSkip } from '../../utils/pagination.js';
import { hasPermission, PERMISSIONS, type RoleKey } from '../roles/permissions.js';
import { User } from '../users/user.model.js';
import {
  canAssignLeads,
  canManageAllLeads,
  canSeeAllLeads,
  readScope,
  withScope,
  writeScope,
} from './lead.access.js';
import {
  CONVERTED_STUDENT_FIELDS,
  type LeadDto,
  type LeadNoteDto,
  type LeadWithRefs,
  toLeadDto,
  toLeadNoteDto,
  USER_REF_FIELDS,
} from './lead.dto.js';
import { studentMatchWarnings, type WithWarnings } from '../contacts/contactWarnings.js';
import { Lead } from './lead.model.js';
import { LeadNote } from './leadNote.model.js';
import type {
  CreateLeadInput,
  CreateLeadNoteInput,
  ListLeadsQuery,
  UpdateLeadInput,
  UpdateLeadStatusInput,
} from './leads.schema.js';

const REFERENCE_START = 1001;

const leadNotFound = () => ApiError.notFound('Lead not found', 'LEAD_NOT_FOUND');
const leadArchived = () =>
  ApiError.conflict('This lead is archived. Restore it before making changes.', 'LEAD_ARCHIVED');

async function findOneWithRefs(filter: Record<string, unknown>): Promise<LeadWithRefs | null> {
  const lead = await Lead.findOne(filter)
    .populate('assignedTo', USER_REF_FIELDS)
    .populate('createdBy', USER_REF_FIELDS)
    .populate('convertedStudent', CONVERTED_STUDENT_FIELDS)
    .populate('campaign', CAMPAIGN_REF_FIELDS)
    .lean();
  return lead as unknown as LeadWithRefs | null;
}

async function loadDto(id: Types.ObjectId | string): Promise<LeadDto> {
  const lead = await findOneWithRefs({ _id: id });
  if (!lead) throw leadNotFound();
  return toLeadDto(lead);
}

/** Loads a lead the caller may edit, or fails with 404 (not visible) / 409 (archived). */
async function loadForWrite(actor: AuthContext, id: string) {
  const lead = await Lead.findOne(withScope(writeScope(actor), [{ _id: id }])).lean();
  if (!lead) throw leadNotFound();
  if (lead.archivedAt) throw leadArchived();
  return lead;
}

/**
 * Applies a change to a lead, re-checking the caller's scope and the archive state in the
 * same atomic update. If the lead was reassigned or archived between loading and writing,
 * nothing is changed.
 */
async function applyUpdate(
  actor: AuthContext,
  id: string,
  update: Record<string, unknown>,
  session?: ClientSession,
): Promise<void> {
  const result = await Lead.updateOne(withScope(writeScope(actor), [{ _id: id, archivedAt: null }]), update, {
    runValidators: true,
    session,
  });
  if (result.matchedCount === 0) throw leadNotFound();
}

/** The assignee must exist, be active, and hold a role that works leads. */
async function validateAssignee(userId: string): Promise<Types.ObjectId> {
  const user = await User.findById(userId)
    .select('status role')
    .populate<{ role: { key: RoleKey } | null }>('role', 'key')
    .lean();

  const invalid = (message: string, code: string) =>
    ApiError.badRequest(message, code, [{ path: 'assignedTo', message }]);

  if (!user || !user.role) throw invalid('The selected user does not exist', 'ASSIGNEE_NOT_FOUND');
  if (user.status !== 'ACTIVE') throw invalid('The selected user is not active', 'ASSIGNEE_INACTIVE');
  if (!hasPermission(user.role.key, PERMISSIONS.LEADS_UPDATE_ASSIGNED)) {
    throw invalid('Leads can only be assigned to Sales, Admin or Owner users', 'ASSIGNEE_ROLE_NOT_ALLOWED');
  }
  return user._id;
}

/** Active leads sharing this email or phone, excluding `exceptId`. */
async function findDuplicates(
  email: string | null | undefined,
  phoneNormalized: string | null,
  exceptId?: Types.ObjectId,
  session?: ClientSession,
): Promise<Array<{ reference: string; email?: string | null; phoneNormalized?: string | null }>> {
  const matches: Array<Record<string, unknown>> = [];
  if (email) matches.push({ email });
  if (phoneNormalized) matches.push({ phoneNormalized });
  if (matches.length === 0) return [];

  return Lead.find({ archivedAt: null, $or: matches, ...(exceptId ? { _id: { $ne: exceptId } } : {}) })
    .select('reference email phoneNormalized')
    .limit(5)
    .session(session ?? null)
    .lean();
}

function duplicateError(
  actor: AuthContext,
  duplicates: Awaited<ReturnType<typeof findDuplicates>>,
  email: string | null | undefined,
  phoneNormalized: string | null,
  action: 'write' | 'restore' = 'write',
): ApiError {
  // Only callers who can see every lead learn which leads match; others just learn that one exists.
  const details: ErrorDetail[] = canSeeAllLeads(actor)
    ? duplicates.map((match) => ({
        path: email && match.email === email ? 'email' : 'phone',
        message: `Matches lead ${match.reference}`,
      }))
    : [
        ...(duplicates.some((m) => email && m.email === email) ? [{ path: 'email', message: 'Already used by another lead' }] : []),
        ...(duplicates.some((m) => phoneNormalized && m.phoneNormalized === phoneNormalized)
          ? [{ path: 'phone', message: 'Already used by another lead' }]
          : []),
      ];
  const message =
    action === 'restore'
      ? 'This lead cannot be restored: an active lead already has this email or phone'
      : 'A lead with this email or phone already exists';
  return new ApiError(409, message, 'DUPLICATE_LEAD', details);
}

/**
 * Records that a manager kept a duplicate contact on purpose. Uses the application log (there is
 * no separate audit store); ids only, no contact data.
 */
function logDuplicateOverride(actor: AuthContext, action: 'create' | 'update', leadId: Types.ObjectId | string): void {
  logger.info({ event: 'duplicate_contact_allowed', entity: 'lead', action, actorId: actor.userId, recordId: String(leadId) }, 'Duplicate contact kept by manager');
}

/** Builds query conditions from validated query values only; never from raw request objects. */
function listConditions(query: ListLeadsQuery): Array<Record<string, unknown>> {
  const conditions: Array<Record<string, unknown>> = [
    { archivedAt: query.archived ? { $ne: null } : null },
  ];

  if (query.status) conditions.push({ status: { $in: query.status } });
  if (query.source) conditions.push({ source: { $in: query.source } });
  if (query.priority) conditions.push({ priority: { $in: query.priority } });
  if (query.tags) conditions.push({ tags: { $in: query.tags } });
  if (query.country) {
    conditions.push({ country: { $in: query.country.map((c) => new RegExp(`^${escapeRegex(c)}$`, 'i')) } });
  }
  if (query.campaign) {
    const ids = query.campaign.filter((value) => value !== 'none').map((id) => new Types.ObjectId(id));
    const options: Array<Record<string, unknown>> = [];
    if (ids.length > 0) options.push({ campaign: { $in: ids } });
    if (query.campaign.includes('none')) options.push({ campaign: null });
    conditions.push({ $or: options });
  }
  if (query.assignedTo) {
    const ids = query.assignedTo.filter((value) => value !== 'unassigned').map((id) => new Types.ObjectId(id));
    const options: Array<Record<string, unknown>> = [];
    if (ids.length > 0) options.push({ assignedTo: { $in: ids } });
    if (query.assignedTo.includes('unassigned')) options.push({ assignedTo: null });
    conditions.push({ $or: options });
  }
  if (query.createdFrom || query.createdTo) {
    conditions.push({
      createdAt: {
        ...(query.createdFrom ? { $gte: query.createdFrom } : {}),
        ...(query.createdTo ? { $lte: query.createdTo } : {}),
      },
    });
  }
  if (query.followUpBefore) conditions.push({ nextFollowUpAt: { $ne: null, $lte: query.followUpBefore } });

  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i');
    const options: Array<Record<string, unknown>> = [{ fullName: pattern }, { email: pattern }, { reference: pattern }];
    const digits = query.search.replace(/\D/g, '');
    if (digits.length >= 3) options.push({ phoneNormalized: new RegExp(escapeRegex(digits)) });
    // A local search such as "050 123…" also finds numbers stored as +97150123… (D53).
    if (digits.length >= 4 && /^0[1-9]/.test(digits)) {
      options.push({ phoneNormalized: new RegExp(escapeRegex(digits.slice(1))) });
    }
    conditions.push({ $or: options });
  }
  return conditions;
}

export const leadsService = {
  async list(actor: AuthContext, query: ListLeadsQuery): Promise<{ items: LeadDto[]; meta: PaginationMeta }> {
    const filter = withScope(readScope(actor), listConditions(query));
    const direction = query.sortDir === 'asc' ? 1 : -1;

    const [items, total] = await Promise.all([
      Lead.find(filter)
        .sort({ [query.sortBy]: direction, _id: direction })
        // Case-insensitive ordering for names.
        .collation({ locale: 'en', strength: 2 })
        .skip(toSkip(query))
        .limit(query.limit)
        .populate('assignedTo', USER_REF_FIELDS)
        .populate('createdBy', USER_REF_FIELDS)
        .populate('convertedStudent', CONVERTED_STUDENT_FIELDS)
    .populate('campaign', CAMPAIGN_REF_FIELDS)
        .lean(),
      Lead.countDocuments(filter),
    ]);

    return {
      items: (items as unknown as LeadWithRefs[]).map(toLeadDto),
      meta: buildPaginationMeta(query, total),
    };
  },

  async getById(actor: AuthContext, id: string): Promise<LeadDto> {
    // Out-of-scope leads are reported as not found, so ids cannot be probed.
    const lead = await findOneWithRefs(withScope(readScope(actor), [{ _id: id }]));
    if (!lead) throw leadNotFound();
    return toLeadDto(lead);
  },

  async create(actor: AuthContext, input: CreateLeadInput): Promise<WithWarnings<LeadDto>> {
    // Assignment: only lead managers may choose an assignee. Salespeople own what they create
    // (otherwise they could not see it); other creators leave it unassigned for a manager.
    let assignedTo: Types.ObjectId | null = null;
    if (input.assignedTo !== undefined) {
      if (!canAssignLeads(actor)) {
        throw ApiError.forbidden('You are not allowed to assign leads', 'FORBIDDEN_FIELD');
      }
      assignedTo = input.assignedTo ? await validateAssignee(input.assignedTo) : null;
    } else if (!canSeeAllLeads(actor)) {
      assignedTo = new Types.ObjectId(actor.userId);
    }

    if (input.allowDuplicate && !canManageAllLeads(actor)) {
      throw ApiError.forbidden('Only lead managers can create duplicate leads', 'FORBIDDEN_FIELD');
    }

    // Campaign attribution: only callers who can read campaigns may reference one, so others cannot
    // probe campaign ids through this endpoint. Checked before the duplicate check so the
    // duplicate-check-to-insert window (Phase 5 contact race) is not widened.
    let campaign: Types.ObjectId | null = null;
    if (input.campaignId !== undefined) {
      if (!actor.permissions.includes(PERMISSIONS.CAMPAIGNS_READ)) {
        throw ApiError.forbidden('You are not allowed to attribute leads to campaigns', 'FORBIDDEN_FIELD');
      }
      campaign = input.campaignId ? await resolveAttributableCampaign(input.campaignId) : null;
    }

    // Country-aware (D53): a leading-0 number becomes +971… only when the country is the UAE.
    const phoneNormalized = normalizePhone(input.phone, input.country);
    const now = new Date();
    // Drawn outside the transaction so concurrent creates do not contend on the counter (gaps are fine).
    const reference = `LD-${await nextSequence('lead', REFERENCE_START)}`;

    // Lock, check and insert in one transaction, so two simultaneous requests with the same
    // contact cannot both pass the duplicate check (D37; see database/contactLock.model.ts).
    const leadId = await runContactTransaction(async (session) => {
      await lockContacts(session, 'lead', input.email, phoneNormalized);
      if (!input.allowDuplicate) {
        const duplicates = await findDuplicates(input.email, phoneNormalized, undefined, session);
        if (duplicates.length > 0) throw duplicateError(actor, duplicates, input.email, phoneNormalized);
      }
      const [lead] = await Lead.create(
        [
          {
            reference,
            fullName: input.fullName,
            email: input.email ?? null,
            phone: input.phone ?? null,
            phoneNormalized,
            country: input.country ?? null,
            city: input.city ?? null,
            profession: input.profession ?? null,
            source: input.source,
            utm: input.utm ?? null,
            campaign,
            campaignAttributedAt: campaign ? now : null,
            campaignAttributedBy: campaign ? actor.userId : null,
            status: input.status,
            statusChangedAt: input.status === 'NEW' ? null : now,
            priority: input.priority,
            tags: input.tags,
            budget: input.budget ?? null,
            nextFollowUpAt: input.nextFollowUpAt ?? null,
            assignedTo,
            assignedAt: assignedTo ? now : null,
            assignedBy: assignedTo ? actor.userId : null,
            createdBy: actor.userId,
          },
        ],
        { session },
      );
      return lead!._id;
    });
    if (input.allowDuplicate) logDuplicateOverride(actor, 'create', leadId);

    return {
      data: await loadDto(leadId),
      warnings: await studentMatchWarnings(actor, input.email, phoneNormalized),
    };
  },

  async update(actor: AuthContext, id: string, input: UpdateLeadInput): Promise<WithWarnings<LeadDto>> {
    // D55: only lead managers (leads:update_all = Owner, Admin) may keep a duplicate contact on edit.
    if (input.allowDuplicate && !canManageAllLeads(actor)) {
      throw ApiError.forbidden('Only lead managers can keep a duplicate contact', 'FORBIDDEN_FIELD');
    }
    const lead = await loadForWrite(actor, id);

    const email = input.email !== undefined ? input.email : lead.email;
    const phone = input.phone !== undefined ? input.phone : lead.phone;
    if (!email && !phone) {
      throw ApiError.badRequest('A lead needs a phone number or an email address', 'VALIDATION_ERROR', [
        { path: 'phone', message: 'Provide a phone number or an email address' },
      ]);
    }

    const { allowDuplicate, ...fields } = input;
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) set[key] = value;
    }

    // The canonical phone depends on the phone and the country (D53), so recompute it when either
    // changes. Unchanged records keep their stored value (no reinterpretation of historic data).
    const country = input.country !== undefined ? input.country : lead.country;
    const recompute = input.phone !== undefined || input.country !== undefined;
    const phoneNormalized = recompute ? normalizePhone(phone, country) : (lead.phoneNormalized ?? null);
    if (recompute) set.phoneNormalized = phoneNormalized;

    // Changing contact details must not create a duplicate of another active lead.
    const emailChanged = input.email !== undefined && input.email !== lead.email;
    const phoneChanged = recompute && phoneNormalized !== (lead.phoneNormalized ?? null);
    if (emailChanged || phoneChanged) {
      // Same lock-check-write transaction as create, for the values being introduced (D37). An
      // authorised allowDuplicate skips only the same-type duplicate check, never the locks.
      const newEmail = emailChanged ? email : null;
      const newPhone = phoneChanged ? phoneNormalized : null;
      await runContactTransaction(async (session) => {
        await lockContacts(session, 'lead', newEmail, newPhone);
        if (!allowDuplicate) {
          const duplicates = await findDuplicates(newEmail, newPhone, lead._id, session);
          if (duplicates.length > 0) throw duplicateError(actor, duplicates, email, phoneNormalized);
        }
        await applyUpdate(actor, id, { $set: set }, session);
      });
      if (allowDuplicate) logDuplicateOverride(actor, 'update', lead._id);
      return {
        data: await loadDto(id),
        warnings: await studentMatchWarnings(actor, newEmail, newPhone),
      };
    }
    await applyUpdate(actor, id, { $set: set });
    return { data: await loadDto(id), warnings: [] };
  },

  async updateStatus(actor: AuthContext, id: string, input: UpdateLeadStatusInput): Promise<LeadDto> {
    const lead = await loadForWrite(actor, id);
    if (lead.status === 'REGISTERED') {
      throw ApiError.conflict('This lead has been converted to a student; its status is final.', 'LEAD_CONVERTED');
    }

    const lostReason = input.status === 'LOST' ? (input.lostReason ?? null) : null;
    if (lead.status === input.status && (lead.lostReason ?? null) === lostReason) return loadDto(id);

    await applyUpdate(actor, id, {
      $set: {
        status: input.status,
        lostReason,
        ...(lead.status !== input.status ? { statusChangedAt: new Date() } : {}),
      },
    });
    return loadDto(id);
  },

  /**
   * Explicitly sets or clears a lead's campaign (Owner/Admin: leads:update_all + campaigns:read).
   * Does not touch the lead's source/utm, its status, or a converted student's snapshot.
   * A newly chosen campaign must be attributable (not archived, has run).
   */
  async setCampaign(actor: AuthContext, id: string, campaignId: string | null): Promise<LeadDto> {
    const lead = await loadForWrite(actor, id);
    if (String(lead.campaign ?? '') === String(campaignId ?? '')) return loadDto(id);

    const campaign = campaignId ? await resolveAttributableCampaign(campaignId) : null;
    await applyUpdate(actor, id, {
      $set: {
        campaign,
        campaignAttributedAt: campaign ? new Date() : null,
        campaignAttributedBy: actor.userId,
      },
    });
    return loadDto(id);
  },

  async assign(actor: AuthContext, id: string, assigneeId: string | null): Promise<LeadDto> {
    const lead = await Lead.findOne(withScope(readScope(actor), [{ _id: id }])).lean();
    if (!lead) throw leadNotFound();
    if (lead.archivedAt) throw leadArchived();

    const assignedTo = assigneeId ? await validateAssignee(assigneeId) : null;
    if (String(lead.assignedTo ?? '') === String(assignedTo ?? '')) return loadDto(id);

    await Lead.updateOne(
      { _id: id, archivedAt: null },
      {
        $set: {
          assignedTo,
          assignedAt: assignedTo ? new Date() : null,
          assignedBy: actor.userId,
        },
      },
    );
    return loadDto(id);
  },

  async archive(actor: AuthContext, id: string): Promise<LeadDto> {
    const result = await Lead.updateOne(withScope(readScope(actor), [{ _id: id, archivedAt: null }]), {
      $set: { archivedAt: new Date(), archivedBy: actor.userId },
    });
    if (result.matchedCount === 0) {
      const exists = await Lead.exists(withScope(readScope(actor), [{ _id: id }]));
      if (!exists) throw leadNotFound();
      throw ApiError.conflict('This lead is already archived', 'LEAD_ALREADY_ARCHIVED');
    }
    return loadDto(id);
  },

  /**
   * Restoring brings a lead back into the active set, so it must not duplicate an active lead's
   * contact (D54): lock, check and write in one transaction, exactly like create. On a conflict
   * nothing changes (the lead stays archived) and the answer is 409 DUPLICATE_LEAD.
   */
  async restore(actor: AuthContext, id: string): Promise<LeadDto> {
    const lead = await Lead.findOne(withScope(readScope(actor), [{ _id: id }]))
      .select('email phoneNormalized archivedAt')
      .lean();
    if (!lead) throw leadNotFound();
    if (!lead.archivedAt) throw ApiError.conflict('This lead is not archived', 'LEAD_NOT_ARCHIVED');

    await runContactTransaction(async (session) => {
      await lockContacts(session, 'lead', lead.email, lead.phoneNormalized ?? null);
      const duplicates = await findDuplicates(lead.email, lead.phoneNormalized ?? null, lead._id, session);
      if (duplicates.length > 0) {
        throw duplicateError(actor, duplicates, lead.email, lead.phoneNormalized ?? null, 'restore');
      }
      const result = await Lead.updateOne(
        withScope(readScope(actor), [{ _id: id, archivedAt: { $ne: null } }]),
        { $set: { archivedAt: null, archivedBy: null } },
        { session },
      );
      // Restored by a concurrent request in the meantime.
      if (result.matchedCount === 0) throw ApiError.conflict('This lead is not archived', 'LEAD_NOT_ARCHIVED');
    });
    return loadDto(id);
  },

  /** Adds a note and bumps the lead's notesCount atomically (one transaction). */
  async addNote(actor: AuthContext, id: string, input: CreateLeadNoteInput): Promise<LeadNoteDto> {
    await loadForWrite(actor, id);

    const noteId = await runInTransaction(async (session) => {
      const [note] = await LeadNote.create(
        [{ lead: id, author: actor.userId, body: input.body, pinned: input.pinned }],
        { session },
      );
      const updated = await Lead.updateOne(
        withScope(writeScope(actor), [{ _id: id, archivedAt: null }]),
        { $inc: { notesCount: 1 } },
        { session },
      );
      // Reassigned or archived in the meantime: roll the note back.
      if (updated.matchedCount === 0) throw leadNotFound();
      return note!._id;
    });

    const note = await LeadNote.findById(noteId).populate('author', USER_REF_FIELDS).lean();
    return toLeadNoteDto(note as unknown as Parameters<typeof toLeadNoteDto>[0]);
  },

  async listNotes(
    actor: AuthContext,
    id: string,
    query: PaginationQuery,
  ): Promise<{ items: LeadNoteDto[]; meta: PaginationMeta }> {
    if (!(await Lead.exists(withScope(readScope(actor), [{ _id: id }])))) throw leadNotFound();

    const [notes, total] = await Promise.all([
      LeadNote.find({ lead: id })
        .sort({ pinned: -1, createdAt: -1, _id: -1 })
        .skip(toSkip(query))
        .limit(query.limit)
        .populate('author', USER_REF_FIELDS)
        .lean(),
      LeadNote.countDocuments({ lead: id }),
    ]);

    return {
      items: (notes as unknown as Array<Parameters<typeof toLeadNoteDto>[0]>).map(toLeadNoteDto),
      meta: buildPaginationMeta(query, total),
    };
  },
};
