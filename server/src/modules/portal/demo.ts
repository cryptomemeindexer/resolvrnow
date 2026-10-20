import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { addMs, nowGlide } from '../../engine/util.js';
import { EXT, T } from './constants.js';
import { submitSurvey } from './surveys.js';
import { createUniversalRequest } from './ur.js';
import { q } from './util.js';

const DAY = 86_400_000;
/** Set once the demo taxonomy exists; content created later by other demos is connected by name. */
const DEMO_FLAG = 'resolvr.portal.demo_taxonomy';

interface DemoTopic {
  name: string;
  icon: string;
  description: string;
  children: { name: string; icon: string; description: string }[];
  /** Catalog item names connected to the topic. */
  catalog: RegExp;
  /** Knowledge article titles connected to the topic. */
  knowledge: RegExp;
}

/** IT topics of the Northwind Labs portal (original sample content). */
const IT_TOPICS: DemoTopic[] = [
  {
    name: 'Hardware',
    icon: 'laptop',
    description: 'Laptops, monitors, printers, phones and accessories',
    children: [
      { name: 'Laptops & Desktops', icon: 'monitor', description: 'New devices, repairs and replacements' },
      {
        name: 'Printers & Peripherals',
        icon: 'printer',
        description: 'Printers, docks, keyboards, mice and headsets',
      },
      { name: 'Mobile Devices', icon: 'smartphone', description: 'Company phones and tablets' },
    ],
    catalog: /laptop|desktop|monitor|keyboard|mouse|headset|dock|printer|phone|tablet|charger|hardware/i,
    knowledge: /laptop|printer|monitor|battery|dock|screen|keyboard|headset|hardware|charger/i,
  },
  {
    name: 'Software',
    icon: 'app-window',
    description: 'Install, update and license business applications',
    children: [
      {
        name: 'Office & Productivity',
        icon: 'file-text',
        description: 'Email, documents, spreadsheets and chat',
      },
      {
        name: 'Business Applications',
        icon: 'briefcase',
        description: 'CRM, finance and line-of-business tools',
      },
    ],
    catalog: /software|licen[cs]e|subscription|install|application|app\b|adobe|office|visio|design tool/i,
    knowledge: /software|install|office|excel|outlook|teams|application|update|license|calendar|email/i,
  },
  {
    name: 'Access & Accounts',
    icon: 'key-round',
    description: 'Passwords, sign-in, multi-factor authentication and permissions',
    children: [
      {
        name: 'Passwords & MFA',
        icon: 'lock',
        description: 'Reset passwords and set up multi-factor sign-in',
      },
      {
        name: 'Permissions & Shared Drives',
        icon: 'folder-lock',
        description: 'Access to folders, groups and systems',
      },
    ],
    catalog: /access|account|permission|password|shared drive|distribution list|group membership/i,
    knowledge: /password|account|mfa|multi-factor|sign[ -]?in|log[ -]?in|locked|access|authenticator/i,
  },
  {
    name: 'Network & Connectivity',
    icon: 'wifi',
    description: 'VPN, Wi-Fi and remote access',
    children: [
      {
        name: 'VPN & Remote Access',
        icon: 'globe-lock',
        description: 'Connect securely from home or while travelling',
      },
      { name: 'Wi-Fi', icon: 'wifi', description: 'Office wireless networks and guest access' },
    ],
    catalog: /vpn|network|wi-?fi|remote access|hotspot/i,
    knowledge: /vpn|network|wi-?fi|connect|remote|proxy|internet/i,
  },
  {
    name: 'Security',
    icon: 'shield',
    description: 'Report suspicious email, lost devices and security concerns',
    children: [
      {
        name: 'Phishing & Suspicious Email',
        icon: 'mail-warning',
        description: 'What to do with a message you do not trust',
      },
      {
        name: 'Lost or Stolen Devices',
        icon: 'shield-alert',
        description: 'Report a missing laptop or phone',
      },
    ],
    catalog: /security|phishing|encrypt|lost|stolen|certificate/i,
    knowledge: /security|phishing|malware|virus|encrypt|suspicious|scam/i,
  },
  {
    name: 'Workplace',
    icon: 'building-2',
    description: 'Meeting rooms, desk phones and office technology',
    children: [
      {
        name: 'Meeting Rooms & AV',
        icon: 'presentation',
        description: 'Screens, cameras and room booking panels',
      },
      { name: 'Desk Phones', icon: 'phone', description: 'Desk phone setup and voicemail' },
    ],
    catalog: /meeting|room|conference|desk|workplace|badge|projector/i,
    knowledge: /meeting|room|conference|desk phone|voicemail|workplace|projector/i,
  },
];

