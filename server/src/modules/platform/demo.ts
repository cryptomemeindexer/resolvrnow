import type { Context } from '../../engine/context.js';

/**
 * Shared demo organization ("Northwind Labs", fictional). Every module's demo data
 * refers to these users and groups by user_name / name.
 */
export const DEMO_PASSWORD = 'demo1234';

export const DEMO_DEPARTMENTS = ['IT', 'Finance', 'Human Resources', 'Sales', 'Marketing', 'Engineering', 'Operations', 'Legal'];

export const DEMO_LOCATIONS = [
  { name: 'Austin HQ', city: 'Austin', country: 'USA', time_zone: 'America/Chicago' },
  { name: 'London Office', city: 'London', country: 'United Kingdom', time_zone: 'Europe/London' },
  { name: 'Dubai Office', city: 'Dubai', country: 'United Arab Emirates', time_zone: 'Asia/Dubai' },
  { name: 'Singapore Office', city: 'Singapore', country: 'Singapore', time_zone: 'Asia/Singapore' },
  { name: 'Remote', city: '', country: '', time_zone: 'UTC' },
];

export const DEMO_GROUPS: { name: string; description: string; manager?: string; roles?: string[] }[] = [
  { name: 'Service Desk', description: 'First line support for all employees', manager: 'priya.nair', roles: ['itil'] },
  { name: 'Network Operations', description: 'LAN, WAN, VPN, Wi-Fi and firewalls', manager: 'marcus.chen', roles: ['itil'] },
  { name: 'Database Administration', description: 'Database platforms and backups', manager: 'sofia.alvarez', roles: ['itil'] },
  { name: 'Hardware Support', description: 'Laptops, desktops, printers and peripherals', manager: 'jamal.wright', roles: ['itil'] },
  { name: 'Software Support', description: 'Business applications and licensing', manager: 'elena.petrova', roles: ['itil'] },
  { name: 'Cloud Operations', description: 'Cloud infrastructure and platform services', manager: 'david.kim', roles: ['itil'] },
  { name: 'Information Security', description: 'Security operations and identity', manager: 'fatima.alsayed', roles: ['itil'] },
  { name: 'Application Development', description: 'Internal applications and integrations', manager: 'tom.becker', roles: ['itil'] },
  { name: 'Change Advisory Board', description: 'Reviews and authorizes changes', manager: 'grace.okafor', roles: ['itil'] },
  { name: 'Problem Management', description: 'Root cause analysis and known errors', manager: 'ravi.menon', roles: ['itil'] },
];

export interface DemoUser {
  user_name: string;
  first_name: string;
  last_name: string;
  title: string;
  department: string;
  location: string;
  roles?: string[];
  groups?: string[];
  vip?: boolean;
  manager?: string;
}

