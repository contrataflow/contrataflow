'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Skeleton,
  toast,
} from '@contrataflow/ui';
import { PROCESS_ASSIGN_LIMITS, assignReasonRequired } from '@contrataflow/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';

import { tenantKey } from '@/lib/query/keys';
import { useShellSession } from '@/lib/session/session-context';

import {
  QUEUE_OPTION,
  assignBodyOf,
  canQueue,
  describeAssignError,
  memberOptions,
  validateAssign,
} from './assign-model';
import type { AssignFormErrors, AssignProblem } from './assign-model';
import { useAssignMutation, useDepartmentMembers } from './process-assign.api';
import { useInvalidateProcess } from '../process-panel/process-panel.api';
import { INPUT_CLASS, TEXTAREA_CLASS } from '../processes/form-field';
import { fetchProcess, processKeys } from '../processes/processes.api';

/** Listas que a atribuição muda além do processo: caixa de tarefas, lista e painel inicial. */
const AFTER_ASSIGN_KEYS = ['processes', 'tasks', 'dashboard'] as const;

/** Tela cheia abaixo de 768 px (story · Acessibilidade e responsividade). */
const DIALOG_CLASS =
  'max-h-[90vh] overflow-y-auto max-md:inset-0 max-md:h-full max-md:max-h-none max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none';

/** Recusas que encerram o diálogo (status mudou, sem permissão, processo sumiu): avisa e recarrega. */
type ClosingProblem = Extract<
  AssignProblem,
  { readonly kind: 'status' | 'permission' | 'notFound' }
>;
const CLOSING: ReadonlySet<AssignProblem['kind']> = new Set(['status', 'permission', 'notFound']);
const isClosing = (problem: AssignProblem): problem is ClosingProblem => CLOSING.has(problem.kind);

export interface AssignProcessDialogProps {
  readonly processId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Depois do sucesso (o diálogo já fechou): o painel decide para onde vai o foco. */
  readonly onDone?: (() => void) | undefined;
}

/** Mensagem do erro com a ação da tabela "Casos de erro" (Recarregar, Tentar novamente, Copiar). */
function ProblemAlert({
  problem,
  onReload,
  onRetry,
}: {
  readonly problem: AssignProblem;
  readonly onReload: () => void;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('processes.assign.errors');
  switch (problem.kind) {
    case 'field':
      return <Alert tone="error" title={t('formErrors')} />;
    case 'stale':
      return (
        <Alert tone="warning" title={t('stale')}>
          <Button size="sm" variant="secondary" className="mt-2" onClick={onReload}>
            {t('reload')}
          </Button>
        </Alert>
      );
    case 'unavailable':
      return (
        <Alert tone="error" title={t('unavailable')}>
          <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
            {t('retry')}
          </Button>
        </Alert>
      );
    case 'unexpected':
      return (
        <Alert tone="error" title={t('unexpected', { correlationId: problem.correlationId })}>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => {
              void navigator.clipboard.writeText(problem.correlationId);
            }}
          >
            {t('copyCode')}
          </Button>
        </Alert>
      );
    default:
      return <Alert tone="error" title={t(problem.kind)} />;
  }
}

/**
 * `AssignProcessDialog` (US-050 · SCR-115): escolhe o novo responsável entre os lotados ativos da
 * unidade atual (`DepartmentMemberSelect`, com "Deixar na fila da unidade" quando há responsável) e,
 * na troca, o motivo (10–2.000, `aria-required`); confirma com o PRC-22 (`If-Match` da versão do
 * PRC-04). Foco inicial no seletor; tela cheia abaixo de 768 px; erro mantém o que foi digitado.
 */
