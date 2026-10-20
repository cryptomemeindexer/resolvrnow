import type { Context } from '../../engine/context.js';
import { matches } from '../../engine/query/matcher.js';
import type { Rec } from '../../engine/record.js';
import { recSubject } from '../../engine/rules.js';
import { chunk, nowGlide, SYS_ID_RE } from '../../engine/util.js';
import { isEmail, parseAddressList, resolvePath } from './util.js';

/** Who a notification (or an ad-hoc email) is meant for, before filtering. */
export interface RecipientSpec {
  /** sys_user sys_ids, user names or email addresses. */
  users?: string[];
  /** sys_user_group sys_ids. */
  groups?: string[];
  /** Field paths on the record (dot-walking allowed). */
  fields?: string[];
  /** Event parameter tokens (user/group sys_ids, user names, email addresses). */
  tokens?: { source: string; values: string[] }[];
  notificationId?: string | null;
  subscribable?: boolean;
  /** Keep the user who triggered the notification (default true). */
  sendSelf?: boolean;
  actorId?: string | null;
  excludeDelegates?: boolean;
  mandatory?: boolean;
  forceDelivery?: boolean;
  /** Approval notifications always address group members individually. */
  isApproval?: boolean;
  /** Addresses this instance sends from (never addressed). Lower case. */
  instanceAddresses?: string[];
  /** Apply per-user preferences (global switch, unsubscribe, filters). Off for ad-hoc sends. */
  applyPreferences?: boolean;
}

export interface Recipient {
  address: string;
  userId: string | null;
  name: string;
  /** Why the recipient was included. */
  reason: string;
}

export interface Exclusion {
  who: string;
  userId: string | null;
  address: string | null;
  reason: string;
}

export interface RecipientResult {
  included: Recipient[];
  excluded: Exclusion[];
}

interface Candidate {
  kind: 'user' | 'address';
  userId?: string;
  address?: string;
  name?: string;
  reason: string;
}

interface UserRow {
  sys_id: string;
  user_name: string | null;
  name: string | null;
  email: string | null;
  active: number | null;
  notification: number | string | null;
}

interface GroupRow {
  name: string | null;
  email: string | null;
  include_members: number | null;
  manager: string | null;
  exclude_manager: number | null;
  active: number | null;
}

/**
 * Recipient resolution for a notification occurrence: collects users, group members or
 * group addresses, record fields (including watch lists and dot-walks), event parameters,
 * subscribers and delegates, then filters them (inactive, no address, the triggering user,
 * unsubscribed, notifications disabled, the instance's own address). Recipients are not
 * filtered by ACLs: they may receive mail about records they cannot open.
 */
