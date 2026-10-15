/** Safe public error type (RULE 120/121). Never carries internal detail to the client. */
export class AppError extends Error {
 readonly status: number;
 readonly code: string;
 readonly details?: Record<string, unknown>;
 readonly expose: boolean;
 constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
 super(message);
 this.name = 'AppError';
 this.status = status;
 this.code = code;
 this.details = details;
 this.expose = status < 500;
 }
}
export const badRequest = (m: string, d?: Record<string, unknown>) => new AppError(400, 'BAD_REQUEST', m, d);
export const validationFailed = (d: Record<string, unknown>) => new AppError(422, 'VALIDATION_FAILED', 'Request validation failed.', d);
export const unauthorized = (m = 'Authentication required.') => new AppError(401, 'UNAUTHENTICATED', m);
export const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials.');
export const forbidden = (m = 'You do not have permission to perform this action.') => new AppError(403, 'FORBIDDEN', m);
export const notFound = (m = 'The requested resource could not be found.') => new AppError(404, 'NOT_FOUND', m);
/** 404 is used for cross-tenant access so resource existence is not leaked (RULE 121). */
export const notFoundOrForbidden = () => notFound();
export const conflict = (m: string, d?: Record<string, unknown>) => new AppError(409, 'CONFLICT', m, d);
export const tooMany = (m = 'Too many requests. Please slow down.') => new AppError(429, 'RATE_LIMITED', m);
export const payloadTooLarge = (m = 'Payload too large.') => new AppError(413, 'PAYLOAD_TOO_LARGE', m);
export const unsupportedMedia = (m = 'Unsupported media type.') => new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', m);
export const internal = (m = 'Internal error.') => new AppError(500, 'INTERNAL_ERROR', m);
export const serviceUnavailable = (m = 'Service temporarily unavailable.') => new AppError(503, 'SERVICE_UNAVAILABLE', m);
/** Signals an operational abort inside a transaction: must roll back, never commit. */
export class TransactionAbort extends Error {
 override readonly cause: AppError;
 constructor(cause: AppError) { super(cause.code); this.name = 'TransactionAbort'; this.cause = cause; }
}
