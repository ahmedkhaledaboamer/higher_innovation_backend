/**
 * Demo data for local development and demos: 10 realistic records per business module, created
 * through the same services and validation schemas as the API, so every invariant (reference
 * numbers, contact rules, seat counts, open-assignment counters, campaign attribution) holds.
 *
 * Safe to run repeatedly: each record has a stable natural key (email, course code, UTM campaign,
 * diploma name, student/course pair, ...). A record whose key already exists is skipped and never
 * modified; nothing is ever deleted. Demo people use the reserved ".test" domain, demo course codes
 * start with "DEMO-", and demo staff accounts have no password (they cannot sign in).
 *
 * Images: only users have an image field in this project (`avatarUrl`). Each demo user gets its own
 * original SVG avatar served by the frontend from `public/demo/avatars/`. Courses, students, trainers,
 * leads, campaigns, diplomas and enrollments have no image field, so none is invented.
 *
 * Run with `npm run seed:demo` (src/scripts/seed-demo-data.ts), which refuses non-local targets.
 */
import type mongoose from 'mongoose';
import { Types } from 'mongoose';
import { CAMPAIGN_STATUSES } from '../modules/campaigns/campaign.model.js';
import { createCampaignSchema } from '../modules/campaigns/campaigns.schema.js';
import { campaignsService } from '../modules/campaigns/campaigns.service.js';
import { createAssignmentSchema } from '../modules/assignments/assignments.schema.js';
import { assignmentsService } from '../modules/assignments/assignments.service.js';
import { TrainerAssignment } from '../modules/assignments/assignment.model.js';
import { Course } from '../modules/courses/course.model.js';
import { createCourseSchema } from '../modules/courses/courses.schema.js';
import { coursesService } from '../modules/courses/courses.service.js';
import { Diploma } from '../modules/diplomas/diploma.model.js';
import { createDiplomaSchema } from '../modules/diplomas/diplomas.schema.js';
import { diplomasService } from '../modules/diplomas/diplomas.service.js';
import { Enrollment, ENROLLMENT_STATUSES } from '../modules/enrollments/enrollment.model.js';
import { createEnrollmentSchema } from '../modules/enrollments/enrollments.schema.js';
import { enrollmentsService } from '../modules/enrollments/enrollments.service.js';
import { Lead } from '../modules/leads/lead.model.js';
import { LeadNote } from '../modules/leads/leadNote.model.js';
import { createLeadNoteSchema, createLeadSchema, updateLeadStatusSchema } from '../modules/leads/leads.schema.js';
import { leadsService } from '../modules/leads/leads.service.js';
import { ROLE_DEFINITIONS, ROLE_KEYS, type RoleKey } from '../modules/roles/permissions.js';
import { Role } from '../modules/roles/role.model.js';
import { Student } from '../modules/students/student.model.js';
import { createStudentSchema } from '../modules/students/students.schema.js';
import { studentsService } from '../modules/students/students.service.js';
import { Trainer } from '../modules/trainers/trainer.model.js';
import { createTrainerSchema } from '../modules/trainers/trainers.schema.js';
import { trainersService } from '../modules/trainers/trainers.service.js';
import { User } from '../modules/users/user.model.js';
import { Campaign } from '../modules/campaigns/campaign.model.js';
import type { AuthContext } from '../types/express.js';
import { ALL_MODELS } from './setup.js';

export const DEMO_EMAIL_DOMAIN = 'demo.hia-academy.test';
export const DEMO_COURSE_PREFIX = 'DEMO-';
/** Path under the frontend origin; the files live in Higher-Innovation-Academy-CRM/public/demo/avatars. */
export const DEMO_AVATAR_BASE = '/demo/avatars';

export const DEMO_MODULES = ['users', 'courses', 'trainers', 'trainerAssignments', 'campaigns', 'diplomas', 'students', 'enrollments', 'leads', 'leadNotes'] as const;
export type DemoModule = (typeof DEMO_MODULES)[number];
export type DemoSeedReport = Record<DemoModule, { created: number; skipped: number }>;

const email = (local: string) => `${local}@${DEMO_EMAIL_DOMAIN}`;

/* ---------------------------------------------------------------- data ---------------------------------------------------------------- */

