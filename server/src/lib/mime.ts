/**
 * Upload validation (RULE 44, RULE 46 scenario 6).
 *
 * Validation is by *magic bytes*, not by client-supplied name or Content-Type.
 * A polyglot or renamed executable fails because the signature is checked after
 * the extension policy, and SVG/HTML are refused outright because browsers
 * execute markup in those types.
 */
import { fileTypeFromBuffer } from 'file-type';
import { unsupportedMedia, payloadTooLarge, badRequest } from './errors.ts';

export type AllowedKind = 'pdf' | 'image' | 'csv' | 'text' | 'zip' | 'docx' | 'xlsx' | 'pptx';

/**
 * Signature -> canonical kind. `null` means "we could not identify it", which is
 * treated as a rejection unless the caller explicitly opts into an allowlist of
 * signature-less formats.
 */
const SIGNATURE_MAP: Record<string, AllowedKind> = {
 'application/pdf': 'pdf',
 'image/png': 'image', 'image/jpeg': 'image', 'image/gif': 'image',
 'image/webp': 'image', 'image/bmp': 'image', 'image/tiff': 'image',
 'image/svg+xml': 'image', // recognised, then rejected by policy below
 'text/csv': 'csv', 'text/plain': 'text',
 'application/zip': 'zip',
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

/**
 * SVG is deliberately NOT uploadable. It is a scripting vector when served
 * same-origin: an SVG can carry <script>, onload= and external references.
 */
const FORBIDDEN_MIME = new Set([
 'image/svg+xml', 'text/html', 'application/xhtml+xml', 'application/x-msdownload',
 'application/x-sh', 'application/x-shellscript', 'text/x-shellscript',
 'application/x-executable', 'application/x-elf', 'application/x-msdos-program',
 'application/x-msi', 'application/java-archive', 'application/x-java-archive',
 'application/vnd.microsoft.portable-executable',
]);

/** Extension allowlist. Presentational only -- the signature is authoritative. */
const EXT_ALLOW: Record<AllowedKind, string[]> = {
 pdf: ['.pdf'],
 image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff'],
 csv: ['.csv'],
 text: ['.txt', '.md'],
 zip: ['.zip'],
 docx: ['.docx'],
 xlsx: ['.xlsx'],
 pptx: ['.pptx'],
};

export const extname = (name: string): string => {
 const i = name.lastIndexOf('.');
 return i === -1 ? '' : name.slice(i).toLowerCase();
};

export type UploadVerdict = { ok: true; kind: AllowedKind; mime: string; ext: string } | { ok: false; reason: string };

export async function inspectUpload(
 buffer: Buffer,
 originalName: string,
 declaredMime: string | undefined,
 limits: { maxBytes: number; allowedKinds: AllowedKind[] },
): Promise<UploadVerdict> {
 if (buffer.length === 0) return { ok: false, reason: 'File is empty.' };
 if (buffer.length > limits.maxBytes) {
 return { ok: false, reason: `File exceeds the ${limits.maxBytes} byte limit.` };
 }

 const name = String(originalName ?? '').trim();
 if (!name || name.length > 255) return { ok: false, reason: 'Missing or over-long filename.' };
 if (name.includes('\0') || name.includes('/') || name.includes('\\') || name.includes('..')) {
 return { ok: false, reason: 'Filename contains illegal characters.' };
 }
 const ext = extname(name);
 if (!ext) return { ok: false, reason: 'Filename must have an extension.' };

 // Signature first. A declared Content-Type is never trusted.
 const detected = await fileTypeFromBuffer(buffer.subarray(0, 8192));
 const detectedMime = detected?.mime ?? null;

 if (detectedMime && FORBIDDEN_MIME.has(detectedMime)) {
 return { ok: false, reason: `File type ${detectedMime} is never accepted.` };
 }
 if (declaredMime && FORBIDDEN_MIME.has(declaredMime.toLowerCase())) {
 return { ok: false, reason: `Declared type ${declaredMime} is never accepted.` };
 }

 let kind: AllowedKind | undefined = detectedMime ? SIGNATURE_MAP[detectedMime] : undefined;

 // Signature-less formats: CSV and plain text. Distinguish from binary content.
 if (!kind) {
 const looksTextual = isProbablyText(buffer);
 if (looksTextual && ext === '.csv') kind = 'csv';
 else if (looksTextual && (ext === '.txt' || ext === '.md')) kind = 'text';
 else if (detectedMime) return { ok: false, reason: `Unsupported file type ${detectedMime}.` };
 else return { ok: false, reason: 'Could not determine the file type from its contents.' };
 }

 if (detectedMime && declaredMime && ext !== '.csv' && ext !== '.txt' && ext !== '.md') {
 const declaredBase = declaredMime.toLowerCase().split(';')[0]!.trim();
 if (declaredBase !== detectedMime && !declaredBase.startsWith('application/octet-stream')) {
 return { ok: false, reason: `Declared type ${declaredBase} does not match detected ${detectedMime}.` };
 }
 }

 if (!EXT_ALLOW[kind].includes(ext)) {
 return { ok: false, reason: `Extension ${ext} is not permitted for ${kind} content.` };
 }
 if (!limits.allowedKinds.includes(kind)) {
 return { ok: false, reason: `File kind ${kind} is not permitted by policy.` };
 }
 return { ok: true, kind, mime: detectedMime ?? kind, ext };
}

function isProbablyText(buf: Buffer): boolean {
 const sample = buf.subarray(0, Math.min(buf.length, 4096));
 let suspicious = 0;
 for (const byte of sample) {
 if (byte === 0) return false;
 if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
 }
 return sample.length === 0 || suspicious / sample.length < 0.05;
}

export function assertUpload(v: UploadVerdict): asserts v is { ok: true; kind: AllowedKind; mime: string; ext: string } {
 if (v.ok) return;
 if (/limit/i.test(v.reason)) throw payloadTooLarge(v.reason);
 if (/type|signature|contents/i.test(v.reason)) throw unsupportedMedia(v.reason);
 throw badRequest(v.reason);
}

/**
 * Opaque, unguessable object key (RULE 50). Never derived from a user-supplied
 * name, and always prefixed with the organization id so a leaked key is still
 * useless without an authorization check.
 */
export const objectKeyFor = (orgId: string, fileId: string, ext: string): string =>
 `organizations/${orgId}/documents/${fileId}${ext}`;