export function AssignProcessDialog({
  processId,
  open,
  onOpenChange,
  onDone,
}: AssignProcessDialogProps) {
  const t = useTranslations('processes.assign');
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const selectId = useId();
  const reasonId = useId();
  const queryClient = useQueryClient();
  const invalidateProcess = useInvalidateProcess(processId);
  const detail = useQuery({
    queryKey: processKeys.detail(tenantId, processId),
    queryFn: ({ signal }) => fetchProcess(processId, signal),
    enabled: open,
    throwOnError: false,
  });
  const process = detail.data;
  const members = useDepartmentMembers(process?.currentDepartment.id, open);
  const mutation = useAssignMutation();
  const done = useRef(false);
  const [selection, setSelection] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<AssignFormErrors>({});
  const [problem, setProblem] = useState<AssignProblem | null>(null);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const submitting = mutation.isPending;

  const currentResponsible = process?.currentResponsible ?? null;
  const currentResponsibleId = currentResponsible?.id ?? null;
  const reasonRequired = assignReasonRequired(currentResponsibleId);
  const options = memberOptions(members.data ?? [], currentResponsibleId).filter(
    (member) => !removed.has(member.id),
  );

  // Foco inicial no seletor de responsável (story · Acessibilidade), assim que o processo carrega.
  const focused = useRef(false);
  const ready = process !== undefined;
  useEffect(() => {
    if (!open) {
      focused.current = false;
      return;
    }
    if (ready && !focused.current) {
      focused.current = true;
      document.getElementById(selectId)?.focus();
    }
  }, [open, ready, selectId]);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setSelection('');
      setReason('');
      setErrors({});
      setProblem(null);
      setRemoved(new Set());
    }
    onOpenChange(next);
  };

  const refreshAll = () => {
    void invalidateProcess();
    for (const key of AFTER_ASSIGN_KEYS) {
      void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, key) });
    }
  };

  const submit = async () => {
    if (submitting || process === undefined) return;
    setProblem(null);
    const draft = { selection, reason };
    const invalid = validateAssign(draft, currentResponsibleId);
    if (invalid.assignee !== undefined || invalid.reason !== undefined) {
      setErrors(invalid);
      setProblem({
        kind: 'field',
        field: invalid.assignee === undefined ? 'reason' : 'assignee',
        message: invalid.assignee ?? invalid.reason ?? '',
      });
      document.getElementById(invalid.assignee === undefined ? reasonId : selectId)?.focus();
      return;
    }
    setErrors({});
    const body = assignBodyOf(draft);
    let updated;
    try {
      updated = await mutation.mutateAsync({ processId, body, version: process.version });
    } catch (failure) {
      const found = describeAssignError(failure);
      if (isClosing(found)) {
        toast({ title: t(`errors.${found.kind}`), tone: 'error' });
        refreshAll();
        handleOpenChange(false);
        return;
      }
      if (found.kind === 'field') {
        setErrors({ [found.field]: found.message });
        document.getElementById(found.field === 'assignee' ? selectId : reasonId)?.focus();
      }
      if (found.kind === 'notEligible' && body.assigneeId !== null) {
        // "Remove a opção da lista; recarrega" (Casos de erro).
        const id = body.assigneeId;
        setRemoved((current) => new Set([...current, id]));
        setSelection('');
        void members.refetch();
      }
      if (found.kind === 'reference') {
        setSelection('');
        void members.refetch();
      }
      setProblem(found);
      return;
    }
    toast({
      title:
        updated.currentResponsible === null
          ? t('queued')
          : t('assigned', { name: updated.currentResponsible.name }),
      tone: 'success',
    });
    refreshAll();
    done.current = true;
    handleOpenChange(false);
  };

  const selectHint = `${selectId}-hint`;
  const selectError = `${selectId}-error`;
  const reasonHint = `${reasonId}-hint`;
  const reasonCounter = `${reasonId}-counter`;
  const reasonError = `${reasonId}-error`;
  const title = currentResponsibleId === null ? t('title.assign') : t('title.reassign');

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        closeLabel={t('close')}
        className={DIALOG_CLASS}
        onCloseAutoFocus={(event) => {
          if (!done.current) return;
          done.current = false;
          event.preventDefault();
          onDone?.();
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {currentResponsible === null
            ? t('description.queue')
            : t('description.current', { name: currentResponsible.name })}
        </DialogDescription>
        {process === undefined && !detail.isError ? (
          <div role="status">
            <span className="sr-only">{t('loading')}</span>
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div aria-live="assertive" className="flex flex-col gap-2">
              {problem === null ? null : (
                <ProblemAlert
                  problem={problem}
                  onReload={() => {
                    setProblem(null);
                    void detail.refetch();
                  }}
                  onRetry={() => {
                    void submit();
                  }}
                />
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={selectId} className="text-sm font-medium">
                {t('assignee.label')}
              </label>
              {members.isPending && members.fetchStatus !== 'idle' ? (
                <div role="status">
                  <span className="sr-only">{t('assignee.loading')}</span>
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : null}
              {members.isError ? (
                <Alert tone="error" title={t('assignee.loadError')}>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-2"
                    onClick={() => {
                      void members.refetch();
                    }}
                  >
                    {t('errors.retry')}
                  </Button>
                </Alert>
              ) : null}
              <select
                id={selectId}
                value={selection}
                aria-required
                aria-invalid={errors.assignee ? true : undefined}
                aria-describedby={[selectHint, errors.assignee ? selectError : undefined]
                  .filter(Boolean)
                  .join(' ')}
                className={`${INPUT_CLASS} min-h-11`}
                onChange={(event) => {
                  setSelection(event.target.value);
                  setErrors(({ reason: current }) =>
                    current === undefined ? {} : { reason: current },
                  );
                }}
              >
                <option value="">{t('assignee.placeholder')}</option>
                {options.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
                {canQueue(currentResponsibleId) ? (
                  <option value={QUEUE_OPTION}>{t('assignee.queue')}</option>
                ) : null}
              </select>
              <p id={selectHint} className="text-xs text-muted-foreground">
                {members.isSuccess && options.length === 0
                  ? t('assignee.empty')
                  : t('assignee.hint')}
              </p>
              {errors.assignee ? (
                <p id={selectError} className="text-xs text-destructive">
                  {errors.assignee}
                </p>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={reasonId} className="text-sm font-medium">
                {reasonRequired ? t('reason.label') : t('reason.optionalLabel')}
              </label>
              <textarea
                id={reasonId}
                value={reason}
                maxLength={PROCESS_ASSIGN_LIMITS.reasonMax}
                aria-required={reasonRequired ? true : undefined}
                aria-invalid={errors.reason ? true : undefined}
                aria-describedby={[
                  reasonHint,
                  reasonCounter,
                  errors.reason ? reasonError : undefined,
                ]
                  .filter(Boolean)
                  .join(' ')}
                className={TEXTAREA_CLASS}
                onChange={(event) => {
                  setReason(event.target.value);
                  setErrors(({ assignee: current }) =>
                    current === undefined ? {} : { assignee: current },
                  );
                }}
              />
              <p className="flex justify-between gap-2 text-xs text-muted-foreground">
                <span id={reasonHint}>{t('reason.hint')}</span>
                <span id={reasonCounter} aria-live="polite">
                  {t('counter', {
                    count: reason.trim().length,
                    max: PROCESS_ASSIGN_LIMITS.reasonMax,
                  })}
                </span>
              </p>
              {errors.reason ? (
                <p id={reasonError} className="text-xs text-destructive">
                  {errors.reason}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                disabled={submitting}
                onClick={() => {
                  handleOpenChange(false);
                }}
              >
                {t('cancel')}
              </Button>
              <Button type="submit" aria-disabled={submitting ? true : undefined}>
                {submitting ? t('submitting') : t('submit')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
