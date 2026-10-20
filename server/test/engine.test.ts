import { afterEach, describe, expect, it } from 'vitest';
import { AccessError, AbortError } from '../src/engine/errors.js';
import type { Platform } from '../src/engine/platform.js';
import { clock } from '../src/engine/util.js';
import { bootPlatform, makeUser } from './helpers.js';

let p: Platform;
afterEach(() => {
  p?.close();
  clock.reset();
});

describe('platform boot', () => {
  it('creates admin, roles and mirrors the dictionary', () => {
    p = bootPlatform();
    const ctx = p.systemContext();
    expect(ctx.first('sys_user', 'user_name=admin')).not.toBeNull();
    expect(ctx.getBy('sys_user_role', 'name', 'itil')).not.toBeNull();
    expect(ctx.count('sys_db_object', 'name=task')).toBe(1);
    expect(ctx.count('sys_dictionary', 'name=task^element=short_description')).toBe(1);
    expect(ctx.count('sys_choice', 'name=task^element=priority')).toBe(5);
    const admin = p.authenticate('admin', 'admin-test-pw');
    expect(admin?.isAdmin).toBe(true);
    expect(p.authenticate('admin', 'wrong')).toBeNull();
  });

  it('is idempotent across boots of the same database file', () => {
    p = bootPlatform();
    const n = p.systemContext().count('sys_user_role');
    // A second boot on the same in-memory DB is not possible, so re-run metadata sync explicitly.
    p.modules.find((m) => m.id === 'platform')!.afterBoot!(p);
    expect(p.systemContext().count('sys_user_role')).toBe(n);
  });
});

describe('records', () => {
  it('numbers, defaults and audits inserts', () => {
    p = bootPlatform();
    const ctx = p.systemContext();
    const t = ctx.insert('task', { short_description: 'Printer on fire', impact: 1, urgency: 1 });
    expect(t.str('number')).toMatch(/^TASK\d{7}$/);
    expect(t.str('state')).toBe('1');
    expect(t.bool('active')).toBe(true);
    expect(t.str('opened_at')).not.toBe('');
    const audits = ctx.count('sys_audit', `documentkey=${t.sysId}`);
    expect(audits).toBe(1);
    expect(p.history.audit("task", t.sysId).length).toBeGreaterThan(3);
    const t2 = ctx.insert('task', { short_description: 'Second' });
    const n1 = Number(t.str('number').slice(4));
    const n2 = Number(t2.str('number').slice(4));
    expect(n2).toBe(n1 + 1);
  });

  it('maintains active flag and closed time from the state model', () => {
    p = bootPlatform();
    const ctx = p.systemContext();
    const t = ctx.insert('task', { short_description: 'Close me' });
    ctx.update(t, { state: '3' });
    const reloaded = ctx.get('task', t.sysId)!;
    expect(reloaded.bool('active')).toBe(false);
    expect(reloaded.str('closed_at')).not.toBe('');
    ctx.update(reloaded, { state: '2' });
    const reopened = ctx.get('task', t.sysId)!;
    expect(reopened.bool('active')).toBe(true);
    expect(reopened.str('closed_at')).toBe('');
  });

  it('records journal entries and field audit on update', () => {
    p = bootPlatform();
    const ctx = p.systemContext();
    const t = ctx.insert('task', { short_description: 'Journal', comments: 'First comment' });
    ctx.update(t, { work_notes: 'Internal note', short_description: 'Journal updated' });
    const journal = p.history.journal('task', t.sysId);
    expect(journal.map((j) => j.element).sort()).toEqual(['comments', 'work_notes']);
    const audit = p.history.audit('task', t.sysId).filter((a) => a.fieldname === 'short_description');
    expect(audit[0]).toMatchObject({ oldvalue: 'Journal', newvalue: 'Journal updated' });
    expect(ctx.get('task', t.sysId)!.num('sys_mod_count')).toBe(1);
  });

  it('counts reassignments only when an existing group changes', () => {
    p = bootPlatform();
    const ctx = p.systemContext();
    const g1 = ctx.insert('sys_user_group', { name: 'Network' });
    const g2 = ctx.insert('sys_user_group', { name: 'Database' });
    const t = ctx.insert('task', { short_description: 'x', assignment_group: g1.sysId });
    ctx.update(t, { assignment_group: g2.sysId });
    expect(ctx.get('task', t.sysId)!.num('reassignment_count')).toBe(1);
  });

  it('resolves reference display values and choice labels on input', () => {
    p = bootPlatform();
    const ctx = p.systemContext();
    ctx.insert('sys_user_group', { name: 'Service Desk' });
    const t = ctx.insert('task', { short_description: 'x', assignment_group: 'Service Desk', priority: '2 - High' });
    expect(t.display('assignment_group')).toBe('Service Desk');
    expect(t.str('priority')).toBe('2');
    expect(t.display('priority')).toBe('2 - High');
  });

  it('aborts on business rule abort', () => {
    p = bootPlatform();
    const ctx = p.systemContext();
    ctx.insert('sys_user', { user_name: 'dup.user' });
    expect(() => ctx.insert('sys_user', { user_name: 'DUP.user' })).toThrow(AbortError);
  });

  it('hashes passwords and derives names', () => {
    p = bootPlatform();
    const ctx = p.systemContext();
    const u = ctx.insert('sys_user', { user_name: 'jane.doe', first_name: 'Jane', last_name: 'Doe', user_password: 's3cret!!' });
    expect(u.str('name')).toBe('Jane Doe');
    expect(u.str('user_password')).toMatch(/^scrypt\$/);
    expect(p.authenticate('jane.doe', 's3cret!!')?.name).toBe('Jane Doe');
  });
});