const QUICK_LINKS = [
  {
    name: 'Report an issue',
    short_description: 'Tell us what is not working',
    page: 'report_issue',
    icon: 'circle-alert',
    order: 10,
  },
  {
    name: 'Request something',
    short_description: 'Browse devices, software and access',
    page: 'sc_home',
    icon: 'shopping-bag',
    order: 20,
  },
  {
    name: 'My tickets',
    short_description: 'Follow your requests and issues',
    page: 'my_requests',
    icon: 'ticket',
    order: 30,
  },
  {
    name: 'Knowledge',
    short_description: 'Guides and answers to common questions',
    page: 'kb_home',
    icon: 'book-open',
    order: 40,
  },
];

function userId(ctx: Context, userName: string): string | null {
  return ctx.first('sys_user', `user_name=${q(userName)}`)?.sysId ?? null;
}

function as(ctx: Context, userName: string): Context | null {
  return userId(ctx, userName) ? ctx.platform.contextAs(userName) : null;
}

/** Topic for a demo record name: the first sub-topic whose pattern matches, else null. */
/** Most specific topics are tried first ("VPN access" belongs to networking, not to accounts). */
const MATCH_ORDER = [
  'Network & Connectivity',
  'Security',
  'Workplace',
  'Access & Accounts',
  'Hardware',
  'Software',
];

function topicForName(ctx: Context, type: 'catalog' | 'knowledge', name: string): Rec | null {
  if (!name) return null;
  const ordered = [...IT_TOPICS].sort((a, b) => MATCH_ORDER.indexOf(a.name) - MATCH_ORDER.indexOf(b.name));
  for (const def of ordered) {
    if (!(type === 'catalog' ? def.catalog : def.knowledge).test(name)) continue;
    return ctx.elevated().first(T.topic, `name=${q(def.name)}`);
  }
  return null;
}

/** Connects one catalog item or article to its demo topic (by name), once. */
function linkDemoRecord(ctx: Context, rec: Rec): boolean {
  const sys = ctx.elevated();
  const isItem = rec.table.ancestors.includes(EXT.catalogItem);
  const type = isItem ? 'catalog' : 'knowledge';
  const field = isItem ? 'catalog_item' : 'knowledge';
  const topic = topicForName(ctx, type, isItem ? rec.str('name') : rec.str('short_description'));
  if (!topic || sys.first(T.content, `${field}=${rec.sysId}`)) return false;
  sys.insert(T.content, {
    topic: topic.sysId,
    content_type: type,
    [field]: rec.sysId,
    order: 100,
    active: true,
  });
  return true;
}

/** Connects every existing catalog item and article to the demo topics by name. */
export function linkDemoContent(ctx: Context): number {
  let n = 0;
  const sys = ctx.elevated();
  for (const [table, field] of [
    [EXT.catalogItem, 'name'],
    [EXT.article, 'short_description'],
  ] as const) {
    if (!ctx.registry.has(table)) continue;
    for (const rec of sys.query(table, { query: `${field}ISNOTEMPTY`, limit: 2000 }))
      if (linkDemoRecord(ctx, rec)) n++;
  }
  return n;
}

/** While demo data loads, content created by modules that load after the portal is connected too. */
export function registerDemoLinking(platform: Platform): void {
  for (const table of [EXT.catalogItem, EXT.article]) {
    platform.hooks.on('insert', table, 'portal: connect demo content', (rec, _prev, ctx) => {
      if (
        platform.properties.get(DEMO_FLAG) !== 'true' ||
        platform.properties.get('resolvr.demo.loaded') === 'true'
      )
        return;
      linkDemoRecord(ctx, rec);
    });
  }
}