export const DEMO_USERS: DemoUser[] = [
  // IT staff
  { user_name: 'priya.nair', first_name: 'Priya', last_name: 'Nair', title: 'Service Desk Manager', department: 'IT', location: 'Austin HQ', roles: ['itil', 'incident_manager', 'major_incident_manager', 'approver_user'], groups: ['Service Desk'] },
  { user_name: 'alex.rivera', first_name: 'Alex', last_name: 'Rivera', title: 'Service Desk Analyst', department: 'IT', location: 'Austin HQ', groups: ['Service Desk'], manager: 'priya.nair' },
  { user_name: 'noor.haddad', first_name: 'Noor', last_name: 'Haddad', title: 'Service Desk Analyst', department: 'IT', location: 'Dubai Office', groups: ['Service Desk'], manager: 'priya.nair' },
  { user_name: 'marcus.chen', first_name: 'Marcus', last_name: 'Chen', title: 'Network Engineer', department: 'IT', location: 'Austin HQ', roles: ['approver_user'], groups: ['Network Operations'] },
  { user_name: 'sofia.alvarez', first_name: 'Sofia', last_name: 'Alvarez', title: 'Database Administrator', department: 'IT', location: 'London Office', roles: ['approver_user'], groups: ['Database Administration'] },
  { user_name: 'jamal.wright', first_name: 'Jamal', last_name: 'Wright', title: 'Desktop Support Lead', department: 'IT', location: 'Austin HQ', roles: ['approver_user', 'asset'], groups: ['Hardware Support'] },
  { user_name: 'elena.petrova', first_name: 'Elena', last_name: 'Petrova', title: 'Application Support Engineer', department: 'IT', location: 'London Office', roles: ['approver_user'], groups: ['Software Support'] },
  { user_name: 'david.kim', first_name: 'David', last_name: 'Kim', title: 'Cloud Engineer', department: 'IT', location: 'Singapore Office', roles: ['approver_user'], groups: ['Cloud Operations'] },
  { user_name: 'fatima.alsayed', first_name: 'Fatima', last_name: 'Al Sayed', title: 'Security Analyst', department: 'IT', location: 'Dubai Office', roles: ['approver_user'], groups: ['Information Security'] },
  { user_name: 'tom.becker', first_name: 'Tom', last_name: 'Becker', title: 'Software Engineer', department: 'Engineering', location: 'London Office', roles: ['approver_user'], groups: ['Application Development'] },
  { user_name: 'grace.okafor', first_name: 'Grace', last_name: 'Okafor', title: 'Change Manager', department: 'IT', location: 'Austin HQ', roles: ['change_manager', 'approver_user'], groups: ['Change Advisory Board'] },
  { user_name: 'ravi.menon', first_name: 'Ravi', last_name: 'Menon', title: 'Problem Manager', department: 'IT', location: 'Singapore Office', roles: ['problem_manager'], groups: ['Problem Management', 'Service Desk'] },
  { user_name: 'hannah.lee', first_name: 'Hannah', last_name: 'Lee', title: 'Knowledge Manager', department: 'IT', location: 'Austin HQ', roles: ['knowledge_manager', 'knowledge_admin'], groups: ['Service Desk'] },
  { user_name: 'lucas.moreau', first_name: 'Lucas', last_name: 'Moreau', title: 'IT Asset Manager', department: 'IT', location: 'London Office', roles: ['asset', 'catalog_admin'], groups: ['Hardware Support'] },
  { user_name: 'maya.cohen', first_name: 'Maya', last_name: 'Cohen', title: 'IT Director', department: 'IT', location: 'Austin HQ', roles: ['approver_user', 'report_admin'], groups: ['Change Advisory Board'] },
  // Employees (end users)
  { user_name: 'olivia.martin', first_name: 'Olivia', last_name: 'Martin', title: 'Account Executive', department: 'Sales', location: 'Austin HQ', manager: 'charlotte.taylor' },
  { user_name: 'noah.johnson', first_name: 'Noah', last_name: 'Johnson', title: 'Financial Analyst', department: 'Finance', location: 'London Office', manager: 'henry.anderson' },
  { user_name: 'emma.williams', first_name: 'Emma', last_name: 'Williams', title: 'HR Business Partner', department: 'Human Resources', location: 'Austin HQ' },
  { user_name: 'liam.brown', first_name: 'Liam', last_name: 'Brown', title: 'Marketing Specialist', department: 'Marketing', location: 'Remote' },
  { user_name: 'ava.jones', first_name: 'Ava', last_name: 'Jones', title: 'Operations Coordinator', department: 'Operations', location: 'Singapore Office' },
  { user_name: 'ethan.garcia', first_name: 'Ethan', last_name: 'Garcia', title: 'Sales Engineer', department: 'Sales', location: 'Dubai Office', manager: 'charlotte.taylor' },
  { user_name: 'mia.miller', first_name: 'Mia', last_name: 'Miller', title: 'Legal Counsel', department: 'Legal', location: 'London Office' },
  { user_name: 'james.davis', first_name: 'James', last_name: 'Davis', title: 'Backend Engineer', department: 'Engineering', location: 'Remote', manager: 'tom.becker' },
  { user_name: 'layla.hassan', first_name: 'Layla', last_name: 'Hassan', title: 'Product Designer', department: 'Engineering', location: 'Dubai Office' },
  { user_name: 'charlotte.taylor', first_name: 'Charlotte', last_name: 'Taylor', title: 'VP of Sales', department: 'Sales', location: 'Austin HQ', vip: true },
  { user_name: 'henry.anderson', first_name: 'Henry', last_name: 'Anderson', title: 'Chief Financial Officer', department: 'Finance', location: 'Austin HQ', vip: true },
];