describe('queries', () => {
  it('supports encoded queries with dot-walking, OR, NQ and ordering', () => {
    p = bootPlatform();
    const ctx = p.systemContext();
    const dept = ctx.insert('cmn_department', { name: 'Finance' });
    const u = ctx.insert('sys_user', { user_name: 'fin.user', first_name: 'Fin', last_name: 'User', department: dept.sysId });
    ctx.insert('task', { short_description: 'A', priority: 1, opened_by: u.sysId });
    ctx.insert('task', { short_description: 'B', priority: 3 });
    ctx.insert('task', { short_description: 'C printer', priority: 5 });
    expect(ctx.query('task', 'opened_by.department.name=Finance').map((r) => r.str('short_description'))).toEqual(['A']);
    expect(ctx.query('task', 'priority=1^ORpriority=5^ORDERBYDESCpriority').map((r) => r.str('short_description'))).toEqual([
      'C printer',
      'A',
    ]);
    expect(ctx.count('task', 'short_descriptionLIKEPRINTER')).toBe(1);
    expect(ctx.count('task', 'priority<=3')).toBe(2);
    expect(ctx.count('task', 'priorityIN1,3')).toBe(2);
    expect(ctx.count('task', 'priority=5^NQpriority=1')).toBe(2);
    expect(ctx.count('task', 'opened_by.user_name=fin.user')).toBe(1);
    expect(ctx.count('task', 'opened_by=Fin User')).toBe(1);
    expect(ctx.count('task', 'bogus_field=1^priority=1')).toBe(1);
    expect(ctx.count('task', '123TEXTQUERY321=printer')).toBe(1);
    expect(ctx.count('task', 'sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()')).toBe(3);
    expect(ctx.count('task', 'sys_created_on<javascript:gs.daysAgoStart(1)')).toBe(0);
  });

  it('supports DYNAMIC Me and one-of-my-groups filters', () => {
    p = bootPlatform();
    const agent = makeUser(p, 'agent.one', ['itil'], ['Network']);
    const sys = p.systemContext();
    const group = sys.getBy('sys_user_group', 'name', 'Network')!;
    sys.insert('task', { short_description: 'mine', assigned_to: agent });
    sys.insert('task', { short_description: 'group', assignment_group: group.sysId });
    sys.insert('task', { short_description: 'other' });
    const ctx = p.contextAs('agent.one');
    expect(ctx.count('task', 'assigned_toDYNAMIC90d1921e5f510100a9ad2572f2b477fe')).toBe(1);
    expect(ctx.count('task', 'assignment_groupDYNAMICd6435e965f510100a9ad2572f2b47744')).toBe(1);
  });
});

describe('access control', () => {
  it('lets itil users work tasks and restricts plain users to their own', () => {
    p = bootPlatform();
    makeUser(p, 'agent.two', ['itil']);
    const requesterId = makeUser(p, 'end.user', []);
    const sys = p.systemContext();
    sys.insert('task', { short_description: 'theirs', opened_by: requesterId });
    sys.insert('task', { short_description: 'someone else' });
    const agent = p.contextAs('agent.two');
    expect(agent.query('task').length).toBe(2);
    const enduser = p.contextAs('end.user');
    expect(enduser.query('task').map((r) => r.str('short_description'))).toEqual(['theirs']);
    expect(() => enduser.insert('task', { short_description: 'nope' })).toThrow(AccessError);
  });

  it('never exposes password hashes through field ACLs', () => {
    p = bootPlatform();
    makeUser(p, 'agent.three', ['itil']);
    const ctx = p.contextAs('agent.three');
    expect(p.acl.canField(ctx, 'sys_user', 'user_password', 'read')).toBe(false);
    expect(p.acl.canField(ctx, 'sys_user', 'email', 'read')).toBe(true);
    const admin = p.contextAs('admin');
    expect(p.acl.canField(admin, 'sys_user', 'user_password', 'read')).toBe(false);
  });
});

describe('demo organization', () => {
  it('seeds users, groups and roles that can sign in', () => {
    p = bootPlatform([], { demo: true });
    const ctx = p.systemContext();
    expect(ctx.count('sys_user', 'emailENDSWITH@northwind.example')).toBeGreaterThan(20);
    const priya = p.authenticate('priya.nair', 'demo1234');
    expect(priya?.roles.has('itil')).toBe(true);
    expect(priya?.roles.has('major_incident_manager')).toBe(true);
    const alex = p.users.byUserName('alex.rivera');
    expect(alex?.roles.has('itil')).toBe(true); // via Service Desk group role
    expect(p.users.byUserName('olivia.martin')?.roles.has('itil')).toBe(false);
  });
});
