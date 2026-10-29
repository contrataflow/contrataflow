'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  toast,
} from '@contrataflow/ui';
import { PROCESS_ASSIGN_LIMITS } from '@contrataflow/validation';
import type { BulkResultResponse } from '@contrataflow/validation';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useDepartmentMembers } from '@/features/process-assign/process-assign.api';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

import {
  canSubmit,
  describeBulkError,
  isFull,
  sharedDepartmentOf,
  summarizeBulk,
  validateBulkAssign,
} from './task-bulk-model';
import type { BulkAssignErrors, BulkProblem, BulkSelection, BulkSummary } from './task-bulk-model';
import { bulkAssign, bulkClaim } from './task-bulk.api';

/** O que o lote muda além da caixa: lista de processos e painel inicial. */
const AFTER_BULK_KEYS = ['tasks', 'processes', 'dashboard'] as const;

/** Tela cheia abaixo de 768 px, como o SCR-115. */
const DIALOG_CLASS =
  'max-h-[90vh] overflow-y-auto max-md:inset-0 max-md:h-full max-md:max-h-none max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none';

type Action = 'claim' | 'assign';

export interface TaskBulkActionsProps {
  readonly selection: BulkSelection;
  readonly canClaim: boolean;
  readonly canAssign: boolean;
  /** FA-05: "Cancelar seleção". */
  readonly onClear: () => void;
  /** Depois do lote: os bem-sucedidos saem da seleção. */
  readonly onProcessed: (succeeded: readonly string[]) => void;
}

/**
 * `BulkActionBar` (US-058 · SCR-013): "{N} selecionados" com "Assumir selecionados" (TSK-03, com
 * confirmação) e "Atribuir selecionados" (TSK-04, SCR-115 adaptado); durante o envio os botões
 * ficam desabilitados ("Processando {N} processos…"); o `BulkResultSummary` anuncia o resultado por
 * `aria-live`. Barra flutuante no rodapé da tela (prd-5), em largura total nas telas pequenas.
 */
