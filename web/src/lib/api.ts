/** HTTP client for the ResolvrNow APIs (cookie session + X-UserToken CSRF header). */

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail: string | null = null,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown> | unknown[] | null;

async function request<T>(method: string, url: string, body?: Json | FormData | Blob, headers: Record<string, string> = {}): Promise<T> {
  const h: Record<string, string> = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...headers };
  let payload: BodyInit | undefined;
  if (body instanceof FormData || body instanceof Blob) payload = body;
  else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (method !== 'GET' && csrfToken) h['X-UserToken'] = csrfToken;
  const res = await fetch(url, { method, headers: h, body: payload, credentials: 'same-origin' });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: { message: text } };
  }
  if (!res.ok) {
    const err = (data as { error?: { message?: string; detail?: string } })?.error;
    if (res.status === 401 && !url.includes('/auth/login')) window.dispatchEvent(new CustomEvent('app:unauthorized'));
    throw new ApiError(res.status, err?.message ?? res.statusText, err?.detail ?? null);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: Json | FormData | Blob, headers?: Record<string, string>) => request<T>('POST', url, body, headers),
  patch: <T>(url: string, body: Json) => request<T>('PATCH', url, body),
  put: <T>(url: string, body: Json) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

// ---------------------------------------------------------------- types

export interface Me {
  sys_id: string;
  user_name: string;
  name: string;
  email: string | null;
  roles: string[];
  groups: { sys_id: string; name: string }[];
  is_admin: boolean;
  is_agent: boolean;
  time_zone: string | null;
  title: string;
  csrf_token: string | null;
  product: string;
}

export interface Choice {
  value: string;
  label: string;
  sequence: number;
  dependentValue: string | null;
  inactive?: boolean;
}

export interface ColumnInfo {
  name: string;
  label: string;
  type: string;
  maxLength: number | null;
  mandatory: boolean;
  readOnly: boolean;
  reference: string | null;
  referenceQual: string | null;
  dependentOn: string | null;
  choiceMode: string | null;
  choices?: Choice[];
  hint: string | null;
  definedOn: string;
  canRead: boolean;
  canWrite: boolean;
}

export interface FormSection {
  caption?: string;
  left?: string[];
  right?: string[];
  fields?: string[];
}

export interface RelatedList {
  table: string;
  field?: string;
  query?: string;
  label?: string;
  columns?: string[];
  via?: { table: string; parentField: string; childField: string };
}

export interface UiPolicy {
  id: string;
  table: string;
  name: string;
  condition: string;
  onLoad?: boolean;
  reverseIfFalse?: boolean;
  order?: number;
  actions: { field: string; mandatory?: boolean; visible?: boolean; readOnly?: boolean }[];
}

export interface TableMeta {
  name: string;
  label: string;
  plural: string;
  parent: string | null;
  ancestors: string[];
  descendants: string[];
  displayField: string;
  numberPrefix: string | null;
  canCreate: boolean;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  columns: Record<string, ColumnInfo>;
  form: { table: string; sections: FormSection[]; relatedLists?: RelatedList[]; highlights?: string[] };
  list: { table: string; columns: string[]; defaultQuery?: string; defaultOrder?: string };
  uiPolicies: UiPolicy[];
}

export interface FieldValue {
  value: string;
  display_value: string;
}

export interface UiAction {
  id: string;
  label: string;
  actionName: string;
  style: 'primary' | 'default' | 'destructive';
  confirm: string | null;
  prompt: { field: string; label?: string; mandatory?: boolean }[] | null;
  saveFirst: boolean;
}

export interface RecordPayload {
  table: string;
  sys_id: string | null;
  is_new: boolean;
  display_value: string;
  values: Record<string, FieldValue | string>;
  can_write: boolean;
  can_delete: boolean;
  actions: UiAction[];
  related: RelatedList[];
}

export interface ActivityItem {
  type: 'journal' | 'changes' | 'created' | 'email' | 'attachment';
  field?: string;
  label?: string;
  value?: string;
  created_on: string;
  created_by?: string;
  user_name?: string;
  changes?: { field: string; label: string; old: string; new: string }[];
  subject?: string;
  recipients?: string;
  file_name?: string;
  sys_id?: string;
  size_bytes?: number;
}

export interface NavModule {
  title: string;
  table?: string;
  query?: string;
  route?: string;
  icon?: string;
  separator?: boolean;
}

export interface NavApp {
  id: string;
  title: string;
  icon?: string;
  order?: number;
  modules: NavModule[];
}

export function fv(v: FieldValue | string | undefined): FieldValue {
  if (v === undefined || v === null) return { value: '', display_value: '' };
  if (typeof v === 'string') return { value: v, display_value: v };
  return v;
}

/** Table API list call with display values for both forms. */
export async function tableQuery(
  table: string,
  opts: { query?: string; fields?: string[]; limit?: number; offset?: number; display?: 'true' | 'false' | 'all' } = {},
): Promise<{ rows: Record<string, FieldValue>[]; total: number }> {
  const url = `/api/now/table/${table}${qs({
    sysparm_query: opts.query,
    sysparm_fields: opts.fields?.join(','),
    sysparm_limit: opts.limit ?? 50,
    sysparm_offset: opts.offset ?? 0,
    sysparm_display_value: opts.display ?? 'all',
    sysparm_exclude_reference_link: true,
  })}`;
  const res = await fetch(url, { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'same-origin' });
  if (res.status === 401) window.dispatchEvent(new CustomEvent('app:unauthorized'));
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? res.statusText, data?.error?.detail ?? null);
  return { rows: data.result, total: Number(res.headers.get('X-Total-Count') ?? data.result.length) };
}
