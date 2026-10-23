import type { Types } from 'mongoose';
import { Campaign, CAMPAIGN_PLATFORMS, CAMPAIGN_STATUSES, type CampaignPlatform, type CampaignStatus } from '../campaigns/campaign.model.js';
import { Course, COURSE_STATUSES, type CourseStatus } from '../courses/course.model.js';
import { Enrollment, ENROLLMENT_STATUSES, type EnrollmentStatus } from '../enrollments/enrollment.model.js';
import { ratio } from '../leads/lead.metrics.js';
import { Lead } from '../leads/lead.model.js';
import { Student, STUDENT_STATUSES, type StudentStatus } from '../students/student.model.js';
import { bucketKeyExpression, bucketKeys, inRange, type Interval, type ReportRange } from './reportRange.js';

/**
 * Student, enrollment, course and campaign aggregations shared by the dashboard and reports.
 * `match` arguments carry the caller's scope; archived students and courses are excluded.
 * Enrollments have no archive state and are all counted (WITHDRAWN shown separately).
 */

function countsFor<K extends string>(keys: readonly K[], rows: Array<{ _id: K; count: number }>): Record<K, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  for (const row of rows) if (row._id in counts) counts[row._id] = row.count;
  return counts;
}

/* ---------------------------------- students ---------------------------------- */

export interface StudentSummary {
  /** Non-archived students. */
  total: number;
  byStatus: Record<StudentStatus, number>;
  /** Distinct students with at least one non-withdrawn enrollment. */
  withActiveEnrollments: number;
  /** Created by converting a lead (have a conversion record). */
  fromLeadConversion: number;
  /** Created directly (no conversion record). */
  createdDirectly: number;
}

export async function studentSummary(match: Record<string, unknown>): Promise<StudentSummary> {
  const [result] = await Student.aggregate<{
    byStatus: Array<{ _id: StudentStatus; count: number }>;
    enrolled: Array<{ count: number }>;
    converted: Array<{ count: number }>;
  }>([
    { $match: { $and: [match, { archivedAt: null }] } },
    {
      $facet: {
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        // activeEnrollments is maintained in the enrollment transactions, so this is one count per student.
        enrolled: [{ $match: { activeEnrollments: { $gt: 0 } } }, { $count: 'count' }],
        converted: [{ $match: { 'conversion.lead': { $type: 'objectId' } } }, { $count: 'count' }],
      },
    },
  ]);
  const byStatus = countsFor(STUDENT_STATUSES, result?.byStatus ?? []);
  const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
  const fromLeadConversion = result?.converted[0]?.count ?? 0;
  return {
    total,
    byStatus,
    withActiveEnrollments: result?.enrolled[0]?.count ?? 0,
    fromLeadConversion,
    createdDirectly: total - fromLeadConversion,
  };
}

/** Top countries of non-archived students (case-insensitive), at most `limit`. */
export async function studentCountries(match: Record<string, unknown>, limit: number) {
  const rows = await Student.aggregate<{ _id: string | null; label: string | null; count: number }>([
    { $match: { $and: [match, { archivedAt: null }] } },
    {
      $group: {
        _id: { $cond: [{ $eq: [{ $ifNull: ['$country', null] }, null] }, null, { $toLower: '$country' }] },
        label: { $first: '$country' },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1, _id: 1 } },
    { $limit: limit },
  ]);
  return rows.map((row) => ({ key: row._id, label: row.label ?? '(not set)', students: row.count }));
}

/* -------------------------------- enrollments --------------------------------- */

export interface EnrollmentSummary {
  /** All enrollments in scope, by current status. */
  byStatus: Record<EnrollmentStatus, number>;
  total: number;
  /** Enrollments not WITHDRAWN (seat-holding). */
  active: number;
  enrolledInRange: number;
  completedInRange: number;
  withdrawnInRange: number;
}

export async function enrollmentSummary(match: Record<string, unknown>, range: ReportRange): Promise<EnrollmentSummary> {
  const window = inRange(range);
  const [result] = await Enrollment.aggregate<{
    byStatus: Array<{ _id: EnrollmentStatus; count: number }>;
    enrolled: Array<{ count: number }>;
    completed: Array<{ count: number }>;
    withdrawn: Array<{ count: number }>;
  }>([
    { $match: match },
    {
      $facet: {
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        enrolled: [{ $match: { enrolledAt: window } }, { $count: 'count' }],
        completed: [{ $match: { completedAt: window } }, { $count: 'count' }],
        withdrawn: [{ $match: { withdrawnAt: window } }, { $count: 'count' }],
      },
    },
  ]);
  const byStatus = countsFor(ENROLLMENT_STATUSES, result?.byStatus ?? []);
  const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
  return {
    byStatus,
    total,
    active: total - byStatus.WITHDRAWN,
    enrolledInRange: result?.enrolled[0]?.count ?? 0,
    completedInRange: result?.completed[0]?.count ?? 0,
    withdrawnInRange: result?.withdrawn[0]?.count ?? 0,
  };
}

