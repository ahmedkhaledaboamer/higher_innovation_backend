import { randomUUID } from 'node:crypto';
import { Lead } from '../../src/modules/leads/lead.model.js';
import { normalizePhone } from '../../src/utils/phone.js';

let counter = 0;

/** A valid create-lead request body with unique contact details. */
export function leadBody(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return {
    fullName: `Lead Person ${counter}`,
    email: `lead.${randomUUID().slice(0, 8)}@example.com`,
    phone: `+20100${String(1_000_000 + counter * 7919).slice(-7)}`,
    source: 'FACEBOOK_ADS',
    ...overrides,
  };
}

/**
 * Inserts a lead straight into MongoDB, for tests that need control over fields the API
 * sets itself (createdAt, status REGISTERED, ...). Uses the same model and validation.
 */
export async function insertLead(createdBy: string, overrides: Record<string, unknown> = {}) {
  const body = leadBody();
  const phone = (overrides.phone as string | undefined) ?? body.phone;
  return Lead.create({
    reference: `LD-T${randomUUID().slice(0, 6)}`,
    fullName: body.fullName,
    email: body.email,
    phone,
    phoneNormalized: normalizePhone(phone),
    source: 'WEBSITE',
    createdBy,
    ...overrides,
  });
}
