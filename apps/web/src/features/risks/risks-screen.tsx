'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@contrataflow/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';
import { AiAssistant } from '@/features/ai/ai-assistant';
import { useShellSession } from '@/lib/session/session-context';

import { RiskList } from './risk-list';
import { RiskMatrixPanel } from './risk-matrix-panel';
import { useRisks } from './risks.api';
import { useInvalidateProcess } from '../process-panel/process-panel.api';
import { fetchProcess, processKeys } from '../processes/processes.api';

type Tab = 'list' | 'matrix';

/**
 * SCR-011 — Riscos (`/processos/[id]/riscos`): cabeçalho com o processo e as abas "Lista de riscos"
 * (US-033/US-034) e "Matriz" (US-035 — grade de calor e Mapa de Riscos). Abas do kit (Radix: setas, Home/End,
 * quebram linha); a matriz leva de volta à lista com o risco aberto. US-119: "Gerar rascunho com
 * IA" (`AiDraftButton` + SCR-117) com a proposta de riscos; `?ia=` abre o painel na geração.
 */
export function RisksScreen({
  processId,
  aiGenerationId = null,
}: {
  readonly processId: string;
  readonly aiGenerationId?: string | null | undefined;
}) {
  const t = useTranslations('risks');
  const session = useShellSession();
  const [tab, setTab] = useState<Tab>('list');
  const [focusRiskId, setFocusRiskId] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: processKeys.detail(session.activeTenant.id, processId),
    queryFn: ({ signal }) => fetchProcess(processId, signal),
    throwOnError: false,
  });
  const risks = useRisks(processId);
  const invalidate = useInvalidateProcess(processId);
  const meta = risks.data?.meta;

  return (
    <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6">
      <AppPageHeader
        breadcrumbs={[
          {
            label:
              detail.data === undefined
                ? t('backToProcess')
                : t('processCrumb', { code: detail.data.code ?? t('draftCode') }),
            href: `/processos/${processId}`,
          },
          { label: t('title') },
        ]}
        title={t('title')}
        description={
          detail.data === undefined
            ? undefined
            : t('processLine', {
                code: detail.data.code ?? t('draftCode'),
                title: detail.data.title,
              })
        }
        actions={
          meta === undefined ? null : (
            <AiAssistant
              processId={processId}
              documentId={meta.riskMap?.id ?? null}
              targetModule="RISK_MAP"
              editable={meta.canManage && meta.lockReason === null}
              initialGenerationId={aiGenerationId}
              riskContext={{
                levelThresholds: meta.levelThresholds,
                existing: (risks.data?.risks ?? []).map((risk) => ({
                  id: risk.id,
                  code: risk.code,
                })),
                onRisksApplied: () => void invalidate(),
              }}
            />
          )
        }
      />
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value as Tab);
        }}
      >
        <TabsList aria-label={t('tabs.label')}>
          <TabsTrigger value="list">{t('listSection')}</TabsTrigger>
          <TabsTrigger value="matrix">{t('matrixSection')}</TabsTrigger>
        </TabsList>
        <TabsContent value="list" className="flex min-w-0 flex-col gap-3">
          <RiskList
            processId={processId}
            focusRiskId={focusRiskId}
            onFocused={() => {
              setFocusRiskId(null);
            }}
          />
        </TabsContent>
        <TabsContent value="matrix" className="flex min-w-0 flex-col gap-3">
          <RiskMatrixPanel
            processId={processId}
            onGoToRisk={(riskId) => {
              setFocusRiskId(riskId);
              setTab('list');
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
