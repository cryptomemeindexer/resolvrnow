import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Context } from '../../engine/context.js';
import { AccessError, InvalidError, NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { type ApiDeps, baseUrl, ctxOf, HttpError, intParam, nowRoute } from '../http.js';

type Q = Record<string, string | undefined>;

const SAFE_NAME = /[^\w.\- ()]/g;

export function attachmentJson(rec: Rec, base: string) {
  return {
    sys_id: rec.sysId,
    file_name: rec.str('file_name'),
    content_type: rec.str('content_type'),
    size_bytes: rec.str('size_bytes'),
    size_compressed: rec.str('size_compressed') || rec.str('size_bytes'),
    compressed: rec.bool('compressed') ? 'true' : 'false',
    table_name: rec.str('table_name'),
    table_sys_id: rec.str('table_sys_id'),
    hash: rec.str('hash'),
    state: rec.str('state') || 'available',
    image_width: rec.str('image_width'),
    image_height: rec.str('image_height'),
    average_image_color: rec.str('average_image_color'),
    chunk_size_bytes: rec.str('chunk_size_bytes'),
    download_link: `${base}/api/now/attachment/${rec.sysId}/file`,
    sys_created_on: rec.str('sys_created_on'),
    sys_created_by: rec.str('sys_created_by'),
    sys_updated_on: rec.str('sys_updated_on'),
    sys_updated_by: rec.str('sys_updated_by'),
    sys_mod_count: rec.str('sys_mod_count'),
    sys_tags: '',
  };
}

/** Stores a file for a record; checks that the caller can read the target record. */
export function saveAttachment(
  ctx: Context,
  dir: string,
  tableName: string,
  tableSysId: string,
  fileName: string,
  contentType: string,
  data: Buffer,
): Rec {
  if (!ctx.registry.has(tableName)) throw new InvalidError(`Invalid table ${tableName}`);
  const target = ctx.get(tableName, tableSysId);
  if (!target) throw new AccessError('Insufficient rights', `Cannot attach to ${tableName}/${tableSysId}`);
  mkdirSync(dir, { recursive: true });
  const rec = ctx.elevated().insert('sys_attachment', {
    file_name: fileName.replace(SAFE_NAME, '_').slice(0, 200) || 'file',
    content_type: contentType || 'application/octet-stream',
    size_bytes: data.length,
    size_compressed: data.length,
    compressed: false,
    table_name: target.className,
    table_sys_id: tableSysId,
    hash: createHash('sha256').update(data).digest('hex'),
    state: 'available',
  });
  const path = join(dir, rec.sysId);
  writeFileSync(path, data);
  ctx.platform.db.run(`UPDATE "sys_attachment" SET "storage_path" = ? WHERE "sys_id" = ?`, [rec.sysId, rec.sysId]);
  return rec;
}

export function readAttachment(dir: string, rec: Rec): Buffer {
  return readFileSync(join(dir, rec.str('storage_path') || rec.sysId));
}

export function registerAttachmentApi(app: FastifyInstance, deps: ApiDeps): void {
  const dir = deps.config.attachmentDir;

  nowRoute(app, 'GET', '/attachment', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const q = req.query as Q;
    const limit = intParam(q.sysparm_limit, 1000, 1, 10000);
    const offset = intParam(q.sysparm_offset, 0, 0);
    const recs = ctx.query('sys_attachment', { query: q.sysparm_query ?? '', limit, offset });
    reply.header('X-Total-Count', String(ctx.count('sys_attachment', q.sysparm_query ?? '')));
    return { result: recs.map((r) => attachmentJson(r, baseUrl(req, deps))) };
  });

  nowRoute(app, 'GET', '/attachment/:sysId', async (req) => {
    const ctx = ctxOf(req, deps);
    const rec = ctx.get('sys_attachment', (req.params as { sysId: string }).sysId);
    if (!rec) throw new NotFoundError();
    return { result: attachmentJson(rec, baseUrl(req, deps)) };
  });

  nowRoute(app, 'GET', '/attachment/:sysId/file', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const rec = ctx.get('sys_attachment', (req.params as { sysId: string }).sysId);
    if (!rec) throw new NotFoundError();
    let data: Buffer;
    try {
      data = readAttachment(dir, rec);
    } catch {
      throw new NotFoundError('Attachment content not found');
    }
    reply
      .header('Content-Type', rec.str('content_type') || 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${rec.str('file_name').replace(/"/g, '')}"`)
      .header('X-Attachment-Metadata', JSON.stringify(attachmentJson(rec, baseUrl(req, deps))))
      .header('Cache-Control', 'private, no-store');
    return reply.send(data);
  });

  nowRoute(app, 'POST', '/attachment/file', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const q = req.query as Q;
    if (!q.table_name || !q.table_sys_id || !q.file_name) {
      throw new HttpError(400, 'Missing required parameter', 'table_name, table_sys_id and file_name are required');
    }
    const body = req.body;
    const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? ''));
    const rec = saveAttachment(ctx, dir, q.table_name, q.table_sys_id, q.file_name, String(req.headers['content-type'] ?? ''), data);
    reply.code(201).header('Location', `${baseUrl(req, deps)}/api/now/attachment/${rec.sysId}`);
    return { result: attachmentJson(rec, baseUrl(req, deps)) };
  });

  nowRoute(app, 'POST', '/attachment/upload', async (req: FastifyRequest, reply) => {
    const ctx = ctxOf(req, deps);
    if (!req.isMultipart()) throw new HttpError(400, 'Expected multipart/form-data');
    const fields: Record<string, string> = {};
    let saved: Rec | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        fields[part.fieldname] = String(part.value ?? '');
      } else {
        const buf = await part.toBuffer();
        if (!fields.table_name || !fields.table_sys_id) {
          throw new HttpError(400, 'Missing required parameter', 'table_name and table_sys_id must precede the file part');
        }
        saved = saveAttachment(ctx, dir, fields.table_name, fields.table_sys_id, part.filename, part.mimetype, buf);
      }
    }
    if (!saved) throw new HttpError(400, 'No file part found');
    reply.code(201).header('Location', `${baseUrl(req, deps)}/api/now/attachment/${saved.sysId}`);
    return { result: attachmentJson(saved, baseUrl(req, deps)) };
  });

  nowRoute(app, 'DELETE', '/attachment/:sysId', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const rec = ctx.get('sys_attachment', (req.params as { sysId: string }).sysId);
    if (!rec) throw new NotFoundError();
    ctx.delete(rec);
    try {
      rmSync(join(dir, rec.str('storage_path') || rec.sysId), { force: true });
    } catch {
      /* file already gone */
    }
    return reply.code(204).send();
  });
}
