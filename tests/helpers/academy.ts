import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { expect } from 'vitest';
import type { Session } from './factories.js';

let counter = 0;
const next = () => {
  counter += 1;
  return counter;
};

/** A valid create-course body with a unique code. */
export function courseBody(overrides: Record<string, unknown> = {}) {
  const n = next();
  return {
    code: `TC-${n}${randomUUID().slice(0, 4).toUpperCase()}`,
    name: `Test Course ${n}`,
    level: 'BEGINNER',
    price: 12000,
    status: 'ACTIVE',
    ...overrides,
  };
}

/** A valid create-student body with unique contact details. */
export function studentBody(overrides: Record<string, unknown> = {}) {
  const n = next();
  return {
    fullName: `Student Person ${n}`,
    email: `student.${randomUUID().slice(0, 8)}@example.com`,
    phone: `+20122${String(2_000_000 + n * 7919).slice(-7)}`,
    ...overrides,
  };
}

/** Creates through the API (as `session`) and returns the response data. */
export async function createCourse(app: Express, session: Session, overrides: Record<string, unknown> = {}) {
  const res = await request(app).post('/api/v1/courses').set(session.auth).send(courseBody(overrides));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; code: string; price: number; [key: string]: unknown };
}

export async function createStudent(app: Express, session: Session, overrides: Record<string, unknown> = {}) {
  const res = await request(app).post('/api/v1/students').set(session.auth).send(studentBody(overrides));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; studentNumber: string; [key: string]: unknown };
}

export function enroll(app: Express, session: Session, studentId: string, body: object) {
  return request(app).post(`/api/v1/students/${studentId}/enrollments`).set(session.auth).send(body);
}

export function setEnrollmentStatus(app: Express, session: Session, enrollmentId: string, status: string) {
  return request(app).patch(`/api/v1/enrollments/${enrollmentId}/status`).set(session.auth).send({ status });
}

/** A valid create-trainer body with a unique email. */
export function trainerBody(overrides: Record<string, unknown> = {}) {
  const n = next();
  return {
    fullName: `Trainer Person ${n}`,
    email: `trainer.${randomUUID().slice(0, 8)}@example.com`,
    specialization: 'Data & Analytics',
    ...overrides,
  };
}

export async function createTrainer(app: Express, session: Session, overrides: Record<string, unknown> = {}) {
  const res = await request(app).post('/api/v1/trainers').set(session.auth).send(trainerBody(overrides));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; code: string; [key: string]: unknown };
}

export function assign(app: Express, session: Session, body: Record<string, unknown>) {
  return request(app).post('/api/v1/trainer-assignments').set(session.auth).send({ role: 'ASSISTANT', ...body });
}

export function endAssignment(app: Express, session: Session, id: string, status = 'COMPLETED') {
  return request(app).post(`/api/v1/trainer-assignments/${id}/end`).set(session.auth).send({ status });
}
