/**
 * Northwind Labs CMDB: three business services (Customer Portal, Payroll, Email) with
 * web/app/database tiers, shared directory and network infrastructure, storage,
 * virtualization and employee laptops. Relationships are wired so that impact analysis
 * from any infrastructure CI reaches the business services above it.
 */
import type { Context } from '../../engine/context.js';
import { addMs, nowGlide } from '../../engine/util.js';
import { upsertRelation } from './ire.js';
import { REL, relTypeId } from './seed.js';

const DAY = 86_400_000;

interface Lookup {
  company: string | null;
  user(userName: string): { id: string | null; location: string | null; department: string | null };
  group(name: string): string | null;
  location(name: string): string | null;
  vendor(name: string): string | null;
}

function lookups(ctx: Context): Lookup {
  const id = (table: string, query: string) => ctx.first(table, query)?.sysId ?? null;
  return {
    company: id('core_company', 'name=Northwind Labs'),
    user(userName) {
      const u = ctx.first('sys_user', `user_name=${userName}`);
      return {
        id: u?.sysId ?? null,
        location: u?.str('location') || null,
        department: u?.str('department') || null,
      };
    },
    group: (name) => id('sys_user_group', `name=${name}`),
    location: (name) => id('cmn_location', `name=${name}`),
    vendor: (name) => id('core_company', `name=${name}`),
  };
}

/** Hardware models used by the demo estate: [name, manufacturer, model number]. */
export const DEMO_MODELS: [string, string, string][] = [
  ['Latitude 7440', 'Dell', 'LAT-7440'],
  ['ThinkPad X1 Carbon Gen 11', 'Lenovo', '21HM'],
  ['MacBook Pro 14 (M3)', 'Apple', 'MRX33'],
  ['PowerEdge R650', 'Dell', 'R650'],
  ['ProLiant DL380 Gen10', 'HP', 'P20174'],
  ['Catalyst 9300-48P', 'Cisco', 'C9300-48P'],
  ['ISR 4451', 'Cisco', 'ISR4451-X'],
  ['Firepower 2130', 'Cisco', 'FPR2130'],
  ['Catalyst 9120 Access Point', 'Cisco', 'C9120AXI'],
  ['PowerStore 1200T', 'Dell', 'PS1200T'],
];

class Builder {
  readonly ids = new Map<string, string>();
  private serial = 4100;

  constructor(
    private ctx: Context,
    private l: Lookup,
  ) {}

  model(name: string): string | null {
    return this.ids.get(`model:${name}`) ?? null;
  }

  models(): void {
    for (const [name, maker, number] of DEMO_MODELS) {
      const existing = this.ctx.first('cmdb_model', `name=${name}`);
      const rec =
        existing ??
        this.ctx.insert('cmdb_hardware_product_model', {
          name,
          manufacturer: this.l.vendor(maker),
          model_number: number,
          status: 'In Production',
        });
      this.ids.set(`model:${name}`, rec.sysId);
    }
  }

  ci(cls: string, name: string, values: Record<string, unknown> = {}): string {
    const rec = this.ctx.insert(cls, { name, company: this.l.company, ...values });
    this.ids.set(name, rec.sysId);
    return rec.sysId;
  }

  /** Physical device defaults: serial number, model, discovery provenance and purchase data. */
  hw(model: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const purchased = addMs(nowGlide(), -420 * DAY).slice(0, 10);
    return {
      model_id: this.model(model),
      serial_number: `NWL${String(++this.serial).padStart(6, '0')}`,
      discovery_source: 'ServiceNow',
      first_discovered: addMs(nowGlide(), -400 * DAY),
      last_discovered: addMs(nowGlide(), -1 * DAY),
      purchase_date: purchased,
      warranty_expiration: addMs(nowGlide(), 680 * DAY).slice(0, 10),
      po_number: `PO-${2024000 + this.serial}`,
      ...extra,
    };
  }

  rel(parent: string, type: string, child: string): void {
    const typeId = relTypeId(this.ctx, type);
    const p = this.ids.get(parent);
    const c = this.ids.get(child);
    if (typeId && p && c) upsertRelation(this.ctx, p, c, typeId);
  }

