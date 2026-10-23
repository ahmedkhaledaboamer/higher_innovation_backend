import type { Types } from 'mongoose';
import { toUserRef, type UserRefDto } from '../leads/lead.dto.js';
import type { TrainerStatus } from './trainer.model.js';

interface PopulatedUser {
  _id: Types.ObjectId;
  firstName: string;
  lastName: string;
  email: string;
}

export interface TrainerWithRefs {
  _id: Types.ObjectId;
  code: string;
  fullName: string;
  title?: string | null;
  specialization?: string | null;
  email: string;
  phone?: string | null;
  bio?: string | null;
  status: TrainerStatus;
  experienceYears?: number | null;
  weeklyCapacityHours?: number | null;
  joinDate?: Date | null;
  city?: string | null;
  country?: string | null;
  user?: PopulatedUser | null;
  openAssignments: number;
  archivedAt?: Date | null;
  createdBy?: PopulatedUser | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TrainerDto {
  id: string;
  /** e.g. "TR-1001" */
  code: string;
  fullName: string;
  title: string | null;
  specialization: string | null;
  email: string;
  phone: string | null;
  bio: string;
  status: TrainerStatus;
  experienceYears: number | null;
  weeklyCapacityHours: number | null;
  /** YYYY-MM-DD */
  joinDate: string | null;
  city: string | null;
  country: string | null;
  /** Linked login account (role TRAINER), if any. */
  user: UserRefDto | null;
  /** Open (SCHEDULED/ACTIVE) assignments: the frontend's coursesCount. */
  openAssignments: number;
  archived: boolean;
  archivedAt: string | null;
  createdBy: UserRefDto | null;
  createdAt: string;
  updatedAt: string;
}

const iso = (date?: Date | null) => (date ? date.toISOString() : null);

export function toTrainerDto(trainer: TrainerWithRefs): TrainerDto {
  return {
    id: trainer._id.toString(),
    code: trainer.code,
    fullName: trainer.fullName,
    title: trainer.title ?? null,
    specialization: trainer.specialization ?? null,
    email: trainer.email,
    phone: trainer.phone ?? null,
    bio: trainer.bio ?? '',
    status: trainer.status,
    experienceYears: trainer.experienceYears ?? null,
    weeklyCapacityHours: trainer.weeklyCapacityHours ?? null,
    joinDate: trainer.joinDate ? trainer.joinDate.toISOString().slice(0, 10) : null,
    city: trainer.city ?? null,
    country: trainer.country ?? null,
    user: toUserRef(trainer.user),
    openAssignments: trainer.openAssignments,
    archived: Boolean(trainer.archivedAt),
    archivedAt: iso(trainer.archivedAt),
    createdBy: toUserRef(trainer.createdBy),
    createdAt: trainer.createdAt.toISOString(),
    updatedAt: trainer.updatedAt.toISOString(),
  };
}

/** Compact trainer reference embedded in assignment responses. */
export interface TrainerRefDto {
  id: string;
  code: string;
  fullName: string;
}

export function toTrainerRef(trainer?: { _id: Types.ObjectId; code: string; fullName: string } | null): TrainerRefDto | null {
  return trainer ? { id: trainer._id.toString(), code: trainer.code, fullName: trainer.fullName } : null;
}
