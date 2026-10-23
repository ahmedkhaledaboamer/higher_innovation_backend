import { runInTransaction } from '../../database/mongoose.js';
import type { AuthContext } from '../../types/express.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPaginationMeta, escapeRegex, type PaginationMeta, toSkip } from '../../utils/pagination.js';
import { endOpenAssignments } from '../assignments/assignments.service.js';
import { USER_REF_FIELDS } from '../leads/lead.dto.js';
import { type CourseDto, type CourseWithRefs, toCourseDto } from './course.dto.js';
import { Course, ENROLLABLE_COURSE_STATUSES } from './course.model.js';
import type { CreateCourseInput, ListCoursesQuery, UpdateCourseInput } from './courses.schema.js';

/**
 * The course catalog. Every role with courses:read sees every course (the catalog is not
 * personal data); changes need courses:write (Owner, Admin).
 */

const courseNotFound = () => ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');
const courseArchived = () =>
  ApiError.conflict('This course is archived. Restore it before making changes.', 'COURSE_ARCHIVED');
const codeTaken = () =>
  new ApiError(409, 'A course with this code already exists', 'COURSE_CODE_TAKEN', [
    { path: 'code', message: 'Already used by another course (including archived ones)' },
  ]);

async function loadDto(id: unknown): Promise<CourseDto> {
  const course = await Course.findById(id).populate('createdBy', USER_REF_FIELDS).lean();
  if (!course) throw courseNotFound();
  return toCourseDto(course as unknown as CourseWithRefs);
}

/** Condition for "accepts a new enrollment right now". Shared with the enrollment service. */
export function enrollableCondition(): Record<string, unknown> {
  return {
    archivedAt: null,
    status: { $in: ENROLLABLE_COURSE_STATUSES },
    $or: [{ seats: null }, { $expr: { $lt: ['$enrolledCount', '$seats'] } }],
  };
}

function listFilter(query: ListCoursesQuery): Record<string, unknown> {
  const conditions: Array<Record<string, unknown>> = [{ archivedAt: query.archived ? { $ne: null } : null }];

  if (query.status) conditions.push({ status: { $in: query.status } });
  if (query.level) conditions.push({ level: { $in: query.level } });
  if (query.startFrom || query.startTo) {
    conditions.push({
      startDate: {
        ...(query.startFrom ? { $gte: query.startFrom } : {}),
        ...(query.startTo ? { $lte: query.startTo } : {}),
      },
    });
  }
  if (query.enrollable === true) conditions.push(enrollableCondition());
  if (query.enrollable === false) conditions.push({ $nor: [enrollableCondition()] });
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i');
    conditions.push({ $or: [{ name: pattern }, { code: pattern }] });
  }
  return { $and: conditions };
}

export const coursesService = {
  async list(query: ListCoursesQuery): Promise<{ items: CourseDto[]; meta: PaginationMeta }> {
    const filter = listFilter(query);
    const direction = query.sortDir === 'asc' ? 1 : -1;
    const [items, total] = await Promise.all([
      Course.find(filter)
        .sort({ [query.sortBy]: direction, _id: direction })
        .collation({ locale: 'en', strength: 2 })
        .skip(toSkip(query))
        .limit(query.limit)
        .populate('createdBy', USER_REF_FIELDS)
        .lean(),
      Course.countDocuments(filter),
    ]);
    return {
      items: (items as unknown as CourseWithRefs[]).map(toCourseDto),
      meta: buildPaginationMeta(query, total),
    };
  },

  async getById(id: string): Promise<CourseDto> {
    return loadDto(id);
  },

  async create(actor: AuthContext, input: CreateCourseInput): Promise<CourseDto> {
    // Friendly error first; the unique index on code still guards against races.
    if (await Course.exists({ code: input.code })) throw codeTaken();

    const course = await Course.create({
      ...input,
      duration: input.duration ?? null,
      hours: input.hours ?? null,
      seats: input.seats ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      createdBy: actor.userId,
    });
    return loadDto(course._id);
  },

  async update(id: string, input: UpdateCourseInput): Promise<CourseDto> {
    const course = await Course.findById(id).lean();
    if (!course) throw courseNotFound();
    if (course.archivedAt) throw courseArchived();

    const startDate = input.startDate !== undefined ? input.startDate : course.startDate;
    const endDate = input.endDate !== undefined ? input.endDate : course.endDate;
    if (startDate && endDate && endDate < startDate) {
      throw ApiError.badRequest('endDate cannot be before startDate', 'VALIDATION_ERROR', [
        { path: 'endDate', message: 'endDate cannot be before startDate' },
      ]);
    }
    if (input.code && input.code !== course.code && (await Course.exists({ code: input.code }))) throw codeTaken();

    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) set[key] = value;
    }

    // Integrity rules checked inside the update itself, so a concurrent enrollment cannot slip past them.
    const conditions: Record<string, unknown> = { _id: id, archivedAt: null };
    if (typeof input.seats === 'number') conditions.enrolledCount = { $lte: input.seats };
    if (input.status === 'DRAFT') conditions.enrolledCount = { ...(conditions.enrolledCount as object), $eq: 0 };

    const result = await Course.updateOne(conditions, { $set: set }, { runValidators: true });
    if (result.matchedCount === 0) {
      const fresh = await Course.findById(id).lean();
      if (!fresh) throw courseNotFound();
      if (fresh.archivedAt) throw courseArchived();
      if (input.status === 'DRAFT' && fresh.enrolledCount > 0) {
        throw ApiError.conflict('A course with enrolled students cannot go back to DRAFT', 'COURSE_HAS_ENROLLMENTS');
      }
      throw new ApiError(
        409,
        `seats cannot be lower than the ${fresh.enrolledCount} students already enrolled`,
        'SEATS_BELOW_ENROLLED',
        [{ path: 'seats', message: `Must be at least ${fresh.enrolledCount}` }],
      );
    }
    return loadDto(id);
  },

  /**
   * Archived courses leave the catalog and accept no new enrollments; existing enrollments are
   * kept. Open trainer assignments end (CANCELLED, reason COURSE_ARCHIVED) in the same
   * transaction, so trainers lose teaching access to the course; diplomas keep listing it.
   */
  async archive(actor: AuthContext, id: string): Promise<CourseDto> {
    await runInTransaction(async (session) => {
      const result = await Course.updateOne(
        { _id: id, archivedAt: null },
        { $set: { archivedAt: new Date(), archivedBy: actor.userId, openAssignments: 0 } },
        { session },
      );
      if (result.matchedCount === 0) {
        if (!(await Course.exists({ _id: id }).session(session))) throw courseNotFound();
        throw ApiError.conflict('This course is already archived', 'COURSE_ALREADY_ARCHIVED');
      }
      await endOpenAssignments({ course: id }, 'COURSE_ARCHIVED', actor.userId, session);
    });
    return loadDto(id);
  },

  async restore(id: string): Promise<CourseDto> {
    const result = await Course.updateOne(
      { _id: id, archivedAt: { $ne: null } },
      { $set: { archivedAt: null, archivedBy: null } },
    );
    if (result.matchedCount === 0) {
      if (!(await Course.exists({ _id: id }))) throw courseNotFound();
      throw ApiError.conflict('This course is not archived', 'COURSE_NOT_ARCHIVED');
    }
    return loadDto(id);
  },
};
