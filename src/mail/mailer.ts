import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Short label for logs, e.g. "password-reset". Never put secrets here. */
  template: string;
}

/**
 * Sends email through Nodemailer.
 *
 * - MAIL_TRANSPORT=smtp:   real delivery through the configured SMTP server (required in production).
 * - MAIL_TRANSPORT=outbox: each message is written as a JSON file into MAIL_OUTBOX_DIR, so
 *   development and tests can open the email (and its link) without a mail server.
 *
 * Logs record which template was sent and the outcome, never the body: bodies contain
 * single-use links that work like passwords.
 */
let transporter: Transporter | undefined;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  transporter =
    env.MAIL_TRANSPORT === 'smtp'
      ? nodemailer.createTransport({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_SECURE,
          // On port 587 refuse to send if the server does not offer STARTTLS.
          requireTLS: !env.SMTP_SECURE,
          ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } } : {}),
        })
      : nodemailer.createTransport({ jsonTransport: true });

  return transporter;
}

export async function sendMail(message: MailMessage): Promise<void> {
  const info = await getTransporter().sendMail({
    from: env.MAIL_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });

  if (env.MAIL_TRANSPORT === 'outbox') {
    const dir = path.resolve(env.MAIL_OUTBOX_DIR);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${message.template}-${randomUUID().slice(0, 8)}.json`);
    await writeFile(file, String(info.message), 'utf8');
    logger.info({ template: message.template, file }, 'Email written to local outbox');
    return;
  }

  logger.info({ template: message.template, messageId: info.messageId }, 'Email sent');
}
