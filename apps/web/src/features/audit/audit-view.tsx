'use client';

import { Alert, Skeleton, cx } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import { AuditRecordsTab } from './audit-records-tab';
import { AuditSealsTab } from './audit-seals-tab';

export type AuditTab = 'records' | 'seals';

const TABS: readonly AuditTab[] = ['records', 'seals'];

export interface AuditViewProps {
  /** Aba aberta ao entrar; padrão "Registros" (SCR-037). */
  readonly defaultTab?: AuditTab;
}

/**
 * SCR-037 — Auditoria (`/auditoria`): acesso por `AUDIT_VIEW` (a API decide cada requisição; aqui
 * só se evita mostrar a tela a quem não tem a permissão — RN-FND-92). Abas "Registros" (US-075,
 * padrão — consulta, detalhe e exportação) e "Selos" (US-074), com setas/Home/End entre as abas.
 */
export function AuditView({ defaultTab = 'records' }: AuditViewProps) {
  const t = useTranslations('audit');
  const tenantId = useTenantId();
  const { allowed, status } = usePermission('AUDIT_VIEW');
  const [tab, setTab] = useState<AuditTab>(defaultTab);
  const tabRefs = useRef<Partial<Record<AuditTab, HTMLButtonElement | null>>>({});

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.indexOf(tab);
    const target =
      event.key === 'ArrowRight'
        ? TABS[(index + 1) % TABS.length]
        : event.key === 'ArrowLeft'
          ? TABS[(index - 1 + TABS.length) % TABS.length]
          : event.key === 'Home'
            ? TABS[0]
            : event.key === 'End'
              ? TABS.at(-1)
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    setTab(target);
    tabRefs.current[target]?.focus();
  };

  return (
    <section className="flex min-w-0 flex-col gap-6">
      <AppPageHeader title={t('title')} description={t('description')} />

      {status === 'pending' ? (
        <div role="status" className="flex flex-col gap-3">
          <span className="sr-only">{t('loadingPermission')}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : null}

      {status !== 'pending' && !allowed ? (
        <Alert tone="error" title={t('forbidden.title')}>
          {t('forbidden.description')}
        </Alert>
      ) : null}

      {allowed ? (
        <div className="flex min-w-0 flex-col gap-4">
          <div
            role="tablist"
            aria-label={t('tabs.label')}
            className="flex gap-2 border-b border-border"
          >
            {TABS.map((item) => (
              <button
                key={item}
                ref={(element) => {
                  tabRefs.current[item] = element;
                }}
                type="button"
                role="tab"
                id={`audit-tab-${item}`}
                aria-selected={tab === item}
                aria-controls={`audit-panel-${item}`}
                tabIndex={tab === item ? 0 : -1}
                onClick={() => {
                  setTab(item);
                }}
                onKeyDown={moveFocus}
                className={cx(
                  'border-b-2 px-3 py-2 text-sm font-medium',
                  tab === item
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`tabs.${item}`)}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`audit-panel-${tab}`} aria-labelledby={`audit-tab-${tab}`}>
            {/* `key` por instituição: filtros, seleção e resultados nunca atravessam a troca de tenant. */}
            {tab === 'records' ? (
              <AuditRecordsTab key={tenantId} />
            ) : (
              <AuditSealsTab key={tenantId} />
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
