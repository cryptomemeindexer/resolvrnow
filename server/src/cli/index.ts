#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AuthService } from '../api/auth.js';
import { loadConfig } from '../config.js';
import { Platform } from '../engine/platform.js';
import { hashPassword } from '../engine/services/password.js';
import { selectModules } from '../modules/index.js';

const HELP = `ResolvrNow command line

Usage: resolvrnow <command> [options]

Commands:
  serve                         Start the server (default)
  demo                          Load the Northwind Labs demo data into the database
  password <user_name> [pass]   Set a user's password (generated when omitted)
  token <user_name> [name]      Create an API token for a user (printed once)
  export [--tables a,b] [--out dir]
                                Export tables to JSON files
  import --from <url> --user <name> --password <pass> [--tables a,b] [--limit n] [--query q]
                                Copy records from another instance exposing the Table API,
                                preserving sys_ids (business rules are not run)
  modules                       List installed modules

Environment: RESOLVRNOW_DATA_DIR, RESOLVRNOW_DB_FILE, RESOLVRNOW_MODULES, RESOLVRNOW_ADMIN_PASSWORD, PORT
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function boot(demo = false): Platform {
  const config = loadConfig();
  return new Platform({ dbFile: config.dbFile, modules: selectModules(), demo, logger: console }).boot();
}

const DEFAULT_IMPORT_ORDER = [
  'core_company',
  'cmn_location',
  'cmn_department',
  'sys_user_group',
  'sys_user',
  'sys_user_grmember',
  'cmdb_ci',
  'cmdb_rel_ci',
  'kb_knowledge_base',
  'kb_category',
  'kb_knowledge',
  'sc_catalog',
  'sc_category',
  'sc_cat_item',
  'incident',
  'problem',
  'change_request',
  'change_task',
  'sc_request',
  'sc_req_item',
  'sc_task',
];

async function importFrom(): Promise<void> {
  const from = arg('from');
  const user = arg('user');
  const password = arg('password') ?? process.env.RESOLVRNOW_IMPORT_PASSWORD;
  if (!from || !user || !password) throw new Error('import requires --from, --user and --password (or RESOLVRNOW_IMPORT_PASSWORD)');
  const limit = Number(arg('limit') ?? 1000);
  const query = arg('query') ?? '';
  const platform = boot();
  const tables = (arg('tables')?.split(',') ?? DEFAULT_IMPORT_ORDER).filter((t) => platform.registry.has(t));
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const ctx = platform.systemContext().derive({ workflow: false });
  for (const table of tables) {
    const meta = platform.registry.table(table);
    let offset = 0;
    let imported = 0;
    for (;;) {
      const url = `${from.replace(/\/$/, '')}/api/now/table/${table}?sysparm_limit=${Math.min(limit - imported, 500)}&sysparm_offset=${offset}&sysparm_exclude_reference_link=true${query ? `&sysparm_query=${encodeURIComponent(query)}` : ''}`;
      const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (!res.ok) {
        console.warn(`  ${table}: HTTP ${res.status}, skipped`);
        break;
      }
      const rows = ((await res.json()) as { result: Record<string, string>[] }).result ?? [];
      if (!rows.length) break;
      platform.db.tx(() => {
        for (const row of rows) {
          if (!row.sys_id) continue;
          const values: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(row)) if (meta.columns.has(k) && k !== 'user_password') values[k] = v;
          const existing = ctx.get(table, row.sys_id);
          if (existing) ctx.update(existing, values, { autoSysFields: false });
          else ctx.insert(table, values, { autoSysFields: false });
        }
      });
      imported += rows.length;
      offset += rows.length;
      if (imported >= limit || rows.length < 1) break;
    }
    console.log(`  ${table}: ${imported} record(s)`);
  }
  platform.close();
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'serve';
  switch (cmd) {
    case 'serve':
      await import('../index.js');
      return;
    case 'demo': {
      const p = boot(true);
      console.log('Demo data loaded. Demo users share the password: demo1234');
      p.close();
      return;
    }
    case 'password': {
      const userName = process.argv[3];
      if (!userName) throw new Error('password requires a user name');
      const pw = process.argv[4] ?? Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 8).toUpperCase();
      const p = boot();
      const r = p.db.run(`UPDATE "sys_user" SET "user_password" = ?, "locked_out" = 0, "failed_attempts" = 0 WHERE "user_name" = ? COLLATE NOCASE`, [
        hashPassword(pw),
        userName,
      ]);
      p.close();
      if (r.changes === 0) throw new Error(`No user ${userName}`);
      console.log(process.argv[4] ? `Password updated for ${userName}` : `New password for ${userName}: ${pw}`);
      return;
    }
    case 'token': {
      const userName = process.argv[3];
      if (!userName) throw new Error('token requires a user name');
      const p = boot();
      const u = p.users.byUserName(userName);
      if (!u?.sysId) throw new Error(`No user ${userName}`);
      const token = new AuthService(p).issueToken(u.sysId, process.argv[4] ?? 'cli');
      p.close();
      console.log(token);
      return;
    }
    case 'export': {
      const p = boot();
      const out = resolve(arg('out') ?? 'export');
      mkdirSync(out, { recursive: true });
      const tables = arg('tables')?.split(',') ?? p.registry.tables().filter((t) => !t.parent && !t.system).map((t) => t.name);
      const ctx = p.systemContext();
      for (const t of tables) {
        if (!p.registry.has(t)) continue;
        const rows = ctx.query(t).map((r) => r.toObject());
        writeFileSync(join(out, `${t}.json`), JSON.stringify(rows, null, 1));
        console.log(`  ${t}: ${rows.length}`);
      }
      p.close();
      return;
    }
    case 'import':
      await importFrom();
      return;
    case 'modules':
      for (const m of selectModules()) console.log(`${m.id.padEnd(16)} ${m.name}`);
      return;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