function seedTaxonomy(ctx: Context): void {
  const taxonomy =
    ctx.first(T.taxonomy, 'name=Employee') ??
    ctx.insert(T.taxonomy, { name: 'Employee', description: 'Northwind Labs employee taxonomy', order: 10 });
  const itService = ctx.first(T.urService, 'name=IT incident');
  const it =
    ctx.first(T.topic, 'name=IT^parent_topicISEMPTY') ??
    ctx.insert(T.topic, {
      name: 'IT',
      taxonomy: taxonomy.sysId,
      icon: 'monitor-smartphone',
      description: 'Get help with technology at Northwind Labs',
      order: 10,
      resolvr_ur_service: itService?.sysId ?? null,
    });
  IT_TOPICS.forEach((def, i) => {
    const topic =
      ctx.first(T.topic, `name=${q(def.name)}^parent_topic=${it.sysId}`) ??
      ctx.insert(T.topic, {
        name: def.name,
        taxonomy: taxonomy.sysId,
        parent_topic: it.sysId,
        icon: def.icon,
        description: def.description,
        order: (i + 1) * 10,
        resolvr_featured: true,
      });
    def.children.forEach((child, j) => {
      if (ctx.first(T.topic, `name=${q(child.name)}^parent_topic=${topic.sysId}`)) return;
      ctx.insert(T.topic, {
        name: child.name,
        taxonomy: taxonomy.sysId,
        parent_topic: topic.sysId,
        icon: child.icon,
        description: child.description,
        order: (j + 1) * 10,
      });
    });
  });
  for (const link of QUICK_LINKS) {
    const rec =
      ctx.first(T.quickLink, `name=${q(link.name)}`) ??
      ctx.insert(T.quickLink, { ...link, content_type: 'page', show_on_home: true, active: true });
    if (!ctx.first(T.content, `topic=${it.sysId}^quick_link=${rec.sysId}`)) {
      ctx.insert(T.content, {
        topic: it.sysId,
        content_type: 'quick_link',
        quick_link: rec.sysId,
        order: link.order,
        active: true,
      });
    }
  }
  const desk = ctx.first('sys_user_group', 'name=Service Desk');
  const dept = ctx.first(T.urDepartment, 'name=IT');
  if (desk && dept && !dept.str('assignment_group')) ctx.update(dept, { assignment_group: desk.sysId });
}

function seedAnnouncementsAndTours(ctx: Context): void {
  const now = nowGlide();
  if (!ctx.first(T.announcement, 'title=Planned maintenance: email upgrade this Saturday')) {
    ctx.insert(T.announcement, {
      title: 'Planned maintenance: email upgrade this Saturday',
      summary:
        'Email and calendars will be unavailable on Saturday from 02:00 to 04:00 UTC while we upgrade the mail servers. No action is needed.',
      display_style: 'normal',
      display_from: addMs(now, -DAY),
      display_to: addMs(now, 7 * DAY),
      dismissible: true,
      order: 10,
      active: true,
    });
  }
  if (!ctx.first(T.tour, 'name=Welcome to the employee portal')) {
    const tour = ctx.insert(T.tour, {
      name: 'Welcome to the employee portal',
      page_id: 'index',
      auto_launch: true,
      active: true,
    });
    [
      {
        target: '[data-tour="search"]',
        title: 'Search first',
        content: 'Type a few words to find answers and requests in one place.',
        placement: 'bottom',
      },
      {
        target: '[data-tour="quick-links"]',
        title: 'Quick links',
        content: 'Report an issue or request something in one click.',
        placement: 'top',
      },
      {
        target: '[data-tour="my-tickets"]',
        title: 'Track your tickets',
        content: 'Every request you raise shows up here with its current status.',
        placement: 'bottom',
      },
    ].forEach((step, i) => {
      ctx.insert(T.tourStep, { ...step, guide: tour.sysId, order: (i + 1) * 10 });
    });
  }
}

