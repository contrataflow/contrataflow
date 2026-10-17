'use client';

import { Alert, Button, Skeleton, toast } from '@contrataflow/ui';
import { PROCESS_PANEL_TABS, processPanelTabOf } from '@contrataflow/validation';
import type { ProcessPanelTab, ProcessSummaryDto } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useShellSession } from '@/lib/session/session-context';

import { ProcessActionBar } from './process-action-bar';
import { ProcessDataCard } from './process-data-card';
import { ProcessHeader } from './process-header';
import {
  isStaleProcessError,
  panelRefetchInterval,
  useInvalidateProcess,
  useProcessStages,
  useProcessSummary,
} from './process-panel.api';
import { SituationalPanel } from './situational-panel';
import { StageStepper } from './stage-stepper';
import { AttachmentsSection } from '../attachments/attachments-section';
import { useAvailableActions } from '../process-actions/process-actions.api';
import { fetchProcess, processKeys } from '../processes/processes.api';
import { TimelineFeed } from '../timeline/timeline-feed';

/** Contador da aba (RN-PROC-57): documentos, itens, comentários e participantes vêm do resumo. */
const COUNTED: Partial<Record<ProcessPanelTab, keyof ProcessSummaryDto['counts']>> = {
  documentos: 'documents',
  itens: 'items',
  comentarios: 'comments',
  participantes: 'participants',
};

/**
 * `ProcessTabs` (RN-PROC-57 · V-06): aba ativa na URL (`?aba=`), roláveis no mobile, padrão
 * WAI-ARIA (setas e Home/End movem o foco e ativam a aba).
 */
