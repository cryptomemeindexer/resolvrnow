import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../../lib/api';

/** Types and queries for the employee portal APIs (see docs/api/portal.md and docs/api/catalog.md). */

export const PORTAL = '/api/app/portal';
export const CATALOG = '/api/app/catalog';

export type Badge = 'submitted' | 'awaiting_approval' | 'in_progress' | 'action_needed' | 'closed' | 'cancelled';

export interface TicketState {
  value: string;
  label: string;
  badge: Badge;
  badge_label: string;
}

export interface TicketRow {
  table: string;
  sys_id: string;
  number: string;
  title: string;
  module: { key: string; label: string };
  state: TicketState;
  created: string;
  updated: string;
  active: boolean;
  survey_pending: boolean;
  survey_instance: string | null;
}

export interface QuickLink {
  sys_id: string;
  name: string;
  short_description: string;
  content_type: string;
  icon: string;
  url: string;
  page: string;
  catalog_item: string | null;
  knowledge: string | null;
}

export interface Announcement {
  sys_id: string;
  title: string;
  summary: string;
  style: 'normal' | 'urgent';
  link: string | null;
  dismissible: boolean;
}

export interface TopicCard {
  sys_id: string;
  name: string;
  description: string;
  icon: string;
  path?: string;
  children?: number;
}

export interface Home {
  user: { sys_id: string; name: string; first_name: string };
  greeting: { key: string; text: string };
  language: { lang: string; dir: 'ltr' | 'rtl' };
  support: { phone: string; email: string; hours: string };
  quick_links: QuickLink[];
  announcements: Announcement[];
  featured_topics: TopicCard[];
  recent_items: TicketRow[];
  counts: { open_tickets: number; pending_approvals: number; pending_surveys: number; favorites: number };
  tables: Record<string, boolean>;
}

export interface Content {
  type: 'catalog' | 'knowledge' | 'quick_link';
  type_label: string;
  table: string;
  sys_id: string;
  title: string;
  short_description: string;
  icon: string;
  url: string;
  page: string;
  number?: string;
  snippet?: string;
  knowledge_base?: { sys_id: string; name: string };
  views?: number;
  price?: string;
  updated?: string;
}

export interface TopicPage {
  topic: TopicCard;
  breadcrumb: { sys_id: string; name: string }[];
  children: TopicCard[];
  counts: Record<string, number>;
  content: Content[];
}

export interface SearchResult {
  query: string;
  total: number;
  groups: { source: string; label: string; total: number; results: Content[] }[];
  message: string | null;
}

export interface TicketPage {
  table: string;
  sys_id: string;
  number: string;
  title: string;
  description: string;
  module: { key: string; label: string };
  header: { number: string; created: string; updated: string; state: TicketState };
  summary: { name: string; label: string; value: string; display_value: string }[];
  variables: { name: string; label: string; value: string; display_value: string }[];
  activity: { sys_id: string; value: string; created_on: string; user_name: string; is_me: boolean }[];
  attachments: { sys_id: string; file_name: string; size_bytes: number; download_url: string }[];
  timeline: { key: string; label: string; status: 'done' | 'current' | 'pending' | 'skipped' | 'cancelled'; at: string | null }[];
  actions: { name: string; label: string; style: string; comment?: string }[];
  can_comment: boolean;
  active: boolean;
}

export interface Approval {
  sys_id: string;
  state: { value: string; label: string };
  created: string;
  target: {
    table: string;
    table_label: string;
    sys_id: string;
    number: string;
    title: string;
    requested_for: { display_value: string } | null;
    price: string;
  };
}

export interface CatalogTree {
  sys_id: string;
  title: string;
  description: string;
  categories: { sys_id: string; title: string; description: string; icon: string; count: number }[];
}

export interface ItemSummary {
  sys_id: string;
  name: string;
  short_description: string;
  icon: string;
  type: 'catalog_item' | 'record_producer' | 'order_guide' | 'content_item';
  price_display?: string;
}

export interface Variable {
  name: string;
  label: string;
  ui_type: string;
  mandatory: boolean;
  read_only: boolean;
  visible: boolean;
  help_text: string;
  example_text: string;
  reference: string | null;
  reference_qualifier: string | null;
  displayvalue?: string;
  choices?: { value: string; label: string; price: number }[];
}

