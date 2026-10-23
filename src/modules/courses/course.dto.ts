import type { Types } from 'mongoose';
import { CURRENCY, type Currency } from '../../config/money.js';
import { toUserRef, type UserRefDto } from '../leads/lead.dto.js';
import { type CourseLevel, type CourseStatus, ENROLLABLE_COURSE_STATUSES } from './course.model.js';

interface PopulatedUser {
  _id: Types.ObjectId;
  firstName: string;
  lastName: string;
  email: string;
}

export interface CourseWithRefs {
  _id: Types.ObjectId;
  code: string;
  name: string;
  description?: string | null;
  level: CourseLevel;
  duration?: string | null;
  hours?: number | null;
  price: number;
  seats?: number | null;
  startDate?: Date | null;
  endDate?: Date | null;
  status: CourseStatus;
  enrolledCount: number;
  archivedAt?: Date | null;
  createdBy?: PopulatedUser | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CourseDto {
  id: string;
  code: string;
  name: string;
  description: string;
  level: CourseLevel;
  duration: string | null;
  hours: number | null;
  /** Whole units of `currency` (see config/money.ts). */
  price: number;
  currency: Currency;
  /** null = unlimited. */
  seats: number | null;
  /** Enrollments holding a seat (every status except WITHDRAWN). */
  enrolledCount: number;
  /** null when seats is unlimited. */
  seatsAvailable: number | null;
  startDate: string | null;
  endDate: string | null;
  status: CourseStatus;
  /** UPCOMING/ACTIVE, not archived, and a seat available. */
  enrollable: boolean;
  archived: boolean;
  archivedAt: string | null;
  createdBy: UserRefDto | null;
  createdAt: string;
  updatedAt: string;
}

const iso = (date?: Date | null) => (date ? date.toISOString() : null);

export function toCourseDto(course: CourseWithRefs): CourseDto {
  const seats = course.seats ?? null;
  const seatsAvailable = seats === null ? null : Math.max(0, seats - course.enrolledCount);
  return {
    id: course._id.toString(),
    code: course.code,
    name: course.name,
    description: course.description ?? '',
    level: course.level,
    duration: course.duration ?? null,
    hours: course.hours ?? null,
    price: course.price,
    currency: CURRENCY,
    seats,
    enrolledCount: course.enrolledCount,
    seatsAvailable,
    startDate: iso(course.startDate),
    endDate: iso(course.endDate),
    status: course.status,
    enrollable:
      !course.archivedAt && ENROLLABLE_COURSE_STATUSES.includes(course.status) && (seatsAvailable === null || seatsAvailable > 0),
    archived: Boolean(course.archivedAt),
    archivedAt: iso(course.archivedAt),
    createdBy: toUserRef(course.createdBy),
    createdAt: course.createdAt.toISOString(),
    updatedAt: course.updatedAt.toISOString(),
  };
}

/** Compact course reference embedded in enrollment responses. */
export interface CourseRefDto {
  id: string;
  code: string;
  name: string;
}

export function toCourseRef(course?: { _id: Types.ObjectId; code: string; name: string } | null): CourseRefDto | null {
  return course ? { id: course._id.toString(), code: course.code, name: course.name } : null;
}
