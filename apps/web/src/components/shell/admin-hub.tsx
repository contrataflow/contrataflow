'use client';

import {
  Building2,
  CalendarDays,
  ClipboardList,
  FileText,
  LayoutTemplate,
  Settings,
  ShieldCheck,
  Users,
  Workflow,
} from '@contrataflow/ui';
import type { IconComponent } from '@contrataflow/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { usePermission } from '@/lib/permissions/use-permission';

import { ADMIN_NAV } from './navigation';
import type { AdminNavItem } from './navigation';
import { AppPageHeader } from './page-header';

/** Grupos do hub (prd-5 · card 8): quem acessa, como a instituição se organiza, o que ela produz. */
type AdminGroup = 'people' | 'structure' | 'documents' | 'system';

const ADMIN_GROUPS: readonly AdminGroup[] = ['people', 'structure', 'documents', 'system'];

const AREAS: Readonly<
  Record<AdminNavItem['labelKey'], { readonly group: AdminGroup; readonly icon: IconComponent }>
> = {
  users: { group: 'people', icon: Users },
  roles: { group: 'people', icon: ShieldCheck },
  structure: { group: 'structure', icon: Building2 },
  calendar: { group: 'structure', icon: CalendarDays },
  templates: { group: 'documents', icon: LayoutTemplate },
  workflows: { group: 'documents', icon: Workflow },
  documentTypes: { group: 'documents', icon: FileText },
  catalogs: { group: 'documents', icon: ClipboardList },
  settings: { group: 'system', icon: Settings },
};

/**
 * Entrada da administração (`/admin` · prd-6 §2.6, padrão do Microlegis): rótulos de grupo em caixa
 * alta (Pessoas e acesso · Estrutura · Documentos e fluxos · Sistema) e cartões com borda em até três
 * colunas, cada um com ícone em quadrado `primary-soft`, título e uma frase — o cartão inteiro é o
 * link, sem chevron. A mesma lista e as mesmas permissões da navegação de administração (`ADMIN_NAV`).
 */
export function AdminHub() {
  const t = useTranslations('shell.admin');
  return (
    <div className="flex max-w-[63rem] flex-col gap-7">
      <AppPageHeader title={t('title')} description={t('description')} />
      {ADMIN_GROUPS.map((group) => (
        <section
          key={group}
          aria-labelledby={`admin-grupo-${group}`}
          className="flex flex-col gap-3"
        >
          <h2
            id={`admin-grupo-${group}`}
            className="text-[0.6875rem] font-bold tracking-[0.12em] text-muted-foreground uppercase"
          >
            {t(`hub.groups.${group}`)}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {ADMIN_NAV.filter((item) => AREAS[item.labelKey].group === group).map((item) =>
              item.permission ? (
                <GatedAreaCard key={item.href} item={item} />
              ) : (
                <AreaCard key={item.href} item={item} />
              ),
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AreaCard({ item }: { readonly item: AdminNavItem }) {
  const t = useTranslations('shell.admin');
  const Icon = AREAS[item.labelKey].icon;
  return (
    <li>
      <Link
        href={item.href}
        className="flex h-full items-start gap-3.5 rounded-card bg-surface p-4 shadow-card transition-shadow hover:shadow-[var(--shadow-card),0_6px_16px_-6px_rgb(15_23_42/0.18)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="flex size-9 flex-none items-center justify-center rounded-control bg-primary-soft text-primary-soft-foreground">
          <Icon aria-hidden="true" className="size-[1.125rem]" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[0.9375rem] leading-snug font-bold text-foreground">
            {t(item.labelKey)}
          </span>
          <span className="text-[0.8125rem] leading-snug text-muted-foreground">
            {t(`hub.descriptions.${item.labelKey}`)}
          </span>
        </span>
      </Link>
    </li>
  );
}

/** Área que exige permissão: o cartão some quando a API confirma que falta (RN-FND-92). */
function GatedAreaCard({ item }: { readonly item: AdminNavItem }) {
  const { allowed, status } = usePermission(item.permission ?? '');
  if (status === 'success' && !allowed) return null;
  return <AreaCard item={item} />;
}
