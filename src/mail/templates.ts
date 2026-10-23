import type { MailMessage } from './mailer.js';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function layout(title: string, paragraphs: string[], link: string, buttonLabel: string): string {
  const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  const safeLink = escapeHtml(link);
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
<h2>${escapeHtml(title)}</h2>${body}
<p><a href="${safeLink}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">${escapeHtml(buttonLabel)}</a></p>
<p style="font-size:12px;color:#555">If the button does not work, copy this link into your browser:<br>${safeLink}</p>
</body></html>`;
}

export function passwordResetEmail(params: { to: string; firstName: string; link: string; minutes: number }): MailMessage {
  const lines = [
    `Hello ${params.firstName},`,
    'We received a request to reset the password for your Academy CRM account.',
    `This link works once and expires in ${params.minutes} minutes.`,
    'If you did not ask for this, you can ignore this email; your password stays the same.',
  ];
  return {
    to: params.to,
    template: 'password-reset',
    subject: 'Reset your Academy CRM password',
    text: `${lines.join('\n\n')}\n\nReset your password: ${params.link}\n`,
    html: layout('Reset your password', lines, params.link, 'Reset password'),
  };
}

export function inviteEmail(params: {
  to: string;
  firstName: string;
  roleName: string;
  invitedBy: string;
  link: string;
  hours: number;
}): MailMessage {
  const lines = [
    `Hello ${params.firstName},`,
    `${params.invitedBy} created an Academy CRM account for you with the ${params.roleName} role.`,
    `Choose your password to activate it. This link works once and expires in ${params.hours} hours.`,
  ];
  return {
    to: params.to,
    template: 'invite',
    subject: 'Your Academy CRM account',
    text: `${lines.join('\n\n')}\n\nSet your password: ${params.link}\n`,
    html: layout('Welcome to Academy CRM', lines, params.link, 'Set password'),
  };
}