/** Staff accounts. All but one are ACTIVE (assignable), none has a password. The first is the actor for the seed. */
export const DEMO_USERS = [
  { key: 'omar', firstName: 'Omar', lastName: 'Khaled', role: 'ADMIN', department: 'Operations', location: 'Cairo', phone: '+20 100 555 0101', status: 'ACTIVE', avatar: 'omar-khaled' },
  { key: 'mariam', firstName: 'Mariam', lastName: 'Adel', role: 'MARKETING', department: 'Marketing', location: 'Cairo', phone: '+20 100 555 0102', status: 'ACTIVE', avatar: 'mariam-adel' },
  { key: 'youssef', firstName: 'Youssef', lastName: 'Samir', role: 'MARKETING', department: 'Marketing', location: 'Giza', phone: '+20 100 555 0103', status: 'ACTIVE', avatar: 'youssef-samir' },
  { key: 'nour', firstName: 'Nour El-Din', lastName: 'Hassan', role: 'SALES', department: 'Admissions', location: 'Cairo', phone: '+20 100 555 0104', status: 'ACTIVE', avatar: 'nour-hassan' },
  { key: 'salma', firstName: 'Salma', lastName: 'Mostafa', role: 'SALES', department: 'Admissions', location: 'Alexandria', phone: '+20 100 555 0105', status: 'ACTIVE', avatar: 'salma-mostafa' },
  { key: 'karim', firstName: 'Karim', lastName: 'Fathy', role: 'SALES', department: 'Admissions', location: 'Mansoura', phone: '+20 100 555 0106', status: 'ACTIVE', avatar: 'karim-fathy' },
  { key: 'hana', firstName: 'Hana', lastName: 'Ibrahim', role: 'HR', department: 'Human Resources', location: 'Cairo', phone: '+20 100 555 0107', status: 'ACTIVE', avatar: 'hana-ibrahim' },
  { key: 'ahmed', firstName: 'Ahmed', lastName: 'Tarek', role: 'TRAINER', department: 'Faculty', location: 'Cairo', phone: '+20 100 555 0108', status: 'ACTIVE', avatar: 'ahmed-tarek' },
  { key: 'laila', firstName: 'Laila', lastName: 'Mahmoud', role: 'TRAINER', department: 'Faculty', location: 'Giza', phone: '+20 100 555 0109', status: 'ACTIVE', avatar: 'laila-mahmoud' },
  { key: 'rania', firstName: 'Rania', lastName: 'Youssef', role: 'VIEWER', department: 'Finance', location: 'Cairo', phone: '+20 100 555 0110', status: 'INVITED', avatar: 'rania-youssef' },
] as const satisfies ReadonlyArray<Record<string, unknown> & { key: string; role: Exclude<RoleKey, 'OWNER'>; status: 'ACTIVE' | 'INVITED' }>;
type UserKey = (typeof DEMO_USERS)[number]['key'];

export const DEMO_COURSES = [
  { code: 'DEMO-DA-101', name: 'Data Analysis with Excel & Power BI', level: 'BEGINNER', duration: '8 weeks · 2 evenings/week', hours: 48, price: 6500, seats: 30, start: -42, end: 14, status: 'ACTIVE', description: 'Clean, analyse and visualise business data with Excel, Power Query and Power BI dashboards.' },
  { code: 'DEMO-PY-110', name: 'Python Programming Fundamentals', level: 'FOUNDATION', duration: '10 weeks · 2 evenings/week', hours: 60, price: 7200, seats: 25, start: -21, end: 49, status: 'ACTIVE', description: 'Variables, control flow, functions, files and a first automation project in Python.' },
  { code: 'DEMO-DS-201', name: 'Data Science & Machine Learning', level: 'INTERMEDIATE', duration: '16 weeks · weekends', hours: 120, price: 18500, seats: 20, start: 21, end: 133, status: 'UPCOMING', description: 'Statistics, pandas, scikit-learn and model evaluation, ending with a capstone project.' },
  { code: 'DEMO-WD-150', name: 'Full-Stack Web Development (React & Node.js)', level: 'INTERMEDIATE', duration: '20 weeks · 3 evenings/week', hours: 160, price: 22000, seats: 24, start: -35, end: 105, status: 'ACTIVE', description: 'Modern JavaScript, React, REST APIs with Node.js and MongoDB, testing and deployment.' },
  { code: 'DEMO-UX-120', name: 'UI/UX Design Essentials', level: 'BEGINNER', duration: '8 weeks · 2 evenings/week', hours: 48, price: 8500, seats: 18, start: 14, end: 70, status: 'UPCOMING', description: 'User research, wireframing, Figma prototyping and usability testing.' },
  { code: 'DEMO-DM-130', name: 'Digital Marketing & Social Media Strategy', level: 'ALL_LEVELS', duration: '6 weeks · 2 evenings/week', hours: 36, price: 5500, seats: 35, start: -14, end: 28, status: 'ACTIVE', description: 'Paid social, SEO, content planning and campaign analytics for growing brands.' },
  { code: 'DEMO-PM-210', name: 'Project Management Professional (PMP) Prep', level: 'PROFESSIONAL', duration: '6 weeks · weekends', hours: 35, price: 9800, seats: 20, start: 28, end: 70, status: 'UPCOMING', description: 'PMBOK domains, agile and hybrid approaches, and full exam simulations.' },
  { code: 'DEMO-CS-220', name: 'Cybersecurity Fundamentals', level: 'INTERMEDIATE', duration: '12 weeks · 2 evenings/week', hours: 72, price: 12500, seats: 20, start: 35, end: 119, status: 'UPCOMING', description: 'Networking basics, threat models, hardening, and an introduction to incident response.' },
  { code: 'DEMO-EN-105', name: 'Business English Communication', level: 'ALL_LEVELS', duration: '10 weeks · 2 mornings/week', hours: 40, price: 4200, seats: 15, start: -28, end: 42, status: 'ACTIVE', description: 'Meetings, presentations, emails and negotiation in professional English.' },
  { code: 'DEMO-AI-310', name: 'Generative AI for Professionals', level: 'ADVANCED', duration: '6 weeks · weekends', hours: 30, price: 11000, seats: 25, start: 60, end: 102, status: 'DRAFT', description: 'Prompt design, retrieval-augmented generation and responsible use of AI at work.' },
] as const;
type CourseCode = (typeof DEMO_COURSES)[number]['code'];

