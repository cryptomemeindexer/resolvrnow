import type { Context } from '../../engine/context.js';
import { PROPS, T } from './constants.js';
import { isRtl, type Lang, t } from './i18n.js';
import { activeAnnouncements, favoriteIds, featuredTopics, homeQuickLinks } from './taxonomy.js';
import {
  myTicketRecords,
  pendingApprovalRecords,
  pendingSurveyCount,
  pendingSurveysByTrigger,
  ticketRow,
} from './tickets.js';
import { localHour } from './util.js';

export function greetingKey(hour: number): 'greeting.morning' | 'greeting.afternoon' | 'greeting.evening' {
  if (hour >= 5 && hour < 12) return 'greeting.morning';
  if (hour >= 12 && hour < 18) return 'greeting.afternoon';
  return 'greeting.evening';
}

/** Home page payload: greeting, quick links, announcements, featured topics, recent items and counts. */
export function homePayload(ctx: Context, lang: Lang) {
  const me = ctx.user.sysId;
  const user = me ? ctx.elevated().get('sys_user', me) : null;
  const firstName = user?.str('first_name') || ctx.user.name.split(' ')[0] || ctx.user.userName;
  const key = greetingKey(localHour(ctx));
  const props = ctx.platform.properties;
  const recentLimit = props.getNumber(PROPS.recentItems, 5);
  const recent = myTicketRecords(ctx, { view: 'all' })
    .sort((a, b) => b.str('sys_updated_on').localeCompare(a.str('sys_updated_on')))
    .slice(0, Math.max(0, recentLimit));
  const surveys = pendingSurveysByTrigger(ctx);
  return {
    user: { sys_id: me, name: ctx.user.name, first_name: firstName, user_name: ctx.user.userName },
    greeting: { key, text: t(lang, key, { name: firstName }) },
    language: { lang, dir: isRtl(lang) ? 'rtl' : 'ltr' },
    support: {
      phone: props.get(PROPS.supportPhone, '') ?? '',
      email: props.get(PROPS.supportEmail, '') ?? '',
      hours: props.get(PROPS.supportHours, '') ?? '',
    },
    quick_links: homeQuickLinks(ctx),
    announcements: activeAnnouncements(ctx),
    featured_topics: featuredTopics(ctx),
    recent_items: recent.map((r) => ticketRow(ctx, r, lang, surveys)),
    counts: {
      open_tickets: myTicketRecords(ctx, { view: 'open' }).length,
      pending_approvals: pendingApprovalRecords(ctx).length,
      pending_surveys: pendingSurveyCount(ctx),
      favorites: favoriteIds(ctx).size,
    },
    tables: {
      universal_request: ctx.registry.has(T.ur),
      catalog: ctx.registry.has('sc_cat_item'),
      knowledge: ctx.registry.has('kb_knowledge'),
      incident: ctx.registry.has('incident'),
    },
  };
}
