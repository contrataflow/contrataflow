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
  cx,
  toast,
} from '@contrataflow/ui';
import { PROCESS_RETURN_LIMITS } from '@contrataflow/validation';
import type { ProcessDto, ReturnedProcessDto } from '@contrataflow/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';

import type { RetryOptions } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useShellSession } from '@/lib/session/session-context';

import { useReturnProcess } from './process-return.api';
import {
  RETURN_FIELD_ORDER,
  buildReturnBody,
  describeReturnError,
  initialTargetId,
  returnTargets,
  validateReturn,
} from './return-model';
import type { ReturnField, ReturnFieldMessages, ReturnProblem, ReturnTarget } from './return-model';
import { useAvailableActions } from '../process-actions/process-actions.api';
import { formatDueDate, localToday } from '../process-forward/forward-model';
import { useInvalidateProcess } from '../process-panel/process-panel.api';
import { INPUT_CLASS, TEXTAREA_CLASS } from '../processes/form-field';
import { fetchProcess, processKeys } from '../processes/processes.api';

/** Listas que a devolução muda além do processo: caixa de tarefas, lista e painel inicial. */
const AFTER_RETURN_KEYS = ['processes', 'tasks', 'dashboard'] as const;

export interface ReturnProcessDialogProps {
  readonly processId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Etapa (`WorkflowStage`) da entrada "Devolver" escolhida no menu. */
  readonly initialStageId?: string | null | undefined;
  /** Depois do sucesso (o diálogo já fechou): o painel decide para onde vai o foco. */
  readonly onReturned?: (() => void) | undefined;
  /** Retentativas automáticas da mutação (testes: `{ retries: 0 }`). */
  readonly retry?: RetryOptions | undefined;
}

/**
 * `ReturnProcessDialog` (US-048 · SCR-104): "Devolver processo" sobre o painel SCR-006. Lista as
 * etapas já percorridas permitidas pela transição `RETURN` (nome e data da última passagem — PRC-08),
 * pede o motivo (10–5.000, com contador) e, só quando a transição permite, o prazo. Confirma com o
 * PRC-20 (`If-Match` da versão do PRC-04, `Idempotency-Key` por intenção e a etapa esperada). Foco
 * inicial no seletor (ou no motivo, havendo um só destino — FA-03); erros em `aria-live`; tela
 * cheia abaixo de 768 px.
 */
