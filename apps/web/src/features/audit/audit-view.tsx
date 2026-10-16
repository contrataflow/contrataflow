'use client';

import { Alert, Skeleton } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import { AuditSealsTab } from './audit-seals-tab';

/**
 * SCR-037 — Auditoria (`/auditoria`): acesso por `AUDIT_VIEW` (a API decide cada requisição; aqui
 * só se evita mostrar a tela a quem não tem a permissão — RN-FND-92). A aba "Registros" (US-075,
 * padrão da tela) entra antes de "Selos" quando existir; hoje só "Selos" (US-074) está implementada.
 */
export function AuditView() {
  const t = useTranslations('audit');
  const tenantId = useTenantId();
  const { allowed, status } = usePermission('AUDIT_VIEW');

  return (
    <section className="flex min-w-0 flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-muted-foreground">{t('description')}</p>
      </header>

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
          {/* Abas de SCR-037: "Registros" (US-075) entra aqui; "Selos" (US-074) é a única hoje. */}
          <div
            role="tablist"
            aria-label={t('tabs.label')}
            className="flex gap-2 border-b border-border"
          >
            <button
              type="button"
              role="tab"
              id="audit-tab-seals"
              aria-selected="true"
              aria-controls="audit-panel-seals"
              className="border-b-2 border-primary px-3 py-2 text-sm font-medium"
            >
              {t('tabs.seals')}
            </button>
          </div>
          <div role="tabpanel" id="audit-panel-seals" aria-labelledby="audit-tab-seals">
            {/* `key` por instituição: seleção e resultado nunca atravessam a troca de tenant. */}
            <AuditSealsTab key={tenantId} />
          </div>
        </div>
      ) : null}
    </section>
  );
}