export interface UiPolicy {
  condition: string;
  reverse_if_false: boolean;
  order: number;
  actions: { name: string; mandatory: string; visible: string; disabled: string }[];
}

export interface ItemForm {
  item: ItemSummary & {
    description: string;
    submit_label: string;
    price_value: number;
    currency: string;
    show_price: boolean;
    show_quantity: boolean;
    quantity_choices: number[];
    delivery_time: string;
  };
  variables: Variable[];
  ui_policies: UiPolicy[];
  values: Record<string, string>;
}

export interface OrderResult {
  request: { number: string } | null;
  request_items: { table: string; sys_id: string; number: string }[];
  record?: { table: string; sys_id: string; number: string } | null;
}

export interface Article {
  sys_id: string;
  number: string;
  title: string;
  content: string;
  knowledge_base: { sys_id: string; title: string } | null;
  author: { name: string } | null;
  updated: string;
  sys_view_count: number;
  helpful: { yes: number; no: number; percent: number };
  my_feedback: { useful: string; rating: number | null };
  related: { sys_id: string; number: string; title: string }[];
}

const get = async <T>(url: string) => (await api.get<{ result: T }>(url)).result;

export const usePortalHome = () => useQuery({ queryKey: ['portal', 'home'], queryFn: () => get<Home>(`${PORTAL}/home`) });

export const useTickets = (view: string, q: string) =>
  useQuery({
    queryKey: ['portal', 'tickets', view, q],
    queryFn: () => get<{ total: number; tickets: TicketRow[] }>(`${PORTAL}/tickets${qs({ view, q, limit: 50 })}`),
    placeholderData: (prev) => prev,
  });

export const useTicket = (table: string, id: string) =>
  useQuery({ queryKey: ['portal', 'ticket', table, id], queryFn: () => get<TicketPage>(`${PORTAL}/tickets/${table}/${id}`) });

export const useTopic = (id: string, type: string) =>
  useQuery({ queryKey: ['portal', 'topic', id, type], queryFn: () => get<TopicPage>(`${PORTAL}/topics/${id}${qs({ type })}`) });

export const useSearch = (q: string, source: string) =>
  useQuery({
    queryKey: ['portal', 'search', q, source],
    enabled: q.trim().length > 0,
    queryFn: () => get<SearchResult>(`${PORTAL}/search${qs({ q, source, limit: source === 'all' ? 5 : 20 })}`),
  });

export const useApprovals = () =>
  useQuery({ queryKey: ['portal', 'approvals'], queryFn: () => get<{ approvals: Approval[] }>(`${PORTAL}/approvals`) });

export const useCatalogs = () => useQuery({ queryKey: ['portal', 'catalogs'], queryFn: () => get<CatalogTree[]>(`${CATALOG}/catalogs`) });

export const useItems = (category: string) =>
  useQuery({ queryKey: ['portal', 'items', category], queryFn: () => get<ItemSummary[]>(`${CATALOG}/items${qs({ category, limit: 100 })}`) });

export const useItemForm = (id: string) => useQuery({ queryKey: ['portal', 'item', id], queryFn: () => get<ItemForm>(`${CATALOG}/items/${id}/form`) });

export const useArticle = (id: string) =>
  useQuery({ queryKey: ['portal', 'article', id], queryFn: () => get<Article>(`/api/app/knowledge/articles/${id}`) });

/** Where a quick link or content row leads inside the portal. */
export function contentHref(c: { type?: string; content_type?: string; sys_id: string; page?: string; url?: string; catalog_item?: string | null; knowledge?: string | null }): string {
  if (c.type === 'knowledge') return `/portal/kb/${c.sys_id}`;
  if (c.type === 'catalog') return `/portal/item/${c.sys_id}`;
  if (c.catalog_item) return `/portal/item/${c.catalog_item}`;
  if (c.knowledge) return `/portal/kb/${c.knowledge}`;
  const pages: Record<string, string> = {
    index: '/portal',
    report_issue: '/portal/report',
    sc_home: '/portal/catalog',
    my_requests: '/portal/tickets',
    kb_home: '/portal/kb',
  };
  if (c.page && pages[c.page]) return pages[c.page];
  return c.url || '/portal';
}