export function resolveRecipients(ctx: Context, spec: RecipientSpec, rec: Rec | null): RecipientResult {
  const platform = ctx.platform;
  const db = platform.db;
  const registry = platform.registry;
  const candidates: Candidate[] = [];
  const excluded: Exclusion[] = [];
  const seenUsers = new Set<string>();
  const seenAddresses = new Set<string>();
  const seenGroups = new Set<string>();
  const hasUsers = registry.has('sys_user');
  const hasGroups = registry.has('sys_user_group') && registry.has('sys_user_grmember');

  const addUser = (id: string, reason: string) => {
    if (!id || seenUsers.has(id)) return;
    seenUsers.add(id);
    candidates.push({ kind: 'user', userId: id, reason });
  };
  const addAddress = (address: string, reason: string, name = '') => {
    const key = address.trim().toLowerCase();
    if (!key || seenAddresses.has(key)) return;
    seenAddresses.add(key);
    candidates.push({ kind: 'address', address: address.trim(), name, reason });
  };
  const userExists = (id: string) =>
    hasUsers && !!db.get(`SELECT 1 AS x FROM "sys_user" WHERE "sys_id" = ?`, [id]);
  const groupExists = (id: string) =>
    hasGroups && !!db.get(`SELECT 1 AS x FROM "sys_user_group" WHERE "sys_id" = ?`, [id]);

  const expandGroup = (groupId: string, reason: string) => {
    if (!hasGroups || !groupId || seenGroups.has(groupId)) return;
    seenGroups.add(groupId);
    const g = db.get<GroupRow>(
      `SELECT "name","email","include_members","manager","exclude_manager","active" FROM "sys_user_group" WHERE "sys_id" = ?`,
      [groupId],
    );
    if (!g) return;
    const label = g.name || groupId;
    if (g.active === 0) {
      excluded.push({ who: label, userId: null, address: null, reason: 'Group is inactive' });
      return;
    }
    const email = (g.email ?? '').trim();
    for (const a of parseAddressList(email))
      addAddress(a.address, `${reason} (email of group ${label})`, a.name || label);
    if (!email || g.include_members === 1 || spec.isApproval) {
      const members = db.all<{ user: string }>(
        `SELECT "user" FROM "sys_user_grmember" WHERE "group" = ? ORDER BY rowid`,
        [groupId],
      );
      for (const m of members) addUser(m.user, `${reason} (member of ${label})`);
      if (g.manager && g.exclude_manager !== 1) addUser(g.manager, `${reason} (manager of ${label})`);
    }
  };

  const addToken = (raw: string, reason: string) => {
    const token = raw.trim();
    if (!token) return;
    if (SYS_ID_RE.test(token)) {
      if (userExists(token)) addUser(token, reason);
      else if (groupExists(token)) expandGroup(token, reason);
      return;
    }
    if (token.includes('@')) {
      for (const a of parseAddressList(token)) addAddress(a.address, reason, a.name);
      return;
    }
    if (hasUsers) {
      const u = db.get<{ sys_id: string }>(
        `SELECT "sys_id" FROM "sys_user" WHERE "user_name" = ? COLLATE NOCASE`,
        [token],
      );
      if (u) addUser(u.sys_id, reason);
    }
  };

  for (const u of spec.users ?? []) addToken(u, 'Listed as a recipient');
  for (const g of spec.groups ?? []) expandGroup(g.trim(), 'Listed group');

  if (rec) {
    for (const rawPath of spec.fields ?? []) {
      const path = rawPath.trim();
      if (!path) continue;
      const { target, col, field } = resolvePath(rec, path);
      if (!target || !col) continue;
      const value = target.get(field);
      if (value === null || value === undefined || value === '') continue;
      const reason = `Field ${path}`;
      const refMeta = col.reference ? registry.tryTable(col.reference) : undefined;
      if (col.type === 'reference' && refMeta) {
        if (refMeta.ancestors.includes('sys_user')) addUser(String(value), reason);
        else if (refMeta.ancestors.includes('sys_user_group')) expandGroup(String(value), reason);
        continue;
      }
      for (const token of String(value).split(',')) addToken(token, reason);
    }
  }

  for (const t of spec.tokens ?? []) for (const v of t.values) addToken(v, t.source);

  if (spec.subscribable && spec.notificationId && registry.has('cmn_notif_message')) {
    const subs = db.all<{ user: string }>(
      `SELECT "user" FROM "cmn_notif_message" WHERE "notification" = ? AND "active" = 1 ORDER BY rowid`,
      [spec.notificationId],
    );
    for (const s of subs) addUser(s.user, 'Subscribed to this notification');
  }

  if (!spec.excludeDelegates && registry.has('sys_user_delegate')) {
    const now = nowGlide();
    for (const cand of [...candidates]) {
      if (cand.kind !== 'user' || !cand.userId) continue;
      const rows = db.all<{ delegate: string }>(
        `SELECT "delegate" FROM "sys_user_delegate" WHERE "user" = ? AND ("notifications" IS NULL OR "notifications" = 1)
           AND ("starts" IS NULL OR "starts" = '' OR "starts" <= ?) AND ("ends" IS NULL OR "ends" = '' OR "ends" > ?)`,
        [cand.userId, now, now],
      );
      for (const r of rows)
        if (r.delegate && r.delegate !== cand.userId)
          addUser(r.delegate, `Notification delegate of ${userLabel(ctx, cand.userId)}`);
    }
  }

  return filterCandidates(ctx, spec, rec, candidates, excluded);
}

function userLabel(ctx: Context, id: string): string {
  const row = ctx.platform.db.get<{ name: string | null; user_name: string | null }>(
    `SELECT "name","user_name" FROM "sys_user" WHERE "sys_id" = ?`,
    [id],
  );
  return row?.name || row?.user_name || id;
}

