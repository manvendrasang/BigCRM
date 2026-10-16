/**
 * Email provider abstraction (RULE 162, 196, 197).
 *
 * RULE 197 is explicit: a console logger is not a production email system. The
 * console driver therefore logs a redacted, non-routable indicator and refuses
 * to carry a live token -- it exists so local development does not silently claim
 * that delivery happened. Production configuration must select the SMTP driver,
 * and startup refuses any other value.
 *
 * Critically, this module is the ONLY consumer of raw password-reset,
 * verification and invitation tokens. Services hand the token here and never
 * return it to a caller, which is what closes the legacy account-takeover path
 * where the invite token was placed in the API response body.
 */
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';

export type EmailMessage = {
 to: string;
 subject: string;
 /** Body text. MUST NOT contain secrets beyond the single inline link. */
 text: string;
 html?: string;
};

export interface EmailProvider {
 readonly name: string;
 send(msg: EmailMessage): Promise<void>;
}

class ConsoleEmailProvider implements EmailProvider {
 readonly name = 'console';
 async send(msg: EmailMessage): Promise<void> {
 // Rule 12/196: log the recipient in masked form and never the body, because
 // the body contains a live single-use token.
 const domain = String(msg.to).split('@')[1] ?? 'unknown';
 logger.info(
 { emailProvider: 'console', recipientDomain: domain, subject: msg.subject },
 'email not delivered (console provider)',
 );
 process.stdout.write(
 `[email:console] to=${maskForConsole(msg.to)} subject=${msg.subject}\n` +
 ' delivery disabled; configure EMAIL_PROVIDER=smtp with SMTP_URL to send real mail\n',
 );
 }
}

const maskForConsole = (to: string): string => {
 const [local = '', domain = ''] = String(to).split('@');
 return `${local.slice(0, 1)}***@${domain}`;
};

class SmtpEmailProvider implements EmailProvider {
 readonly name = 'smtp';
 // Declared as an explicit field rather than a TypeScript parameter property:
 // `constructor(private readonly url: string)` is a compile-time-only feature
 // that Node's `--experimental-strip-types` refuses to erase, so the module
 // failed to load at all with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. This file was
 // never imported by any test until the route layer reached it, which is why
 // the break went unnoticed -- see docs/TESTING.md §coverage is not proof of
 // loadability.
 private readonly url: string;

 constructor(url: string) {
 this.url = url;
 }

 async send(_msg: EmailMessage): Promise<void> {
 // The transport is intentionally not vendored: production wires this to the
 // cloud provider SDK or a vetted SMTP client. Until then, failing loudly is
 // correct -- silently logging "sent" would be worse (RULE 4).
 void this.url;
 throw new Error(
 'EMAIL_PROVIDER=smtp requires a configured SMTP transport. ' +
 'Wire an EmailProvider implementation (see docs/DEPLOYMENT.md §Email) before enabling in production.',
 );
 }
}

let provider: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
 if (provider) return provider;
 if (env.email.provider === 'smtp') {
 if (!env.email.smtpUrl) throw new Error('EMAIL_PROVIDER=smtp requires SMTP_URL.');
 provider = new SmtpEmailProvider(env.email.smtpUrl);
 } else {
 if (env.nodeEnv === 'production') {
 throw new Error(
 'EMAIL_PROVIDER must be set to a real provider in production. ' +
 'A console logger is not email delivery (RULE 197).',
 );
 }
 provider = new ConsoleEmailProvider();
 }
 return provider;
}


//  templates 
/** Builds an absolute, single-use, expiring URL. The token appears only here. */
const link = (path: string, token: string): string => `${env.publicUrl}${path}?token=${encodeURIComponent(token)}`;



export const sendInvitationEmail = async (args: {
 email: string; token: string; organizationName: string; inviterName: string; role: string;
}): Promise<void> => {
 const url = link('/accept-invitation', args.token);
 await getEmailProvider().send({
 to: args.email,
 subject: `You have been invited to ${args.organizationName}`,
 text: `${args.inviterName} invited you to join ${args.organizationName} as ${args.role}.\n\nAccept the invitation:\n${url}\n\nThis link expires in 7 days and can be used once.`,
 });
};

