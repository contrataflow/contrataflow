'use client';

import { Alert, ListPage, ViewTabs } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import { AuditRecordsTab } from './audit-records-tab';
import { AuditSealsTab } from './audit-seals-tab';

export type AuditTab = 'records' | 'seals';

const TABS: readonly AuditTab[] = ['records', 'seals'];

/** Painel controlado pelas abas (`aria-controls`). */
const AUDIT_PANEL_ID = 'auditoria-painel';

export interface AuditViewProps {
  /** Aba aberta ao entrar; padrão "Registros" (SCR-037). */
  readonly defaultTab?: AuditTab;
}

/**
 * SCR-037 — Auditoria (`/auditoria`): acesso por `AUDIT_VIEW` (a API decide cada requisição; aqui
 * só se evita mostrar a tela a quem não tem a permissão — RN-FND-92). Abas "Registros" (US-075,
 * padrão — consulta, detalhe e exportação) e "Selos" (US-074) no `ViewTabs` do kit (setas,
 * Home/End), no `ListPage`. "Exportar" é a ação do cabeçalho na aba "Registros" (prd-5 · regra 1):
 * a aba o desenha por portal no espaço de ações do cabeçalho, onde fica o estado da exportação.
 * Cabeçalho e abas ficam fixos na troca de aba (o foco do teclado não se perde).
 */
export function AuditView({ defaultTab = 'records' }: AuditViewProps) {
  const t = useTranslations('audit');
  const tenantId = useTenantId();
  const { allowed, status } = usePermission('AUDIT_VIEW');
  const [tab, setTab] = useState<AuditTab>(defaultTab);
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);

  const header = (actions?: ReactNode) => (
    <AppPageHeader title={t('title')} description={t('description')} actions={actions} />
  );

  if (!allowed) {
    return (
      <ListPage
        header={header()}
        loading={status === 'pending'}
        loadingLabel={t('loadingPermission')}
        error={
          status === 'pending' ? null : (
            <Alert tone="error" title={t('forbidden.title')}>
              {t('forbidden.description')}
            </Alert>
          )
        }
      />
    );
  }

  return (
    <ListPage
      header={header(<div ref={setActionsSlot} className="contents" />)}
      tabs={
        <ViewTabs
          label={t('tabs.label')}
          value={tab}
          panelId={AUDIT_PANEL_ID}
          onValueChange={(id) => {
            setTab(id as AuditTab);
          }}
          tabs={TABS.map((item) => ({ id: item, label: t(`tabs.${item}`) }))}
        />
      }
    >
      <div
        role="tabpanel"
        id={AUDIT_PANEL_ID}
        aria-label={t(`tabs.${tab}`)}
        className="flex min-w-0 flex-col gap-5"
      >
        {/* `key` por instituição: filtros, seleção e resultados nunca atravessam a troca de tenant. */}
        {tab === 'records' ? (
          <AuditRecordsTab key={tenantId} actionsSlot={actionsSlot} />
        ) : (
          <AuditSealsTab key={tenantId} />
        )}
      </div>
    </ListPage>
  );
}