export async function enrollmentTimeseries(match: Record<string, unknown>, range: ReportRange, interval: Interval) {
  const window = inRange(range);
  const [enrolled, completed] = await Promise.all([
    Enrollment.aggregate<{ _id: string; count: number }>([
      { $match: { $and: [match, { enrolledAt: window }] } },
      { $group: { _id: bucketKeyExpression('enrolledAt', interval), count: { $sum: 1 } } },
    ]),
    Enrollment.aggregate<{ _id: string; count: number }>([
      { $match: { $and: [match, { completedAt: window }] } },
      { $group: { _id: bucketKeyExpression('completedAt', interval), count: { $sum: 1 } } },
    ]),
  ]);
  const enrolledBy = new Map(enrolled.map((row) => [row._id, row.count]));
  const completedBy = new Map(completed.map((row) => [row._id, row.count]));
  return bucketKeys(range, interval).map((period) => ({
    period,
    enrolled: enrolledBy.get(period) ?? 0,
    completed: completedBy.get(period) ?? 0,
  }));
}

/** Courses with the most enrollments created in the range (archived courses included and flagged). */
export async function popularCourses(match: Record<string, unknown>, range: ReportRange, limit: number) {
  return Enrollment.aggregate<{ courseId: Types.ObjectId; code: string; name: string; archived: boolean; enrollments: number }>([
    { $match: { $and: [match, { enrolledAt: inRange(range) }] } },
    { $group: { _id: '$course', enrollments: { $sum: 1 } } },
    { $sort: { enrollments: -1, _id: 1 } },
    { $limit: limit },
    { $lookup: { from: Course.collection.collectionName, localField: '_id', foreignField: '_id', as: 'course' } },
    { $unwind: '$course' },
    {
      $project: {
        _id: 0,
        courseId: '$_id',
        code: '$course.code',
        name: '$course.name',
        archived: { $ne: [{ $ifNull: ['$course.archivedAt', null] }, null] },
        enrollments: 1,
      },
    },
  ]);
}

/* ---------------------------------- courses ----------------------------------- */

export interface CourseCapacitySummary {
  /** Non-archived courses. */
  total: number;
  byStatus: Record<CourseStatus, number>;
  /** Courses with a seat limit. */
  limitedCourses: number;
  unlimitedCourses: number;
  /** Sum of seats over limited courses. */
  seats: number;
  /** Seat-holding enrollments in limited courses. */
  seatsTaken: number;
  /** seatsTaken / seats (0..1). */
  fillRate: number;
  fullCourses: number;
  /** Seat-holding enrollments across all non-archived courses. */
  enrolled: number;
}

export async function courseCapacity(): Promise<CourseCapacitySummary> {
  const [result] = await Course.aggregate<{
    byStatus: Array<{ _id: CourseStatus; count: number }>;
    capacity: Array<{ limited: number; seats: number; taken: number; full: number }>;
    enrolled: Array<{ count: number }>;
  }>([
    { $match: { archivedAt: null } },
    {
      $facet: {
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        capacity: [
          { $match: { seats: { $type: 'number' } } },
          {
            $group: {
              _id: null,
              limited: { $sum: 1 },
              seats: { $sum: '$seats' },
              taken: { $sum: '$enrolledCount' },
              full: { $sum: { $cond: [{ $gte: ['$enrolledCount', '$seats'] }, 1, 0] } },
            },
          },
        ],
        enrolled: [{ $group: { _id: null, count: { $sum: '$enrolledCount' } } }],
      },
    },
  ]);
  const byStatus = countsFor(COURSE_STATUSES, result?.byStatus ?? []);
  const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
  const capacity = result?.capacity[0] ?? { limited: 0, seats: 0, taken: 0, full: 0 };
  return {
    total,
    byStatus,
    limitedCourses: capacity.limited,
    unlimitedCourses: total - capacity.limited,
    seats: capacity.seats,
    seatsTaken: capacity.taken,
    fillRate: ratio(capacity.taken, capacity.seats),
    fullCourses: capacity.full,
    enrolled: result?.enrolled[0]?.count ?? 0,
  };
}

/* --------------------------------- campaigns ---------------------------------- */

export interface CampaignPortfolio {
  /** Non-archived campaigns. */
  total: number;
  byStatus: Record<CampaignStatus, number>;
  /** Whole AED; budgets that are not set count as 0. */
  budget: number;
  spent: number;
}

