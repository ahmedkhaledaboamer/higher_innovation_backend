import type { Types } from 'mongoose';
import { CURRENCY, type Currency } from '../../config/money.js';
import type { CourseLevel, CourseStatus } from '../courses/course.model.js';
import { toUserRef, type UserRefDto } from '../leads/lead.dto.js';
import type { DiplomaStatus } from './diploma.model.js';

interface PopulatedCourse {
  _id: Types.ObjectId;
  code: string;
  name: string;
  status: CourseStatus;
  archivedAt?: Date | null;
}

export interface DiplomaWithRefs {
  _id: Types.ObjectId;
  name: string;
  description?: string | null;
  level: CourseLevel;
  duration?: string | null;
  price?: number | null;
  status: DiplomaStatus;
  courses: Array<PopulatedCourse | null>;
  archivedAt?: Date | null;
  createdBy?: { _id: Types.ObjectId; firstName: string; lastName: string; email: string } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DiplomaCourseDto {
  id: string;
  code: string;
  name: string;
  status: CourseStatus;
  /** Archived courses stay listed in diplomas they already belonged to. */
  archived: boolean;
}

export interface DiplomaDto {
  id: string;
  name: string;
  description: string;
  level: CourseLevel;
  duration: string | null;
  /** Whole units of `currency`; null if not priced as a package. */
  price: number | null;
  currency: Currency;
  status: DiplomaStatus;
  /** Ordered course ids (frontend `courseIds[]`). */
  courseIds: string[];
  courses: DiplomaCourseDto[];
  coursesCount: number;
  archived: boolean;
  archivedAt: string | null;
  createdBy: UserRefDto | null;
  createdAt: string;
  updatedAt: string;
}

export const DIPLOMA_COURSE_FIELDS = 'code name status archivedAt';

export function toDiplomaDto(diploma: DiplomaWithRefs): DiplomaDto {
  const courses = diploma.courses
    .filter((course): course is PopulatedCourse => course !== null)
    .map((course) => ({
      id: course._id.toString(),
      code: course.code,
      name: course.name,
      status: course.status,
      archived: Boolean(course.archivedAt),
    }));
  return {
    id: diploma._id.toString(),
    name: diploma.name,
    description: diploma.description ?? '',
    level: diploma.level,
    duration: diploma.duration ?? null,
    price: diploma.price ?? null,
    currency: CURRENCY,
    status: diploma.status,
    courseIds: courses.map((course) => course.id),
    courses,
    coursesCount: courses.length,
    archived: Boolean(diploma.archivedAt),
    archivedAt: diploma.archivedAt ? diploma.archivedAt.toISOString() : null,
    createdBy: toUserRef(diploma.createdBy),
    createdAt: diploma.createdAt.toISOString(),
    updatedAt: diploma.updatedAt.toISOString(),
  };
}