  member(service: string, cis: string[]): void {
    const s = this.ids.get(service);
    for (const name of cis) {
      const ci = this.ids.get(name);
      if (s && ci && !this.ctx.first('svc_ci_assoc', `service_id=${s}^ci_id=${ci}`))
        this.ctx.insert('svc_ci_assoc', { service_id: s, ci_id: ci });
    }
  }
}

function network(b: Builder, l: Lookup): void {
  const austin = l.location('Austin HQ');
  const london = l.location('London Office');
  const net = {
    support_group: l.group('Network Operations'),
    managed_by: l.user('marcus.chen').id,
    location: austin,
  };
  b.ci(
    'cmdb_ci_ip_firewall',
    'aus-fw-01',
    b.hw('Firepower 2130', {
      ...net,
      ip_address: '10.0.0.1',
      firmware_version: '7.4.1',
      can_route: true,
      short_description: 'Perimeter firewall, Austin datacenter',
    }),
  );
  b.ci(
    'cmdb_ci_ip_router',
    'aus-rtr-01',
    b.hw('ISR 4451', {
      ...net,
      ip_address: '10.0.0.2',
      firmware_version: '17.9.4',
      can_route: true,
      short_description: 'WAN edge router',
    }),
  );
  b.ci(
    'cmdb_ci_ip_switch',
    'aus-sw-core-01',
    b.hw('Catalyst 9300-48P', {
      ...net,
      ip_address: '10.0.0.3',
      ports: 48,
      can_switch: true,
      can_route: true,
      short_description: 'Datacenter core switch',
    }),
  );
  b.ci(
    'cmdb_ci_ip_switch',
    'aus-sw-acc-01',
    b.hw('Catalyst 9300-48P', {
      ...net,
      ip_address: '10.0.0.4',
      ports: 48,
      can_switch: true,
      short_description: 'Office floor access switch',
    }),
  );
  b.ci(
    'cmdb_ci_ip_switch',
    'lon-sw-01',
    b.hw('Catalyst 9300-48P', {
      ...net,
      location: london,
      ip_address: '10.20.0.3',
      ports: 48,
      can_switch: true,
      short_description: 'London office switch',
    }),
  );
  b.ci(
    'cmdb_ci_wap_network',
    'aus-wap-01',
    b.hw('Catalyst 9120 Access Point', {
      ...net,
      ip_address: '10.0.1.10',
      short_description: 'Austin office Wi-Fi, floor 2',
    }),
  );
  b.ci(
    'cmdb_ci_wap_network',
    'lon-wap-01',
    b.hw('Catalyst 9120 Access Point', {
      ...net,
      location: london,
      ip_address: '10.20.1.10',
      short_description: 'London office Wi-Fi',
    }),
  );
  b.rel('aus-sw-core-01', REL.CONNECTS_TO, 'aus-rtr-01');
  b.rel('aus-rtr-01', REL.CONNECTS_TO, 'aus-fw-01');
  b.rel('aus-sw-acc-01', REL.CONNECTS_TO, 'aus-sw-core-01');
  b.rel('aus-wap-01', REL.CONNECTS_TO, 'aus-sw-acc-01');
  b.rel('lon-sw-01', REL.CONNECTS_TO, 'aus-rtr-01');
  b.rel('lon-wap-01', REL.CONNECTS_TO, 'lon-sw-01');
}

const linux = (version = '22.04 LTS') => ({
  os: 'Ubuntu Linux',
  os_version: version,
  kernel_release: '5.15.0-91-generic',
  os_address_width: 64,
});
const windows = { os: 'Windows Server', os_version: '2022 Datacenter', os_address_width: 64 };