export const DEMO_TRAINERS = [
  { emailLocal: 'ahmed.tarek', fullName: 'Ahmed Tarek', title: 'Lead Data Instructor', specialization: 'Data Analysis & BI', experienceYears: 9, weeklyCapacityHours: 20, joinDays: -900, city: 'Cairo', status: 'ACTIVE', user: 'ahmed' },
  { emailLocal: 'laila.mahmoud', fullName: 'Laila Mahmoud', title: 'Senior Python Instructor', specialization: 'Python & Automation', experienceYears: 7, weeklyCapacityHours: 18, joinDays: -700, city: 'Giza', status: 'ACTIVE', user: 'laila' },
  { emailLocal: 'mostafa.elsayed', fullName: 'Dr. Mostafa El-Sayed', title: 'Machine Learning Lead', specialization: 'Machine Learning', experienceYears: 12, weeklyCapacityHours: 12, joinDays: -1200, city: 'Cairo', status: 'ACTIVE', user: null },
  { emailLocal: 'sara.nabil', fullName: 'Sara Nabil', title: 'Full-Stack Engineer & Instructor', specialization: 'React & Node.js', experienceYears: 8, weeklyCapacityHours: 16, joinDays: -500, city: 'Alexandria', status: 'ACTIVE', user: null },
  { emailLocal: 'omar.farouk', fullName: 'Omar Farouk', title: 'Product Designer', specialization: 'UI/UX & Figma', experienceYears: 6, weeklyCapacityHours: 10, joinDays: -400, city: 'Cairo', status: 'ACTIVE', user: null },
  { emailLocal: 'dina.ashraf', fullName: 'Dina Ashraf', title: 'Growth Marketing Consultant', specialization: 'Digital Marketing', experienceYears: 10, weeklyCapacityHours: 8, joinDays: -650, city: 'Giza', status: 'ACTIVE', user: null },
  { emailLocal: 'hesham.ragab', fullName: 'Eng. Hesham Ragab', title: 'PMP Certified Trainer', specialization: 'Project Management', experienceYears: 15, weeklyCapacityHours: 8, joinDays: -1500, city: 'Cairo', status: 'ACTIVE', user: null },
  { emailLocal: 'mohamed.adly', fullName: 'Mohamed Adly', title: 'Security Engineer & Instructor', specialization: 'Cybersecurity', experienceYears: 11, weeklyCapacityHours: 10, joinDays: -300, city: 'Cairo', status: 'ACTIVE', user: null },
  { emailLocal: 'jessica.moore', fullName: 'Jessica Moore', title: 'Business English Coach', specialization: 'Business English', experienceYears: 9, weeklyCapacityHours: 14, joinDays: -800, city: 'Cairo', status: 'ON_LEAVE', user: null },
  { emailLocal: 'youssef.galal', fullName: 'Youssef Galal', title: 'AI Solutions Architect', specialization: 'Generative AI', experienceYears: 7, weeklyCapacityHours: 6, joinDays: -120, city: 'Cairo', status: 'ACTIVE', user: null },
] as const satisfies ReadonlyArray<Record<string, unknown> & { user: UserKey | null }>;

/** One PRIMARY per course where a trainer leads it, plus one assistant on the longest course. */
export const DEMO_ASSIGNMENTS = [
  { trainer: 'ahmed.tarek', course: 'DEMO-DA-101', role: 'PRIMARY', hours: 48 },
  { trainer: 'laila.mahmoud', course: 'DEMO-PY-110', role: 'PRIMARY', hours: 60 },
  { trainer: 'mostafa.elsayed', course: 'DEMO-DS-201', role: 'PRIMARY', hours: 100 },
  { trainer: 'sara.nabil', course: 'DEMO-WD-150', role: 'PRIMARY', hours: 140 },
  { trainer: 'omar.farouk', course: 'DEMO-UX-120', role: 'PRIMARY', hours: 48 },
  { trainer: 'dina.ashraf', course: 'DEMO-DM-130', role: 'PRIMARY', hours: 36 },
  { trainer: 'hesham.ragab', course: 'DEMO-PM-210', role: 'PRIMARY', hours: 35 },
  { trainer: 'mohamed.adly', course: 'DEMO-CS-220', role: 'PRIMARY', hours: 72 },
  { trainer: 'youssef.galal', course: 'DEMO-AI-310', role: 'PRIMARY', hours: 30 },
  { trainer: 'laila.mahmoud', course: 'DEMO-WD-150', role: 'ASSISTANT', hours: 40 },
] as const satisfies ReadonlyArray<Record<string, unknown> & { course: CourseCode }>;

