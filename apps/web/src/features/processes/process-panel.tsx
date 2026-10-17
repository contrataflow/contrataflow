'use client';

import { Skeleton } from '@contrataflow/ui';
import type { ProcessDto } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { formatDateTime, formatMoney } from '@/lib/i18n/format';
import { useShellSession } from '@/lib/session/session-context';

import { ProcessStatusBadge } from './process-status-badge';
import { fetchProcess, processKeys } from './processes.api';
import { AttachmentsSection } from '../attachments/attachments-section';
import { AvailableActionsPanel } from '../process-actions/available-actions-panel';
import { TimelineFeed } from '../timeline/timeline-feed';

const TABS = ['summary', 'timeline'] as const;
type PanelTab = (typeof TABS)[number];

/**
 * Abas do painel (SCR-006): por ora "Resumo" e "Timeline" (US-060); as demais (Documentos, Itens,
 * Tramitação, Comentários, Participantes) chegam com as stories do painel (US-004). Padrão WAI-ARIA
 * de abas: setas e Home/End movem o foco e ativam a aba.
 */
function PanelTabs({
  active,
  onChange,
  idPrefix,
}: {
  readonly active: PanelTab;
  readonly onChange: (tab: PanelTab) => void;
  readonly idPrefix: string;
}) {
  const t = useTranslations('processes.panel.tabs');
  const refs = useRef<Partial<Record<PanelTab, HTMLButtonElement | null>>>({});
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.indexOf(active);
    const moves: Record<string, number> = {
      ArrowRight: (index + 1) % TABS.length,
      ArrowLeft: (index - 1 + TABS.length) % TABS.length,
      Home: 0,
      End: TABS.length - 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const tab = TABS[next] ?? 'summary';
    onChange(tab);
    refs.current[tab]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={t('label')}
      className="flex gap-1 overflow-x-auto border-b border-border"
    >
      {TABS.map((tab) => (
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
              ? '-mb-px border-b-2 border-primary px-3 py-2 text-sm font-medium text-primary'
              : '-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
          }
          onKeyDown={onKeyDown}
          onClick={() => {
            onChange(tab);
          }}
        >
          {t(tab)}
        </button>
      ))}
    </div>
  );
}

/** Tipos de documento da etapa que têm texto próprio de "próximo passo" (mensagens `panel.next`). */
const NEXT_STEP_DOCUMENTS = ['DFD'] as const;

export type NextStep =
  | { readonly kind: 'document'; readonly code: (typeof NEXT_STEP_DOCUMENTS)[number] }
  | { readonly kind: 'instructions'; readonly text: string }
  | { readonly kind: 'none' };

/**
 * Próximo passo da etapa atual (SCR-006 · `NextStepCard`): o texto do primeiro tipo de documento
 * elaborado na etapa que tenha mensagem própria (ex.: `DFD`); senão, a orientação da etapa
 * (`instructions`); senão, nada.
 */
export function nextStepOf(stage: ProcessDto['currentStage']): NextStep {
  if (!stage) return { kind: 'none' };
  const code = NEXT_STEP_DOCUMENTS.find((candidate) => stage.documentTypeCodes.includes(candidate));
  if (code) return { kind: 'document', code };
  const text = stage.instructions?.trim();
  return text ? { kind: 'instructions', text } : { kind: 'none' };
}

