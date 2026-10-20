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
import { PROCESS_SUSPENSION_LIMITS } from '@contrataflow/validation';
import type { ProcessSummaryDto } from '@contrataflow/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { RetryOptions } from '@/lib/api/client';
import { formatCivilDate, formatDate } from '@/lib/i18n/format';
import { tenantKey } from '@/lib/query/keys';
import { useShellSession } from '@/lib/session/session-context';

import { useResumePreview, useResumeProcess, useSuspendProcess } from './process-suspension.api';
import {
  describeSuspensionError,
  extensionQuery,
  suspendedPeriod,
  validateResumeComment,
  validateSuspendReason,
} from './suspension-model';
import type { SuspensionProblem } from './suspension-model';
import { useInvalidateProcess } from '../process-panel/process-panel.api';
import { TEXTAREA_CLASS } from '../processes/form-field';
import { fetchProcess, processKeys } from '../processes/processes.api';

/** Listas que suspender/retomar mudam além do processo: caixa de tarefas, lista e painel inicial. */
const AFTER_LIFECYCLE_KEYS = ['processes', 'tasks', 'dashboard'] as const;

/** Tela cheia abaixo de 768 px (story · Responsivo). */
const DIALOG_CLASS =
  'max-h-[90vh] overflow-y-auto max-md:inset-0 max-md:h-full max-md:max-h-none max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none';

interface LifecycleDialogProps {
  readonly processId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Depois do sucesso (o diálogo já fechou): o painel decide para onde vai o foco. */
  readonly onDone?: (() => void) | undefined;
  /** Retentativas automáticas da mutação (testes: `{ retries: 0 }`). */
  readonly retry?: RetryOptions | undefined;
}

/** A versão do PRC-04 (o `If-Match`), lida só com o diálogo aberto. */
function useProcessVersion(processId: string, open: boolean) {
  const session = useShellSession();
  return useQuery({
    queryKey: processKeys.detail(session.activeTenant.id, processId),
    queryFn: ({ signal }) => fetchProcess(processId, signal),
    enabled: open,
    throwOnError: false,
  });
}

/** Invalida o processo e as listas depois do sucesso. */
function useAfterLifecycle(processId: string) {
  const queryClient = useQueryClient();
  const tenantId = useShellSession().activeTenant.id;
  const invalidateProcess = useInvalidateProcess(processId);
  return () => {
    void invalidateProcess();
    for (const key of AFTER_LIFECYCLE_KEYS) {
      void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, key) });
    }
  };
}

/**
 * Campo de texto longo com contador anunciado (`aria-live="polite"`), dica e erro associados
 * (`aria-describedby`).
 */
function LongTextField({
  id,
  label,
  hint,
  value,
  max,
  required,
  error,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly max: number;
  readonly required: boolean;
  readonly error: string | undefined;
  readonly onChange: (value: string) => void;
}) {
  const t = useTranslations('processes.suspension');
  const hintId = `${id}-hint`;
  const counterId = `${id}-counter`;
  const errorId = `${id}-error`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        maxLength={max}
        aria-required={required ? true : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, counterId, error ? errorId : undefined]
          .filter(Boolean)
          .join(' ')}
        className={TEXTAREA_CLASS}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <p className="flex justify-between gap-2 text-xs text-muted-foreground">
        <span id={hintId}>{hint}</span>
        <span id={counterId} aria-live="polite">
          {t('counter', { count: value.trim().length, max })}
        </span>
      </p>
      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Mensagem do erro com a ação da tabela "Casos de erro" (Recarregar, Tentar novamente, Copiar). */
function ProblemAlert({
  problem,
  onReload,
  onRetry,
}: {
  readonly problem: SuspensionProblem;
  readonly onReload: () => void;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('processes.suspension.errors');
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

/** Recusa que encerra o diálogo (status mudou, sem permissão, sem acesso): avisa e recarrega. */
type ClosingProblem = Extract<
  SuspensionProblem,
  { readonly kind: 'status' | 'permission' | 'notFound' | 'access' }
>;
const CLOSING: ReadonlySet<SuspensionProblem['kind']> = new Set([
  'status',
  'permission',
  'notFound',
  'access',
]);
const isClosing = (problem: SuspensionProblem): problem is ClosingProblem =>
  CLOSING.has(problem.kind);

/**
 * Estado comum dos diálogos: erro do campo e da API (limpos ao fechar, por qualquer caminho) e o
 * foco devolvido ao painel só depois do sucesso.
 */
function useLifecycleDialog(
  onOpenChange: (open: boolean) => void,
  onDone: (() => void) | undefined,
) {
  const done = useRef(false);
  const [error, setError] = useState<string | undefined>();
  const [problem, setProblem] = useState<SuspensionProblem | null>(null);
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setError(undefined);
      setProblem(null);
    }
    onOpenChange(next);
  };
  return {
    error,
    setError,
    problem,
    setProblem,
    handleOpenChange,
    close: () => {
      handleOpenChange(false);
    },
    finish: () => {
      done.current = true;
      handleOpenChange(false);
    },
    onCloseAutoFocus: (event: Event) => {
      if (!done.current) return;
      done.current = false;
      event.preventDefault();
      onDone?.();
    },
  };
}