function ProcessTabs({
  active,
  counts,
  onChange,
  idPrefix,
}: {
  readonly active: ProcessPanelTab;
  readonly counts: ProcessSummaryDto['counts'];
  readonly onChange: (tab: ProcessPanelTab) => void;
  readonly idPrefix: string;
}) {
  const t = useTranslations('processes.panel.tabs');
  const refs = useRef<Partial<Record<ProcessPanelTab, HTMLButtonElement | null>>>({});
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = PROCESS_PANEL_TABS.indexOf(active);
    const last = PROCESS_PANEL_TABS.length - 1;
    const moves: Record<string, number> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const tab = PROCESS_PANEL_TABS[next] ?? 'resumo';
    onChange(tab);
    refs.current[tab]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={t('label')}
      className="flex gap-1 overflow-x-auto border-b border-border"
    >
      {PROCESS_PANEL_TABS.map((tab) => {
        const counted = COUNTED[tab];
        const label =
          counted === undefined || counts[counted] === 0
            ? t(tab)
            : t('count', { label: t(tab), count: counts[counted] });
        return (
          <button
            key={tab}
            ref={(element) => {
              refs.current[tab] = element;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab}`}
            aria-selected={active === tab}
            aria-controls={`${idPrefix}-panel-${tab}`}
            tabIndex={active === tab ? 0 : -1}
            className={
              active === tab
                ? '-mb-px border-b-2 border-primary px-3 py-2 text-sm font-medium whitespace-nowrap text-primary'
                : '-mb-px border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground'
            }
            onKeyDown={onKeyDown}
            onClick={() => {
              onChange(tab);
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Primeira carga: skeleton por bloco (o painel aparece progressivamente — DEC-181). */
function PanelSkeleton() {
  const t = useTranslations('processes.panel');
  return (
    <div role="status" className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-8 w-96 max-w-full" />
      <Skeleton className="h-10 w-64 max-w-full" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 7 }, (_, index) => (
          <Skeleton key={index} className="h-32" />
        ))}
      </div>
    </div>
  );
}

/** FA-01 (404 → "não encontrado ou sem acesso") e banco fora sem cache (503 · "Falha de banco"). */
function PanelFailure({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('processes.panel.errors');
  if (isApiError(error) && error.status === 404) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        <Alert tone="error" title={t('notFound')}>
          <Link href="/processos" className="text-sm text-primary underline">
            {t('backToList')}
          </Link>
        </Alert>
      </div>
    );
  }
  const correlationId = isApiError(error) ? (error.correlationId ?? '—') : '—';
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      <Alert
        tone="error"
        title={isApiError(error) && error.status === 429 ? t('rateLimited') : t('unavailable')}
      >
        <p className="text-sm">{t('code', { correlationId })}</p>
        <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>
          {t('retry')}
        </Button>
      </Alert>
    </div>
  );
}

/**
 * FA-11: comando das stories donas recusado por dado desatualizado (409 `STAGE_CHANGED`, 412
 * `VERSION_CONFLICT`, 403 `NOT_PROCESS_CUSTODIAN`) — avisa e recarrega o painel. `recover` devolve
 * se tratou o erro (o diálogo da story dona decide o resto).
 */
export function useStaleProcessRecovery(processId: string) {
  const invalidate = useInvalidateProcess(processId);
  const [conflict, setConflict] = useState(false);
  const recover = useCallback(
    (error: unknown): boolean => {
      if (!isStaleProcessError(error)) return false;
      setConflict(true);
      void invalidate();
      return true;
    },
    [invalidate],
  );
  return {
    conflict,
    recover,
    dismiss: () => {
      setConflict(false);
    },
  };
}

/** Conteúdo das abas cujas stories donas ainda não entregaram a lista (carregado sob demanda). */
function SoonPanel({ tab }: { readonly tab: Exclude<ProcessPanelTab, 'resumo' | 'timeline'> }) {
  const t = useTranslations('processes.panel.tabs.soon');
  return <p className="text-sm text-muted-foreground">{t(tab)}</p>;
}

/**
 * SCR-006 — Detalhe do processo (US-004): cabeçalho, barra de ações (ação primária + "Mais"),
 * stepper das etapas, painel situacional com as 7 perguntas (PRC-07) e as abas Resumo, Documentos,
 * Itens, Tramitação, Timeline, Comentários e Participantes (`?aba=`). PRC-04/07/08/10 em paralelo;
 * cada bloco falha sozinho; banco fora com dados em cache mostra o aviso e desabilita as ações.
 */
export function ProcessPanel({ processId }: { readonly processId: string }) {
  const t = useTranslations('processes.panel');
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const timeZone = session.activeTenant.timezone;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabsId = useId();
  const tab = processPanelTabOf(searchParams.get('aba'));
  const summary = useProcessSummary(processId);
  const stages = useProcessStages(processId);
  const actions = useAvailableActions(processId);
  const detail = useQuery({
    queryKey: processKeys.detail(tenantId, processId),
    queryFn: ({ signal }) => fetchProcess(processId, signal),
    refetchOnWindowFocus: true,
    refetchInterval: panelRefetchInterval,
    throwOnError: false,
  });
  const stale = useStaleProcessRecovery(processId);

  const changeTab = (next: ProcessPanelTab) => {
    router.replace(next === 'resumo' ? pathname : `${pathname}?aba=${next}`, { scroll: false });
  };

  if (summary.data === undefined) {
    if (summary.isPending) return <PanelSkeleton />;
    return (
      <PanelFailure
        error={summary.error}
        onRetry={() => {
          void summary.refetch();
        }}
      />
    );
  }

  const data = summary.data;
  const frozen = summary.isError;
  const updatedAt = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short', timeZone }).format(
    new Date(summary.dataUpdatedAt),
  );

  let content: ReactNode;
  if (tab === 'resumo') {
    content = (
      <div className="flex min-w-0 flex-col gap-6">
        <SituationalPanel summary={data} processId={processId} timeZone={timeZone} />
        <ProcessDataCard query={detail} />
        {/* US-068: anexos do processo (alvo `PROCESS`); a lista completa é da US-069. */}
        <AttachmentsSection targetType="PROCESS" targetId={processId} />
      </div>
    );
  } else if (tab === 'timeline') {
    content = <TimelineFeed processId={processId} />;
  } else {
    content = <SoonPanel tab={tab} />;
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6 pb-24 md:pb-0">
      <ProcessHeader header={data.header} />
      {frozen ? (
        <Alert tone="warning" title={t('actions.stale', { time: updatedAt })}>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => {
              void summary.refetch();
            }}
          >
            {t('errors.retry')}
          </Button>
        </Alert>
      ) : null}
      {stale.conflict ? <Alert tone="info" title={t('actions.conflict')} /> : null}
      <ProcessActionBar
        summary={data}
        actions={actions.data}
        frozen={frozen}
        onAction={() => {
          toast({ title: t('actions.notYet') });
        }}
      />
      <StageStepper
        stages={stages.data}
        isPending={stages.isPending}
        error={stages.error}
        onRetry={() => {
          void stages.refetch();
        }}
        timeZone={timeZone}
      />
      <ProcessTabs active={tab} counts={data.counts} onChange={changeTab} idPrefix={tabsId} />
      <div
        role="tabpanel"
        id={`${tabsId}-panel-${tab}`}
        aria-labelledby={`${tabsId}-tab-${tab}`}
        className="min-w-0"
      >
        {content}
      </div>
    </div>
  );
}