export function ReturnProcessDialog({
  processId,
  open,
  onOpenChange,
  initialStageId,
  onReturned,
  retry,
}: ReturnProcessDialogProps) {
  const t = useTranslations('processes.return');
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const detail = useQuery({
    queryKey: processKeys.detail(tenantId, processId),
    queryFn: ({ signal }) => fetchProcess(processId, signal),
    enabled: open,
    throwOnError: false,
  });
  const actions = useAvailableActions(processId);
  // Devolveu: o foco vai para onde o painel decidir, não para o botão que abriu o diálogo.
  const returned = useRef(false);
  const loaded = detail.data !== undefined && actions.data !== undefined;
  const failed = !loaded && (detail.isError || actions.isError);

  let body;
  if (loaded) {
    body = (
      <ReturnForm
        key={`${detail.data.id}:${String(detail.data.version)}`}
        process={detail.data}
        targets={returnTargets(actions.data)}
        initialStageId={initialStageId}
        retry={retry}
        onClose={() => {
          onOpenChange(false);
        }}
        onReturned={() => {
          returned.current = true;
          onOpenChange(false);
        }}
      />
    );
  } else if (failed) {
    body = (
      <Alert tone="error" title={t('loadFailed')}>
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => {
            void detail.refetch();
            void actions.refetch();
          }}
        >
          {t('retry')}
        </Button>
      </Alert>
    );
  } else {
    body = (
      <div role="status" className="flex flex-col gap-3">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={t('close')}
        onCloseAutoFocus={(event) => {
          if (!returned.current) return;
          returned.current = false;
          event.preventDefault();
          onReturned?.();
        }}
        className="max-h-[90vh] overflow-y-auto max-md:inset-0 max-md:h-full max-md:max-h-none max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none"
      >
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
}

function ReturnForm({
  process,
  targets,
  initialStageId,
  retry,
  onClose,
  onReturned,
}: {
  readonly process: ProcessDto;
  readonly targets: readonly ReturnTarget[];
  readonly initialStageId: string | null | undefined;
  readonly retry: RetryOptions | undefined;
  readonly onClose: () => void;
  readonly onReturned: () => void;
}) {
  const t = useTranslations('processes.return');
  const queryClient = useQueryClient();
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const timeZone = session.activeTenant.timezone;
  const ids = useId();
  const fieldId = (field: ReturnField) => `${ids}-${field}`;
  const invalidateProcess = useInvalidateProcess(process.id);
  const mutation = useReturnProcess(retry);
  const submitting = mutation.isPending;

  const [stageChoice, setStageChoice] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [errors, setErrors] = useState<ReturnFieldMessages>({});
  const [problem, setProblem] = useState<ReturnProblem | null>(null);
  const [focusRequest, setFocusRequest] = useState<{
    fields: readonly ReturnField[];
    n: number;
  } | null>(null);

  const selectedId = stageChoice ?? initialTargetId(targets, initialStageId);
  const target = targets.find((candidate) => candidate.stageId === selectedId);
  const today = localToday(new Date(), timeZone);

  // Foco inicial: o seletor; com um só destino já escolhido, o motivo (FA-03).
  const firstFocus = useRef(false);
  useEffect(() => {
    if (firstFocus.current || targets.length === 0) return;
    firstFocus.current = true;
    const field: ReturnField = targets.length === 1 ? 'comment' : 'targetStageId';
    const element =
      field === 'comment'
        ? document.getElementById(fieldId('comment'))
        : document.querySelector<HTMLInputElement>(
            `input[name="${fieldId('targetStageId')}"]:checked, input[name="${fieldId('targetStageId')}"]`,
          );
    element?.focus();
    // `fieldId` só depende de `ids`, estável.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets.length]);

  useEffect(() => {
    if (focusRequest === null) return;
    for (const field of focusRequest.fields) {
      const element =
        field === 'targetStageId'
          ? document.querySelector<HTMLInputElement>(`input[name="${fieldId(field)}"]`)
          : document.getElementById(fieldId(field));
      if (element !== null) {
        element.focus();
        return;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  const showErrors = (found: ReturnFieldMessages) => {
    setErrors(found);
    const fields = RETURN_FIELD_ORDER.filter((field) => found[field] !== undefined);
    if (fields.length > 0) {
      setFocusRequest((previous) => ({ fields, n: (previous?.n ?? 0) + 1 }));
    }
  };
  const clearError = (field: ReturnField) => {
    setErrors((previous) => {
      if (previous[field] === undefined) return previous;
      const { [field]: _removed, ...rest } = previous;
      return rest;
    });
  };

  const handleError = (error: unknown) => {
    const found = describeReturnError(error);
    switch (found.kind) {
      case 'fields':
        setProblem(found);
        showErrors(found.messages);
        return;
      case 'targetNotAvailable':
        // Recarrega a lista de etapas (o destino pode ter deixado de valer).
        setStageChoice(null);
        setProblem(found);
        void invalidateProcess();
        return;
      case 'dueNotAllowed':
        setDueAt('');
        setProblem(found);
        void invalidateProcess();
        return;
      case 'status':
      case 'custody':
      case 'notFound':
        toast({ title: t(`errors.${found.kind}`), tone: 'error' });
        void invalidateProcess();
        onClose();
        return;
      default:
        setProblem(found);
    }
  };

  const finish = (result: ReturnedProcessDto) => {
    toast({
      title: t('returned', { stage: result.currentStage?.name ?? target?.stageName ?? '' }),
      tone: 'success',
    });
    void invalidateProcess();
    for (const key of AFTER_RETURN_KEYS) {
      void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, key) });
    }
    onReturned();
  };

  const submit = async () => {
    if (submitting) return;
    setProblem(null);
    const draft = { target, comment, dueAt };
    const found = validateReturn(draft, today);
    if (Object.keys(found).length > 0 || target === undefined) {
      showErrors(found);
      setProblem({ kind: 'fields', messages: found, others: [] });
      return;
    }
    setErrors({});
    const expectedStageId = process.currentStage?.id;
    if (expectedStageId === undefined) return;
    let result: ReturnedProcessDto;
    try {
      result = await mutation.submit({
        processId: process.id,
        body: buildReturnBody({ ...draft, target }, expectedStageId),
        version: process.version,
      });
    } catch (error) {
      handleError(error);
      return;
    }
    finish(result);
  };

  const reload = () => {
    void invalidateProcess();
    onClose();
  };

  if (targets.length === 0) {
    return (
      <>
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
        </DialogFooter>
      </>
    );
  }

  const commentHintId = `${fieldId('comment')}-hint`;
  const commentLength = comment.trim().length;

  return (
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
            onReload={reload}
            onRetry={() => {
              void submit();
            }}
          />
        )}
      </div>

      <fieldset
        className="flex min-w-0 flex-col gap-2"
        aria-describedby={errors.targetStageId ? `${fieldId('targetStageId')}-error` : undefined}
      >
        <legend className="text-sm font-medium">{t('target.legend')}</legend>
        {targets.map((option) => {
          const optionId = `${fieldId('targetStageId')}-${option.stageId}`;
          return (
            <label
              key={option.stageId}
              htmlFor={optionId}
              className={cx(
                'flex cursor-pointer items-start gap-3 rounded-control border p-3',
                option.stageId === selectedId ? 'border-primary bg-muted' : 'border-border',
              )}
            >
              <input
                type="radio"
                id={optionId}
                name={fieldId('targetStageId')}
                value={option.stageId}
                checked={option.stageId === selectedId}
                className="mt-1"
                onChange={() => {
                  setStageChoice(option.stageId);
                  if (!option.allowDueDateOverride) setDueAt('');
                  clearError('targetStageId');
                }}
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{option.stageName}</span>
                {option.lastPassedAt === null ? null : (
                  <span className="text-xs text-muted-foreground">
                    {t('target.lastPassed', {
                      date: formatDueDate(option.lastPassedAt, timeZone),
                    })}
                  </span>
                )}
              </span>
            </label>
          );
        })}
        {errors.targetStageId ? (
          <p id={`${fieldId('targetStageId')}-error`} className="text-xs text-destructive">
            {errors.targetStageId}
          </p>
        ) : null}
      </fieldset>

      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={fieldId('comment')} className="text-sm font-medium">
          {t('comment.label')}
        </label>
        <textarea
          id={fieldId('comment')}
          value={comment}
          maxLength={PROCESS_RETURN_LIMITS.commentMax}
          aria-required
          aria-invalid={errors.comment ? true : undefined}
          aria-describedby={
            [commentHintId, errors.comment ? `${fieldId('comment')}-error` : undefined]
              .filter(Boolean)
              .join(' ') || undefined
          }
          className={TEXTAREA_CLASS}
          onChange={(event) => {
            setComment(event.target.value);
            clearError('comment');
          }}
        />
        <p id={commentHintId} className="flex justify-between gap-2 text-xs text-muted-foreground">
          <span>{t('comment.hint')}</span>
          <span>
            {t('comment.counter', {
              count: commentLength,
              max: PROCESS_RETURN_LIMITS.commentMax,
            })}
          </span>
        </p>
        {errors.comment ? (
          <p id={`${fieldId('comment')}-error`} className="text-xs text-destructive">
            {errors.comment}
          </p>
        ) : null}
      </div>

      {target?.allowDueDateOverride === true ? (
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={fieldId('dueAt')} className="text-sm font-medium">
            {t('due.label')}
          </label>
          <input
            id={fieldId('dueAt')}
            type="date"
            value={dueAt}
            min={today}
            aria-invalid={errors.dueAt ? true : undefined}
            aria-describedby={
              [`${fieldId('dueAt')}-hint`, errors.dueAt ? `${fieldId('dueAt')}-error` : undefined]
                .filter(Boolean)
                .join(' ') || undefined
            }
            className={INPUT_CLASS}
            onChange={(event) => {
              setDueAt(event.target.value);
              clearError('dueAt');
            }}
          />
          <p id={`${fieldId('dueAt')}-hint`} className="text-xs text-muted-foreground">
            {t('due.hint')}
          </p>
          {errors.dueAt ? (
            <p id={`${fieldId('dueAt')}-error`} className="text-xs text-destructive">
              {errors.dueAt}
            </p>
          ) : null}
        </div>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="secondary" disabled={submitting} onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button type="submit" aria-disabled={submitting ? true : undefined}>
          {submitting ? t('submitting') : t('submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Mensagem do erro com a ação da tabela "Casos de erro" (Atualizar, Tentar novamente, Copiar). */
function ProblemAlert({
  problem,
  onReload,
  onRetry,
}: {
  readonly problem: ReturnProblem;
  readonly onReload: () => void;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('processes.return.errors');
  switch (problem.kind) {
    case 'fields':
      return (
        <Alert tone="error" title={t('formErrors')}>
          {problem.others.length === 0 ? null : (
            <ul className="list-disc pl-5 text-sm">
              {problem.others.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </Alert>
      );
    case 'stale':
    case 'precondition':
      return (
        <Alert
          tone="warning"
          title={
            problem.kind === 'precondition'
              ? t('precondition')
              : problem.code === 'STAGE_CHANGED'
                ? t('stageChanged')
                : t('versionConflict')
          }
        >
          <Button size="sm" variant="secondary" className="mt-2" onClick={onReload}>
            {t('reload')}
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
    case 'unavailable':
      return (
        <Alert tone="error" title={t('unavailable')}>
          <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
            {t('retry')}
          </Button>
        </Alert>
      );
    default:
      return <Alert tone="error" title={t(problem.kind)} />;
  }
}
