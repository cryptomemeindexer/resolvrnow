import {
  type ChoiceDef,
  type ColumnDef,
  type ColumnMeta,
  STORAGE,
  SYSTEM_COLUMNS,
  type TableDef,
  type TableMeta,
} from './types.js';

const IDENT = /^[a-z_][a-z0-9_]*$/;

export class SchemaError extends Error {}

/**
 * Holds every table definition and resolves the class hierarchy.
 *
 * Storage follows a "table per hierarchy" layout: every table that extends another
 * shares the physical SQL table of its root and is told apart by `sys_class_name`.
 * Querying `task` therefore returns incidents, problems and changes, while querying
 * `incident` filters on the incident class and its descendants.
 */
export class SchemaRegistry {
  private defs = new Map<string, TableDef>();
  private metas = new Map<string, TableMeta>();
  private finalized = false;
  /** Choice lists from code definitions; DB choices (sys_choice) are layered on top by ChoiceService. */
  readonly codeChoices = new Map<string, ChoiceDef[]>();

  define(def: TableDef): void {
    if (!IDENT.test(def.name)) throw new SchemaError(`Invalid table name: ${def.name}`);
    const existing = this.defs.get(def.name);
    if (existing) {
      // Merge additional columns (e.g. a module adding fields to a platform table).
      const names = new Set(existing.columns.map((c) => c.name));
      for (const c of def.columns) {
        if (!names.has(c.name)) existing.columns.push(c);
      }
      existing.overrides = { ...(existing.overrides ?? {}), ...(def.overrides ?? {}) };
      if (def.textIndex) existing.textIndex = [...new Set([...(existing.textIndex ?? []), ...def.textIndex])];
      if (def.indexes) existing.indexes = [...(existing.indexes ?? []), ...def.indexes];
      if (def.displayField && !existing.displayField) existing.displayField = def.displayField;
      if (def.number && !existing.number) existing.number = def.number;
    } else {
      this.defs.set(def.name, { ...def, columns: [...def.columns] });
    }
    this.finalized = false;
  }

  /** Adds or replaces a column on an existing table (used by runtime dictionary edits). */
  addColumn(table: string, col: ColumnDef): void {
    const def = this.defs.get(table);
    if (!def) throw new SchemaError(`Unknown table ${table}`);
    const idx = def.columns.findIndex((c) => c.name === col.name);
    if (idx >= 0) def.columns[idx] = col;
    else def.columns.push(col);
    this.finalized = false;
  }

  removeColumn(table: string, name: string): void {
    const def = this.defs.get(table);
    if (!def) return;
    def.columns = def.columns.filter((c) => c.name !== name);
    this.finalized = false;
  }

  removeTable(name: string): void {
    this.defs.delete(name);
    this.finalized = false;
  }

  definitions(): TableDef[] {
    return [...this.defs.values()];
  }