export function TaskBulkActions({
  selection,
  canClaim,
  canAssign,
  onClear,
  onProcessed,
}: TaskBulkActionsProps) {
  const t = useTranslations('taskInbox.bulk');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [summary, setSummary] = useState<{ action: Action; value: BulkSummary } | null>(null);
  const [problem, setProblem] = useState<{ action: Action; value: BulkProblem } | null>(null);
  /** O envio que caiu por indisponibilidade ("Tentar novamente" — Casos de erro). */
  const [retryable, setRetryable] = useState<{
    readonly action: Action;
    readonly send: (key: string) => Promise<BulkResultResponse>;
  } | null>(null);
  const count = selection.size;
  const ready = canSubmit(selection);

  const run = async (action: Action, send: (key: string) => Promise<BulkResultResponse>) => {
    if (processing) return;
    setProcessing(true);
    setProblem(null);
    setSummary(null);
    const snapshot = selection;
    try {
      const result = await send(crypto.randomUUID());
      const value = summarizeBulk(result, snapshot);
      setSummary({ action, value });
      onProcessed(value.succeeded);
      setRetryable(null);
    } catch (error) {
      const value = describeBulkError(error);
      setProblem({ action, value });
      setRetryable(value.kind === 'unavailable' ? { action, send } : null);
      if (value.kind === 'denied' || value.kind === 'reused' || value.kind === 'tooLong') {
        toast({ title: t(`errors.${value.kind}`), tone: 'error' });
      }
    } finally {
      setProcessing(false);
      for (const key of AFTER_BULK_KEYS) {
        void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, key) });
      }
    }
  };

  const claimSelected = () => {
    setConfirming(false);
    const ids = [...selection.keys()];
    void run('claim', (key) => bulkClaim(ids, key));
  };

  return (
    <>
      {count > 0 ? (
        <div
          role="region"
          aria-label={t('label')}
          className="fixed inset-x-0 bottom-0 z-30 flex flex-wrap items-center gap-2 bg-surface px-4 py-3 shadow-popover md:inset-x-auto md:bottom-6 md:left-1/2 md:w-[min(48rem,calc(100vw-3rem))] md:-translate-x-1/2 md:rounded-card md:px-5"
        >
          <p className="text-sm font-medium" aria-live="polite">
            {processing ? t('processing', { count }) : t('selected', { count })}
          </p>
          {isFull(selection) ? <p className="text-xs text-muted-foreground">{t('limit')}</p> : null}
          {!ready && !isFull(selection) ? (
            <p className="text-xs text-muted-foreground">{t('minimum')}</p>
          ) : null}
          <div className="ms-auto flex flex-wrap gap-2">
            {canClaim ? (
              <Button
                size="sm"
                disabled={!ready || processing}
                onClick={() => {
                  setConfirming(true);
                }}
              >
                {t('claim')}
              </Button>
            ) : null}
            {canAssign ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={!ready || processing}
                onClick={() => {
                  setAssigning(true);
                }}
              >
                {t('assign')}
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" disabled={processing} onClick={onClear}>
              {t('clear')}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {summary === null ? null : (
          <BulkResultSummary
            action={summary.action}
            summary={summary.value}
            onDismiss={() => {
              setSummary(null);
            }}
          />
        )}
        {problem === null ? null : (
          <BulkProblemAlert
            problem={problem.value}
            onRetry={
              retryable === null
                ? null
                : () => {
                    void run(retryable.action, retryable.send);
                  }
            }
          />
        )}
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent closeLabel={t('close')}>
          <DialogTitle>{t('confirmClaim.title', { count })}</DialogTitle>
          <DialogDescription>{t('confirmClaim.description')}</DialogDescription>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t('cancel')}
            </Button>
            <Button onClick={claimSelected}>{t('confirmClaim.submit')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {assigning ? (
        <BulkAssignDialog
          selection={selection}
          onClose={() => {
            setAssigning(false);
          }}
          onSubmit={(draft) => {
            setAssigning(false);
            const ids = [...selection.keys()];
            void run('assign', (key) =>
              bulkAssign(
                { processIds: ids, assigneeId: draft.assigneeId, reason: draft.reason.trim() },
                key,
              ),
            );
          }}
        />
      ) : null}
    </>
  );
}

/** `BulkResultSummary`: "42 de 45 processos assumidos. 3 não puderam ser assumidos." + erros. */
function BulkResultSummary({
  action,
  summary,
  onDismiss,
}: {
  readonly action: Action;
  readonly summary: BulkSummary;
  readonly onDismiss: () => void;
}) {
  const t = useTranslations('taskInbox.bulk.summary');
  const title =
    summary.kind === 'failure'
      ? t('failure')
      : summary.kind === 'success'
        ? t(`${action}.success`, { count: summary.successCount })
        : t(`${action}.partial`, {
            success: summary.successCount,
            total: summary.total,
            errors: summary.errorCount,
          });
  return (
    <Alert
      tone={
        summary.kind === 'success' ? 'success' : summary.kind === 'failure' ? 'error' : 'warning'
      }
      title={title}
    >
      {summary.problems.length > 0 ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-sm">
            {t('details', { count: summary.problems.length })}
          </summary>
          <ul className="mt-1 list-disc ps-5 text-sm">
            {summary.problems.map((problem) => (
              <li key={problem.processId}>{itemMessage(t, problem)}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <Button size="sm" variant="secondary" className="mt-2" onClick={onDismiss}>
        {t('dismiss')}
      </Button>
    </Alert>
  );
}

function itemMessage(
  t: ReturnType<typeof useTranslations<'taskInbox.bulk.summary'>>,
  problem: BulkSummary['problems'][number],
): string {
  if (problem.code === 'PROCESS_ALREADY_ASSIGNED') {
    return t('items.alreadyAssigned', { code: problem.label });
  }
  if (problem.code === 'REFERENCE_NOT_FOUND') return t('items.notFound', { code: problem.label });
  return t('items.other', { code: problem.label, message: problem.message });
}

function BulkProblemAlert({
  problem,
  onRetry,
}: {
  readonly problem: BulkProblem;
  readonly onRetry: (() => void) | null;
}) {
  const t = useTranslations('taskInbox.bulk.errors');
  const title =
    problem.kind === 'unexpected'
      ? t('unexpected', { correlationId: problem.correlationId })
      : problem.kind === 'field'
        ? problem.message
        : t(problem.kind);
  return (
    <Alert tone="error" title={title}>
      {onRetry === null ? null : (
        <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
          {t('retry')}
        </Button>
      )}
    </Alert>
  );
}

/**
 * SCR-115 adaptado ("Atribuir {N} processos a"): responsável entre os lotados ativos da unidade
 * atual (o mesmo USR-02 do `AssignProcessDialog`) e o motivo obrigatório do lote (POL-05). Seleção
 * com unidades diferentes não tem uma lista comum: avisa e não envia.
 */
function BulkAssignDialog({
  selection,
  onClose,
  onSubmit,
}: {
  readonly selection: BulkSelection;
  readonly onClose: () => void;
  readonly onSubmit: (draft: { assigneeId: string; reason: string }) => void;
}) {
  const t = useTranslations('taskInbox.bulk.assignDialog');
  const selectId = useId();
  const reasonId = useId();
  const departmentId = sharedDepartmentOf(selection);
  const members = useDepartmentMembers(departmentId ?? undefined, departmentId !== null);
  const [assigneeId, setAssigneeId] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<BulkAssignErrors>({});
  const count = selection.size;

  const submit = () => {
    const invalid = validateBulkAssign({ assigneeId, reason });
    if (invalid.assignee !== undefined || invalid.reason !== undefined) {
      setErrors(invalid);
      document.getElementById(invalid.assignee === undefined ? reasonId : selectId)?.focus();
      return;
    }
    onSubmit({ assigneeId, reason });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent closeLabel={t('close')} className={DIALOG_CLASS}>
        <DialogTitle>{t('title', { count })}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        {departmentId === null ? (
          <Alert tone="warning" title={t('mixedDepartments')} />
        ) : (
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Field label={t('assignee')} id={selectId} required error={errors.assignee}>
              {members.isPending && members.fetchStatus !== 'idle' ? (
                <div role="status">
                  <span className="sr-only">{t('loading')}</span>
                  <Skeleton className="h-11 w-full" />
                </div>
              ) : null}
              {members.isError ? <Alert tone="error" title={t('loadError')} /> : null}
              <Select
                value={assigneeId}
                onValueChange={(value) => {
                  setAssigneeId(value);
                  setErrors(({ reason: current }) =>
                    current === undefined ? {} : { reason: current },
                  );
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  {(members.data ?? []).map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      {member.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label={t('reason')}
              id={reasonId}
              required
              description={t('reasonHint')}
              error={errors.reason}
            >
              <Textarea
                value={reason}
                maxLength={PROCESS_ASSIGN_LIMITS.reasonMax}
                onChange={(event) => {
                  setReason(event.target.value);
                  setErrors(({ assignee: current }) =>
                    current === undefined ? {} : { assignee: current },
                  );
                }}
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={onClose}>
                {t('cancel')}
              </Button>
              <Button type="submit">{t('submit')}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
