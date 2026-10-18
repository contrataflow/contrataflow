'use client';

import { cx } from '@contrataflow/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { AiAssistant } from '@/features/ai/ai-assistant';
import { useShellSession } from '@/lib/session/session-context';

import { RiskList } from './risk-list';
import { RiskMatrixPanel } from './risk-matrix-panel';
import { useRisks } from './risks.api';
import { useInvalidateProcess } from '../process-panel/process-panel.api';
import { fetchProcess, processKeys } from '../processes/processes.api';

const TABS = ['list', 'matrix'] as const;
type Tab = (typeof TABS)[number];

/**
 * SCR-011 — Riscos (`/processos/[id]/riscos`): cabeçalho com o processo e as abas "Lista de riscos"
 * (US-033/US-034) e "Matriz" (US-035 — grade de calor e Mapa de Riscos). Abas no padrão WAI-ARIA
 * (setas, Home/End); a matriz leva de volta à lista com o risco aberto. US-119: "Gerar rascunho com
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
  const id = useId();
  const [tab, setTab] = useState<Tab>('list');
  const [focusRiskId, setFocusRiskId] = useState<string | null>(null);
  const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const detail = useQuery({
    queryKey: processKeys.detail(session.activeTenant.id, processId),
    queryFn: ({ signal }) => fetchProcess(processId, signal),
    throwOnError: false,
  });
  const risks = useRisks(processId);
  const invalidate = useInvalidateProcess(processId);
  const meta = risks.data?.meta;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.indexOf(tab);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    const target = TABS[next] ?? 'list';
    setTab(target);
    refs.current[target]?.focus();
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link href={`/processos/${processId}`} className="text-sm text-primary underline">
          {t('backToProcess')}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          {meta === undefined ? null : (
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
          )}
        </div>
        {detail.data === undefined ? null : (
          <p className="text-sm text-muted-foreground">
            {t('processLine', {
              code: detail.data.code ?? t('draftCode'),
              title: detail.data.title,
            })}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <div
          role="tablist"
          aria-label={t('tabs.label')}
          className="flex gap-1 overflow-x-auto border-b border-border"
        >
          {TABS.map((candidate) => (
            <button
              key={candidate}
              ref={(element) => {
                refs.current[candidate] = element;
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${candidate}`}
              aria-selected={tab === candidate}
              aria-controls={`${id}-panel`}
              tabIndex={tab === candidate ? 0 : -1}
              onKeyDown={onKeyDown}
              className={cx(
                'min-h-10 px-4 text-sm font-medium whitespace-nowrap',
                tab === candidate
                  ? 'border-b-2 border-primary text-foreground'
                  : 'text-muted-foreground',
              )}
              onClick={() => {
                setTab(candidate);
              }}
            >
              {candidate === 'list' ? t('listSection') : t('matrixSection')}
            </button>
          ))}
        </div>
        <section
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-tab-${tab}`}
          className="flex min-w-0 flex-col gap-3"
        >
          {tab === 'list' ? (
            <RiskList
              processId={processId}
              focusRiskId={focusRiskId}
              onFocused={() => {
                setFocusRiskId(null);
              }}
            />
          ) : (
            <RiskMatrixPanel
              processId={processId}
              onGoToRisk={(riskId) => {
                setFocusRiskId(riskId);
                setTab('list');
              }}
            />
          )}
        </section>
      </div>
    </div>
  );
}