/**
 * Esqueleto comum dos diálogos: título, efeitos (`DialogDescription` → `aria-describedby`), foco
 * preso pelo `Dialog`, alerta em `aria-live` e foco devolvido ao painel depois do sucesso.
 */
function LifecycleShell({
  open,
  onOpenChange,
  onCloseAutoFocus,
  title,
  description,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCloseAutoFocus: (event: Event) => void;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  const t = useTranslations('processes.suspension');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={t('close')}
        onCloseAutoFocus={onCloseAutoFocus}
        className={DIALOG_CLASS}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/**
 * `SuspendProcessDialog` (US-008 · SCR-116): explica os efeitos, pede o motivo (20–5.000, com
 * contador) e confirma com o PRC-23 (`If-Match` da versão do PRC-04, `Idempotency-Key` por
 * intenção). Erro mantém o texto digitado; conflito de versão recarrega o processo sem perder o
 * motivo.
 */
export function SuspendProcessDialog({
  processId,
  open,
  onOpenChange,
  onDone,
  retry,
}: LifecycleDialogProps) {
  const t = useTranslations('processes.suspension');
  const fieldId = useId();
  const detail = useProcessVersion(processId, open);
  const mutation = useSuspendProcess(retry);
  const after = useAfterLifecycle(processId);
  const invalidateProcess = useInvalidateProcess(processId);
  const dialog = useLifecycleDialog(onOpenChange, onDone);
  const { error, setError, problem, setProblem, close } = dialog;
  const [reason, setReason] = useState('');
  const submitting = mutation.isPending;

  const submit = async () => {
    if (submitting) return;
    setProblem(null);
    const invalid = validateSuspendReason(reason);
    if (invalid !== undefined) {
      setError(invalid);
      setProblem({ kind: 'field', message: invalid });
      document.getElementById(fieldId)?.focus();
      return;
    }
    const version = detail.data?.version;
    if (version === undefined) return;
    setError(undefined);
    try {
      await mutation.submit({ processId, body: { reason: reason.trim() }, version });
    } catch (failure) {
      const found = describeSuspensionError(failure, 'reason');
      if (isClosing(found)) {
        toast({ title: t(`errors.${found.kind}`), tone: 'error' });
        void invalidateProcess();
        close();
        return;
      }
      if (found.kind === 'field') {
        setError(found.message);
        document.getElementById(fieldId)?.focus();
      }
      setProblem(found);
      return;
    }
    toast({ title: t('suspended'), tone: 'success' });
    after();
    setReason('');
    dialog.finish();
  };

  return (
    <LifecycleShell
      open={open}
      onOpenChange={dialog.handleOpenChange}
      onCloseAutoFocus={dialog.onCloseAutoFocus}
      title={t('suspend.title')}
      description={t('suspend.description')}
    >
      {detail.data === undefined && !detail.isError ? (
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
          <LongTextField
            id={fieldId}
            label={t('suspend.reason.label')}
            hint={t('suspend.reason.hint')}
            value={reason}
            max={PROCESS_SUSPENSION_LIMITS.reasonMax}
            required
            error={error}
            onChange={(value) => {
              setReason(value);
              setError(undefined);
            }}
          />
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={submitting} onClick={close}>
              {t('cancel')}
            </Button>
            <Button type="submit" aria-disabled={submitting ? true : undefined}>
              {submitting ? t('suspend.submitting') : t('suspend.submit')}
            </Button>
          </DialogFooter>
        </form>
      )}
    </LifecycleShell>
  );
}

export interface ResumeProcessDialogProps extends LifecycleDialogProps {
  /** O resumo do painel (PRC-07): período suspenso, prazo da etapa e prazo alvo. */
  readonly summary: ProcessSummaryDto;
  /** FA-06: atalho "Revisar prazo alvo" (abre a edição dos dados — US-005). */
  readonly onReviewTargetDate?: (() => void) | undefined;
}

/**
 * `ResumeProcessDialog` (US-008 · SCR-116): mostra o período suspenso, os dias acrescidos ao prazo
 * da etapa e o novo prazo (prévia pelo calendário do tenant — CAL-05/CAL-06 — confirmada pela
 * resposta do PRC-24), lembra o prazo alvo (FA-06) e aceita um comentário opcional.
 */
export function ResumeProcessDialog({
  processId,
  open,
  onOpenChange,
  onDone,
  retry,
  summary,
  onReviewTargetDate,
}: ResumeProcessDialogProps) {
  const t = useTranslations('processes.suspension');
  const timeZone = useShellSession().activeTenant.timezone;
  const fieldId = useId();
  const detail = useProcessVersion(processId, open);
  const mutation = useResumeProcess(retry);
  const after = useAfterLifecycle(processId);
  const invalidateProcess = useInvalidateProcess(processId);
  const dialog = useLifecycleDialog(onOpenChange, onDone);
  const { error, setError, problem, setProblem, close } = dialog;
  const [comment, setComment] = useState('');
  const submitting = mutation.isPending;

  const suspendedAt = summary.where.suspendedAt;
  const period = suspendedAt === null ? null : suspendedPeriod(suspendedAt, new Date(), timeZone);
  const dueAt = summary.deadline?.dueAt ?? null;
  const slaType = summary.deadline?.slaType ?? 'BUSINESS';
  const preview = useResumePreview({
    enabled: open && period !== null,
    query: period === null ? { kind: 'none' } : extensionQuery(period, slaType),
    dueAt,
    slaType,
  });

  const submit = async () => {
    if (submitting) return;
    setProblem(null);
    const invalid = validateResumeComment(comment);
    if (invalid !== undefined) {
      setError(invalid);
      setProblem({ kind: 'field', message: invalid });
      document.getElementById(fieldId)?.focus();
      return;
    }
    const version = detail.data?.version;
    if (version === undefined) return;
    setError(undefined);
    const trimmed = comment.trim();
    let result;
    try {
      result = await mutation.submit({
        processId,
        body: trimmed === '' ? {} : { comment: trimmed },
        version,
      });
    } catch (failure) {
      const found = describeSuspensionError(failure, 'comment');
      if (isClosing(found)) {
        toast({ title: t(`errors.${found.kind}`), tone: 'error' });
        void invalidateProcess();
        close();
        return;
      }
      if (found.kind === 'field') {
        setError(found.message);
        document.getElementById(fieldId)?.focus();
      }
      setProblem(found);
      return;
    }
    const newDueAt = result.meta.newDueAt;
    toast({
      title:
        newDueAt === null
          ? t('resumed')
          : t('resumedWithDue', { date: formatDate(newDueAt, timeZone) }),
      tone: 'success',
    });
    after();
    setComment('');
    dialog.finish();
  };

  let extension: ReactNode;
  if (dueAt === null) {
    extension = t('resume.noDeadline');
  } else if (preview.days === 0) {
    extension = t('resume.noDays');
  } else if (preview.isError) {
    extension = t('resume.previewFailed');
  } else if (preview.isPending || preview.days === null || preview.newDueAt === null) {
    extension = t('resume.calculating');
  } else {
    extension = t(slaType === 'CALENDAR' ? 'resume.calendarDays' : 'resume.businessDays', {
      count: preview.days,
      date: formatDate(preview.newDueAt, timeZone),
    });
  }

  return (
    <LifecycleShell
      open={open}
      onOpenChange={dialog.handleOpenChange}
      onCloseAutoFocus={dialog.onCloseAutoFocus}
      title={t('resume.title')}
      description={t('resume.description')}
    >
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
        <dl className="flex flex-col gap-2 text-sm">
          {suspendedAt === null ? null : (
            <div>
              <dt className="font-medium">{t('resume.period')}</dt>
              <dd>{t('resume.since', { date: formatDate(suspendedAt, timeZone) })}</dd>
            </div>
          )}
          <div>
            <dt className="font-medium">{t('resume.deadline')}</dt>
            <dd aria-live="polite">{extension}</dd>
          </div>
          {summary.target === null ? null : (
            <div>
              <dt className="font-medium">{t('resume.target')}</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <span>
                  {t('resume.targetKept', { date: formatCivilDate(summary.target.targetDate) })}
                </span>
                {onReviewTargetDate ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      close();
                      onReviewTargetDate();
                    }}
                  >
                    {t('resume.reviewTarget')}
                  </Button>
                ) : null}
              </dd>
            </div>
          )}
        </dl>
        <LongTextField
          id={fieldId}
          label={t('resume.comment.label')}
          hint={t('resume.comment.hint')}
          value={comment}
          max={PROCESS_SUSPENSION_LIMITS.commentMax}
          required={false}
          error={error}
          onChange={(value) => {
            setComment(value);
            setError(undefined);
          }}
        />
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={submitting} onClick={close}>
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            aria-disabled={submitting || detail.data === undefined ? true : undefined}
          >
            {submitting ? t('resume.submitting') : t('resume.submit')}
          </Button>
        </DialogFooter>
      </form>
    </LifecycleShell>
  );
}
