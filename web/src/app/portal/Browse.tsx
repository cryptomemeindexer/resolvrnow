import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, BookOpen, Eye, ThumbsDown, ThumbsUp } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Icon } from '../../components/Icon';
import { Chip, cx, Empty, IconTile, Loading, relativeTime, SectionHeader, Segmented, type Tint, useToast } from '../../components/ui';
import { api, fv, tableQuery } from '../../lib/api';
import { type Content, contentHref, useArticle, useCatalogs, useItems, useSearch, useTopic } from './data';
import { useI18n } from './i18n';
import { LinkCard, NotFound, RichText, SearchBox, Snippet } from './parts';

const TYPE_TINT: Record<string, Tint> = { catalog: 'blue', knowledge: 'rose', quick_link: 'violet' };

function ContentRow({ c }: { c: Content }) {
  const { t } = useI18n();
  return (
    <Link to={contentHref(c)} className="group flex items-start gap-4 px-5 py-4 transition-colors hover:bg-raised">
      <IconTile
        tint={TYPE_TINT[c.type] ?? 'sand'}
        icon={c.type === 'knowledge' ? <BookOpen className="size-[18px]" strokeWidth={1.8} /> : <Icon name={c.icon || 'package'} className="size-[18px]" strokeWidth={1.8} />}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="micro text-subtle">{c.type_label || t(`type.${c.type}`)}</span>
          {c.number && <span className="micro text-accent">{c.number}</span>}
        </div>
        <p className="mt-0.5 font-semibold group-hover:text-accent">{c.title}</p>
        {c.snippet ? <Snippet html={c.snippet} /> : c.short_description && <p className="line-clamp-2 text-[13px] leading-relaxed text-muted">{c.short_description}</p>}
      </div>
      {!!c.price && Number(String(c.price).replace(/[^0-9.]/g, '')) > 0 && <Chip>{c.price}</Chip>}
      <ArrowRight className="mt-2 size-4 shrink-0 text-subtle rtl:rotate-180" />
    </Link>
  );
}

function ContentList({ items }: { items: Content[] }) {
  return (
    <div className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
      {items.map((c) => (
        <ContentRow key={`${c.type}:${c.sys_id}`} c={c} />
      ))}
    </div>
  );
}

export function SearchPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const source = params.get('source') ?? 'all';
  const res = useSearch(q, source);
  const setSource = (s: string) => {
    const next = new URLSearchParams(params);
    next.set('source', s);
    setParams(next);
  };
  return (
    <div className="space-y-8">
      <div className="max-w-3xl">
        <SearchBox key={q} initial={q} source={source === 'all' ? undefined : source} />
      </div>
      <Segmented
        value={source}
        onChange={setSource}
        options={[
          { id: 'all', label: t('search.all') },
          { id: 'knowledge', label: t('search.knowledge') },
          { id: 'catalog', label: t('search.catalog') },
        ]}
      />
      {!q.trim() ? null : res.isLoading ? (
        <Loading label={t('common.loading')} />
      ) : !res.data || res.data.total === 0 ? (
        <Empty title={t('search.no_results', { q })} />
      ) : (
        res.data.groups
          .filter((g) => g.results.length > 0)
          .map((g) => (
            <section key={g.source}>
              <SectionHeader
                title={g.label}
                aside={
                  source === 'all' && g.total > g.results.length ? (
                    <button type="button" className="font-semibold text-accent hover:underline" onClick={() => setSource(g.source)}>
                      {t('search.see_all')} ({g.total})
                    </button>
                  ) : (
                    `${g.total}`
                  )
                }
              />
              <div className="mt-4">
                <ContentList items={g.results} />
              </div>
            </section>
          ))
      )}
    </div>
  );
}

