/**
 * Initial setup:  npm run db:seed   (production: npm run db:seed:prod)
 *
 * 1. Builds all indexes.
 * 2. Creates/updates the seven system roles.
 * 3. Creates the first Owner from SEED_OWNER_* variables, if no Owner exists yet.
 *
 * Safe to run more than once. Remove SEED_OWNER_PASSWORD from the environment
 * afterwards; the Owner should then change it from the app.
 */
import { z } from 'zod';
import { passwordSchema } from '../modules/auth/auth.schema.js';
import { assertTransactionSupport, connectDatabase, disconnectDatabase } from '../database/mongoose.js';
import { ownerExists, seedOwner, seedRoles, syncAllIndexes } from '../database/setup.js';
import { logger } from '../utils/logger.js';

const ownerEnvSchema = z.object({
  SEED_OWNER_EMAIL: z.string().trim().toLowerCase().pipe(z.email('must be a valid email')),
  SEED_OWNER_PASSWORD: passwordSchema,
  SEED_OWNER_FIRST_NAME: z.string().trim().min(1).max(60).default('Academy'),
  SEED_OWNER_LAST_NAME: z.string().trim().min(1).max(60).default('Owner'),
});

async function main(): Promise<void> {
  await connectDatabase();
  await assertTransactionSupport();

  const collections = await syncAllIndexes();
  logger.info({ collections }, 'Indexes synchronised');

  await seedRoles();
  logger.info('System roles are up to date');

  if (await ownerExists()) {
    logger.info('An Owner account already exists; skipping Owner creation');
    return;
  }

  const parsed = ownerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Report which variables are wrong, never their values.
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`No Owner exists yet and the SEED_OWNER_* variables are invalid:\n  - ${problems.join('\n  - ')}`);
  }

  const result = await seedOwner({
    email: parsed.data.SEED_OWNER_EMAIL,
    password: parsed.data.SEED_OWNER_PASSWORD,
    firstName: parsed.data.SEED_OWNER_FIRST_NAME,
    lastName: parsed.data.SEED_OWNER_LAST_NAME,
  });
  if (result.created) {
    logger.info({ email: result.email }, 'Owner account created. Remove SEED_OWNER_PASSWORD from your environment now.');
  }
}

main()
  .then(async () => {
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    logger.error({ err: error }, 'Seed failed');
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
