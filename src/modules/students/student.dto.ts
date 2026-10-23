import type { Types } from 'mongoose';
import { type CampaignRefDto, toCampaignRef } from '../campaigns/campaign.ref.js';
import { toUserRef, type UserRefDto } from '../leads/lead.dto.js';
import type { LeadSource } from '../leads/lead.model.js';
import type { StudentStatus } from './student.model.js';

interface PopulatedUser {
  _id: Types.ObjectId;
  firstName: string;
  lastName: string;
  email: string;
}

export interface StudentWithRefs {
  _id: Types.ObjectId;
  studentNumber: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  city?: string | null;
  profession?: string | null;
  dateOfBirth?: Date | null;
  status: StudentStatus;
  advisor?: PopulatedUser | null;
  advisorAssignedAt?: Date | null;
  activeEnrollments: number;
  archivedAt?: Date | null;
  createdBy?: PopulatedUser | null;
  conversion?: {
    lead: Types.ObjectId;
    leadReference: string;
    source: LeadSource;
    utm?: Record<string, string | null | undefined> | null;
    campaign?: { _id: Types.ObjectId; code: string; name: string; archivedAt?: Date | null } | null;
    convertedAt: Date;
    convertedBy?: PopulatedUser | null;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Read-only attribution of a student created by converting a lead. */
export interface StudentConversionDto {
  leadId: string;
  leadReference: string;
  source: LeadSource;
  utm: { source: string | null; medium: string | null; campaign: string | null; term: string | null; content: string | null } | null;
  /** The lead's campaign at conversion time (snapshot). */
  campaign: CampaignRefDto | null;
  convertedAt: string;
  convertedBy: UserRefDto | null;
}

export interface StudentDto {
  id: string;
  studentNumber: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
  profession: string | null;
  /** YYYY-MM-DD */
  dateOfBirth: string | null;
  status: StudentStatus;
  advisor: UserRefDto | null;
  advisorAssignedAt: string | null;
  /** Enrollments that are not WITHDRAWN. */
  activeEnrollments: number;
  archived: boolean;
  archivedAt: string | null;
  createdBy: UserRefDto | null;
  /** Present only for students created by converting a lead. */
  conversion: StudentConversionDto | null;
  createdAt: string;
  updatedAt: string;
}

const iso = (date?: Date | null) => (date ? date.toISOString() : null);

export function toStudentDto(student: StudentWithRefs): StudentDto {
  return {
    id: student._id.toString(),
    studentNumber: student.studentNumber,
    fullName: student.fullName,
    email: student.email ?? null,
    phone: student.phone ?? null,
    country: student.country ?? null,
    city: student.city ?? null,
    profession: student.profession ?? null,
    dateOfBirth: student.dateOfBirth ? student.dateOfBirth.toISOString().slice(0, 10) : null,
    status: student.status,
    advisor: toUserRef(student.advisor),
    advisorAssignedAt: iso(student.advisorAssignedAt),
    activeEnrollments: student.activeEnrollments,
    archived: Boolean(student.archivedAt),
    archivedAt: iso(student.archivedAt),
    createdBy: toUserRef(student.createdBy),
    conversion: student.conversion
      ? {
          leadId: student.conversion.lead.toString(),
          leadReference: student.conversion.leadReference,
          source: student.conversion.source,
          utm: student.conversion.utm
            ? {
                source: student.conversion.utm.source ?? null,
                medium: student.conversion.utm.medium ?? null,
                campaign: student.conversion.utm.campaign ?? null,
                term: student.conversion.utm.term ?? null,
                content: student.conversion.utm.content ?? null,
              }
            : null,
          campaign: toCampaignRef(student.conversion.campaign),
          convertedAt: student.conversion.convertedAt.toISOString(),
          convertedBy: toUserRef(student.conversion.convertedBy),
        }
      : null,
    createdAt: student.createdAt.toISOString(),
    updatedAt: student.updatedAt.toISOString(),
  };
}

/**
 * What a trainer sees about a student of their course: enough to teach and contact them,
 * nothing more (no phone, date of birth, address, advisor or conversion data).
 */
export interface StudentTeachingDto {
  id: string;
  studentNumber: string;
  fullName: string;
  email: string | null;
  status: StudentStatus;
}

export function toStudentTeachingDto(student: StudentWithRefs): StudentTeachingDto {
  return {
    id: student._id.toString(),
    studentNumber: student.studentNumber,
    fullName: student.fullName,
    email: student.email ?? null,
    status: student.status,
  };
}

/** Compact student reference embedded in enrollment responses. */
export interface StudentRefDto {
  id: string;
  studentNumber: string;
  fullName: string;
}

export function toStudentRef(
  student?: { _id: Types.ObjectId; studentNumber: string; fullName: string } | null,
): StudentRefDto | null {
  return student ? { id: student._id.toString(), studentNumber: student.studentNumber, fullName: student.fullName } : null;
}