export function TopicPage() {
  const { t } = useI18n();
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const type = params.get('type') ?? 'all';
  const topic = useTopic(id, type);
  if (topic.isLoading) return <Loading label={t('common.loading')} />;
  if (!topic.data) return <NotFound />;
  const d = topic.data;
  return (
    <div className="space-y-10">
      <div>
        <nav className="micro flex flex-wrap items-center gap-2 text-subtle" aria-label="Breadcrumb">
          <Link to="/portal" className="hover:text-ink">
            {t('nav.home')}
          </Link>
          {d.breadcrumb.map((b) => (
            <span key={b.sys_id} className="flex items-center gap-2">
              <span aria-hidden>/</span>
              <Link to={`/portal/topic/${b.sys_id}`} className="hover:text-ink">
                {b.name}
              </Link>
            </span>
          ))}
        </nav>
        <h1 className="display mt-4">{d.topic.name}</h1>
        {d.topic.description && <p className="mt-3.5 max-w-2xl text-base leading-[1.7] text-muted">{d.topic.description}</p>}
      </div>
      {d.children.length > 0 && (
        <section>
          <SectionHeader title={t('topic.child_topics')} />
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {d.children.map((c) => (
              <LinkCard key={c.sys_id} to={`/portal/topic/${c.sys_id}`} icon={c.icon} tint="sand" title={c.name} text={c.description} />
            ))}
          </div>
        </section>
      )}
      <section>
        <SectionHeader title={t('topic.resources')} aside={`${d.counts.all ?? d.content.length}`} />
        <div className="mt-4 mb-4">
          <Segmented
            value={type}
            onChange={(v) => setParams(v === 'all' ? {} : { type: v })}
            options={(['all', 'catalog', 'knowledge', 'quick_link'] as const)
              .filter((k) => k === 'all' || (d.counts[k] ?? 0) > 0)
              .map((k) => ({ id: k, label: `${t(`topic.filter.${k}`)} ${d.counts[k] ?? 0}` }))}
          />
        </div>
        {d.content.length ? <ContentList items={d.content} /> : <Empty title={t('topic.empty')} />}
      </section>
    </div>
  );
}

