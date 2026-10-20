import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { PORTAL } from './data';

interface Bundle {
  lang: string;
  dir: 'ltr' | 'rtl';
  strings: Record<string, string>;
  languages: { code: string; name: string; dir: string }[];
}

/** Portal labels the server bundle does not carry. */
const EXTRA: Record<string, Record<string, string>> = {
  en: {
    'search.button': 'Search',
    'nav.catalog': 'Request something',
    'nav.knowledge': 'Knowledge',
    'nav.report': 'Report an issue',
    'nav.workspace': 'Agent workspace',
    'home.eyebrow': 'Employee portal',
    'home.subtitle': 'Report an issue, request what you need or find an answer. We keep you posted every step of the way.',
    'home.open_tickets': 'Open tickets',
    'home.approvals': 'Approvals',
    'home.surveys': 'Surveys',
    'catalog.subtitle': 'Devices, software and access, delivered to you.',
    'catalog.categories': 'Categories',
    'catalog.items': '{n} items',
    'item.quantity': 'Quantity',
    'item.price': 'Price',
    'item.delivery': 'Delivery',
    'item.required': 'Fill in the required fields: {fields}',
    'item.done': 'Submitted {number}',
    'kb.subtitle': 'Guides and answers written by the teams who support you.',
    'kb.popular': 'Popular articles',
    'kb.helpful': 'Was this article helpful?',
    'kb.yes': 'Yes',
    'kb.no': 'No',
    'kb.thanks': 'Thanks for your feedback',
    'kb.views': '{n} views',
    'kb.related': 'Related articles',
    'report.subtitle': 'Tell us what is not working or what you need. We route it to the right team.',
    'report.topic': 'Topic (optional)',
    'report.title_label': 'Short summary (optional)',
    'todos.approvals': 'Approvals waiting on you',
    'todos.empty': 'Nothing needs your attention right now.',
    'ticket.no_activity': 'No comments yet.',
    'ticket.placeholder': 'Write a comment…',
    'common.back': 'Back',
    'common.view': 'View',
  },
  ar: {
    'search.button': 'بحث',
    'nav.catalog': 'طلب خدمة',
    'nav.knowledge': 'قاعدة المعرفة',
    'nav.report': 'الإبلاغ عن مشكلة',
    'nav.workspace': 'مساحة عمل الدعم',
    'home.eyebrow': 'بوابة الموظفين',
    'home.subtitle': 'أبلغ عن مشكلة أو اطلب ما تحتاجه أو ابحث عن إجابة، وسنُطلعك على كل خطوة.',
    'home.open_tickets': 'تذاكر مفتوحة',
    'home.approvals': 'الموافقات',
    'home.surveys': 'الاستبيانات',
    'catalog.subtitle': 'الأجهزة والبرامج والصلاحيات، تصلك حيث أنت.',
    'catalog.categories': 'الفئات',
    'catalog.items': '{n} عناصر',
    'item.quantity': 'الكمية',
    'item.price': 'السعر',
    'item.delivery': 'مدة التسليم',
    'item.required': 'يرجى تعبئة الحقول المطلوبة: {fields}',
    'item.done': 'تم إرسال {number}',
    'kb.subtitle': 'أدلة وإجابات كتبتها الفرق التي تدعمك.',
    'kb.popular': 'المقالات الأكثر قراءة',
    'kb.helpful': 'هل كانت هذه المقالة مفيدة؟',
    'kb.yes': 'نعم',
    'kb.no': 'لا',
    'kb.thanks': 'شكراً لملاحظاتك',
    'kb.views': '{n} مشاهدة',
    'kb.related': 'مقالات ذات صلة',
    'report.subtitle': 'أخبرنا بما لا يعمل أو بما تحتاجه، وسنوجّهه إلى الفريق المناسب.',
    'report.topic': 'الموضوع (اختياري)',
    'report.title_label': 'ملخص قصير (اختياري)',
    'todos.approvals': 'موافقات بانتظارك',
    'todos.empty': 'لا شيء يحتاج إلى انتباهك الآن.',
    'ticket.no_activity': 'لا توجد تعليقات بعد.',
    'ticket.placeholder': 'اكتب تعليقاً…',
    'common.back': 'رجوع',
    'common.view': 'عرض',
  },
};

const KEY = 'portal.lang';

interface I18n {
  lang: string;
  dir: 'ltr' | 'rtl';
  t: (key: string, vars?: Record<string, string | number>) => string;
  setLang: (lang: string) => Promise<void>;
  languages: { code: string; name: string }[];
}

const I18nContext = createContext<I18n | null>(null);

function stored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Loads the portal's UI strings and applies the language direction to the page. */
export function I18nProvider({ children, initial, lang: fixed }: { children: ReactNode; initial?: string; lang?: string }) {
  const qc = useQueryClient();
  const [chosen, setLangState] = useState(() => stored() ?? initial ?? 'en');
  useEffect(() => {
    if (!stored() && initial) setLangState(initial);
  }, [initial]);
  // A fixed language (the portal currently ships in English only) wins over stored choices.
  const lang = fixed ?? chosen;
  const bundle = useQuery({
    queryKey: ['portal', 'i18n', lang],
    queryFn: async () => (await api.get<{ result: Bundle }>(`${PORTAL}/i18n/${lang}`)).result,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const dir = bundle.data?.dir ?? (lang === 'ar' ? 'rtl' : 'ltr');

  useEffect(() => {
    const root = document.documentElement;
    root.dir = dir;
    root.lang = lang;
    return () => {
      root.dir = 'ltr';
      root.lang = 'en';
    };
  }, [dir, lang]);

  const setLang = useCallback(
    async (next: string) => {
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* storage unavailable */
      }
      setLangState(next);
      await api.post(`${PORTAL}/language`, { lang: next }).catch(() => undefined);
      // Badges, greetings and module names are rendered by the server in the user's language.
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'portal' && q.queryKey[1] !== 'i18n' });
    },
    [qc],
  );

  const value = useMemo<I18n>(() => {
    const strings = bundle.data?.strings ?? {};
    const extra = EXTRA[lang] ?? EXTRA.en;
    return {
      lang,
      dir,
      setLang,
      languages: bundle.data?.languages ?? [
        { code: 'en', name: 'English' },
        { code: 'ar', name: 'العربية' },
      ],
      t: (key, vars) => {
        let s = strings[key] ?? extra[key] ?? EXTRA.en[key] ?? key;
        for (const [k, v] of Object.entries(vars ?? {})) s = s.replaceAll(`{${k}}`, String(v));
        return s;
      },
    };
  }, [bundle.data, lang, dir, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}
