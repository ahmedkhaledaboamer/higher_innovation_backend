import type { Types } from 'mongoose';
import { type CampaignRefDto, toCampaignRef } from '../campaigns/campaign.ref.js';
import type { LeadPriority, LeadSource, LeadStatus, LeadTag } from './lead.model.js';

/** A user reference as embedded in lead responses. */
export interface UserRefDto {
  id: string;
  name: string;
  email: string;
}

interface PopulatedUser {
  _id: Types.ObjectId;
  firstName: string;
  lastName: string;
  email: string;
}

/** Fields to populate on user references in lead queries. */
export const USER_REF_FIELDS = 'firstName lastName email';

/** A lead as loaded with assignedTo/createdBy populated. */
export interface LeadWithRefs {
  _id: Types.ObjectId;
  reference: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  city?: string | null;
  profession?: string | null;
  source: LeadSource;
  utm?: Record<string, string | null | undefined> | null;
  campaign?: { _id: Types.ObjectId; code: string; name: string; archivedAt?: Date | null } | null;
  campaignAttributedAt?: Date | null;
  status: LeadStatus;
  statusChangedAt?: Date | null;
  lostReason?: string | null;
  priority: LeadPriority;
  tags: LeadTag[];
  budget?: number | null;
  assignedTo?: PopulatedUser | null;
  assignedAt?: Date | null;
  nextFollowUpAt?: Date | null;
  notesCount: number;
  archivedAt?: Date | null;
  createdBy?: PopulatedUser | null;
  convertedStudent?: { _id: Types.ObjectId; studentNumber: string } | null;
  convertedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields to populate on lead.convertedStudent. */
export const CONVERTED_STUDENT_FIELDS = 'studentNumber';

export interface LeadDto {
  id: string;
  reference: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
  profession: string | null;
  source: LeadSource;
  utm: { source: string | null; medium: string | null; campaign: string | null; term: string | null; content: string | null } | null;
  /** Attributed campaign (kept even if the campaign is later archived: `archived: true`). */
  campaign: CampaignRefDto | null;
  campaignAttributedAt: string | null;
  status: LeadStatus;
  statusChangedAt: string | null;
  lostReason: string | null;
  priority: LeadPriority;
  tags: LeadTag[];
  budget: number | null;
  assignedTo: UserRefDto | null;
  assignedAt: string | null;
  nextFollowUpAt: string | null;
  notesCount: number;
  archived: boolean;
  archivedAt: string | null;
  createdBy: UserRefDto | null;
  /** The student this lead was converted into (status REGISTERED), else null. */
  convertedStudent: { id: string; studentNumber: string } | null;
  convertedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const iso = (date?: Date | null) => (date ? date.toISOString() : null);

export function toUserRef(user?: PopulatedUser | null): UserRefDto | null {
  if (!user) return null;
  return { id: user._id.toString(), name: `${user.firstName} ${user.lastName}`.trim(), email: user.email };
}

/** Allow-list of what a lead looks like in API responses. */
export function toLeadDto(lead: LeadWithRefs): LeadDto {
  const utm = lead.utm;
  return {
    id: lead._id.toString(),
    reference: lead.reference,
    fullName: lead.fullName,
    email: lead.email ?? null,
    phone: lead.phone ?? null,
    country: lead.country ?? null,
    city: lead.city ?? null,
    profession: lead.profession ?? null,
    source: lead.source,
    utm: utm
      ? {
          source: utm.source ?? null,
          medium: utm.medium ?? null,
          campaign: utm.campaign ?? null,
          term: utm.term ?? null,
          content: utm.content ?? null,
        }
      : null,
    campaign: toCampaignRef(lead.campaign),
    campaignAttributedAt: iso(lead.campaignAttributedAt),
    status: lead.status,
    statusChangedAt: iso(lead.statusChangedAt),
    lostReason: lead.lostReason ?? null,
    priority: lead.priority,
    tags: lead.tags ?? [],
    budget: lead.budget ?? null,
    assignedTo: toUserRef(lead.assignedTo),
    assignedAt: iso(lead.assignedAt),
    nextFollowUpAt: iso(lead.nextFollowUpAt),
    notesCount: lead.notesCount,
    archived: Boolean(lead.archivedAt),
    archivedAt: iso(lead.archivedAt),
    createdBy: toUserRef(lead.createdBy),
    convertedStudent: lead.convertedStudent
      ? { id: lead.convertedStudent._id.toString(), studentNumber: lead.convertedStudent.studentNumber }
      : null,
    convertedAt: iso(lead.convertedAt),
    createdAt: lead.createdAt.toISOString(),
    updatedAt: lead.updatedAt.toISOString(),
  };
}

export interface LeadNoteDto {
  id: string;
  leadId: string;
  body: string;
  pinned: boolean;
  author: UserRefDto | null;
  createdAt: string;
  updatedAt: string;
}

export function toLeadNoteDto(note: {
  _id: Types.ObjectId;
  lead: Types.ObjectId;
  body: string;
  pinned?: boolean | null;
  author?: PopulatedUser | null;
  createdAt: Date;
  updatedAt: Date;
}): LeadNoteDto {
  return {
    id: note._id.toString(),
    leadId: note.lead.toString(),
    body: note.body,
    pinned: Boolean(note.pinned),
    author: toUserRef(note.author),
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}