function Card({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card"
    >
      <h2 id={headingId} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Rows({ rows }: { readonly rows: readonly { label: string; value: string }[] }) {
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function isoDate(value: string): string {
  return value.split('-').reverse().join('/');
}

/**
 * Painel mínimo do processo (SCR-006 · US-001): cabeçalho com código (ou "Rascunho (sem número)"),
 * título e situação; "Onde está", "Próximo passo" (ex.: "Elabore o DFD para formalizar a demanda.")
 * e as ações disponíveis da US-041, na aba "Resumo"; a aba "Timeline" é a da US-060. As demais
 * abas/cartões chegam com as stories do painel (US-004). 404/5xx vão ao `error.tsx` do segmento.
 */
export function ProcessPanel({ processId }: { readonly processId: string }) {
  const t = useTranslations('processes');
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const timeZone = session.activeTenant.timezone;
  const tabsId = useId();
  const [tab, setTab] = useState<PanelTab>('summary');
  const query = useQuery({
    queryKey: processKeys.detail(tenantId, processId),
    queryFn: ({ signal }) => fetchProcess(processId, signal),
    refetchOnWindowFocus: true,
  });

  if (!query.data) {
    return (
      <div role="status" className="flex flex-col gap-4">
        <span className="sr-only">{t('panel.loading')}</span>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-96 max-w-full" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      </div>
    );
  }

  const process = query.data;
  const stage = process.currentStage;
  const next = nextStepOf(stage);
  const none = t('panel.data.none');

  let nextBody: ReactNode;
  if (next.kind === 'document') {
    nextBody = <p className="text-sm">{t(`panel.next.documents.${next.code}`)}</p>;
  } else if (next.kind === 'instructions') {
    nextBody = <p className="text-sm whitespace-pre-line">{next.text}</p>;
  } else {
    nextBody = <p className="text-sm text-muted-foreground">{t('panel.next.none')}</p>;
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-2">
        <Link href="/processos" className="text-sm text-primary underline">
          {t('panel.backToList')}
        </Link>
        <p className="text-sm font-medium text-muted-foreground">
          {process.code ?? t('panel.noNumber')}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight break-words">{process.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <ProcessStatusBadge status={process.status} />
          <span className="text-sm text-muted-foreground">
            {t('panel.priority', { priority: t(`priorities.${process.priority}`) })}
          </span>
        </div>
      </header>

      <PanelTabs active={tab} onChange={setTab} idPrefix={tabsId} />

      {tab === 'timeline' ? (
        <div
          role="tabpanel"
          id={`${tabsId}-panel-timeline`}
          aria-labelledby={`${tabsId}-tab-timeline`}
          className="min-w-0"
        >
          <TimelineFeed processId={processId} />
        </div>
      ) : (
        <div
          role="tabpanel"
          id={`${tabsId}-panel-summary`}
          aria-labelledby={`${tabsId}-tab-summary`}
          className="flex min-w-0 flex-col gap-6"
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Card title={t('panel.where.title')}>
              {stage ? (
                <Rows
                  rows={[
                    { label: t('panel.where.stage'), value: stage.name },
                    { label: t('panel.where.department'), value: process.currentDepartment.name },
                    {
                      label: t('panel.where.responsible'),
                      value: process.currentResponsible?.name ?? t('panel.where.noResponsible'),
                    },
                    {
                      label: t('panel.where.dueAt'),
                      value: stage.dueAt
                        ? formatDateTime(stage.dueAt, timeZone)
                        : t('panel.where.noDueAt'),
                    },
                    ...(process.targetDate
                      ? [{ label: t('panel.where.targetDate'), value: isoDate(process.targetDate) }]
                      : []),
                  ]}
                />
              ) : (
                <p className="text-sm text-muted-foreground">{t('panel.where.noStage')}</p>
              )}
            </Card>
            <Card title={t('panel.next.title')}>{nextBody}</Card>
          </div>

          <AvailableActionsPanel processId={processId} />

          <Card title={t('panel.data.title')}>
            <Rows
              rows={[
                { label: t('panel.data.object'), value: process.object },
                { label: t('panel.data.contractingType'), value: process.contractingType.label },
                {
                  label: t('panel.data.modality'),
                  value: process.modality?.label ?? t('panel.data.undefinedModality'),
                },
                { label: t('panel.data.origin'), value: process.origin.label },
                {
                  label: t('panel.data.workflow'),
                  value: t('panel.data.workflowValue', {
                    name: process.workflow.name,
                    version: process.workflow.versionNumber,
                  }),
                },
                {
                  label: t('panel.data.estimatedValue'),
                  value: process.estimatedValueMasked
                    ? t('panel.data.masked')
                    : process.estimatedValue
                      ? formatMoney(process.estimatedValue)
                      : none,
                },
              ]}
            />
          </Card>

          {/* US-068: anexos do processo (alvo `PROCESS`); a lista completa é da US-069. */}
          <AttachmentsSection targetType="PROCESS" targetId={processId} />
        </div>
      )}
    </div>
  );
}