/** Status counts and money totals of non-archived campaigns. Money is lifetime (no daily spend data). */
export async function campaignPortfolio(): Promise<CampaignPortfolio> {
  const [result] = await Campaign.aggregate<{
    byStatus: Array<{ _id: CampaignStatus; count: number }>;
    money: Array<{ budget: number; spent: number }>;
  }>([
    { $match: { archivedAt: null } },
    {
      $facet: {
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        money: [{ $group: { _id: null, budget: { $sum: { $ifNull: ['$budget', 0] } }, spent: { $sum: '$spent' } } }],
      },
    },
  ]);
  const byStatus = countsFor(CAMPAIGN_STATUSES, result?.byStatus ?? []);
  return {
    total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
    byStatus,
    budget: result?.money[0]?.budget ?? 0,
    spent: result?.money[0]?.spent ?? 0,
  };
}

export interface PlatformRow {
  platform: CampaignPlatform;
  campaigns: number;
  budget: number;
  spent: number;
  /** Lifetime leads attributed to the platform's campaigns (non-archived leads). */
  leads: number;
  /** Of those, converted to students. */
  converted: number;
  /** Attributed leads created within the range. */
  leadsInRange: number;
  /** spent / leads (lifetime, AED, 2 decimals); null without leads. */
  costPerLead: number | null;
  /** spent / converted (lifetime, AED, 2 decimals); null without conversions. */
  costPerConversion: number | null;
  /** This platform's share of total spend (0..1). */
  spendShare: number;
}

/**
 * Per-platform performance of non-archived campaigns. Two aggregations: campaign money by
 * platform, and attributed lead counts by campaign (joined to platforms through the campaign
 * list, which is small). Spend is a lifetime figure, so cost ratios use lifetime lead counts;
 * `leadsInRange` is reported separately and never divided by lifetime spend.
 */
export async function platformPerformance(range: ReportRange): Promise<{ rows: PlatformRow[]; unattributedLeads: number; unattributedLeadsInRange: number }> {
  const window = inRange(range);
  const [campaigns, leadRows, unattributed] = await Promise.all([
    Campaign.find({ archivedAt: null }).select('platform budget spent').lean(),
    Lead.aggregate<{ _id: Types.ObjectId; leads: number; converted: number; inRange: number }>([
      { $match: { archivedAt: null, campaign: { $type: 'objectId' } } },
      {
        $group: {
          _id: '$campaign',
          leads: { $sum: 1 },
          converted: { $sum: { $cond: [{ $eq: ['$status', 'REGISTERED'] }, 1, 0] } },
          inRange: { $sum: { $cond: [{ $and: [{ $gte: ['$createdAt', window.$gte] }, { $lt: ['$createdAt', window.$lt] }] }, 1, 0] } },
        },
      },
    ]),
    Lead.aggregate<{ total: number; inRange: number }>([
      { $match: { archivedAt: null, campaign: null } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          inRange: { $sum: { $cond: [{ $and: [{ $gte: ['$createdAt', window.$gte] }, { $lt: ['$createdAt', window.$lt] }] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const leadsByCampaign = new Map(leadRows.map((row) => [row._id.toString(), row]));
  const rows = new Map<CampaignPlatform, PlatformRow>(
    CAMPAIGN_PLATFORMS.map((platform) => [
      platform,
      { platform, campaigns: 0, budget: 0, spent: 0, leads: 0, converted: 0, leadsInRange: 0, costPerLead: null, costPerConversion: null, spendShare: 0 },
    ]),
  );
  for (const campaign of campaigns) {
    const row = rows.get(campaign.platform)!;
    const leads = leadsByCampaign.get(campaign._id.toString());
    row.campaigns += 1;
    row.budget += campaign.budget ?? 0;
    row.spent += campaign.spent;
    row.leads += leads?.leads ?? 0;
    row.converted += leads?.converted ?? 0;
    row.leadsInRange += leads?.inRange ?? 0;
  }
  const totalSpent = [...rows.values()].reduce((sum, row) => sum + row.spent, 0);
  for (const row of rows.values()) {
    row.costPerLead = row.leads ? ratio(row.spent, row.leads, 2) : null;
    row.costPerConversion = row.converted ? ratio(row.spent, row.converted, 2) : null;
    row.spendShare = ratio(row.spent, totalSpent);
  }
  return {
    rows: [...rows.values()].filter((row) => row.campaigns > 0),
    unattributedLeads: unattributed[0]?.total ?? 0,
    unattributedLeadsInRange: unattributed[0]?.inRange ?? 0,
  };
}