export function CatalogPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const catalogs = useCatalogs();
  const categories = catalogs.data?.flatMap((c) => c.categories) ?? [];
  const category = params.get('category') ?? categories[0]?.sys_id ?? '';
  const items = useItems(category);
  if (catalogs.isLoading) return <Loading label={t('common.loading')} />;
  const current = categories.find((c) => c.sys_id === category);
  return (
    <div className="space-y-8">
      <div>
        <div className="eyebrow">{catalogs.data?.[0]?.title}</div>
        <h1 className="display mt-4">{t('nav.catalog')}</h1>
        <p className="mt-3.5 max-w-2xl text-base leading-[1.7] text-muted">{t('catalog.subtitle')}</p>
      </div>
      <div className="grid gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
        <nav aria-label={t('catalog.categories')}>
          <p className="micro mb-3 text-subtle">{t('catalog.categories')}</p>
          <ul className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
            {categories.map((c) => (
              <li key={c.sys_id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => setParams({ category: c.sys_id })}
                  className={cx(
                    'flex w-full items-center gap-2.5 rounded-control px-3 py-2 text-start text-[13px]',
                    c.sys_id === category ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-200' : 'hover:bg-sunken',
                  )}
                >
                  <Icon name={c.icon} className="size-4 shrink-0" />
                  <span className="flex-1 truncate">{c.title}</span>
                  <span className="text-[11px] text-subtle">{c.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <section>
          <SectionHeader title={current?.title ?? ''} aside={t('catalog.items', { n: items.data?.length ?? 0 })} />
          {items.isLoading ? (
            <Loading label={t('common.loading')} />
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {(items.data ?? []).map((it) => (
                <LinkCard key={it.sys_id} to={`/portal/item/${it.sys_id}`} icon={it.icon || 'package'} tint="blue" title={it.name} text={it.short_description} meta={it.price_display} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export function KnowledgeHome() {
  const { t } = useI18n();
  const popular = useQuery({
    queryKey: ['portal', 'kb-popular'],
    queryFn: () =>
      tableQuery('kb_knowledge', {
        query: 'workflow_state=published^ORDERBYDESCsys_view_count',
        fields: ['sys_id', 'number', 'short_description', 'sys_view_count', 'kb_knowledge_base', 'sys_updated_on'],
        limit: 12,
      }),
  });
  return (
    <div className="space-y-10">
      <div>
        <div className="eyebrow">{t('nav.knowledge')}</div>
        <h1 className="display mt-4">{t('nav.knowledge')}</h1>
        <p className="mt-3.5 max-w-2xl text-base leading-[1.7] text-muted">{t('kb.subtitle')}</p>
        <div className="mt-8 max-w-3xl">
          <SearchBox large source="knowledge" />
        </div>
      </div>
      <section>
        <SectionHeader title={t('kb.popular')} />
        {popular.isLoading ? (
          <Loading label={t('common.loading')} />
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(popular.data?.rows ?? []).map((r) => (
              <LinkCard
                key={fv(r.sys_id).value}
                to={`/portal/kb/${fv(r.sys_id).value}`}
                icon="book-open"
                tint="rose"
                title={fv(r.short_description).display_value || fv(r.short_description).value}
                text={fv(r.kb_knowledge_base).display_value}
                meta={t('kb.views', { n: fv(r.sys_view_count).value || '0' })}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function ArticlePage() {
  const { t } = useI18n();
  const { id = '' } = useParams();
  const toast = useToast();
  const qc = useQueryClient();
  const article = useArticle(id);
  const vote = useMutation({
    mutationFn: (useful: 'yes' | 'no') => api.post(`/api/app/knowledge/articles/${id}/feedback`, { useful }),
    onSuccess: () => {
      toast(t('kb.thanks'), 'success');
      qc.invalidateQueries({ queryKey: ['portal', 'article', id] });
    },
  });
  if (article.isLoading) return <Loading label={t('common.loading')} />;
  if (!article.data) return <NotFound />;
  const a = article.data;
  const voted = a.my_feedback?.useful;
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
      <article className="min-w-0">
        <nav className="micro flex flex-wrap items-center gap-2 text-subtle">
          <Link to="/portal/kb" className="hover:text-ink">
            {t('nav.knowledge')}
          </Link>
          {a.knowledge_base && (
            <>
              <span aria-hidden>/</span>
              <span>{a.knowledge_base.title}</span>
            </>
          )}
        </nav>
        <h1 className="mt-4 text-[30px] leading-tight font-bold tracking-[-0.02em] sm:text-[36px]">{a.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-subtle">
          <span className="micro text-accent">{a.number}</span>
          {a.author && <span>{a.author.name}</span>}
          <span>{relativeTime(a.updated)}</span>
          <span className="inline-flex items-center gap-1">
            <Eye className="size-3.5" /> {t('kb.views', { n: a.sys_view_count })}
          </span>
        </div>
        <div className="mt-8 rounded-card border border-line bg-surface p-6 shadow-card sm:p-8">
          <RichText html={a.content} className="text-[15px]" />
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface px-6 py-4 shadow-card">
          <span className="font-semibold">{t('kb.helpful')}</span>
          {(['yes', 'no'] as const).map((v) => (
            <button
              key={v}
              type="button"
              disabled={vote.isPending}
              onClick={() => vote.mutate(v)}
              className={cx(
                'inline-flex items-center gap-1.5 rounded-control border px-3 py-1.5 text-[13px] font-semibold',
                voted === v ? 'border-brand-500 text-brand-600' : 'border-line hover:bg-sunken',
              )}
            >
              {v === 'yes' ? <ThumbsUp className="size-4" /> : <ThumbsDown className="size-4" />}
              {t(`kb.${v}`)}
            </button>
          ))}
          <span className="ms-auto text-xs text-subtle">{a.helpful.percent}% · {a.helpful.yes + a.helpful.no}</span>
        </div>
      </article>
      {a.related.length > 0 && (
        <aside>
          <p className="micro mb-3 text-subtle">{t('kb.related')}</p>
          <ul className="space-y-2">
            {a.related.map((r) => (
              <li key={r.sys_id}>
                <Link to={`/portal/kb/${r.sys_id}`} className="block rounded-tile border border-line bg-surface px-4 py-3 text-sm font-semibold shadow-card hover:border-brand-300">
                  {r.title}
                </Link>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
