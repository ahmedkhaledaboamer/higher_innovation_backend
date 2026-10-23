import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Reads email that the app really sent through its outbox transport
 * (MAIL_TRANSPORT=outbox; the directory is created per test run by globalSetup).
 */
export interface OutboxEmail {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

async function readAll(): Promise<OutboxEmail[]> {
  const dir = process.env.MAIL_OUTBOX_DIR!;
  const files = await readdir(dir).catch(() => [] as string[]);
  return Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map(async (file) => {
        // Nodemailer's JSON transport format: { to: [{ address, name }], subject, text, html, ... }
        const message = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
        const to = (message.to as Array<{ address: string }>).map((recipient) => recipient.address);
        return { to, subject: message.subject, text: message.text, html: message.html };
      }),
  );
}

export async function emailsTo(address: string): Promise<OutboxEmail[]> {
  return (await readAll()).filter((email) => email.to.includes(address));
}

/** Waits for the n-th email to `address` (forgot-password sends in the background). */
export async function waitForEmail(address: string, count = 1, timeoutMs = 3000): Promise<OutboxEmail> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const emails = await emailsTo(address);
    if (emails.length >= count) return emails[count - 1]!;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No email #${count} to ${address} within ${timeoutMs}ms`);
}

/** Pulls the raw token out of a reset/invite link in the email body. */
export function tokenFromEmail(email: OutboxEmail): string {
  const match = /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(email.text);
  if (!match) throw new Error('No reset link in email');
  return match[1]!;
}
