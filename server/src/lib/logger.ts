/** Structured logging with automatic redaction (RULE 12, 81, 83). */
import { pino } from 'pino';
import { env } from '../config/env.ts';
import { redact, maskIp, maskEmail } from './redact.ts';

export const logger = pino({
 level: env.logLevel,
 base: { service: 'bigcrm-api', env: env.envName },
 redact: {
 paths: [
 'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]',
 'res.headers["set-cookie"]', 'password', '*.password', '*.token', '*.accessToken',
 '*.refreshToken', '*.tokenHash', '*.secret', '*.apiKey', 'body.password',
 ],
 censor: '[REDACTED]',
 },
 formatters: {
 level: (l) => ({ level: l }),
 log: (o) => redact(o) as Record<string, unknown>,
 },
 timestamp: pino.stdTimeFunctions.isoTime,
});

export type SecurityEventName =
 | 'auth.login.success' | 'auth.login.failure' | 'auth.logout' | 'auth.logout_all'
 | 'auth.register' | 'auth.password_reset_requested' | 'auth.password_reset_completed'
 | 'auth.password_changed' | 'auth.email_verified' | 'auth.email_verification_resent'
 | 'auth.token_refresh' | 'auth.token_refresh_reuse_detected'
 | 'auth.mfa.enrolled' | 'auth.mfa.challenge_failed' | 'auth.mfa.verified'
 | 'auth.mfa.recovery_code_used' | 'auth.mfa.disabled'
 | 'session.created' | 'session.revoked' | 'session.revoked_all' | 'session.expired'
 | 'session.idle_timeout' | 'session.absolute_timeout'
 | 'member.invited' | 'member.invite_accepted' | 'member.role_changed' | 'member.removed'
 | 'permission.denied' | 'tenant.violation_attempt' | 'idor.blocked'
 | 'rate_limit.blocked' | 'cors.blocked' | 'csrf.blocked'
 | 'upload.rejected' | 'ssrf.blocked' | 'export.created' | 'import.started' | 'import.completed'
 | 'meeting.scheduled' | 'meeting.invited'
 | 'integration.storage_write'
 | 'retention.swept'
 | 'account.locked' | 'account.unlocked' | 'suspicious_login';

/** Security-relevant events get a stable shape for SIEM correlation (RULE 82). */
export const securityLog = (
 event: SecurityEventName,
 fields: Record<string, unknown> = {},
): void => {
 logger.warn({ securityEvent: event, ...fields }, `sec:${event}`);
};
export const clientIp = (req: { ip?: string; socket?: { remoteAddress?: string } }): string =>
 req.ip ?? req.socket?.remoteAddress ?? 'unknown';
export { maskIp, maskEmail };