/** Resolves and closes the incident behind a demo request (when the incident module is installed). */
function finishIncident(ctx: Context, agent: string, inc: Rec | null, note: string, close: boolean): void {
  if (!inc) return;
  const sys = ctx.elevated();
  const desk = sys.first('sys_user_group', 'name=Service Desk');
  const who = userId(ctx, agent);
  sys.update(inc, { assignment_group: desk?.sysId ?? '', assigned_to: who ?? '', state: '2' });
  const actor = as(ctx, agent)?.elevated() ?? sys;
  actor.update(sys.get('incident', inc.sysId)!, { comments: note });
  actor.update(sys.get('incident', inc.sysId)!, {
    state: '6',
    close_code: 'Solution provided',
    close_notes: note,
  });
  if (close) actor.update(sys.get('incident', inc.sysId)!, { state: '7' });
}

function seedRequests(ctx: Context): void {
  const topic = (name: string) => ctx.first(T.topic, `name=${q(name)}`)?.sysId ?? null;
  const olivia = as(ctx, 'olivia.martin');
  const noah = as(ctx, 'noah.johnson');
  const layla = as(ctx, 'layla.hassan');
  const hasIncident = ctx.registry.has('incident');

  if (olivia && !ctx.first(T.ur, 'short_description=My second monitor keeps flickering')) {
    const { ur } = createUniversalRequest(olivia, {
      description:
        'My second monitor keeps flickering\nThe external screen on my desk flickers every few seconds since this morning. I already tried another cable.',
      topic: topic('Laptops & Desktops'),
    });
    olivia.elevated().update(ur, { comments: 'It is worse when the laptop is on battery.' });
  }
  if (olivia && !ctx.first(T.ur, 'short_description=Question about laptop encryption before travelling')) {
    // No topic: stays unrouted until a routing agent picks it up.
    createUniversalRequest(olivia, {
      description:
        'Question about laptop encryption before travelling\nI travel to a customer site next week. Do I need to do anything to my laptop before I go?',
    });
  }
  if (noah && !ctx.first(T.ur, 'short_description=Laptop battery drains within an hour')) {
    const { ur, primary } = createUniversalRequest(noah, {
      description:
        'Laptop battery drains within an hour\nThe battery went from full to empty during a single meeting.',
      topic: topic('Hardware'),
    });
    if (hasIncident)
      finishIncident(
        ctx,
        'alex.rivera',
        primary,
        'The battery calibration was reset and a power plan update was applied.',
        true,
      );
    else ctx.elevated().update(ur, { state: '4', comments: 'Replaced the battery.' });
    const inst = ctx.elevated().first(T.instance, `trigger_id=${ur.sysId}`);
    if (inst) submitSurvey(noah, inst, { rating: 4, comment: 'Quick fix, thank you.' });
  }
  if (layla && !ctx.first(T.ur, 'short_description=VPN disconnects every few minutes from home')) {
    const { ur, primary } = createUniversalRequest(layla, {
      description:
        'VPN disconnects every few minutes from home\nThe VPN client drops the connection roughly every five minutes since yesterday.',
      topic: topic('VPN & Remote Access'),
    });
    if (hasIncident)
      finishIncident(
        ctx,
        'noor.haddad',
        primary,
        'Updated the VPN client profile. Please confirm it stays connected.',
        false,
      );
    else ctx.elevated().update(ur, { state: '3', state_reason: 'confirm_response' });
  }
  if (layla && !ctx.first(T.ur, 'short_description=Replacement charger for my laptop')) {
    const { ur, primary } = createUniversalRequest(layla, {
      description: 'Replacement charger for my laptop\nThe charger cable is frayed near the plug.',
      topic: topic('Hardware'),
    });
    if (hasIncident)
      finishIncident(
        ctx,
        'alex.rivera',
        primary,
        'A new charger is waiting for you at the Dubai office reception.',
        true,
      );
    else ctx.elevated().update(ur, { state: '4' });
  }
}

/** Demo data: IT taxonomy, quick links, an announcement, a tour, universal requests and surveys. */
export function seedPortalDemo(ctx: Context): void {
  seedTaxonomy(ctx);
  seedAnnouncementsAndTours(ctx);
  ctx.platform.properties.set(DEMO_FLAG, 'true');
  linkDemoContent(ctx);
  seedRequests(ctx);
}
