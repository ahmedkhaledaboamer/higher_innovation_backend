import mongoose, { Types } from 'mongoose';
import type { AuthContext } from '../../types/express.js';
import { ApiError, type ErrorDetail } from '../../utils/ApiError.js';
import { buildPaginationMeta, escapeRegex, type PaginationMeta, toSkip } from '../../utils/pagination.js';
import { Course } from '../courses/course.model.js';
import { USER_REF_FIELDS } from '../leads/lead.dto.js';
import { DIPLOMA_COURSE_FIELDS, type DiplomaDto, type DiplomaWithRefs, toDiplomaDto } from './diploma.dto.js';
import { Diploma } from './diploma.model.js';
import type { CreateDiplomaInput, ListDiplomasQuery, UpdateDiplomaInput } from './diplomas.schema.js';

/**
 * Diplomas: catalog data, like courses (courses:read / courses:write). A diploma lists courses;
 * a course can be in several diplomas. Nothing here enrolls or charges students.
 */

const NAME_COLLATION = { locale: 'en', strength: 2 } as const;

const diplomaNotFound = () => ApiError.notFound('Diploma not found', 'DIPLOMA_NOT_FOUND');
const diplomaArchived = () =>
  ApiError.conflict('This diploma is archived. Restore it before making changes.', 'DIPLOMA_ARCHIVED');
const nameTaken = () =>
  new ApiError(409, 'A diploma with this name already exists', 'DIPLOMA_NAME_TAKEN', [
    { path: 'name', message: 'Already used by another diploma (including archived ones)' },
  ]);

async function loadDto(id: unknown): Promise<DiplomaDto> {
  const diploma = await Diploma.findById(id)
    .populate('courses', DIPLOMA_COURSE_FIELDS)
    .populate('createdBy', USER_REF_FIELDS)
    .lean();
  if (!diploma) throw diplomaNotFound();
  return toDiplomaDto(diploma as unknown as DiplomaWithRefs);
}

async function nameExists(name: string, exceptId?: string): Promise<boolean> {
  const filter: Record<string, unknown> = { name };
  if (exceptId) filter._id = { $ne: exceptId };
  return Boolean(await Diploma.findOne(filter).collation(NAME_COLLATION).select('_id').lean());
}

/**
 * Every referenced course must exist. Courses being *added* must also not be archived;
 * courses already in the diploma may stay even if archived since (history).
 */
async function validateCourses(courseIds: string[], alreadyIncluded: Set<string> = new Set()): Promise<Types.ObjectId[]> {
  const ids = courseIds.map((id) => new Types.ObjectId(id));
  const found = await Course.find({ _id: { $in: ids } }).select('_id archivedAt').lean();
  const byId = new Map(found.map((course) => [course._id.toString(), course]));

  const missing: ErrorDetail[] = [];
  const archived: ErrorDetail[] = [];
  courseIds.forEach((id, index) => {
    const course = byId.get(id);
    if (!course) missing.push({ path: `courseIds.${index}`, message: 'Course not found' });
    else if (course.archivedAt && !alreadyIncluded.has(id)) {
      archived.push({ path: `courseIds.${index}`, message: 'Archived courses cannot be added' });
    }
  });
  if (missing.length) throw ApiError.badRequest('Some courses do not exist', 'COURSE_NOT_FOUND', missing);
  if (archived.length) throw new ApiError(409, 'Archived courses cannot be added to a diploma', 'COURSE_ARCHIVED', archived);
  return ids;
}

function uniqueConflict(error: unknown): ApiError | null {
  return error instanceof mongoose.mongo.MongoServerError && error.code === 11000 ? nameTaken() : null;
}

export const diplomasService = {
  async list(query: ListDiplomasQuery): Promise<{ items: DiplomaDto[]; meta: PaginationMeta }> {
    const conditions: Array<Record<string, unknown>> = [{ archivedAt: query.archived ? { $ne: null } : null }];
    if (query.status) conditions.push({ status: { $in: query.status } });
    if (query.level) conditions.push({ level: { $in: query.level } });
    if (query.course) conditions.push({ courses: { $in: query.course.map((id) => new Types.ObjectId(id)) } });
    if (query.search) conditions.push({ name: new RegExp(escapeRegex(query.search), 'i') });

    const filter = { $and: conditions };
    const direction = query.sortDir === 'asc' ? 1 : -1;
    const [items, total] = await Promise.all([
      Diploma.find(filter)
        .sort({ [query.sortBy]: direction, _id: direction })
        .collation(NAME_COLLATION)
        .skip(toSkip(query))
        .limit(query.limit)
        .populate('courses', DIPLOMA_COURSE_FIELDS)
        .populate('createdBy', USER_REF_FIELDS)
        .lean(),
      Diploma.countDocuments(filter),
    ]);
    return {
      items: (items as unknown as DiplomaWithRefs[]).map(toDiplomaDto),
      meta: buildPaginationMeta(query, total),
    };
  },

  async getById(id: string): Promise<DiplomaDto> {
    return loadDto(id);
  },

  async create(actor: AuthContext, input: CreateDiplomaInput): Promise<DiplomaDto> {
    if (await nameExists(input.name)) throw nameTaken();
    const courses = await validateCourses(input.courseIds);
    const { courseIds: _courseIds, ...fields } = input;
    try {
      const diploma = await Diploma.create({
        ...fields,
        duration: fields.duration ?? null,
        price: fields.price ?? null,
        courses,
        createdBy: actor.userId,
      });
      return loadDto(diploma._id);
    } catch (error) {
      throw uniqueConflict(error) ?? error;
    }
  },

  async update(id: string, input: UpdateDiplomaInput): Promise<DiplomaDto> {
    const diploma = await Diploma.findById(id).lean();
    if (!diploma) throw diplomaNotFound();
    if (diploma.archivedAt) throw diplomaArchived();
    if (input.name && (await nameExists(input.name, id))) throw nameTaken();

    const { courseIds, ...fields } = input;
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) set[key] = value;
    }
    if (courseIds) {
      set.courses = await validateCourses(courseIds, new Set(diploma.courses.map((course) => course.toString())));
    }

    try {
      const result = await Diploma.updateOne({ _id: id, archivedAt: null }, { $set: set }, { runValidators: true });
      if (result.matchedCount === 0) throw diplomaArchived();
    } catch (error) {
      throw uniqueConflict(error) ?? error;
    }
    return loadDto(id);
  },

  async archive(actor: AuthContext, id: string): Promise<DiplomaDto> {
    const result = await Diploma.updateOne(
      { _id: id, archivedAt: null },
      { $set: { archivedAt: new Date(), archivedBy: actor.userId } },
    );
    if (result.matchedCount === 0) {
      if (!(await Diploma.exists({ _id: id }))) throw diplomaNotFound();
      throw ApiError.conflict('This diploma is already archived', 'DIPLOMA_ALREADY_ARCHIVED');
    }
    return loadDto(id);
  },

  async restore(id: string): Promise<DiplomaDto> {
    const result = await Diploma.updateOne(
      { _id: id, archivedAt: { $ne: null } },
      { $set: { archivedAt: null, archivedBy: null } },
    );
    if (result.matchedCount === 0) {
      if (!(await Diploma.exists({ _id: id }))) throw diplomaNotFound();
      throw ApiError.conflict('This diploma is not archived', 'DIPLOMA_NOT_ARCHIVED');
    }
    return loadDto(id);
  },
};
