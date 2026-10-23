import type { Types } from 'mongoose';
import { type CourseRefDto, toCourseRef } from '../courses/course.dto.js';
import { toUserRef, type UserRefDto } from '../leads/lead.dto.js';
import { toTrainerRef, type TrainerRefDto } from '../trainers/trainer.dto.js';
import type { AssignmentRole, AssignmentStatus } from './assignment.model.js';

interface PopulatedUser {
  _id: Types.ObjectId;
  firstName: string;
  lastName: string;
  email: string;
}

export interface AssignmentWithRefs {
  _id: Types.ObjectId;
  trainer: { _id: Types.ObjectId; code: string; fullName: string } | null;
  course: { _id: Types.ObjectId; code: string; name: string } | null;
  role: AssignmentRole;
  status: AssignmentStatus;
  isOpen: boolean;
  startDate?: Date | null;
  endDate?: Date | null;
  teachingHours?: number | null;
  endedAt?: Date | null;
  endedReason?: string | null;
  endedBy?: PopulatedUser | null;
  assignedBy?: PopulatedUser | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssignmentDto {
  id: string;
  trainer: TrainerRefDto | null;
  course: CourseRefDto | null;
  role: AssignmentRole;
  status: AssignmentStatus;
  /** SCHEDULED or ACTIVE. */
  open: boolean;
  startDate: string | null;
  endDate: string | null;
  teachingHours: number | null;
  endedAt: string | null;
  /** MANUAL, TRAINER_ARCHIVED or COURSE_ARCHIVED. */
  endedReason: string | null;
  endedBy: UserRefDto | null;
  assignedBy: UserRefDto | null;
  createdAt: string;
  updatedAt: string;
}

const iso = (date?: Date | null) => (date ? date.toISOString() : null);

export function toAssignmentDto(assignment: AssignmentWithRefs): AssignmentDto {
  return {
    id: assignment._id.toString(),
    trainer: toTrainerRef(assignment.trainer),
    course: toCourseRef(assignment.course),
    role: assignment.role,
    status: assignment.status,
    open: assignment.isOpen,
    startDate: iso(assignment.startDate),
    endDate: iso(assignment.endDate),
    teachingHours: assignment.teachingHours ?? null,
    endedAt: iso(assignment.endedAt),
    endedReason: assignment.endedReason ?? null,
    endedBy: toUserRef(assignment.endedBy),
    assignedBy: toUserRef(assignment.assignedBy),
    createdAt: assignment.createdAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
  };
}
