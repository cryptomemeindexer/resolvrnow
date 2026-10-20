import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Context } from '../../engine/context.js';
import { NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { isSysId, normalizeDateTime, quoteIdent } from '../../engine/util.js';
import { type ApiDeps, baseUrl, ctxOf, HttpError, nowRoute, queryParam } from '../http.js';
import { parseBool } from '../serialize.js';
import { accepts } from './compat.js';
import { linkHeader, listQuery } from './table.js';

type Q = Record<string, unknown>;

const SAFE_NAME = /[^\w.\- ()]/g;
const ATTRIBUTE_TABLE = 'sys_attachment_attribute';

/**
 * Attachment metadata exactly as documented: every value is a plain string. `names`
 * resolves a user name to the user's display name (created_by_name / updated_by_name).
 */
export function attachmentJson(rec: Rec, base: string, names?: (userName: string) => string) {
  const name = (u: string) => (u && names ? names(u) : u);
  return {
    sys_id: rec.sysId,
    file_name: rec.str('file_name'),
    content_type: rec.str('content_type'),
    size_bytes: rec.str('size_bytes'),
    size_compressed: rec.str('size_compressed') || rec.str('size_bytes'),
    compressed: rec.bool('compressed') ? 'true' : 'false',
    table_name: rec.str('table_name'),
    table_sys_id: rec.str('table_sys_id'),
    download_link: `${base}/api/now/attachment/${rec.sysId}/file`,
    image_width: rec.str('image_width'),
    image_height: rec.str('image_height'),
    average_image_color: rec.str('average_image_color'),
    sys_tags: '',
    sys_mod_count: rec.str('sys_mod_count'),
    sys_created_by: rec.str('sys_created_by'),
    sys_created_on: rec.str('sys_created_on'),
    sys_updated_by: rec.str('sys_updated_by'),
    sys_updated_on: rec.str('sys_updated_on'),
    created_by_name: name(rec.str('sys_created_by')),
    updated_by_name: name(rec.str('sys_updated_by')),
  };
}

function userNames(ctx: Context): (userName: string) => string {
  const cache = new Map<string, string>();
  return (u) => {
    let n = cache.get(u);
    if (n === undefined) {
      const row = ctx.platform.db.get<{ name: string | null }>(
        `SELECT "name" FROM "sys_user" WHERE "user_name" = ?`,
        [u],
      );
      n = row?.name || u;
      cache.set(u, n);
    }
    return n;
  };
}

/** Width and height of PNG, GIF and JPEG images; null for other content. */
export function imageSize(data: Buffer): { width: number; height: number } | null {
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47)
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.length >= 10 && data.toString('ascii', 0, 4) === 'GIF8')
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) return null;
      const marker = data[i + 1];
      const len = data.readUInt16BE(i + 2);
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return null;
}

export interface SaveAttachmentOptions {
  /** Overrides the creation time (offline uploads), as a UTC date-time. */
  creationTime?: string | null;
}

/**
 * Stores a file for a record. The caller must be able to read and write the target record
 * and create attachments; size and extension limits come from the platform properties.
 */
