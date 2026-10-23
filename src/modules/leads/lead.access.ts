import { Types } from 'mongoose';
import type { AuthContext } from '../../types/express.js';
import { ApiError } from '../../utils/ApiError.js';
import { type Permission, PERMISSIONS } from '../roles/permissions.js';

/**
 * Record-level visibility for leads, applied inside every database query.
 *
 * A scope is a MongoDB condition that is AND-ed with whatever the request asks for,
 * so a caller can never widen it: a Sales user filtering by someone else's id, or
 * opening another salesperson's lead by id, simply matches nothing (404).
 *
 * Only values from the authenticated session go into a scope, never request data.
 */
export type LeadScope = { assignedTo?: Types.ObjectId };

const has = (actor: AuthContext, permission: Permission) => actor.permissions.includes(permission);

/** Leads the caller may see. */
export function readScope(actor: AuthContext): LeadScope {
  if (has(actor, PERMISSIONS.LEADS_READ_ALL)) return {};
  if (has(actor, PERMISSIONS.LEADS_READ_ASSIGNED)) return { assignedTo: new Types.ObjectId(actor.userId) };
  throw ApiError.forbidden();
}

/** Leads the caller may edit (details, status, notes). */
export function writeScope(actor: AuthContext): LeadScope {
  if (has(actor, PERMISSIONS.LEADS_UPDATE_ALL)) return {};
  if (has(actor, PERMISSIONS.LEADS_UPDATE_ASSIGNED)) return { assignedTo: new Types.ObjectId(actor.userId) };
  throw ApiError.forbidden();
}

export const canAssignLeads = (actor: AuthContext) => has(actor, PERMISSIONS.LEADS_ASSIGN);
export const canSeeAllLeads = (actor: AuthContext) => has(actor, PERMISSIONS.LEADS_READ_ALL);
export const canManageAllLeads = (actor: AuthContext) => has(actor, PERMISSIONS.LEADS_UPDATE_ALL);

export { withScope } from '../../utils/scope.js';