function filterCandidates(
  ctx: Context,
  spec: RecipientSpec,
  rec: Rec | null,
  candidates: Candidate[],
  excluded: Exclusion[],
): RecipientResult {
  const platform = ctx.platform;
  const db = platform.db;
  const registry = platform.registry;
  const ids = candidates.filter((c) => c.kind === 'user' && c.userId).map((c) => c.userId!);
  const users = new Map<string, UserRow>();
  const devices = new Map<string, string>();
  const subs = new Map<string, { active: number | null; filter_condition: string | null }>();
  for (const part of chunk(ids, 400)) {
    const marks = part.map(() => '?').join(',');
    if (registry.has('sys_user')) {
      for (const u of db.all<UserRow>(
        `SELECT "sys_id","user_name","name","email","active","notification" FROM "sys_user" WHERE "sys_id" IN (${marks})`,
        part,
      ))
        users.set(u.sys_id, u);
    }
    if (registry.has('cmn_notif_device')) {
      for (const d of db.all<{ user: string; email_address: string | null }>(
        `SELECT "user","email_address" FROM "cmn_notif_device" WHERE "user" IN (${marks}) AND "type" = 'Email' AND "primary_email" = 1 AND ("active" IS NULL OR "active" = 1) ORDER BY "order", rowid`,
        part,
      )) {
        if (d.email_address && !devices.has(d.user)) devices.set(d.user, d.email_address.trim());
      }
    }
    if (spec.notificationId && registry.has('cmn_notif_message')) {
      for (const s of db.all<{ user: string; active: number | null; filter_condition: string | null }>(
        `SELECT "user","active","filter_condition" FROM "cmn_notif_message" WHERE "notification" = ? AND "user" IN (${marks})`,
        [spec.notificationId, ...part],
      ))
        subs.set(s.user, s);
    }
  }

  const instance = new Set((spec.instanceAddresses ?? []).map((a) => a.toLowerCase()));
  const sendSelf = spec.sendSelf !== false;
  const prefs = spec.applyPreferences !== false;
  const included: Recipient[] = [];
  const taken = new Set<string>();

  for (const c of candidates) {
    if (c.kind === 'address') {
      const address = c.address ?? '';
      if (!isEmail(address)) {
        excluded.push({ who: address, userId: null, address, reason: 'Not a valid email address' });
        continue;
      }
      if (instance.has(address.toLowerCase())) {
        excluded.push({ who: address, userId: null, address, reason: 'Sending address of this instance' });
        continue;
      }
      if (taken.has(address.toLowerCase())) continue;
      taken.add(address.toLowerCase());
      included.push({ address, userId: null, name: c.name ?? '', reason: c.reason });
      continue;
    }
    const id = c.userId!;
    const u = users.get(id);
    if (!u) {
      excluded.push({ who: id, userId: id, address: null, reason: 'User not found' });
      continue;
    }
    const who = u.name || u.user_name || id;
    if (u.active === 0) {
      excluded.push({ who, userId: id, address: null, reason: 'User is inactive' });
      continue;
    }
    const address = devices.get(id) || (u.email ?? '').trim();
    if (!address || !isEmail(address)) {
      excluded.push({ who, userId: id, address: null, reason: 'No email address' });
      continue;
    }
    if (!sendSelf && spec.actorId && id === spec.actorId) {
      excluded.push({
        who,
        userId: id,
        address,
        reason: 'Triggered the notification and "Send to event creator" is off',
      });
      continue;
    }
    if (prefs) {
      const sub = subs.get(id);
      if (sub && sub.active === 0 && !spec.mandatory && !spec.forceDelivery) {
        excluded.push({ who, userId: id, address, reason: 'Unsubscribed from this notification' });
        continue;
      }
      if (
        sub?.filter_condition &&
        rec &&
        !matches(sub.filter_condition, recSubject(rec, null, registry), ctx.env)
      ) {
        excluded.push({ who, userId: id, address, reason: 'Record does not match the subscription filter' });
        continue;
      }
      if (Number(u.notification) === 1 && !spec.forceDelivery) {
        excluded.push({
          who,
          userId: id,
          address,
          reason: 'Email notifications are turned off for this user',
        });
        continue;
      }
    }
    if (instance.has(address.toLowerCase())) {
      excluded.push({ who, userId: id, address, reason: 'Sending address of this instance' });
      continue;
    }
    if (taken.has(address.toLowerCase())) continue;
    taken.add(address.toLowerCase());
    included.push({ address, userId: id, name: who, reason: c.reason });
  }
  return { included, excluded };
}
