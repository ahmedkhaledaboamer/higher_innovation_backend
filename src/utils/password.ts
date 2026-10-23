import bcrypt from 'bcrypt';
import { env } from '../config/env.js';

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// A real bcrypt hash of a random value, computed once. Comparing against it when the
// email is unknown makes "no such user" take as long as "wrong password", so response
// timing does not reveal which emails have accounts.
let dummyHash: Promise<string> | undefined;

export async function burnPasswordCheck(plain: string): Promise<void> {
  dummyHash ??= bcrypt.hash(crypto.randomUUID(), env.BCRYPT_ROUNDS);
  await bcrypt.compare(plain, await dummyHash);
}