function servers(b: Builder, l: Lookup): void {
  const austin = l.location('Austin HQ');
  const infra = {
    location: austin,
    classification: 'Production',
    used_for: 'Production',
    cpu_count: 2,
    cpu_core_count: 16,
    cpu_name: 'Intel Xeon Silver 4314',
  };
  const cloud = { ...infra, support_group: l.group('Cloud Operations'), managed_by: l.user('david.kim').id };
  const dba = {
    ...infra,
    support_group: l.group('Database Administration'),
    managed_by: l.user('sofia.alvarez').id,
  };
  const apps = {
    ...infra,
    support_group: l.group('Application Development'),
    managed_by: l.user('tom.becker').id,
  };
  const sw = { ...infra, support_group: l.group('Software Support'), managed_by: l.user('elena.petrova').id };
  const server = (
    cls: string,
    name: string,
    ip: string,
    model: string,
    base: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    b.ci(
      cls,
      name,
      b.hw(model, {
        ...base,
        ip_address: ip,
        host_name: name,
        fqdn: `${name}.northwind.example`,
        ram: 65536,
        disk_space: 960,
        ...extra,
      }),
    );

  server('cmdb_ci_esx_server', 'aus-esx-01', '10.10.0.20', 'PowerEdge R650', cloud, {
    os: 'VMware ESXi',
    os_version: '8.0 U2',
    ram: 524288,
    cpu_core_count: 32,
  });
  b.ci('cmdb_ci_vmware_instance', 'vm-build-01', {
    support_group: l.group('Application Development'),
    cpus: 8,
    memory: 32768,
    state: 'on',
    short_description: 'Build agent for internal applications',
  });
  b.ci('cmdb_ci_vmware_instance', 'vm-monitor-01', {
    support_group: l.group('Cloud Operations'),
    cpus: 4,
    memory: 16384,
    state: 'on',
    short_description: 'Monitoring and log collection',
  });
  b.ci(
    'cmdb_ci_san',
    'aus-san-01',
    b.hw('PowerStore 1200T', {
      ...cloud,
      size_bytes: 120e12,
      ip_address: '10.10.0.30',
      short_description: 'Primary storage array',
    }),
  );

  server('cmdb_ci_lb', 'cp-lb-01', '10.10.1.5', 'PowerEdge R650', apps, {
    ...linux(),
    short_description: 'Customer Portal load balancer (HAProxy)',
    internet_facing: true,
    firewall_status: 'Internet',
  });
  server('cmdb_ci_linux_server', 'cp-web-01', '10.10.1.11', 'PowerEdge R650', apps, linux());
  server('cmdb_ci_linux_server', 'cp-web-02', '10.10.1.12', 'PowerEdge R650', apps, linux());
  server('cmdb_ci_linux_server', 'cp-app-01', '10.10.2.11', 'PowerEdge R650', apps, linux());
  server('cmdb_ci_linux_server', 'cp-app-02', '10.10.2.12', 'PowerEdge R650', apps, linux());
  server('cmdb_ci_linux_server', 'cp-db-01', '10.10.3.11', 'ProLiant DL380 Gen10', dba, {
    os: 'Red Hat Enterprise Linux',
    os_version: '9.3',
    kernel_release: '5.14.0-362.el9',
    ram: 262144,
  });

  server('cmdb_ci_win_server', 'pay-web-01', '10.10.4.11', 'PowerEdge R650', sw, windows);
  server('cmdb_ci_win_server', 'pay-app-01', '10.10.4.21', 'PowerEdge R650', sw, windows);
  server('cmdb_ci_win_server', 'pay-db-01', '10.10.4.31', 'ProLiant DL380 Gen10', dba, {
    ...windows,
    ram: 262144,
  });
  server('cmdb_ci_win_server', 'pay-db-02', '10.10.4.32', 'ProLiant DL380 Gen10', dba, {
    ...windows,
    ram: 262144,
    operational_status: 4,
    used_for: 'Disaster Recovery',
    classification: 'Disaster recovery',
  });
  b.ci('cmdb_ci_win_cluster', 'pay-sql-cluster', {
    support_group: l.group('Database Administration'),
    cluster_status: 'Online',
    short_description: 'Payroll SQL Server failover cluster',
  });

  server('cmdb_ci_linux_server', 'mail-gw-01', '10.10.5.11', 'PowerEdge R650', cloud, {
    ...linux('20.04 LTS'),
    internet_facing: true,
    firewall_status: 'Internet',
  });
  server('cmdb_ci_win_server', 'mail-01', '10.10.5.21', 'PowerEdge R650', cloud, windows);
  server(
    'cmdb_ci_win_server',
    'dc-01',
    '10.10.0.10',
    'PowerEdge R650',
    { ...infra, support_group: l.group('Information Security'), managed_by: l.user('fatima.alsayed').id },
    windows,
  );

  b.rel('aus-esx-01', REL.VIRTUALIZES, 'vm-build-01');
  b.rel('aus-esx-01', REL.VIRTUALIZES, 'vm-monitor-01');
  b.rel('pay-sql-cluster', REL.MEMBERS, 'pay-db-01');
  b.rel('pay-sql-cluster', REL.MEMBERS, 'pay-db-02');
  for (const s of ['cp-db-01', 'pay-db-01', 'pay-db-02', 'aus-esx-01'])
    b.rel(s, REL.DEPENDS_ON, 'aus-san-01');
  const all = [
    'aus-esx-01',
    'aus-san-01',
    'cp-lb-01',
    'cp-web-01',
    'cp-web-02',
    'cp-app-01',
    'cp-app-02',
    'cp-db-01',
    'pay-web-01',
    'pay-app-01',
    'pay-db-01',
    'pay-db-02',
    'mail-gw-01',
    'mail-01',
    'dc-01',
  ];
  for (const s of all) b.rel(s, REL.CONNECTS_TO, 'aus-sw-core-01');
}

function applications(b: Builder, l: Lookup): void {
  const apps = {
    support_group: l.group('Application Development'),
    managed_by: l.user('tom.becker').id,
    used_for: 'Production',
  };
  const dba = {
    support_group: l.group('Database Administration'),
    managed_by: l.user('sofia.alvarez').id,
    used_for: 'Production',
  };
  const sw = {
    support_group: l.group('Software Support'),
    managed_by: l.user('elena.petrova').id,
    used_for: 'Production',
  };
  const cloud = {
    support_group: l.group('Cloud Operations'),
    managed_by: l.user('david.kim').id,
    used_for: 'Production',
  };
  b.ci('cmdb_ci_nginx_web_server', 'nginx@cp-web-01', { ...apps, version: '1.24.0', tcp_port: '443' });
  b.ci('cmdb_ci_nginx_web_server', 'nginx@cp-web-02', { ...apps, version: '1.24.0', tcp_port: '443' });
  b.ci('cmdb_ci_app_server_tomcat', 'tomcat@cp-app-01', { ...apps, version: '10.1.16', tcp_port: '8080' });
  b.ci('cmdb_ci_app_server_tomcat', 'tomcat@cp-app-02', { ...apps, version: '10.1.16', tcp_port: '8080' });
  b.ci('cmdb_ci_db_postgresql_instance', 'postgres@cp-db-01', {
    ...dba,
    version: '15.4',
    instance_name: 'main',
    tcp_port: '5432',
  });
  b.ci('cmdb_ci_database', 'customer_portal', {
    support_group: l.group('Database Administration'),
    type: 'PostgreSQL',
    version: '15',
  });

  b.ci('cmdb_ci_iis_web_server', 'IIS@pay-web-01', { ...sw, version: '10.0', tcp_port: '443' });
  b.ci('cmdb_ci_appl_dot_net', 'Payroll Engine@pay-app-01', {
    ...sw,
    version: '2024.2',
    install_directory: 'D:\\Apps\\PayrollEngine',
  });
  b.ci('cmdb_ci_db_mssql_instance', 'MSSQLSERVER@pay-db-01', {
    ...dba,
    version: '2022 CU10',
    instance_name: 'MSSQLSERVER',
    tcp_port: '1433',
  });
  b.ci('cmdb_ci_database', 'payroll', {
    support_group: l.group('Database Administration'),
    type: 'SQL Server',
    version: '2022',
  });

  b.ci('cmdb_ci_appl', 'Postfix@mail-gw-01', { ...cloud, version: '3.7.9', tcp_port: '25' });
  b.ci('cmdb_ci_appl', 'Mailbox Service@mail-01', { ...cloud, version: '2019 CU14', tcp_port: '443' });
  b.ci('cmdb_ci_appl', 'Directory Services@dc-01', {
    support_group: l.group('Information Security'),
    managed_by: l.user('fatima.alsayed').id,
    used_for: 'Production',
    version: '2022',
    tcp_port: '389,636',
  });

  const runsOn: [string, string][] = [
    ['nginx@cp-web-01', 'cp-web-01'],
    ['nginx@cp-web-02', 'cp-web-02'],
    ['tomcat@cp-app-01', 'cp-app-01'],
    ['tomcat@cp-app-02', 'cp-app-02'],
    ['postgres@cp-db-01', 'cp-db-01'],
    ['IIS@pay-web-01', 'pay-web-01'],
    ['Payroll Engine@pay-app-01', 'pay-app-01'],
    ['MSSQLSERVER@pay-db-01', 'pay-db-01'],
    ['Postfix@mail-gw-01', 'mail-gw-01'],
    ['Mailbox Service@mail-01', 'mail-01'],
    ['Directory Services@dc-01', 'dc-01'],
  ];
  for (const [app, host] of runsOn) b.rel(app, REL.RUNS_ON, host);
  b.rel('cp-lb-01', REL.DEPENDS_ON, 'nginx@cp-web-01');
  b.rel('cp-lb-01', REL.DEPENDS_ON, 'nginx@cp-web-02');
  for (const web of ['nginx@cp-web-01', 'nginx@cp-web-02'])
    for (const app of ['tomcat@cp-app-01', 'tomcat@cp-app-02']) b.rel(web, REL.DEPENDS_ON, app);
  b.rel('tomcat@cp-app-01', REL.DEPENDS_ON, 'customer_portal');
  b.rel('tomcat@cp-app-02', REL.DEPENDS_ON, 'customer_portal');
  b.rel('customer_portal', REL.HOSTED_ON, 'postgres@cp-db-01');
  b.rel('IIS@pay-web-01', REL.DEPENDS_ON, 'Payroll Engine@pay-app-01');
  b.rel('Payroll Engine@pay-app-01', REL.DEPENDS_ON, 'payroll');
  b.rel('Payroll Engine@pay-app-01', REL.DEPENDS_ON, 'Directory Services@dc-01');
  b.rel('payroll', REL.HOSTED_ON, 'MSSQLSERVER@pay-db-01');
  b.rel('Mailbox Service@mail-01', REL.DEPENDS_ON, 'Directory Services@dc-01');
}

function services(b: Builder, l: Lookup): void {
  const svc = (cls: string, name: string, values: Record<string, unknown>) =>
    b.ci(cls, name, { discovery_source: 'ManualEntry', ...values });
  svc('cmdb_ci_service_business', 'Customer Portal', {
    busines_criticality: '1 - most critical',
    owned_by: l.user('charlotte.taylor').id,
    support_group: l.group('Application Development'),
    short_description: 'Self-service portal where Northwind customers manage orders and support cases',
  });
  svc('cmdb_ci_service_business', 'Payroll', {
    busines_criticality: '1 - most critical',
    owned_by: l.user('henry.anderson').id,
    support_group: l.group('Software Support'),
    short_description: 'Monthly payroll calculation and payslip distribution',
  });
  svc('cmdb_ci_service_business', 'Email', {
    busines_criticality: '2 - somewhat critical',
    owned_by: l.user('maya.cohen').id,
    support_group: l.group('Cloud Operations'),
    short_description: 'Corporate email, calendars and distribution lists',
  });
  svc('cmdb_ci_service_technical', 'Network Connectivity', {
    busines_criticality: '1 - most critical',
    owned_by: l.user('marcus.chen').id,
    support_group: l.group('Network Operations'),
    short_description: 'LAN, WAN, Wi-Fi and perimeter security for all offices',
  });
  const instance = (name: string, group: string) =>
    svc('cmdb_ci_service_auto', name, {
      support_group: l.group(group),
      used_for: 'Production',
      environment: 'Production',
    });
  instance('Customer Portal Production', 'Application Development');
  instance('Payroll Production', 'Software Support');
  instance('Email Production', 'Cloud Operations');
  const offering = (name: string, parent: string, group: string) =>
    svc('service_offering', name, { parent: b.ids.get(parent), support_group: l.group(group) });
  offering('Customer Portal - Standard', 'Customer Portal', 'Application Development');
  offering('Payroll - Monthly Processing', 'Payroll', 'Software Support');
  offering('Email - Corporate Mail', 'Email', 'Cloud Operations');
  offering('Network Connectivity - Corporate LAN', 'Network Connectivity', 'Network Operations');
  const app = (name: string, owner: string, values: Record<string, unknown> = {}) =>
    b.ci('cmdb_ci_business_app', name, {
      it_application_owner: l.user(owner).id,
      discovery_source: 'ManualEntry',
      ...values,
    });
  app('Northwind Customer Portal', 'tom.becker', {
    short_description: 'Customer-facing ordering and case management application',
  });
  app('Northwind Payroll', 'elena.petrova', { short_description: 'Payroll engine and payslip publishing' });
  app('Northwind Mail', 'david.kim', { short_description: 'Corporate messaging platform' });

  b.rel('Customer Portal - Standard', REL.DEPENDS_ON, 'Customer Portal Production');
  b.rel('Payroll - Monthly Processing', REL.DEPENDS_ON, 'Payroll Production');
  b.rel('Email - Corporate Mail', REL.DEPENDS_ON, 'Email Production');
  b.rel('Customer Portal Production', REL.DEPENDS_ON, 'cp-lb-01');
  b.rel('Payroll Production', REL.DEPENDS_ON, 'IIS@pay-web-01');
  b.rel('Email Production', REL.DEPENDS_ON, 'Postfix@mail-gw-01');
  b.rel('Email Production', REL.DEPENDS_ON, 'Mailbox Service@mail-01');
  for (const n of ['aus-fw-01', 'aus-rtr-01', 'aus-sw-core-01', 'lon-sw-01'])
    b.rel('Network Connectivity', REL.DEPENDS_ON, n);
  b.rel('Northwind Customer Portal', REL.USES, 'Customer Portal Production');
  b.rel('Northwind Payroll', REL.USES, 'Payroll Production');
  b.rel('Northwind Mail', REL.USES, 'Email Production');

  b.member('Customer Portal Production', [
    'cp-lb-01',
    'nginx@cp-web-01',
    'nginx@cp-web-02',
    'tomcat@cp-app-01',
    'tomcat@cp-app-02',
    'postgres@cp-db-01',
    'customer_portal',
  ]);
  b.member('Payroll Production', [
    'IIS@pay-web-01',
    'Payroll Engine@pay-app-01',
    'MSSQLSERVER@pay-db-01',
    'payroll',
  ]);
  b.member('Email Production', ['Postfix@mail-gw-01', 'Mailbox Service@mail-01', 'Directory Services@dc-01']);
}

/** Laptops assigned to Northwind employees: [asset tag, user, model, operating system]. */
export const DEMO_LAPTOPS: [string, string, string, string][] = [
  ['NWL-LT-1001', 'olivia.martin', 'Latitude 7440', 'Windows 11 Enterprise'],
  ['NWL-LT-1002', 'noah.johnson', 'ThinkPad X1 Carbon Gen 11', 'Windows 11 Enterprise'],
  ['NWL-LT-1003', 'emma.williams', 'MacBook Pro 14 (M3)', 'macOS 14'],
  ['NWL-LT-1004', 'liam.brown', 'MacBook Pro 14 (M3)', 'macOS 14'],
  ['NWL-LT-1005', 'ava.jones', 'Latitude 7440', 'Windows 11 Enterprise'],
  ['NWL-LT-1006', 'ethan.garcia', 'ThinkPad X1 Carbon Gen 11', 'Windows 11 Enterprise'],
  ['NWL-LT-1007', 'mia.miller', 'Latitude 7440', 'Windows 11 Enterprise'],
  ['NWL-LT-1008', 'james.davis', 'ThinkPad X1 Carbon Gen 11', 'Ubuntu Linux 24.04'],
  ['NWL-LT-1009', 'layla.hassan', 'MacBook Pro 14 (M3)', 'macOS 14'],
  ['NWL-LT-1010', 'charlotte.taylor', 'MacBook Pro 14 (M3)', 'macOS 14'],
  ['NWL-LT-1011', 'henry.anderson', 'Latitude 7440', 'Windows 11 Enterprise'],
  ['NWL-LT-1012', 'alex.rivera', 'ThinkPad X1 Carbon Gen 11', 'Windows 11 Enterprise'],
];

function laptops(b: Builder, l: Lookup): void {
  for (const [tag, userName, model, os] of DEMO_LAPTOPS) {
    const u = l.user(userName);
    b.ci(
      'cmdb_ci_computer',
      tag,
      b.hw(model, {
        asset_tag: tag,
        form_factor: 'Laptop',
        chassis_type: 'Notebook',
        os,
        assigned_to: u.id,
        assigned: addMs(nowGlide(), -300 * DAY),
        location: u.location,
        department: u.department,
        support_group: l.group('Hardware Support'),
        managed_by: l.user('jamal.wright').id,
        ram: 32768,
        disk_space: 512,
        discovery_source: 'SCCM',
      }),
    );
  }
}

/** A few deliberate data quality problems so CMDB Health has something to report. */
function healthExamples(b: Builder, l: Lookup, ctx: Context): void {
  const old = addMs(nowGlide(), -150 * DAY);
  ctx.insert(
    'cmdb_ci_linux_server',
    {
      name: 'legacy-ftp-01',
      company: l.company,
      os: 'CentOS Linux',
      os_version: '7.9',
      operational_status: 2,
      location: l.location('Austin HQ'),
      short_description: 'Retired partner file drop, pending decommission',
      sys_created_on: addMs(old, -900 * DAY),
      sys_updated_on: old,
    },
    { autoSysFields: false },
  );
  b.ci('cmdb_ci_appl', 'Legacy Reporting', {
    support_group: l.group('Software Support'),
    version: '3.2',
    short_description: 'Old reporting tool, host unknown',
  });
  ctx.insert('cmdb_ci_wap_network', {
    name: 'aus-wap-01',
    company: l.company,
    location: l.location('Austin HQ'),
    discovery_source: 'ImportSet',
    short_description: 'Imported twice from the facilities spreadsheet',
  });

  const typeId = relTypeId(ctx, REL.RUNS_ON);
  if (typeId && !ctx.first('cmdb_health_orphan_rule', 'applies_to=cmdb_ci_appl')) {
    ctx.insert('cmdb_health_orphan_rule', {
      applies_to: 'cmdb_ci_appl',
      relationship_type: typeId,
      operator: 'and',
    });
  }
  for (const [applies, element] of [
    ['cmdb_ci_server', 'ip_address'],
    ['cmdb_ci_hardware', 'serial_number'],
  ]) {
    if (!ctx.first('resolvr_cmdb_recommended_field', `applies_to=${applies}^element=${element}`)) {
      ctx.insert('resolvr_cmdb_recommended_field', { applies_to: applies, element, active: true });
    }
  }
  const compliance: [string, string, string, string][] = [
    [
      'Servers have a support group',
      'cmdb_ci_server',
      'support_groupISNOTEMPTY',
      'Every server must be supported by an assignment group.',
    ],
    [
      'Business services have an owner',
      'cmdb_ci_service_business',
      'owned_byISNOTEMPTY',
      'Business services need an accountable owner.',
    ],
  ];
  for (const [name, applies, condition, description] of compliance) {
    if (!ctx.first('resolvr_cmdb_compliance_rule', `name=${name}`))
      ctx.insert('resolvr_cmdb_compliance_rule', {
        name,
        applies_to: applies,
        condition,
        description,
        active: true,
      });
  }
}

export function loadCmdbDemo(ctx: Context): void {
  if (ctx.first('cmdb_ci', 'name=Customer Portal Production')) return;
  const l = lookups(ctx);
  const b = new Builder(ctx, l);
  b.models();
  network(b, l);
  servers(b, l);
  applications(b, l);
  services(b, l);
  laptops(b, l);
  healthExamples(b, l, ctx);
  ctx.platform.properties.set('resolvr.cmdb.health.job_enabled', 'true');
}
