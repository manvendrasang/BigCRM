/**
 * Item 8 client: custom fields, attachments, import/export.
 *
 * Three thin wrappers. Uploads and imports send raw bytes (`fetch` directly,
 * not `api.post`, because the body is a File/Blob rather than JSON) but reuse
 * the session: `credentials: 'same-origin'` carries the HttpOnly refresh
 * cookie, and the CSRF header is attached the same way `api.ts` attaches it.
 * Every error still funnels through `ApiError` so messages stay safe to render.
 */
import { ApiError, api } from './api';

const CSRF_HEADER = 'X-CSRF-Token';
const CSRF_COOKIE = 'bigcrm_csrf';

function csrfHeader(): Record<string, string> {
 // Mirrors `getCsrfToken` in api.ts, which is module-private. The cookie name
 // must match the server's CSRF_COOKIE_NAME; both default to `bigcrm_csrf`.
 if (typeof document === 'undefined') return {};
 const match = document.cookie
 .split(';').map((p) => p.trim()).find((p) => p.startsWith(`${CSRF_COOKIE}=`));
 if (!match) return {};
 try {
 return { [CSRF_HEADER]: decodeURIComponent(match.slice(CSRF_COOKIE.length + 1)) };
 } catch {
 return {};
 }
}

async function throwForStatus(res: Response): Promise<never> {
 if (res.status >= 500) throw new ApiError(res.status, 'SERVER_ERROR', 'Something went wrong. Please try again.');
 let code = 'REQUEST_FAILED';
 let message = 'The request could not be completed.';
 try {
 const body = (await res.json()) as Record<string, unknown>;
 if (typeof body['code'] === 'string') code = body['code'];
 if (typeof body['message'] === 'string') message = body['message'].slice(0, 300);
 } catch { /* non-JSON body */ }
 throw new ApiError(res.status, code, message);
}

//  custom fields 

export interface CustomFieldDef {
 id: string;
 entityType: string;
 key: string;
 label: string;
 fieldType: string;
 options: unknown[];
 isRequired: boolean;
}

export async function listFieldDefs(entityType: string): Promise<CustomFieldDef[]> {
 const body = await api.get<unknown>(`/custom-fields/${encodeURIComponent(entityType)}`);
 return Array.isArray(body) ? (body as CustomFieldDef[]) : [];
}

export async function createFieldDef(input: {
 entityType: string; key: string; label: string; fieldType: string; options?: string[];
}): Promise<CustomFieldDef> {
 return api.post<CustomFieldDef>('/custom-fields', input);
}

export async function deleteFieldDef(id: string): Promise<void> {
 await api.del(`/custom-fields/${encodeURIComponent(id)}`);
}

export async function getFieldValues(entityType: string, entityId: string): Promise<Record<string, unknown>> {
 const body = await api.get<unknown>(
 `/custom-fields/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/values`);
 return (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
}

export async function setFieldValue(fieldId: string, entityId: string, value: unknown): Promise<void> {
 await api.post(`/custom-fields/${encodeURIComponent(fieldId)}/values/${encodeURIComponent(entityId)}`, { value });
}

//  attachments 

export interface AttachmentRow {
 id: string;
 fileName: string;
 contentType: string;
 sizeBytes: number;
 createdAt: string;
}

export async function listAttachments(entityType: string, entityId: string): Promise<AttachmentRow[]> {
 const body = await api.get<unknown>(
 `/attachments/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`);
 return Array.isArray(body) ? (body as AttachmentRow[]) : [];
}

/**
 * Uploads a file. The body is the raw bytes; metadata travels in headers so
 * there is no multipart parser to confuse (see the route doc).
 */
export async function uploadAttachment(
 entityType: string,
 entityId: string,
 file: File,
): Promise<AttachmentRow> {
 const res = await fetch('/api/v1/attachments', {
 method: 'POST',
 credentials: 'same-origin',
 headers: {
 'Content-Type': 'application/octet-stream',
 'X-Entity-Type': entityType,
 'X-Entity-Id': entityId,
 'X-File-Name': encodeURIComponent(file.name),
 ...csrfHeader(),
 },
 body: file,
 });
 if (!res.ok) await throwForStatus(res);
 const body = (await res.json()) as { data: AttachmentRow };
 return body.data;
}

export function downloadUrl(id: string): string {
 return `/api/v1/attachments/file/${encodeURIComponent(id)}`;
}

export async function deleteAttachment(id: string): Promise<void> {
 await api.del(`/attachments/file/${encodeURIComponent(id)}`);
}

//  transfers 

export interface ExportJobRow {
 id: string;
 entityType: string;
 status: string;
 rowCount: number | null;
 byteSize: number | null;
 expiresAt: string;
}

export async function startExport(entityType: string): Promise<ExportJobRow> {
 return api.post<ExportJobRow>('/transfers/exports', {
 entityType,
 idempotencyKey: `${entityType}-${Date.now()}`,
 });
}

export function exportDownloadUrl(id: string): string {
 return `/api/v1/transfers/exports/${encodeURIComponent(id)}/download`;
}

export interface ImportResult {
 id: string;
 status: string;
 totalRows: number;
 createdCount: number;
 skippedCount: number;
 errorCount: number;
 errors: { line: number; message: string }[];
}

export async function startImport(entityType: string, csvText: string): Promise<ImportResult> {
 const res = await fetch('/api/v1/transfers/imports', {
 method: 'POST',
 credentials: 'same-origin',
 headers: {
 'Content-Type': 'text/csv; charset=utf-8',
 'X-Entity-Type': entityType,
 'X-Idempotency-Key': `${entityType}-${Date.now()}`,
 ...csrfHeader(),
 },
 body: csvText,
 });
 if (!res.ok) await throwForStatus(res);
 const body = (await res.json()) as { data: ImportResult };
 return body.data;
}

/** Human file size. Non-numbers render blank. */
export function fileSize(bytes: unknown): string {
 if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '--';
 if (bytes < 1024) return `${bytes} B`;
 if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
 return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
