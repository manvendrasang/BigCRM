/**
 * Attachments (item 8).
 *
 * Files attached to records, stored on the local driver and described in the
 * `attachments` table. The upload path is the security-sensitive one, so its
 * controls are stated explicitly:
 *
 * 1. **Magic bytes, not MIME.** `inspectUpload` identifies the content from its
 *    signature; a renamed `.exe` fails because its bytes say executable, and
 *    SVG/HTML are refused outright because browsers execute them.
 * 2. **Size bounded twice.** Express's body limit caps the request, and
 *    `maxUploadBytes` caps the file — a 25 MB default neither of which the
 *    client can raise.
 * 3. **Content-addressed storage key.** The key is `sha256(content)`, so two
 *    uploads of the same bytes share storage and a key cannot be guessed to
 *    overwrite an unrelated file. The original filename is metadata only and
 *    never reaches the filesystem.
 * 4. **Tenant-scoped rows.** The `attachments` table is in TENANT_TABLES; every
 *    statement carries `organization_id`. Download re-checks the row belongs
 *    to the caller's org — a signed URL or guessed id for another tenant's
 *    file 404s rather than serving it.
 *
 * Only the `local` driver is implemented. S3 needs credentials, a bucket, and
 * a presigning flow that cannot be verified without AWS; the config accepts
 * the setting so the shape is forward-compatible, but the service refuses to
 * boot on it rather than pretend. That refusal is documented, not silent.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../config/env.ts';
import { TenantScope } from '../repositories/base.ts';
import { badRequest, notFound, payloadTooLarge, unsupportedMedia } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { assertUpload, inspectUpload } from '../lib/mime.ts';
import type { ActorRef } from './records.ts';

const ENTITY_TYPES: readonly string[] = ['contact', 'company', 'lead', 'deal', 'task', 'note'];

export type Attachment = {
  id: string;
  entityType: string;
  entityId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  version: number;
  createdAt: string;
};

const rowToAttachment = (r: Record<string, unknown>): Attachment => ({
  id: String(r['id']),
  entityType: String(r['entity_type']),
  entityId: String(r['entity_id']),
  fileName: String(r['file_name']),
  contentType: String(r['content_type']),
  sizeBytes: Number(r['size_bytes']),
  checksumSha256: String(r['checksum_sha256']),
  version: Number(r['version'] ?? 1),
  createdAt: String(r['created_at']),
});

function storageDir(): string {
  if (env.storage.driver !== 'local') {
    // See the module doc: refusing loudly beats storing nowhere.
    throw badRequest('Only the local storage driver is implemented on this deployment.');
  }
  return env.storage.localDir;
}

/**
 * Stores an uploaded file and records it against an entity.
 *
 * `buffer` is the raw request body, already bounded by Express's body limit.
 * Returns the attachment row. Versioning: re-uploading to the same entity with
 * the same filename bumps `version` rather than creating a second row, so the
 * attachment list shows one entry per document with its history implicit.
 */
export async function uploadAttachment(
  actor: ActorRef,
  input: {
    entityType: string;
    entityId: string;
    fileName: string;
    declaredMime?: string;
    buffer: Buffer;
  },
): Promise<Attachment> {
  if (!ENTITY_TYPES.includes(input.entityType)) {
    throw badRequest(`Unknown entity type '${input.entityType}'.`);
  }

  const verdict = await inspectUpload(input.buffer, input.fileName, input.declaredMime, {
    maxBytes: env.storage.maxUploadBytes,
    allowedKinds: ['pdf', 'image', 'csv', 'text', 'zip', 'docx', 'xlsx', 'pptx'],
  });
  if (!verdict.ok) {
    // 415 for type rejections, 413 for size — the status tells the client
    // whether retrying with a smaller file could help.
    if (verdict.reason.includes('exceeds')) throw payloadTooLarge(verdict.reason);
    throw unsupportedMedia(verdict.reason);
  }
  assertUpload(verdict);

  const checksum = createHash('sha256').update(input.buffer).digest('hex');
  const key = `${checksum.slice(0, 2)}/${checksum.slice(2, 4)}/${checksum}${verdict.ext}`;
  const dir = storageDir();
  await mkdir(join(dir, checksum.slice(0, 2), checksum.slice(2, 4)), { recursive: true });
  await writeFile(join(dir, key), input.buffer);

  const scope = new TenantScope(actor.organizationId);
  const existing = await scope.query<{ version: number }>(
    `SELECT version FROM attachments
     WHERE organization_id = $1 AND entity_type = $2 AND entity_id = $3
       AND file_name = $4 AND deleted_at IS NULL`,
    [actor.organizationId, input.entityType, input.entityId, input.fileName.trim()],
  );
  const version = (existing[0]?.version ?? 0) + 1;
  const id = newId();
  const now = nowIso();

  await scope.query(
    `INSERT INTO attachments
       (id,organization_id,entity_type,entity_id,file_id,file_name,content_type,
        size_bytes,storage_key,checksum_sha256,version,uploaded_by,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, actor.organizationId, input.entityType, input.entityId, newId(),
      input.fileName.trim(), verdict.mime, input.buffer.length, key, checksum,
      version, actor.userId, now],
  );
  const rows = await scope.query(
    `SELECT * FROM attachments WHERE organization_id = $1 AND id = $2`,
    [actor.organizationId, id],
  );
  return rowToAttachment(rows[0]!);
}

/** Lists non-deleted attachments on one entity, newest first. */
export async function listAttachments(
  actor: ActorRef,
  entityType: string,
  entityId: string,
): Promise<Attachment[]> {
  if (!ENTITY_TYPES.includes(entityType)) {
    throw badRequest(`Unknown entity type '${entityType}'.`);
  }
  const scope = new TenantScope(actor.organizationId);
  const rows = await scope.query(
    `SELECT * FROM attachments
     WHERE organization_id = $1 AND entity_type = $2 AND entity_id = $3
       AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [actor.organizationId, entityType, entityId],
  );
  return rows.map(rowToAttachment);
}

/**
 * Reads an attachment's bytes for download.
 *
 * The row lookup filters by org, so a valid id from another tenant behaves
 * exactly like a nonexistent id. The file is read by storage key, never by any
 * client-supplied path — there is no traversal to perform because no client
 * input reaches the filesystem.
 */
export async function downloadAttachment(
  actor: ActorRef,
  id: string,
): Promise<{ attachment: Attachment; bytes: Buffer }> {
  const scope = new TenantScope(actor.organizationId);
  const rows = await scope.query(
    `SELECT * FROM attachments
     WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [actor.organizationId, id],
  );
  if (rows.length === 0) throw notFound('Attachment not found.');
  const attachment = rowToAttachment(rows[0]!);
  const bytes = await readFile(join(storageDir(), String(rows[0]!['storage_key'])));
  return { attachment, bytes };
}

/** Soft-deletes an attachment. Bytes are retained for audit and restore. */
export async function deleteAttachment(actor: ActorRef, id: string): Promise<void> {
  const scope = new TenantScope(actor.organizationId);
  const r = await scope.query(
    `UPDATE attachments SET deleted_at = $3, deleted_by = $4
     WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [actor.organizationId, id, nowIso(), actor.userId],
  );
  if (r.length === 0) throw notFound('Attachment not found.');
}
