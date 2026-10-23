import type { QueryFilter, SortOrder } from 'mongoose';
import { env } from '../../config/env.js';
import { runInTransaction } from '../../database/mongoose.js';
import { sendMail } from '../../mail/mailer.js';
import { inviteEmail } from '../../mail/templates.js';
import type { AuthContext } from '../../types/express.js';
import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../utils/logger.js';
import { buildPaginationMeta, escapeRegex, type PaginationMeta, toSkip } from '../../utils/pagination.js';
import { buildPasswordLink, issueActionToken, revokeAllSessions } from '../auth/session.service.js';
import { canManageRole, type RoleKey } from '../roles/permissions.js';
import { Role } from '../roles/role.model.js';
import { ROLE_FIELDS, toUserDto, type UserDto, type UserWithRole } from './user.dto.js';
import { User, type UserFields } from './user.model.js';
import type { CreateUserInput, ListUsersQuery, UpdateUserInput } from './users.schema.js';

async function findUserWithRole(id: string): Promise<UserWithRole> {
  const user = await User.findById(id).populate<{ role: UserWithRole['role'] }>('role', ROLE_FIELDS).lean();
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  return user as unknown as UserWithRole;
}

async function findRoleByKey(key: RoleKey) {
  const role = await Role.findOne({ key }).lean();
  // Roles are created by the seed command; a missing one means setup was skipped.
  if (!role) throw ApiError.badRequest(`Role ${key} is not set up. Run the seed command.`, 'ROLE_NOT_FOUND');
  return role;
}

/** Record-level rule: the actor must outrank the target user (see canManageRole). */
function assertCanManage(actor: AuthContext, target: UserWithRole): void {
  if (!canManageRole(actor.role, target.role.key)) {
    throw ApiError.forbidden('You cannot manage a user with this role', 'INSUFFICIENT_ROLE');
  }
}

async function sendInvite(user: UserWithRole, rawToken: string, invitedBy: string): Promise<boolean> {
  try {
    await sendMail(
      inviteEmail({
        to: user.email,
        firstName: user.firstName,
        roleName: user.role.name,
        invitedBy,
        link: buildPasswordLink(rawToken),
        hours: env.INVITE_TTL_HOURS,
      }),
    );
    return true;
  } catch (error) {
    // The account exists either way; the admin can resend the invitation.
    logger.error({ err: error, userId: user._id.toString() }, 'Failed to send invitation email');
    return false;
  }
}

export const usersService = {
  async list(query: ListUsersQuery): Promise<{ items: UserDto[]; meta: PaginationMeta }> {
    const filter: QueryFilter<UserFields> = {};
    if (query.status) filter.status = { $in: query.status };
    if (query.role) {
      const roles = await Promise.all(query.role.map((key) => findRoleByKey(key)));
      filter.role = { $in: roles.map((role) => role._id) };
    }
    if (query.search) {
      const pattern = new RegExp(escapeRegex(query.search), 'i');
      filter.$or = [{ firstName: pattern }, { lastName: pattern }, { email: pattern }];
    }

    const direction: SortOrder = query.sortDir === 'asc' ? 1 : -1;
    const [items, total] = await Promise.all([
      User.find(filter)
        .sort({ [query.sortBy]: direction, _id: direction })
        .skip(toSkip(query))
        .limit(query.limit)
        .populate<{ role: UserWithRole['role'] }>('role', ROLE_FIELDS)
        .lean(),
      User.countDocuments(filter),
    ]);

    return {
      items: (items as unknown as UserWithRole[]).map(toUserDto),
      meta: buildPaginationMeta(query, total),
    };
  },

  async getById(id: string): Promise<UserDto> {
    return toUserDto(await findUserWithRole(id));
  },

  /**
   * Creates an INVITED account and emails a "set your password" link.
   * The user and the invite token are written in one transaction, so there is never
   * an account that nobody can activate.
   */
  async create(actor: AuthContext, input: CreateUserInput): Promise<{ user: UserDto; inviteSent: boolean }> {
    if (!canManageRole(actor.role, input.role)) {
      throw ApiError.forbidden(`You cannot create users with the ${input.role} role`, 'ROLE_NOT_ASSIGNABLE');
    }
    const role = await findRoleByKey(input.role);

    // Friendly error first; the unique index on email still guards against races.
    if (await User.exists({ email: input.email })) {
      throw ApiError.conflict('A user with this email already exists', 'EMAIL_TAKEN');
    }

    const { userId, rawToken } = await runInTransaction(async (session) => {
      const [created] = await User.create(
        [
          {
            firstName: input.firstName,
            lastName: input.lastName,
            email: input.email,
            phone: input.phone ?? null,
            department: input.department ?? null,
            location: input.location ?? null,
            role: role._id,
            status: 'INVITED',
            createdBy: actor.userId,
          },
        ],
        { session },
      );
      const token = await issueActionToken(created!._id, 'INVITE', session);
      return { userId: created!._id.toString(), rawToken: token };
    });

    const user = await findUserWithRole(userId);
    const inviteSent = await sendInvite(user, rawToken, actor.email);
    return { user: toUserDto(user), inviteSent };
  },

  async resendInvite(actor: AuthContext, id: string): Promise<{ inviteSent: boolean }> {
    const user = await findUserWithRole(id);
    assertCanManage(actor, user);
    if (user.status !== 'INVITED') {
      throw ApiError.conflict('This user has already activated their account', 'USER_NOT_INVITED');
    }
    const rawToken = await issueActionToken(user._id, 'INVITE');
    return { inviteSent: await sendInvite(user, rawToken, actor.email) };
  },

  async update(actor: AuthContext, id: string, input: UpdateUserInput): Promise<UserDto> {
    const target = await findUserWithRole(id);
    const isSelf = target._id.toString() === actor.userId;

    if (isSelf && input.status) {
      throw ApiError.forbidden('You cannot change the status of your own account', 'CANNOT_MODIFY_SELF');
    }
    if (!isSelf) assertCanManage(actor, target);

    if (input.status === 'ACTIVE' && target.status === 'INVITED') {
      throw ApiError.conflict('An invited user becomes active by accepting the invitation', 'USER_NOT_ACTIVATED');
    }

    const { status, ...profile } = input;
    const disabling = (status === 'SUSPENDED' || status === 'INACTIVE') && target.status !== status;

    await runInTransaction(async (session) => {
      await User.updateOne({ _id: target._id }, { ...profile, ...(status ? { status } : {}) }, { session, runValidators: true });
      // A disabled account must lose every session immediately, not when tokens expire.
      if (disabling) await revokeAllSessions(target._id, 'ACCOUNT_DISABLED', session);
    });

    return toUserDto(await findUserWithRole(id));
  },

  async assignRole(actor: AuthContext, id: string, roleKey: RoleKey): Promise<UserDto> {
    const target = await findUserWithRole(id);

    if (target._id.toString() === actor.userId) {
      throw ApiError.forbidden('You cannot change your own role', 'CANNOT_MODIFY_SELF');
    }
    assertCanManage(actor, target);
    if (!canManageRole(actor.role, roleKey)) {
      throw ApiError.forbidden(`You cannot assign the ${roleKey} role`, 'ROLE_NOT_ASSIGNABLE');
    }

    const role = await findRoleByKey(roleKey);
    // No session revocation needed: authenticate reads the role from the database on
    // every request, so the new permissions apply to the user's next request.
    await User.updateOne({ _id: target._id }, { role: role._id });
    return toUserDto(await findUserWithRole(id));
  },
};
