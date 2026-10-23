import type { AuthContext } from '../../types/express.js';
import { teachingCourseIds } from '../assignments/teaching.access.js';
import { enrollmentReadScope } from '../enrollments/enrollments.service.js';
import { readScope as leadReadScope } from '../leads/lead.access.js';
import { type Permission, PERMISSIONS } from '../roles/permissions.js';
import { studentReadAccess, studentReadScope } from '../students/student.access.js';
import { Trainer, TRAINER_STATUSES } from '../trainers/trainer.model.js';
import { User, USER_STATUSES } from '../users/user.model.js';
import { campaignPortfolio, courseCapacity, enrollmentSummary, studentSummary } from '../reports/academyReports.js';
import { followUpsDue, leadRangeSummary } from '../reports/leadReports.js';
import type { ReportRange } from '../reports/reportRange.js';

/**
 * GET /dashboard/summary: one call for the home screen, available to every signed-in user.
 *
 * Each section is included only when the caller holds the permission that grants that data
 * elsewhere in the API, and is computed inside the caller's existing scope:
 *   leads       – leads:read_all (all) or leads:read_assigned (Sales: own leads only)
 *   students    – students:read_all / read_assigned (advised) / read_teaching (taught courses)
 *   enrollments – enrollments:read + a student scope (Sales: advised students; Trainer: taught courses)
 *   teaching    – trainers with a linked profile: number of courses taught
 *   courses     – courses:read (catalog capacity; not personal data)
 *   campaigns   – campaigns:read
 *   staff       – users:read / trainers:read
 * No section reveals data its permission would not already reveal through list endpoints.
 */

const has = (actor: AuthContext, permission: Permission) => actor.permissions.includes(permission);

async function countByStatus<K extends string>(
  model: typeof User | typeof Trainer,
  statuses: readonly K[],
  match: Record<string, unknown>,
): Promise<Record<K, number>> {
  const rows = await (model as typeof User).aggregate<{ _id: K; count: number }>([
    { $match: match },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(statuses.map((s) => [s, 0])) as Record<K, number>;
  for (const row of rows) if (row._id in counts) counts[row._id] = row.count;
  return counts;
}

export const dashboardService = {
  async summary(actor: AuthContext, range: ReportRange) {
    const sections: Record<string, unknown> = {};
    const jobs: Array<Promise<void>> = [];

    if (has(actor, PERMISSIONS.LEADS_READ_ALL) || has(actor, PERMISSIONS.LEADS_READ_ASSIGNED)) {
      const scope = leadReadScope(actor);
      jobs.push(
        Promise.all([leadRangeSummary(scope, range), followUpsDue(scope)]).then(([summary, due]) => {
          sections.leads = { scope: has(actor, PERMISSIONS.LEADS_READ_ALL) ? 'all' : 'assigned', ...summary, followUpsDue: due };
        }),
      );
    }

    let studentAccess: ReturnType<typeof studentReadAccess> | null = null;
    try {
      studentAccess = studentReadAccess(actor);
    } catch {
      studentAccess = null; // no student permission: no student/enrollment sections
    }
    if (studentAccess) {
      const access = studentAccess;
      jobs.push(
        studentReadScope(actor).then(async (scope) => {
          const summary = await studentSummary(scope);
          if (access === 'teaching') {
            // Trainers' student view excludes conversion data; so do their counts.
            const { fromLeadConversion: _converted, createdDirectly: _direct, ...teachingSummary } = summary;
            sections.students = { scope: access, ...teachingSummary };
          } else {
            sections.students = { scope: access, ...summary };
          }
        }),
      );
      if (has(actor, PERMISSIONS.ENROLLMENTS_READ)) {
        jobs.push(
          enrollmentReadScope(actor).then(async (scope) => {
            sections.enrollments = { scope: access, ...(await enrollmentSummary(scope, range)) };
          }),
        );
      }
      if (access === 'teaching') {
        jobs.push(
          teachingCourseIds(actor.userId).then((ids) => {
            sections.teaching = { coursesTaught: ids.length };
          }),
        );
      }
    }

    if (has(actor, PERMISSIONS.COURSES_READ)) {
      jobs.push(courseCapacity().then((courses) => void (sections.courses = courses)));
    }
    if (has(actor, PERMISSIONS.CAMPAIGNS_READ)) {
      jobs.push(campaignPortfolio().then((campaigns) => void (sections.campaigns = campaigns)));
    }
    if (has(actor, PERMISSIONS.USERS_READ) || has(actor, PERMISSIONS.TRAINERS_READ)) {
      jobs.push(
        (async () => {
          const staff: Record<string, unknown> = {};
          if (has(actor, PERMISSIONS.USERS_READ)) staff.usersByStatus = await countByStatus(User, USER_STATUSES, {});
          if (has(actor, PERMISSIONS.TRAINERS_READ)) {
            staff.trainersByStatus = await countByStatus(Trainer, TRAINER_STATUSES, { archivedAt: null });
          }
          sections.staff = staff;
        })(),
      );
    }

    await Promise.all(jobs);
    return {
      range: { from: range.from, to: range.to, days: range.days, timezone: range.timezone },
      sections,
    };
  },
};
