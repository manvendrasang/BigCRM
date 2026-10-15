/** Recursive PII/secret redaction for logs (RULE 12/81/83). */
const SECRET_KEYS = new Set([
 'password', 'newpassword', 'currentpassword', 'passwordhash', 'password_hash',
 'token', 'accesstoken', 'access_token', 'refreshtoken', 'refresh_token', 'idtoken',
 'secret', 'clientsecret', 'client_secret', 'apikey', 'api_key', 'authorization',
 'cookie', 'setcookie', 'set-cookie', 'csrftoken', 'csrf', 'sessionid', 'session_id',
 'tokenhash', 'token_hash', 'totpsecret', 'totp_secret', 'recoverycode', 'recovery_code',
 'privatekey', 'private_key', 'pepper', 'signingsecret', 'signing_secret', 'presignedurl', 'presigned_url',
]);
const PII_KEYS = new Set([
 'email', 'emailaddress', 'password', 'phone', 'mobile', 'mobilephone', 'address',
 'birthday', 'ssn', 'taxid', 'linkedinurl', 'secondaryemail',
]);
export const REDACTED = '[REDACTED]';

const redactString = (v: string, key: string): string => {
 const k = key.toLowerCase().replace(/[-_\s]/g, '');
 if (SECRET_KEYS.has(k)) return REDACTED;
 if (PII_KEYS.has(k)) return maskEmail(v);
 return v;
};
/** Keeps the domain so support can correlate, drops the local part (RULE 12). */
export const maskEmail = (v: string): string => {
 const s = String(v); const at = s.lastIndexOf('@');
 if (at <= 0) return REDACTED;
 const local = s.slice(0, at); const domain = s.slice(at);
 return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, local.length - 1))}${domain}`;
};
export const maskIp = (v: string): string => {
 if (v.includes(':')) return v.replace(/(:[0-9a-f]{1,4})+$/i, ':*');
 return v.replace(/\.\d{1,3}$/, '.*');
};
export function redact(input: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
 if (depth > 8) return '[TRUNCATED]';
 if (input === null || input === undefined) return input;
 if (typeof input === 'string') return input;
 if (typeof input !== 'object') return input;
 if (seen.has(input)) return '[CIRCULAR]';
 seen.add(input);
 if (Array.isArray(input)) return input.slice(0, 100).map((v) => redact(v, depth + 1, seen));
 if (input instanceof Date) return input.toISOString();
 if (input instanceof Error) {
 return { name: input.name, message: input.message, stack: input.stack?.split('\n').slice(0, 4).join('\n') };
 }
 const out: Record<string, unknown> = {};
 for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
 const key = k.toLowerCase().replace(/[-_\s]/g, '');
 if (SECRET_KEYS.has(key)) { out[k] = REDACTED; continue; }
 if (PII_KEYS.has(key) && typeof v === 'string') { out[k] = redactString(v, key); continue; }
 out[k] = redact(v, depth + 1, seen);
 }
 return out;
}
/** Columns whose values must never be written to the audit trail (RULE 81). */
export const AUDIT_DENY_FIELDS = new Set([
 'password', 'password_hash', 'passwordhash', 'token', 'token_hash', 'tokenhash',
 'totp_secret', 'totpsecret', 'mfa_secret', 'recovery_codes', 'recoverycodes',
]);
/** Only these contact/company columns are ever copied into audit diffs. Minimisation (RULE 81). */
export const AUDIT_ALLOW_FIELDS = new Set([
 'status', 'lifecycle_stage', 'lifecycleStage', 'stage', 'owner_id', 'ownerId',
 'assignee_id', 'assigneeId', 'name', 'value', 'currency', 'archived', 'source',
 'industry', 'priority', 'role', 'probability', 'expected_close_date', 'expectedCloseDate',
 'severity', 'resolved', 'type', 'title',
]);
export function auditDiff(row: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
 if (!row) return null;
 const out: Record<string, unknown> = {};
 for (const [k, v] of Object.entries(row)) {
 if (AUDIT_DENY_FIELDS.has(k)) continue;
 if (!AUDIT_ALLOW_FIELDS.has(k)) continue;
 if (typeof v === 'string' && v.length > 200) out[k] = `${v.slice(0, 200)}...`;
 else out[k] = v;
 }
 return Object.keys(out).length ? out : null;
}