  finalize(): void {
    this.metas.clear();
    this.codeChoices.clear();
    // Validate parents
    for (const def of this.defs.values()) {
      if (def.extends && !this.defs.has(def.extends)) {
        throw new SchemaError(`Table ${def.name} extends unknown table ${def.extends}`);
      }
    }
    const rootOf = (name: string, seen = new Set<string>()): string => {
      const d = this.defs.get(name)!;
      if (!d.extends) return name;
      if (seen.has(name)) throw new SchemaError(`Cyclic table hierarchy at ${name}`);
      seen.add(name);
      return rootOf(d.extends, seen);
    };
    const ancestorsOf = (name: string): string[] => {
      const out: string[] = [];
      let cur: string | undefined = name;
      while (cur) {
        out.push(cur);
        cur = this.defs.get(cur)?.extends;
      }
      return out;
    };
    const children = new Map<string, string[]>();
    for (const def of this.defs.values()) {
      if (def.extends) {
        const list = children.get(def.extends) ?? [];
        list.push(def.name);
        children.set(def.extends, list);
      }
    }
    const descendantsOf = (name: string): string[] => {
      const out = [name];
      for (const c of children.get(name) ?? []) out.push(...descendantsOf(c));
      return out;
    };

    // Physical column allocation per root: (definedOn, name) -> physical name
    const physicalByRoot = new Map<string, Map<string, { storage: string; owners: Set<string> }>>();

    // Process tables parents-first so inherited columns exist before children.
    const order = [...this.defs.values()].sort(
      (a, b) => ancestorsOf(a.name).length - ancestorsOf(b.name).length,
    );
    for (const def of order) {
      const ancestors = ancestorsOf(def.name);
      const root = rootOf(def.name);
      const parentMeta = def.extends ? this.metas.get(def.extends)! : null;
      const columns = new Map<string, ColumnMeta>();
      let physCols = physicalByRoot.get(root);
      if (!physCols) {
        physCols = new Map();
        physicalByRoot.set(root, physCols);
      }
      const allocate = (col: ColumnDef, definedOn: string): ColumnMeta => {
        const storage = STORAGE[col.type] ?? null;
        let physical = col.name;
        if (storage) {
          const existing = physCols!.get(physical);
          if (existing && existing.storage !== storage && !existing.owners.has(definedOn)) {
            physical = `${definedOn}__${col.name}`;
          }
          const slot = physCols!.get(physical) ?? { storage, owners: new Set<string>() };
          slot.owners.add(definedOn);
          physCols!.set(physical, slot);
        }
        return { ...col, definedOn, physical, storage };
      };

      if (parentMeta) {
        for (const [k, v] of parentMeta.columns) columns.set(k, { ...v });
      } else {
        for (const sc of SYSTEM_COLUMNS) columns.set(sc.name, { ...allocate(sc, def.name), system: true });
      }
      for (const col of def.columns) {
        if (!IDENT.test(col.name)) throw new SchemaError(`Invalid column name ${def.name}.${col.name}`);
        if (columns.has(col.name) && columns.get(col.name)!.system) continue;
        columns.set(col.name, allocate(col, def.name));
        if (col.choices?.length) this.codeChoices.set(`${def.name}.${col.name}`, col.choices);
      }
      for (const [field, ov] of Object.entries(def.overrides ?? {})) {
        const base = columns.get(field);
        if (!base) continue;
        columns.set(field, { ...base, ...ov });
        if (ov.choices?.length) this.codeChoices.set(`${def.name}.${field}`, ov.choices);
      }
      const displayField =
        def.displayField ??
        parentMeta?.displayField ??
        (columns.has('number') ? 'number' : columns.has('name') ? 'name' : 'sys_id');
      const num = def.number ?? undefined;
      this.metas.set(def.name, {
        name: def.name,
        label: def.label,
        plural: def.plural ?? `${def.label}s`,
        def,
        parent: def.extends ?? null,
        root,
        physical: root,
        ancestors,
        children: children.get(def.name) ?? [],
        descendants: descendantsOf(def.name),
        columns,
        displayField,
        number: num ? { prefix: num.prefix, start: num.start ?? 10000, digits: num.digits ?? 7 } : undefined,
        audit: def.audit ?? parentMeta?.audit ?? false,
        extensible: def.extensible ?? (children.get(def.name)?.length ?? 0) > 0,
        system: def.system ?? false,
      });
    }
    this.finalized = true;
  }

  private ensure(): void {
    if (!this.finalized) this.finalize();
  }

  has(table: string): boolean {
    this.ensure();
    return this.metas.has(table);
  }

  table(table: string): TableMeta {
    this.ensure();
    const m = this.metas.get(table);
    if (!m) throw new SchemaError(`Invalid table name ${table}`);
    return m;
  }

  tryTable(table: string): TableMeta | undefined {
    this.ensure();
    return this.metas.get(table);
  }

  tables(): TableMeta[] {
    this.ensure();
    return [...this.metas.values()];
  }

  column(table: string, field: string): ColumnMeta | undefined {
    return this.tryTable(table)?.columns.get(field);
  }

  isA(table: string, base: string): boolean {
    const m = this.tryTable(table);
    return !!m && m.ancestors.includes(base);
  }

  /** Physical SQL columns for a root table, de-duplicated. */
  physicalColumns(root: string): Map<string, string> {
    this.ensure();
    const out = new Map<string, string>();
    for (const m of this.metas.values()) {
      if (m.root !== root) continue;
      for (const c of m.columns.values()) if (c.storage) out.set(c.physical, c.storage);
    }
    return out;
  }

  /** Columns flagged for indexing (references, declared indexes) per root table. */
  indexedColumns(root: string): string[][] {
    this.ensure();
    const out = new Map<string, string[]>();
    const add = (cols: string[]) => out.set(cols.join(','), cols);
    add(['sys_class_name']);
    add(['sys_created_on']);
    add(['sys_updated_on']);
    for (const m of this.metas.values()) {
      if (m.root !== root) continue;
      for (const c of m.columns.values()) {
        if (!c.storage) continue;
        if (c.type === 'reference' || c.type === 'document_id' || c.indexed || c.unique || c.name === 'number') {
          add([c.physical]);
        }
      }
      for (const idx of m.def.indexes ?? []) {
        const phys = idx.map((f) => m.columns.get(f)?.physical ?? f);
        add(phys);
      }
    }
    return [...out.values()];
  }
}
