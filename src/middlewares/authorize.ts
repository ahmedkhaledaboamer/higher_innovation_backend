import type { RequestHandler } from 'express';
import type { Permission } from '../modules/roles/permissions.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Requires every listed permission. Use after `authenticate`:
 *
 *   router.post('/', authenticate, authorize(PERMISSIONS.USERS_CREATE), controller.create)
 *
 * This is the coarse check ("may this role create users at all?"). Rules that depend
 * on the specific record (e.g. "Admin cannot edit an Owner", "Sales sees only their
 * own leads") live in the service, which has the record in hand.
 */
export function authorize(...required: Permission[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw ApiError.unauthorized();

    const granted = req.auth.permissions;
    if (!required.every((permission) => granted.includes(permission))) {
      throw ApiError.forbidden();
    }
    next();
  };
}

/**
 * Requires at least one of the listed permissions. For actions that are allowed
 * in different scopes, e.g. reading leads with `leads:read_all` OR `leads:read_assigned`;
 * the service then narrows the query to the scope the caller actually has.
 */
export function authorizeAny(...accepted: Permission[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw ApiError.unauthorized();

    const granted = req.auth.permissions;
    if (!accepted.some((permission) => granted.includes(permission))) {
      throw ApiError.forbidden();
    }
    next();
  };
}
