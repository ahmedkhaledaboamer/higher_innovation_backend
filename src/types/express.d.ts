import type { Permission, RoleKey } from '../modules/roles/permissions.js';

/** The signed-in user, attached to the request by the authenticate middleware. */
export interface AuthContext {
  userId: string;
  email: string;
  role: RoleKey;
  permissions: readonly Permission[];
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `authenticate`. Present on every route behind it. */
    auth?: AuthContext;
  }
}