/** Creates the demo organization; idempotent. */
export function seedDemoOrganization(ctx: Context): void {
  const company =
    ctx.first('core_company', 'name=Northwind Labs') ??
    ctx.insert('core_company', { name: 'Northwind Labs', primary: true, city: 'Austin', country: 'USA', website: 'https://northwind.example' });
  for (const m of ['Dell', 'Lenovo', 'Apple', 'Cisco', 'Microsoft', 'HP', 'Oracle', 'Amazon Web Services']) {
    if (!ctx.first('core_company', `name=${m}`)) ctx.insert('core_company', { name: m, manufacturer: true, vendor: true });
  }
  const dept = new Map<string, string>();
  for (const d of DEMO_DEPARTMENTS) {
    const rec = ctx.first('cmn_department', `name=${d}`) ?? ctx.insert('cmn_department', { name: d, company: company.sysId });
    dept.set(d, rec.sysId);
  }
  const loc = new Map<string, string>();
  for (const l of DEMO_LOCATIONS) {
    const rec = ctx.first('cmn_location', `name=${l.name}`) ?? ctx.insert('cmn_location', { ...l, company: company.sysId });
    loc.set(l.name, rec.sysId);
  }
  const users = new Map<string, string>();
  for (const u of DEMO_USERS) {
    const existing = ctx.first('sys_user', `user_name=${u.user_name}`);
    const rec =
      existing ??
      ctx.insert('sys_user', {
        user_name: u.user_name,
        first_name: u.first_name,
        last_name: u.last_name,
        title: u.title,
        email: `${u.user_name}@northwind.example`,
        department: dept.get(u.department),
        location: loc.get(u.location),
        company: company.sysId,
        vip: !!u.vip,
        user_password: DEMO_PASSWORD,
        time_zone: DEMO_LOCATIONS.find((l) => l.name === u.location)?.time_zone ?? 'UTC',
        active: true,
      });
    users.set(u.user_name, rec.sysId);
  }
  for (const u of DEMO_USERS) {
    if (u.manager && users.has(u.manager)) ctx.update(ctx.get('sys_user', users.get(u.user_name)!)!, { manager: users.get(u.manager) });
  }
  const roleId = (name: string) => (ctx.getBy('sys_user_role', 'name', name) ?? ctx.insert('sys_user_role', { name })).sysId;
  for (const g of DEMO_GROUPS) {
    const group =
      ctx.first('sys_user_group', `name=${g.name}`) ??
      ctx.insert('sys_user_group', { name: g.name, description: g.description, manager: g.manager ? users.get(g.manager) : null, email: `${g.name.toLowerCase().replace(/[^a-z]+/g, '-')}@northwind.example` });
    for (const r of g.roles ?? []) {
      const rid = roleId(r);
      if (!ctx.first('sys_group_has_role', `group=${group.sysId}^role=${rid}`)) ctx.insert('sys_group_has_role', { group: group.sysId, role: rid });
    }
  }
  for (const u of DEMO_USERS) {
    for (const g of u.groups ?? []) {
      const group = ctx.first('sys_user_group', `name=${g}`)!;
      const uid = users.get(u.user_name)!;
      if (!ctx.first('sys_user_grmember', `user=${uid}^group=${group.sysId}`)) ctx.insert('sys_user_grmember', { user: uid, group: group.sysId });
    }
    for (const r of u.roles ?? []) {
      const uid = users.get(u.user_name)!;
      const rid = roleId(r);
      if (!ctx.first('sys_user_has_role', `user=${uid}^role=${rid}`)) ctx.insert('sys_user_has_role', { user: uid, role: rid });
    }
  }
  ctx.platform.users.invalidate();
}
