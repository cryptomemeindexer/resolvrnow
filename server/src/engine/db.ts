import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { SchemaRegistry } from './registry.js';
import { quoteIdent } from './util.js';

export type SqlParam = string | number | bigint | null | Buffer;

/**
 * Thin synchronous wrapper around better-sqlite3.
 *
 * The whole platform engine is synchronous (like server-side scripting on the
 * platform being reimplemented), which keeps business rules, ACLs and the
 * script sandbox free of async re-entrancy problems.
 */
export class Database {
  readonly sqlite: BetterSqlite3.Database;
  private stmts = new Map<string, BetterSqlite3.Statement>();
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.sqlite = new BetterSqlite3(file);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('synchronous = NORMAL');
    this.sqlite.pragma('foreign_keys = OFF');
    this.sqlite.pragma('busy_timeout = 5000');
    this.sqlite.pragma('cache_size = -64000');
    this.sqlite.function('regexp', { deterministic: true }, (pattern: unknown, value: unknown) => {
      if (value === null || value === undefined) return 0;
      try {
        return new RegExp(String(pattern), 'i').test(String(value)) ? 1 : 0;
      } catch {
        return 0;
      }
    });
  }

  prepare(sql: string): BetterSqlite3.Statement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.sqlite.prepare(sql);
      if (this.stmts.size > 2000) this.stmts.clear();
      this.stmts.set(sql, s);
    }
    return s;
  }

  all<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, params: SqlParam[] = []): BetterSqlite3.RunResult {
    return this.prepare(sql).run(...params);
  }

  exec(sql: string): void {
    this.sqlite.exec(sql);
  }

  /** Runs `fn` inside a transaction; nested calls become savepoints. */
  tx<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }

  get inTransaction(): boolean {
    return this.sqlite.inTransaction;
  }

  close(): void {
    this.stmts.clear();
    this.sqlite.close();
  }

  /** Creates missing physical tables, columns and indexes for every registered table. */
  syncSchema(registry: SchemaRegistry): { createdTables: string[]; addedColumns: string[] } {
    const createdTables: string[] = [];
    const addedColumns: string[] = [];
    const roots = new Set(registry.tables().map((t) => t.root));
    this.tx(() => {
      for (const root of roots) {
        const cols = registry.physicalColumns(root);
        const existing = this.all<{ name: string }>(`PRAGMA table_info(${quoteIdent(root)})`);
        if (existing.length === 0) {
          const parts = [`"sys_id" TEXT PRIMARY KEY`];
          for (const [name, storage] of cols) {
            if (name === 'sys_id') continue;
            parts.push(`${quoteIdent(name)} ${storage}`);
          }
          this.exec(`CREATE TABLE ${quoteIdent(root)} (${parts.join(', ')})`);
          createdTables.push(root);
        } else {
          const have = new Set(existing.map((c) => c.name));
          for (const [name, storage] of cols) {
            if (!have.has(name)) {
              this.exec(`ALTER TABLE ${quoteIdent(root)} ADD COLUMN ${quoteIdent(name)} ${storage}`);
              addedColumns.push(`${root}.${name}`);
            }
          }
        }
        for (const idx of registry.indexedColumns(root)) {
          if (!idx.every((c) => cols.has(c))) continue;
          const name = `ix_${root}_${idx.join('_')}`.slice(0, 120);
          this.exec(
            `CREATE INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${quoteIdent(root)} (${idx.map(quoteIdent).join(', ')})`,
          );
        }
      }
    });
    return { createdTables, addedColumns };
  }
}