type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const DEMO_CAMPAIGNS = [
  { slug: 'hia-demo-powerbi-autumn', name: 'Power BI Autumn Intake', platform: 'FACEBOOK_ADS', course: 'DEMO-DA-101', owner: 'mariam', budget: 25000, spent: 18400, start: -60, end: -10, status: 'COMPLETED', objective: 'Fill the autumn Power BI cohort', source: 'facebook', medium: 'paid_social' },
  { slug: 'hia-demo-python-reels', name: 'Python Beginners Reels', platform: 'INSTAGRAM_ADS', course: 'DEMO-PY-110', owner: 'youssef', budget: 15000, spent: 9200, start: -30, end: 20, status: 'RUNNING', objective: 'Reach career switchers aged 20–30', source: 'instagram', medium: 'paid_social' },
  { slug: 'hia-demo-datascience-search', name: 'Data Science Search Campaign', platform: 'GOOGLE_ADS', course: 'DEMO-DS-201', owner: 'mariam', budget: 40000, spent: 12750, start: -20, end: 30, status: 'RUNNING', objective: 'Capture high-intent searches for data science courses', source: 'google', medium: 'cpc' },
  { slug: 'hia-demo-fullstack-linkedin', name: 'Full-Stack Bootcamp on LinkedIn', platform: 'LINKEDIN', course: 'DEMO-WD-150', owner: 'youssef', budget: 30000, spent: 30000, start: -90, end: -40, status: 'COMPLETED', objective: 'Recruit working professionals for the evening bootcamp', source: 'linkedin', medium: 'sponsored' },
  { slug: 'hia-demo-ux-tiktok', name: 'UX Design Challenge (TikTok)', platform: 'TIKTOK', course: 'DEMO-UX-120', owner: 'mariam', budget: 12000, spent: 4100, start: -10, end: 25, status: 'PAUSED', objective: 'Awareness among design students', source: 'tiktok', medium: 'paid_social' },
  { slug: 'hia-demo-marketing-webinar', name: 'Free Digital Marketing Webinar', platform: 'WEBSITE', course: 'DEMO-DM-130', owner: 'youssef', budget: 5000, spent: 3600, start: -25, end: 5, status: 'RUNNING', objective: 'Webinar sign-ups that convert to enrollments', source: 'website', medium: 'webinar' },
  { slug: 'hia-demo-pmp-referral', name: 'PMP Alumni Referral Programme', platform: 'REFERRAL', course: 'DEMO-PM-210', owner: 'mariam', budget: 8000, spent: 1500, start: -15, end: 45, status: 'RUNNING', objective: 'Referral discounts for alumni', source: 'referral', medium: 'alumni' },
  { slug: 'hia-demo-cyber-seo', name: 'Cybersecurity Career Guide (SEO)', platform: 'ORGANIC', course: 'DEMO-CS-220', owner: 'youssef', budget: null, spent: 0, start: 5, end: 60, status: 'SCHEDULED', objective: 'Organic traffic from the career guide article', source: 'blog', medium: 'organic' },
  { slug: 'hia-demo-english-ramadan', name: 'Business English Ramadan Offer', platform: 'FACEBOOK_ADS', course: 'DEMO-EN-105', owner: 'mariam', budget: 10000, spent: 0, start: 40, end: 70, status: 'DRAFT', objective: 'Seasonal offer for corporate teams', source: 'facebook', medium: 'paid_social' },
  { slug: 'hia-demo-genai-launch', name: 'Generative AI Course Launch', platform: 'GOOGLE_ADS', course: 'DEMO-AI-310', owner: 'youssef', budget: 35000, spent: 0, start: 50, end: 100, status: 'DRAFT', objective: 'Pre-launch waiting list for the AI course', source: 'google', medium: 'cpc' },
] as const satisfies ReadonlyArray<Record<string, unknown> & { course: CourseCode; owner: UserKey; status: CampaignStatus }>;
type CampaignSlug = (typeof DEMO_CAMPAIGNS)[number]['slug'];

export const DEMO_DIPLOMAS = [
  { name: 'Professional Diploma in Data Analytics', level: 'INTERMEDIATE', duration: '6 months', price: 24000, status: 'ACTIVE', courses: ['DEMO-DA-101', 'DEMO-PY-110', 'DEMO-DS-201'], description: 'From spreadsheets to machine learning: a complete analytics track.' },
  { name: 'Full-Stack Software Engineering Diploma', level: 'ADVANCED', duration: '9 months', price: 32000, status: 'ACTIVE', courses: ['DEMO-PY-110', 'DEMO-WD-150'], description: 'Programming foundations followed by the full-stack web bootcamp.' },
  { name: 'Digital Product Design Diploma', level: 'BEGINNER', duration: '4 months', price: 14000, status: 'UPCOMING', courses: ['DEMO-UX-120', 'DEMO-WD-150'], description: 'Design thinking and front-end skills to ship digital products.' },
  { name: 'Digital Marketing Professional Diploma', level: 'ALL_LEVELS', duration: '3 months', price: 9500, status: 'ACTIVE', courses: ['DEMO-DM-130', 'DEMO-EN-105'], description: 'Marketing strategy and business communication for growing teams.' },
  { name: 'Project Leadership Diploma', level: 'PROFESSIONAL', duration: '4 months', price: 15500, status: 'UPCOMING', courses: ['DEMO-PM-210', 'DEMO-EN-105'], description: 'PMP preparation with professional communication skills.' },
  { name: 'Cybersecurity Specialist Diploma', level: 'INTERMEDIATE', duration: '6 months', price: 21000, status: 'UPCOMING', courses: ['DEMO-PY-110', 'DEMO-CS-220'], description: 'Scripting and security fundamentals for junior security roles.' },
  { name: 'AI & Data Leadership Diploma', level: 'ADVANCED', duration: '5 months', price: 27500, status: 'UPCOMING', courses: ['DEMO-DS-201', 'DEMO-AI-310'], description: 'Machine learning and generative AI for technical leads.' },
  { name: 'Business Intelligence Diploma', level: 'BEGINNER', duration: '3 months', price: 11500, status: 'ACTIVE', courses: ['DEMO-DA-101', 'DEMO-EN-105'], description: 'Reporting and dashboards with clear business communication.' },
  { name: 'Growth & Analytics Diploma', level: 'INTERMEDIATE', duration: '4 months', price: 13500, status: 'CLOSED', courses: ['DEMO-DM-130', 'DEMO-DA-101'], description: 'Data-driven marketing: campaigns measured end to end.' },
  { name: 'Technology Management Diploma', level: 'PROFESSIONAL', duration: '6 months', price: 26000, status: 'UPCOMING', courses: ['DEMO-PM-210', 'DEMO-AI-310', 'DEMO-CS-220'], description: 'Delivery, security and AI strategy for technology managers.' },
] as const satisfies ReadonlyArray<Record<string, unknown> & { courses: readonly CourseCode[] }>;