export function saveAttachment(
  ctx: Context,
  dir: string,
  tableName: string,
  tableSysId: string,
  fileName: string,
  contentType: string,
  data: Buffer,
  opts: SaveAttachmentOptions = {},
): Rec {
  if (!ctx.registry.has(tableName)) throw new HttpError(400, `Invalid table ${tableName}`);
  const target = isSysId(tableSysId) ? ctx.get(tableName, tableSysId) : null;
  if (!target)
    throw new HttpError(
      404,
      'No Record found',
      `Record ${tableName}/${tableSysId} doesn't exist or ACL restricts the record retrieval`,
    );
  const acl = ctx.platform.acl;
  if (
    !acl.canTable(ctx, target.className, 'write', target).allowed ||
    !acl.canTable(ctx, 'sys_attachment', 'create').allowed
  ) {
    throw new HttpError(403, 'Operation Failed', 'ACL Exception Insert Failed due to security constraints');
  }
  const maxMb = ctx.platform.properties.getNumber('com.glide.attachment.max_size', 1024);
  if (maxMb > 0 && data.length > maxMb * 1024 * 1024) {
    throw new HttpError(400, 'Failed to create the attachment', `File size exceeds the limit of ${maxMb} MB`);
  }
  const cleanName = fileName.replace(SAFE_NAME, '_').slice(0, 200) || 'file';
  const allowed = (ctx.platform.properties.get('glide.attachment.extensions') ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  if (allowed.length) {
    const ext = cleanName.includes('.') ? cleanName.split('.').pop()!.toLowerCase() : '';
    if (!allowed.includes(ext))
      throw new HttpError(
        400,
        'Failed to create the attachment',
        `File extension ${ext || '(none)'} is not allowed`,
      );
  }
  mkdirSync(dir, { recursive: true });
  const dims = imageSize(data);
  const rec = ctx.elevated().insert('sys_attachment', {
    file_name: cleanName,
    content_type: contentType || 'application/octet-stream',
    size_bytes: data.length,
    size_compressed: data.length,
    compressed: false,
    table_name: target.className,
    table_sys_id: tableSysId,
    hash: createHash('sha256').update(data).digest('hex'),
    state: 'available',
    image_width: dims ? dims.width : null,
    image_height: dims ? dims.height : null,
  });
  writeFileSync(join(dir, rec.sysId), data);
  ctx.platform.db.run(`UPDATE "sys_attachment" SET "storage_path" = ? WHERE "sys_id" = ?`, [
    rec.sysId,
    rec.sysId,
  ]);
  const created = opts.creationTime ? normalizeDateTime(opts.creationTime) : null;
  if (created)
    ctx.platform.db.run(`UPDATE "sys_attachment" SET "sys_created_on" = ? WHERE "sys_id" = ?`, [
      created,
      rec.sysId,
    ]);
  return ctx.elevated().get('sys_attachment', rec.sysId) ?? rec;
}

export function readAttachment(dir: string, rec: Rec): Buffer {
  return readFileSync(join(dir, rec.str('storage_path') || rec.sysId));
}

function attachmentOf(ctx: Context, req: FastifyRequest): Rec {
  const rec = ctx.get('sys_attachment', (req.params as { sysId: string }).sysId);
  if (!rec) throw new NotFoundError();
  return rec;
}

function attributeApi(ctx: Context): boolean {
  return ctx.registry.has(ATTRIBUTE_TABLE);
}

export function registerAttachmentApi(app: FastifyInstance, deps: ApiDeps): void {
  const dir = deps.config.attachmentDir;
  const meta = (req: FastifyRequest, ctx: Context, rec: Rec) =>
    attachmentJson(rec, baseUrl(req, deps), userNames(ctx));

  nowRoute(app, 'GET', '/attachment', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const q = req.query as Q;
    const n = Number.parseInt(String(queryParam(q.sysparm_limit) ?? ''), 10);
    const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 10000) : 1000;
    const o = Number.parseInt(String(queryParam(q.sysparm_offset) ?? ''), 10);
    const offset = Number.isFinite(o) && o > 0 ? o : 0;
    const table = ctx.registry.table('sys_attachment');
    const lq = listQuery(req, ctx, table, { sysparm_query: queryParam(q.sysparm_query) ?? '' });
    const recs = lq.noRows ? [] : ctx.query('sys_attachment', { query: lq.query, limit, offset });
    const total = lq.noRows ? 0 : ctx.count('sys_attachment', lq.query);
    reply.header('X-Total-Count', String(total));
    if (!parseBool(q.sysparm_suppress_pagination_header))
      reply.header('Link', linkHeader(req, baseUrl(req, deps), total, limit, offset, recs.length));
    return { result: recs.map((r) => meta(req, ctx, r)) };
  });

  nowRoute(app, 'GET', '/attachment/:sysId', async (req) => {
    const ctx = ctxOf(req, deps);
    return { result: meta(req, ctx, attachmentOf(ctx, req)) };
  });

  nowRoute(
    app,
    'GET',
    '/attachment/:sysId/file',
    async (req, reply) => {
      const ctx = ctxOf(req, deps);
      const rec = attachmentOf(ctx, req);
      const type = rec.str('content_type') || 'application/octet-stream';
      if (!accepts(req.headers.accept, type)) {
        throw new HttpError(406, 'Not Acceptable', `The attachment's content type ${type} is not accepted`);
      }
      let data: Buffer;
      try {
        data = readAttachment(dir, rec);
      } catch {
        throw new NotFoundError(
          'Attachment content not found',
          `The file of attachment ${rec.sysId} is missing`,
        );
      }
      reply
        .header('Content-Type', type)
        .header(
          'Content-Disposition',
          `attachment; filename="${rec.str('file_name').replace(/["\\\r\n]/g, '')}"`,
        )
        .header('X-Attachment-Metadata', JSON.stringify(meta(req, ctx, rec)))
        .header('Cache-Control', 'private, no-store');
      return reply.send(data);
    },
    { produces: ['*'] },
  );

  // Raw uploads keep the exact bytes whatever the Content-Type, so this route gets its own
  // body parser instead of the JSON / XML ones.
  app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    nowRoute(
      raw,
      'POST',
      '/attachment/file',
      async (req, reply) => {
        const ctx = ctxOf(req, deps);
        const q = req.query as Q;
        const tableName = queryParam(q.table_name);
        const tableSysId = queryParam(q.table_sys_id);
        const fileName = queryParam(q.file_name);
        const missing = [
          ['table_name', tableName],
          ['table_sys_id', tableSysId],
          ['file_name', fileName],
        ]
          .filter(([, v]) => !v)
          .map(([k]) => k);
        if (missing.length)
          throw new HttpError(400, 'Missing required parameter', `${missing.join(', ')} must be supplied`);
        const contentType = String(req.headers['content-type'] ?? '').trim();
        if (!contentType)
          throw new HttpError(400, 'Missing required header', 'Content-Type must be supplied');
        const body = req.body;
        const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : '');
        const rec = saveAttachment(ctx, dir, tableName!, tableSysId!, fileName!, contentType, data, {
          creationTime: queryParam(q.creation_time) ?? null,
        });
        reply.code(201).header('Location', `${baseUrl(req, deps)}/api/now/attachment/${rec.sysId}`);
        return { result: meta(req, ctx, rec) };
      },
      { rawBody: true },
    );
  });

  nowRoute(
    app,
    'POST',
    '/attachment/upload',
    async (req: FastifyRequest, reply) => {
      const ctx = ctxOf(req, deps);
      if (!req.isMultipart())
        throw new HttpError(
          400,
          'Expected multipart/form-data',
          'Send table_name and table_sys_id fields followed by the file part',
        );
      const fields: Record<string, string> = {};
      let saved: Rec | null = null;
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          fields[part.fieldname] = String(part.value ?? '');
          continue;
        }
        const buf = await part.toBuffer();
        if (saved) continue; // one file per request; the file part must be last
        const missing = ['table_name', 'table_sys_id'].filter((k) => !fields[k]);
        if (missing.length) {
          throw new HttpError(
            400,
            'Missing required parameter',
            `${missing.join(', ')} must precede the file part`,
          );
        }
        saved = saveAttachment(
          ctx,
          dir,
          fields.table_name,
          fields.table_sys_id,
          fields.file_name || part.filename || 'file',
          part.mimetype,
          buf,
          {
            creationTime: fields.creation_time ?? null,
          },
        );
      }
      if (!saved) throw new HttpError(400, 'Missing required parameter', 'No file part found');
      reply.code(201).header('Location', `${baseUrl(req, deps)}/api/now/attachment/${saved.sysId}`);
      return { result: meta(req, ctx, saved) };
    },
    { rawBody: true },
  );

  nowRoute(app, 'PATCH', '/attachment/:sysId', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const rec = attachmentOf(ctx, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.file_name === 'string' ? body.file_name.trim() : '';
    if (!name) throw new HttpError(400, 'Missing required parameter', 'file_name must be supplied');
    const parent = ctx.get(rec.str('table_name'), rec.str('table_sys_id'));
    if (!parent || !ctx.platform.acl.canTable(ctx, parent.className, 'write', parent).allowed) {
      throw new HttpError(403, 'Operation Failed', 'ACL Exception Update Failed due to security constraints');
    }
    ctx.elevated().update(rec, { file_name: name.replace(SAFE_NAME, '_').slice(0, 200) });
    return reply.code(204).send();
  });

  nowRoute(app, 'DELETE', '/attachment/:sysId', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const rec = attachmentOf(ctx, req);
    try {
      ctx.delete(rec);
    } catch {
      throw new HttpError(403, 'Operation Failed', 'ACL Exception Delete Failed due to security constraints');
    }
    try {
      rmSync(join(dir, rec.str('storage_path') || rec.sysId), { force: true });
    } catch {
      /* file already gone */
    }
    if (attributeApi(ctx))
      ctx.platform.db.run(`DELETE FROM ${quoteIdent(ATTRIBUTE_TABLE)} WHERE "attachment" = ?`, [rec.sysId]);
    return reply.code(204).send();
  });

  // Attachment attributes (key/value pairs) live in sys_attachment_attribute when that table
  // is installed; without it these endpoints answer 400.
  const attributes = (ctx: Context, attachmentId: string) =>
    ctx.platform.db.all<{ sys_id: string; key: string; value: string | null }>(
      `SELECT "sys_id","key","value" FROM ${quoteIdent(ATTRIBUTE_TABLE)} WHERE "attachment" = ? ORDER BY rowid`,
      [attachmentId],
    );
  const requireAttributes = (ctx: Context) => {
    if (!attributeApi(ctx))
      throw new HttpError(
        400,
        'Requested URI does not represent any resource',
        'Attachment attributes are not installed',
      );
  };
  const attributeOf = (ctx: Context, attachmentId: string, key: string) => {
    const row = attributes(ctx, attachmentId).find((a) => a.key === key);
    if (!row) throw new HttpError(404, 'No Record found', `Attribute ${key} does not exist`);
    return row;
  };
  const canWrite = (ctx: Context, rec: Rec) => {
    const parent = ctx.get(rec.str('table_name'), rec.str('table_sys_id'));
    if (!parent || !ctx.platform.acl.canTable(ctx, parent.className, 'write', parent).allowed) {
      throw new HttpError(403, 'Operation Failed', 'ACL Exception Update Failed due to security constraints');
    }
  };

  nowRoute(app, 'GET', '/attachment/:sysId/attributes', async (req) => {
    const ctx = ctxOf(req, deps);
    requireAttributes(ctx);
    const rec = attachmentOf(ctx, req);
    return { result: attributes(ctx, rec.sysId).map((a) => ({ key: a.key, value: a.value ?? '' })) };
  });

  nowRoute(app, 'GET', '/attachment/:sysId/attributes/:key', async (req) => {
    const ctx = ctxOf(req, deps);
    requireAttributes(ctx);
    const rec = attachmentOf(ctx, req);
    const a = attributeOf(ctx, rec.sysId, (req.params as { key: string }).key);
    return { result: { key: a.key, value: a.value ?? '' } };
  });

  nowRoute(app, 'POST', '/attachment/:sysId/attributes', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    requireAttributes(ctx);
    const rec = attachmentOf(ctx, req);
    canWrite(ctx, rec);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.key !== 'string' || !body.key.trim() || body.value === undefined || body.value === null) {
      throw new HttpError(400, 'Missing required parameter', 'key and value must be supplied');
    }
    const key = body.key.trim();
    if (attributes(ctx, rec.sysId).some((a) => a.key === key))
      throw new HttpError(400, 'Invalid attribute', `Attribute ${key} already exists`);
    ctx.elevated().insert(ATTRIBUTE_TABLE, { attachment: rec.sysId, key, value: String(body.value) });
    reply.code(201);
    return { result: { key, value: String(body.value) } };
  });

  nowRoute(app, 'PUT', '/attachment/:sysId/attributes/:key', async (req) => {
    const ctx = ctxOf(req, deps);
    requireAttributes(ctx);
    const rec = attachmentOf(ctx, req);
    canWrite(ctx, rec);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.value === undefined || body.value === null)
      throw new HttpError(400, 'Missing required parameter', 'value must be supplied');
    const a = attributeOf(ctx, rec.sysId, (req.params as { key: string }).key);
    ctx.elevated().updateById(ATTRIBUTE_TABLE, a.sys_id, { value: String(body.value) });
    return { result: { key: a.key, value: String(body.value) } };
  });

  nowRoute(app, 'DELETE', '/attachment/:sysId/attributes', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    requireAttributes(ctx);
    const rec = attachmentOf(ctx, req);
    canWrite(ctx, rec);
    for (const a of attributes(ctx, rec.sysId)) ctx.elevated().deleteById(ATTRIBUTE_TABLE, a.sys_id);
    return reply.code(204).send();
  });

  nowRoute(app, 'DELETE', '/attachment/:sysId/attributes/:key', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    requireAttributes(ctx);
    const rec = attachmentOf(ctx, req);
    canWrite(ctx, rec);
    const a = attributeOf(ctx, rec.sysId, (req.params as { key: string }).key);
    ctx.elevated().deleteById(ATTRIBUTE_TABLE, a.sys_id);
    return reply.code(204).send();
  });
}
