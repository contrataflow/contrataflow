'use client';

import { Skeleton, cx } from '@contrataflow/ui';
import type { ProcessStageEntryDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

import { formatDate } from '@/lib/i18n/format';

import { PanelError } from '../process-actions/panel-error';

/** Etapas consecutivas com o mesmo `groupLabel` (RN-PROC-52: agrupadas na ordem do workflow). */
export function groupStages(
  stages: readonly ProcessStageEntryDto[],
): { readonly label: string | null; readonly stages: ProcessStageEntryDto[] }[] {
  const groups: { label: string | null; stages: ProcessStageEntryDto[] }[] = [];
  for (const stage of stages) {
    const last = groups.at(-1);
    if (last?.label === stage.groupLabel) last.stages.push(stage);
    else groups.push({ label: stage.groupLabel, stages: [stage] });
  }
  return groups;
}

const MARKS: Readonly<Record<string, string>> = {
  COMPLETED: '✓',
  RETURNED: '↩',
  CANCELED: '×',
  ACTIVE: '●',
};

function StageItem({
  stage,
  timeZone,
}: {
  readonly stage: ProcessStageEntryDto;
  readonly timeZone: string;
}) {
  const t = useTranslations('processes.panel.stepper');
  const status = stage.lastPassStatus;
  const sla =
    stage.slaDays === null
      ? null
      : t(stage.slaType === 'CALENDAR' ? 'slaCalendar' : 'sla', { days: stage.slaDays });
  return (
    <li
      aria-current={stage.isCurrent ? 'step' : undefined}
      className={cx(
        'flex min-w-0 flex-col gap-1 rounded-control border p-2 text-sm md:min-w-40',
        stage.isCurrent ? 'border-primary bg-primary-soft' : 'border-border',
      )}
    >
      <span className="flex items-center gap-2 font-medium">
        <span
          aria-hidden="true"
          className={cx(
            'grid size-5 flex-none place-items-center rounded-full border text-xs',
            status === null ? 'border-border text-muted-foreground' : 'border-primary text-primary',
          )}
        >
          {status === null ? '' : (MARKS[status] ?? '')}
        </span>
        {stage.name}
      </span>
      <span className="text-xs text-muted-foreground">
        {stage.isCurrent ? `${t('current')} · ` : ''}
        {status === null ? t('notStarted') : t(`statuses.${status}`)}
        {status === null && sla ? ` · ${sla}` : ''}
      </span>
      {stage.passes.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-primary">
            {t('passes', { count: stage.passes.length })}
          </summary>
          <ol className="mt-1 flex flex-col gap-1">
            {stage.passes.map((pass) => (
              <li key={pass.processStageId}>
                {t('pass', {
                  sequence: pass.sequence,
                  department: pass.department.name,
                  entered: formatDate(pass.enteredAt, timeZone),
                })}
                {pass.exitedAt
                  ? ` · ${t('exited', { date: formatDate(pass.exitedAt, timeZone) })}`
                  : ''}
                {` · ${t(`statuses.${pass.status}`)}`}
                {pass.assignee ? ` · ${t('assignee', { name: pass.assignee.name })}` : ''}
                {pass.dueDateOverridden ? ` · ${t('overridden')}` : ''}
                {pass.overdueSince
                  ? ` · ${t('overdue', { date: formatDate(pass.overdueSince, timeZone) })}`
                  : ''}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </li>
  );
}

export interface StageStepperProps {
  readonly stages: readonly ProcessStageEntryDto[] | undefined;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly timeZone: string;
}

/**
 * `StageStepper` (SCR-006 · RN-PROC-52 · PRC-10): lista ordenada das etapas da versão fixada,
 * agrupadas por `groupLabel`, a atual com `aria-current="step"` e as passagens (idas e voltas) em
 * detalhe recolhível. Horizontal no desktop; vertical e recolhível no mobile (FA-12).
 */
export function StageStepper({ stages, isPending, error, onRetry, timeZone }: StageStepperProps) {
  const t = useTranslations('processes.panel.stepper');
  const headingId = useId();
  let body;
  if (stages === undefined && isPending) {
    body = <Skeleton className="h-16 w-full" />;
  } else if (stages === undefined) {
    body = <PanelError error={error} onRetry={onRetry} />;
  } else {
    body = (
      <details open className="group md:[&>summary]:hidden">
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground md:hidden">
          {t('toggle')}
        </summary>
        <ol className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-start">
          {groupStages(stages).map((group, index) => (
            <li
              key={`${String(index)}:${group.label ?? ''}`}
              className="flex min-w-0 flex-col gap-1"
            >
              {group.label ? (
                <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {group.label}
                </span>
              ) : null}
              <ol className="flex flex-col gap-2 md:flex-row">
                {group.stages.map((stage) => (
                  <StageItem key={stage.workflowStageId} stage={stage} timeZone={timeZone} />
                ))}
              </ol>
            </li>
          ))}
        </ol>
      </details>
    );
  }
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <h2 id={headingId} className="text-base font-semibold">
        {t('title')}
      </h2>
      {body}
    </section>
  );
}