export const DEMO_STUDENTS = [
  { emailLocal: 'mohamed.ali', fullName: 'Mohamed Ali Hassan', phone: '+20 101 555 0201', country: 'Egypt', city: 'Cairo', profession: 'Accountant', birth: '1994-03-12', status: 'ACTIVE', advisor: 'nour' },
  { emailLocal: 'fatma.zahraa', fullName: 'فاطمة الزهراء محمود', phone: '+20 101 555 0202', country: 'Egypt', city: 'Giza', profession: 'Fresh graduate', birth: '2001-07-03', status: 'ACTIVE', advisor: 'salma' },
  { emailLocal: 'abdelrahman.saeed', fullName: 'Abdelrahman Saeed', phone: '+20 101 555 0203', country: 'Egypt', city: 'Alexandria', profession: 'Sales executive', birth: '1997-11-21', status: 'GRADUATED', advisor: 'salma' },
  { emailLocal: 'yasmin.hamdy', fullName: 'Yasmin Hamdy', phone: '+20 101 555 0204', country: 'Egypt', city: 'Cairo', profession: 'Graphic designer', birth: '1999-01-30', status: 'ACTIVE', advisor: 'karim' },
  { emailLocal: 'khaled.alotaibi', fullName: 'خالد العتيبي', phone: '+966 55 555 0205', country: 'Saudi Arabia', city: 'Riyadh', profession: 'IT support specialist', birth: '1995-05-18', status: 'ACTIVE', advisor: 'nour' },
  { emailLocal: 'nada.elsherif', fullName: 'Nada El-Sherif', phone: '+20 101 555 0206', country: 'Egypt', city: 'Mansoura', profession: 'Pharmacist', birth: '1993-09-09', status: 'ACTIVE', advisor: 'karim' },
  { emailLocal: 'amr.mansour', fullName: 'Amr Mansour', phone: '+971 50 555 0207', country: 'United Arab Emirates', city: 'Dubai', profession: 'Project coordinator', birth: '1990-02-14', status: 'ACTIVE', advisor: 'nour' },
  { emailLocal: 'reem.abdullah', fullName: 'ريم عبدالله', phone: '+20 101 555 0208', country: 'Egypt', city: 'Cairo', profession: 'Marketing specialist', birth: '1998-12-01', status: 'PENDING', advisor: 'salma' },
  { emailLocal: 'hassan.elnaggar', fullName: 'Hassan El-Naggar', phone: '+20 101 555 0209', country: 'Egypt', city: 'Tanta', profession: 'Network engineer', birth: '1992-06-25', status: 'ACTIVE', advisor: 'karim' },
  { emailLocal: 'mai.gamal', fullName: 'Mai Gamal', phone: '+20 101 555 0210', country: 'Egypt', city: 'Cairo', profession: 'HR specialist', birth: '1996-04-07', status: 'ACTIVE', advisor: 'nour' },
] as const satisfies ReadonlyArray<Record<string, unknown> & { advisor: UserKey }>;

/** Enrollments in UPCOMING/ACTIVE courses; the final status is applied right after creation. */
export const DEMO_ENROLLMENTS = [
  { student: 'mohamed.ali', course: 'DEMO-DA-101', daysAgo: 45, status: 'IN_PROGRESS' },
  { student: 'fatma.zahraa', course: 'DEMO-PY-110', daysAgo: 25, status: 'IN_PROGRESS' },
  { student: 'abdelrahman.saeed', course: 'DEMO-DA-101', daysAgo: 48, status: 'COMPLETED' },
  { student: 'yasmin.hamdy', course: 'DEMO-UX-120', daysAgo: 6, status: 'NOT_STARTED' },
  { student: 'khaled.alotaibi', course: 'DEMO-WD-150', daysAgo: 40, status: 'IN_PROGRESS' },
  { student: 'nada.elsherif', course: 'DEMO-DM-130', daysAgo: 16, status: 'IN_PROGRESS' },
  { student: 'amr.mansour', course: 'DEMO-PM-210', daysAgo: 9, status: 'NOT_STARTED' },
  { student: 'reem.abdullah', course: 'DEMO-DM-130', daysAgo: 12, status: 'WITHDRAWN' },
  { student: 'hassan.elnaggar', course: 'DEMO-CS-220', daysAgo: 4, status: 'NOT_STARTED' },
  { student: 'mai.gamal', course: 'DEMO-EN-105', daysAgo: 30, status: 'IN_PROGRESS' },
] as const satisfies ReadonlyArray<Record<string, unknown> & { course: CourseCode; status: (typeof ENROLLMENT_STATUSES)[number] }>;

