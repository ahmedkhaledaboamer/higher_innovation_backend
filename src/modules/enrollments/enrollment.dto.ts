import type { Types } from 'mongoose';
import { CURRENCY, type Currency } from '../../config/money.js';
import { type CourseRefDto, toCourseRef } from '../courses/course.dto.js';
import { toUserRef, type UserRefDto } from '../leads/lead.dto.js';
import { type StudentRefDto, toStudentRef } from '../students/student.dto.js';
import type { EnrollmentStatus } from './enrollment.model.js';

export interface EnrollmentWithRefs {
  _id: Types.ObjectId;
  student: { _id: Types.ObjectId; studentNumber: string; fullName: string } | null;
  course: { _id: Types.ObjectId; code: string; name: string } | null;
  status: EnrollmentStatus;
  enrolledAt: Date;
  statusChangedAt?: Date | null;
  completedAt?: Date | null;
  withdrawnAt?: Date | null;
  price: number;
  enrolledBy?: { _id: Types.ObjectId; firstName: string; lastName: string; email: string } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnrollmentDto {
  id: string;
  student: StudentRefDto | null;
  course: CourseRefDto | null;
  status: EnrollmentStatus;
  enrolledAt: string;
  statusChangedAt: string | null;
  completedAt: string | null;
  withdrawnAt: string | null;
  /** Course price at enrollment time (whole units of `currency`). */
  price: number;
  currency: Currency;
  /** Staff member who enrolled the student (frontend `employeeId`). */
  enrolledBy: UserRefDto | null;
  createdAt: string;
  updatedAt: string;
}

const iso = (date?: Date | null) => (date ? date.toISOString() : null);

/** What a trainer sees about an enrollment in their course: no price, no enrolling staff member. */
export type EnrollmentTeachingDto = Omit<EnrollmentDto, 'price' | 'currency' | 'enrolledBy'>;

export function toEnrollmentTeachingDto(enrollment: EnrollmentWithRefs): EnrollmentTeachingDto {
  const { price: _price, currency: _currency, enrolledBy: _enrolledBy, ...rest } = toEnrollmentDto(enrollment);
  return rest;
}

export function toEnrollmentDto(enrollment: EnrollmentWithRefs): EnrollmentDto {
  return {
    id: enrollment._id.toString(),
    student: toStudentRef(enrollment.student),
    course: toCourseRef(enrollment.course),
    status: enrollment.status,
    enrolledAt: enrollment.enrolledAt.toISOString(),
    statusChangedAt: iso(enrollment.statusChangedAt),
    completedAt: iso(enrollment.completedAt),
    withdrawnAt: iso(enrollment.withdrawnAt),
    price: enrollment.price,
    currency: CURRENCY,
    enrolledBy: toUserRef(enrollment.enrolledBy),
    createdAt: enrollment.createdAt.toISOString(),
    updatedAt: enrollment.updatedAt.toISOString(),
  };
}
