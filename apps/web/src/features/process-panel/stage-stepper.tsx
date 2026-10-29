'use client';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Skeleton,
  StageProgress,
  cx,
} from '@contrataflow/ui';
import type { ProcessStageEntryDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

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

/**
 * Posição da etapa atual na barra: a marcada como atual; sem ela, todas concluídas (processo
 * encerrado) ou nenhuma começada (rascunho).
 */
export function currentStageIndex(stages: readonly ProcessStageEntryDto[]): number {
  const current = stages.findIndex((stage) => stage.isCurrent);
  if (current >= 0) return current;
  return stages.length > 0 && stages.every((stage) => stage.lastPassStatus === 'COMPLETED')
    ? stages.length
    : -1;
}

const MARKS: Readonly<Record<string, string>> = {
  COMPLETED: '✓',
  RETURNED: '↩',
  CANCELED: '×',
  ACTIVE: '●',
};

/** Marcador colorido por situação da última passagem (o texto ao lado diz a situação). */
const MARK_TONES: Readonly<Record<string, string>> = {
  COMPLETED: 'border-success bg-success-soft text-success-soft-foreground',
  RETURNED: 'border-warning bg-warning-soft text-warning-soft-foreground',
  CANCELED: 'border-destructive bg-destructive-soft text-destructive-soft-foreground',
  ACTIVE: 'border-primary bg-primary text-primary-foreground',
};

function useSlaText(stage: ProcessStageEntryDto): string | null {
  const t = useTranslations('processes.panel.stepper');
  if (stage.slaDays === null) return null;
  return t(stage.slaType === 'CALENDAR' ? 'slaCalendar' : 'sla', { days: stage.slaDays });
}

/** Uma etapa no histórico: situação da última passagem e cada passagem (idas e voltas). */
function StageItem({
  stage,
  timeZone,
}: {
  readonly stage: ProcessStageEntryDto;
  readonly timeZone: string;
}) {
  const t = useTranslations('processes.panel.stepper');
  const status = stage.lastPassStatus;
  const sla = useSlaText(stage);
  return (
    <li className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="flex items-center gap-2 font-medium">
        <span
          aria-hidden="true"
          className={cx(
            'grid size-5 flex-none place-items-center rounded-full border text-xs',
            status === null
              ? 'border-border-strong text-muted-foreground'
              : (MARK_TONES[status] ?? 'border-primary text-primary'),
          )}
        >
          {status === null ? '' : (MARKS[status] ?? '')}
        </span>
        {stage.name}
      </span>
      <span className="pl-7 text-xs text-muted-foreground">
        {stage.isCurrent ? `${t('current')} · ` : ''}
        {status === null ? t('notStarted') : t(`statuses.${status}`)}
        {status === null && sla ? ` · ${sla}` : ''}
        {stage.passes.length > 0 ? ` · ${t('passes', { count: stage.passes.length })}` : ''}
      </span>
      {stage.passes.length > 0 ? (
        <ol className="flex flex-col gap-1 pl-7 text-xs">
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
      ) : null}
    </li>
  );
}

/** Histórico completo (RN-PROC-52): etapas agrupadas por `groupLabel`, com todas as passagens. */
function StageHistory({
  stages,
  timeZone,
}: {
  readonly stages: readonly ProcessStageEntryDto[];
  readonly timeZone: string;
}) {
  return (
    <ol className="grid gap-x-8 gap-y-4 pt-2 sm:grid-cols-2 xl:grid-cols-3">
      {groupStages(stages).map((group, index) => (
        <li key={`${String(index)}:${group.label ?? ''}`} className="flex min-w-0 flex-col gap-2">
          {group.label ? (
            <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {group.label}
            </span>
          ) : null}
          <ol className="flex flex-col gap-3">
            {group.stages.map((stage) => (
              <StageItem key={stage.workflowStageId} stage={stage} timeZone={timeZone} />
            ))}
          </ol>
        </li>
      ))}
    </ol>
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
 * `StageStepper` (SCR-006 · RN-PROC-52 · PRC-10 · prd-5 regra 6): as etapas da versão fixada como
 * barra fina de pontos ligados (`StageProgress`), a atual com `aria-current="step"` e o detalhe só
 * nela; o histórico com grupos e passagens (idas e voltas) fica em "Ver histórico das etapas".
 * Quebra linha em vez de rolar (regra 8).
 */
export function StageStepper({ stages, isPending, error, onRetry, timeZone }: StageStepperProps) {
  const t = useTranslations('processes.panel.stepper');
  if (stages === undefined && isPending) return <Skeleton className="h-12 w-full" />;
  if (stages === undefined) return <PanelError error={error} onRetry={onRetry} />;
  if (stages.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <StageProgress
        label={t('title')}
        current={currentStageIndex(stages)}
        steps={stages.map((stage) => ({
          id: stage.workflowStageId,
          label: stage.name,
          detail: <CurrentDetail stage={stage} />,
        }))}
        labels={{
          done: t('done'),
          current: t('current'),
          upcoming: t('upcoming'),
          position: (current, total) => t('position', { current, total }),
        }}
      />
      <Collapsible>
        <CollapsibleTrigger>{t('history')}</CollapsibleTrigger>
        <CollapsibleContent>
          <StageHistory stages={stages} timeZone={timeZone} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/** Detalhe da etapa atual: o nome e o SLA (o prazo colorido fica nos fatos do cabeçalho). */
function CurrentDetail({ stage }: { readonly stage: ProcessStageEntryDto }) {
  const sla = useSlaText(stage);
  return (
    <>
      {stage.name}
      {sla ? ` · ${sla}` : ''}
    </>
  );
}