/** Prospects. `status` is set at creation, except LOST, which goes through the status endpoint with a reason. */
export const DEMO_LEADS = [
  { emailLocal: 'sherif.kamal', fullName: 'Sherif Kamal', phone: '+20 102 555 0301', country: 'Egypt', city: 'Cairo', profession: 'Financial analyst', source: 'FACEBOOK_ADS', campaign: 'hia-demo-powerbi-autumn', priority: 'HIGH', tags: ['HOT'], budget: 7000, followUp: 2, status: 'QUALIFIED', assignee: 'nour', note: 'Wants the Power BI course for his finance team; asked about a corporate invoice.' },
  { emailLocal: 'aya.helmy', fullName: 'آية حلمي', phone: '+20 102 555 0302', country: 'Egypt', city: 'Giza', profession: 'Computer science student', source: 'INSTAGRAM_ADS', campaign: 'hia-demo-python-reels', priority: 'MEDIUM', tags: [], budget: 5000, followUp: 1, status: 'CONTACTED', assignee: 'salma', note: 'Prefers evening classes; will confirm after her exams finish.' },
  { emailLocal: 'tamer.fouad', fullName: 'Tamer Fouad', phone: '+20 102 555 0303', country: 'Egypt', city: 'Cairo', profession: 'Software developer', source: 'GOOGLE_ADS', campaign: 'hia-demo-datascience-search', priority: 'URGENT', tags: ['HOT', 'VIP'], budget: 20000, followUp: 1, status: 'MEETING_SCHEDULED', assignee: 'karim', note: 'Meeting booked with the ML instructor to review the curriculum.' },
  { emailLocal: 'noha.essam', fullName: 'Noha Essam', phone: '+20 102 555 0304', country: 'Egypt', city: 'Alexandria', profession: 'Front-end developer', source: 'LANDING_PAGE', campaign: 'hia-demo-fullstack-linkedin', priority: 'HIGH', tags: ['RETURNING'], budget: 22000, followUp: 3, status: 'PAYMENT_PENDING', assignee: 'salma', note: 'Agreed on the instalment plan; waiting for the first payment.' },
  { emailLocal: 'ziad.hosny', fullName: 'Ziad Hosny', phone: '+20 102 555 0305', country: 'Egypt', city: 'Cairo', profession: 'Architecture student', source: 'ORGANIC', campaign: null, priority: 'LOW', tags: ['COLD'], budget: null, followUp: 14, status: 'NEW', assignee: 'karim', note: 'Downloaded the UX syllabus; no reply to the first message yet.' },
  { emailLocal: 'lamiaa.ashour', fullName: 'Lamiaa Ashour', phone: '+20 102 555 0306', country: 'Egypt', city: 'Zagazig', profession: 'Shop owner', source: 'WEBSITE', campaign: 'hia-demo-marketing-webinar', priority: 'MEDIUM', tags: [], budget: 6000, followUp: 5, status: 'INTERESTED', assignee: 'nour', note: 'Attended the free webinar and asked about weekend groups.' },
  { emailLocal: 'basel.yassin', fullName: 'باسل ياسين', phone: '+962 79 555 0307', country: 'Jordan', city: 'Amman', profession: 'Operations manager', source: 'REFERRAL', campaign: 'hia-demo-pmp-referral', priority: 'HIGH', tags: ['VIP'], budget: 10000, followUp: 4, status: 'QUALIFIED', assignee: 'karim', note: 'Referred by an alumnus; needs the PMP prep before his exam date.' },
  { emailLocal: 'heba.salah', fullName: 'Heba Salah', phone: '+20 102 555 0308', country: 'Egypt', city: 'Cairo', profession: 'IT helpdesk', source: 'GOOGLE_ADS', campaign: 'hia-demo-datascience-search', priority: 'MEDIUM', tags: [], budget: 12500, followUp: null, status: 'LOST', lostReason: 'Chose a cheaper online course', assignee: 'salma', note: 'Price was the deciding factor; offered the instalment plan without success.' },
  { emailLocal: 'george.adel', fullName: 'George Adel', phone: '+20 102 555 0309', country: 'Egypt', city: 'Asyut', profession: 'Customer service team lead', source: 'FACEBOOK_ADS', campaign: 'hia-demo-powerbi-autumn', priority: 'MEDIUM', tags: ['RETURNING'], budget: 4500, followUp: 7, status: 'CONTACTED', assignee: 'nour', note: 'Previously took Business English; now interested in Power BI.' },
  { emailLocal: 'malak.osama', fullName: 'Malak Osama', phone: '+20 102 555 0310', country: 'Egypt', city: 'Cairo', profession: 'Marketing student', source: 'INSTAGRAM_ADS', campaign: 'hia-demo-ux-tiktok', priority: 'LOW', tags: [], budget: 3000, followUp: 10, status: 'NEW', assignee: null, note: 'Asked for the course schedule via Instagram direct message.' },
] as const satisfies ReadonlyArray<Record<string, unknown> & { campaign: CampaignSlug | null; assignee: UserKey | null }>;

/* ------------------------------------------------------------ remote target check ------------------------------------------------------------ */

/**
 * For the remote opt-in (DEMO_SEED_REMOTE_DATABASE): before the first write, the connected database
 * must be the confirmed one and hold nothing but this CRM's collections and demo records. Users are
 * allowed (the Owner created by `db:seed`); courses, students, leads, trainers, campaigns and diplomas
 * must all be demo records. So a database used by another project, or a CRM database with real data,
 * is refused and left untouched.
 */
export async function assertDedicatedDemoDatabase(connection: mongoose.Connection, expectedDatabase: string): Promise<void> {
  const db = connection.db;
  if (!db || db.databaseName !== expectedDatabase) {
    throw new Error('Refusing to seed demo data: the connection does not use the confirmed database (DEMO_SEED_REMOTE_DATABASE).');
  }
  const known = new Set(ALL_MODELS.map((model) => model.collection.collectionName));
  const present = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((name) => !name.startsWith('system.'));
  if (present.some((name) => !known.has(name))) {
    throw new Error('Refusing to seed demo data: the confirmed database contains collections that do not belong to this CRM (it may belong to another project).');
  }
  const demoEmail = new RegExp(`@${DEMO_EMAIL_DOMAIN.replaceAll('.', '\\.')}$`);
  const realRecords: Array<[mongoose.Model<any>, Record<string, unknown>]> = [
    [Course, { code: { $not: new RegExp(`^${DEMO_COURSE_PREFIX}`) } }],
    [Student, { email: { $not: demoEmail } }],
    [Lead, { email: { $not: demoEmail } }],
    [Trainer, { email: { $not: demoEmail } }],
    [Campaign, { 'utm.campaign': { $not: /^hia-demo-/ } }],
    [Diploma, { name: { $nin: DEMO_DIPLOMAS.map((diploma) => diploma.name) } }],
  ];
  for (const [model, filter] of realRecords) {
    if (await db.collection(model.collection.collectionName).countDocuments(filter, { limit: 1 })) {
      throw new Error(`Refusing to seed demo data: the confirmed database already contains ${model.collection.collectionName} that are not demo data.`);
    }
  }
}

/* ---------------------------------------------------------------- seeding ---------------------------------------------------------------- */

const DAY = 24 * 60 * 60 * 1000;

function contextFor(user: { _id: Types.ObjectId; email: string }, role: RoleKey): AuthContext {
  return { userId: user._id.toString(), email: user.email, role, permissions: ROLE_DEFINITIONS[role].permissions };
}

/**
 * Seeds the demo data and returns how many records were created or skipped per module. Assumes the
 * caller has connected and verified the target (see src/scripts/seed-demo-data.ts); never deletes
 * or updates records that already exist.
 */
export async function seedDemoData(now: Date = new Date()): Promise<DemoSeedReport> {
  const report = Object.fromEntries(DEMO_MODULES.map((module) => [module, { created: 0, skipped: 0 }])) as DemoSeedReport;
  const tally = (module: DemoModule, created: boolean) => {
    report[module][created ? 'created' : 'skipped'] += 1;
  };
  const at = (days: number) => new Date(now.getTime() + days * DAY);
  const isoDate = (days: number) => at(days).toISOString().slice(0, 10);

  const roles = await Role.find({ key: { $in: ROLE_KEYS } }).select('key').lean();
  if (roles.length !== ROLE_KEYS.length) {
    throw new Error('The system roles are missing. Run "npm run db:seed" once before seeding demo data.');
  }
  const roleId = new Map(roles.map((role) => [role.key, role._id]));

  // Users: written directly (no invitation e-mail, no password), keyed by e-mail.
  const users = new Map<UserKey, { _id: Types.ObjectId; email: string; role: RoleKey }>();
  const actorKey = DEMO_USERS[0].key;
  for (const definition of DEMO_USERS) {
    const address = email(`${definition.firstName.split(' ')[0]!.toLowerCase()}.${definition.lastName.toLowerCase()}`);
    const existing = await User.findOne({ email: address }).select('_id email').lean();
    let user: { _id: Types.ObjectId; email: string };
    if (existing) {
      user = { _id: existing._id, email: existing.email };
      tally('users', false);
    } else {
      const actor = users.get(actorKey);
      const [created] = await User.create([
        {
          firstName: definition.firstName,
          lastName: definition.lastName,
          email: address,
          phone: definition.phone,
          role: roleId.get(definition.role),
          status: definition.status,
          avatarUrl: `${DEMO_AVATAR_BASE}/${definition.avatar}.svg`,
          department: definition.department,
          location: definition.location,
          createdBy: actor?._id ?? null,
        },
      ]);
      user = { _id: created!._id, email: created!.email };
      tally('users', true);
    }
    users.set(definition.key, { ...user, role: definition.role });
  }
  const userOf = (key: UserKey) => users.get(key)!;
  const actor = contextFor(userOf(actorKey), 'ADMIN');

  // Courses, keyed by code.
  const courses = new Map<CourseCode, string>();
  for (const definition of DEMO_COURSES) {
    const existing = await Course.findOne({ code: definition.code }).select('_id').lean();
    if (existing) {
      courses.set(definition.code, existing._id.toString());
      tally('courses', false);
      continue;
    }
    const input = createCourseSchema.parse({
      code: definition.code,
      name: definition.name,
      description: definition.description,
      level: definition.level,
      duration: definition.duration,
      hours: definition.hours,
      price: definition.price,
      seats: definition.seats,
      startDate: isoDate(definition.start),
      endDate: isoDate(definition.end),
      status: definition.status,
    });
    courses.set(definition.code, (await coursesService.create(actor, input)).id);
    tally('courses', true);
  }
  const courseOf = (code: CourseCode) => courses.get(code)!;

  // Trainers, keyed by e-mail; two are linked to the TRAINER accounts.
  const trainers = new Map<string, string>();
  for (const definition of DEMO_TRAINERS) {
    const address = email(definition.emailLocal);
    const existing = await Trainer.findOne({ email: address }).select('_id').lean();
    if (existing) {
      trainers.set(definition.emailLocal, existing._id.toString());
      tally('trainers', false);
      continue;
    }
    const input = createTrainerSchema.parse({
      fullName: definition.fullName,
      email: address,
      phone: null,
      title: definition.title,
      specialization: definition.specialization,
      bio: `${definition.fullName} has ${definition.experienceYears} years of experience in ${definition.specialization.toLowerCase()} and teaches at the academy.`,
      status: definition.status,
      experienceYears: definition.experienceYears,
      weeklyCapacityHours: definition.weeklyCapacityHours,
      joinDate: isoDate(definition.joinDays),
      city: definition.city,
      country: 'Egypt',
      userId: definition.user ? userOf(definition.user)._id.toString() : null,
    });
    trainers.set(definition.emailLocal, (await trainersService.create(actor, input)).id);
    tally('trainers', true);
  }

  // Trainer assignments, keyed by trainer + course.
  for (const definition of DEMO_ASSIGNMENTS) {
    const course = DEMO_COURSES.find((candidate) => candidate.code === definition.course)!;
    const trainer = trainers.get(definition.trainer)!;
    if (await TrainerAssignment.exists({ trainer, course: courseOf(definition.course) })) {
      tally('trainerAssignments', false);
      continue;
    }
    const input = createAssignmentSchema.parse({
      trainerId: trainer,
      courseId: courseOf(definition.course),
      role: definition.role,
      status: course.status === 'ACTIVE' ? 'ACTIVE' : 'SCHEDULED',
      startDate: isoDate(course.start),
      endDate: isoDate(course.end),
      teachingHours: definition.hours,
    });
    await assignmentsService.create(actor, input);
    tally('trainerAssignments', true);
  }

  // Campaigns, keyed by UTM campaign. Started as RUNNING when the final status needs it.
  const campaigns = new Map<CampaignSlug, string>();
  for (const definition of DEMO_CAMPAIGNS) {
    const existing = await Campaign.findOne({ 'utm.campaign': definition.slug }).collation({ locale: 'en', strength: 2 }).select('_id').lean();
    if (existing) {
      campaigns.set(definition.slug, existing._id.toString());
      tally('campaigns', false);
      continue;
    }
    const initial = definition.status === 'PAUSED' || definition.status === 'COMPLETED' ? 'RUNNING' : definition.status;
    const input = createCampaignSchema.parse({
      name: definition.name,
      platform: definition.platform,
      objective: definition.objective,
      description: `${definition.objective}. Course: ${DEMO_COURSES.find((course) => course.code === definition.course)!.name}.`,
      courseId: courseOf(definition.course),
      ownerId: userOf(definition.owner)._id.toString(),
      budget: definition.budget,
      spent: definition.spent,
      startDate: isoDate(definition.start),
      endDate: isoDate(definition.end),
      utm: { source: definition.source, medium: definition.medium, campaign: definition.slug },
      status: initial,
    });
    const created = await campaignsService.create(actor, input);
    if (definition.status !== initial) await campaignsService.changeStatus(created.id, definition.status);
    campaigns.set(definition.slug, created.id);
    tally('campaigns', true);
  }

  // Diplomas, keyed by name (case-insensitive, like the unique index).
  for (const definition of DEMO_DIPLOMAS) {
    if (await Diploma.exists({ name: definition.name }).collation({ locale: 'en', strength: 2 })) {
      tally('diplomas', false);
      continue;
    }
    const input = createDiplomaSchema.parse({
      name: definition.name,
      description: definition.description,
      level: definition.level,
      duration: definition.duration,
      price: definition.price,
      status: definition.status,
      courseIds: definition.courses.map(courseOf),
    });
    await diplomasService.create(actor, input);
    tally('diplomas', true);
  }

  // Students, keyed by e-mail.
  const students = new Map<string, string>();
  for (const definition of DEMO_STUDENTS) {
    const address = email(definition.emailLocal);
    const existing = await Student.findOne({ email: address }).select('_id').lean();
    if (existing) {
      students.set(definition.emailLocal, existing._id.toString());
      tally('students', false);
      continue;
    }
    const input = createStudentSchema.parse({
      fullName: definition.fullName,
      email: address,
      phone: definition.phone,
      country: definition.country,
      city: definition.city,
      profession: definition.profession,
      dateOfBirth: definition.birth,
      status: definition.status,
      advisor: userOf(definition.advisor)._id.toString(),
    });
    students.set(definition.emailLocal, (await studentsService.create(actor, input)).data.id);
    tally('students', true);
  }

  // Enrollments, keyed by student + course; the final status is applied only to new ones.
  for (const definition of DEMO_ENROLLMENTS) {
    const student = students.get(definition.student)!;
    if (await Enrollment.exists({ student, course: courseOf(definition.course) })) {
      tally('enrollments', false);
      continue;
    }
    const input = createEnrollmentSchema.parse({ courseId: courseOf(definition.course), enrolledAt: at(-definition.daysAgo).toISOString() });
    const created = await enrollmentsService.create(actor, student, input);
    if (definition.status === 'COMPLETED') await enrollmentsService.updateStatus(actor, created.id, 'IN_PROGRESS');
    if (definition.status !== 'NOT_STARTED') await enrollmentsService.updateStatus(actor, created.id, definition.status);
    tally('enrollments', true);
  }

  // Leads (keyed by e-mail), each with one note written by its owner (keyed by lead + text).
  for (const definition of DEMO_LEADS) {
    const address = email(definition.emailLocal);
    let leadId = (await Lead.findOne({ email: address }).select('_id').lean())?._id.toString();
    if (leadId) {
      tally('leads', false);
    } else {
      const lost = definition.status === 'LOST';
      const input = createLeadSchema.parse({
        fullName: definition.fullName,
        email: address,
        phone: definition.phone,
        country: definition.country,
        city: definition.city,
        profession: definition.profession,
        source: definition.source,
        priority: definition.priority,
        tags: [...definition.tags],
        budget: definition.budget,
        nextFollowUpAt: definition.followUp === null ? null : at(definition.followUp).toISOString(),
        status: lost ? 'NEW' : definition.status,
        assignedTo: definition.assignee ? userOf(definition.assignee)._id.toString() : null,
        campaignId: definition.campaign ? campaigns.get(definition.campaign)! : null,
      });
      leadId = (await leadsService.create(actor, input)).data.id;
      if (lost) {
        await leadsService.updateStatus(actor, leadId, updateLeadStatusSchema.parse({ status: 'LOST', lostReason: definition.lostReason }));
      }
      tally('leads', true);
    }

    if (await LeadNote.exists({ lead: leadId, body: definition.note })) {
      tally('leadNotes', false);
      continue;
    }
    const author = definition.assignee ? contextFor(userOf(definition.assignee), 'SALES') : actor;
    await leadsService.addNote(author, leadId, createLeadNoteSchema.parse({ body: definition.note, pinned: definition.priority === 'URGENT' }));
    tally('leadNotes', true);
  }

  return report;
}
