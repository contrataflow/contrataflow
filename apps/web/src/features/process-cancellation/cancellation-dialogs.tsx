'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  toast,
} from '@contrataflow/ui';
import { PROCESS_CANCELLATION_LIMITS } from '@contrataflow/validation';
import type { ProcessSummaryDto } from '@contrataflow/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { RetryOptions } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useShellSession } from '@/lib/session/session-context';

import {
  cancellationImpact,
  describeCancellationError,
  validateCancellationReason,
  validateDiscardReason,
} from './cancellation-model';
import type { CancellationProblem } from './cancellation-model';
import { useCancelProcess, useDiscardProcessDraft } from './process-cancellation.api';
import { useInvalidateProcess } from '../process-panel/process-panel.api';
import { TEXTAREA_CLASS } from '../processes/form-field';
import { fetchProcess, processKeys } from '../processes/processes.api';

/** Listas que cancelar/descartar mudam além do processo: caixa de tarefas, lista e painel inicial. */
const AFTER_KEYS = ['processes', 'tasks', 'dashboard'] as const;

/** Tela cheia abaixo de 768 px (utilizável em 360 px — story · "Frontend"). */
const DIALOG_CLASS =
  'max-h-[90vh] overflow-y-auto max-md:inset-0 max-md:h-full max-md:max-h-none max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none';

interface CancellationDialogProps {
  readonly processId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
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
function useAfterCancellation(processId: string) {
  const queryClient = useQueryClient();
  const tenantId = useShellSession().activeTenant.id;
  const invalidateProcess = useInvalidateProcess(processId);
  return () => {
    void invalidateProcess();
    for (const key of AFTER_KEYS) {
      void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, key) });
    }
  };
}

/** Texto longo com contador anunciado e dica/erro associados (`aria-describedby`). */
function ReasonField({
  id,
  label,
  hint,
  value,
  max,
  required,
  error,
  describedBy,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly max: number;
  readonly required: boolean;
  readonly error: string | undefined;
  /** Outro elemento que descreve o campo (a lista de impactos). */
  readonly describedBy?: string | undefined;
  readonly onChange: (value: string) => void;
}) {
  const t = useTranslations('processes.cancellation');
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
        aria-describedby={[describedBy, hintId, counterId, error ? errorId : undefined]
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
  onCancelInstead,
}: {
  readonly problem: CancellationProblem;
  readonly onReload: () => void;
  readonly onRetry: () => void;
  readonly onCancelInstead?: (() => void) | undefined;
}) {
  const t = useTranslations('processes.cancellation.errors');
  switch (problem.kind) {
    case 'field':
      return <Alert tone="error" title={problem.message} />;
    case 'stale':
      return (
        <Alert tone="warning" title={t('stale')}>
          <Button size="sm" variant="secondary" className="mt-2" onClick={onReload}>
            {t('reload')}
          </Button>
        </Alert>
      );
    case 'numbered':
      // FA-01: o rascunho já tem número — a saída é cancelar.
      return (
        <Alert tone="warning" title={t('numbered')}>
          {onCancelInstead ? (
            <Button size="sm" variant="secondary" className="mt-2" onClick={onCancelInstead}>
              {t('cancelInstead')}
            </Button>
          ) : null}
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

/** Recusa que encerra o diálogo (status mudou, sem permissão, sem acesso, não encontrado). */
type ClosingProblem = Extract<
  CancellationProblem,
  { readonly kind: 'status' | 'permission' | 'notFound' | 'access' }
>;
const CLOSING: ReadonlySet<CancellationProblem['kind']> = new Set([
  'status',
  'permission',
  'notFound',
  'access',
]);
const isClosing = (problem: CancellationProblem): problem is ClosingProblem =>
  CLOSING.has(problem.kind);

/**
 * Esqueleto comum: título, efeitos (`DialogDescription`), foco inicial no campo do motivo, alerta
 * em `aria-live` e o diálogo travado durante a requisição.
 */
function CancellationShell({
  open,
  onOpenChange,
  busy,
  fieldId,
  title,
  description,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly busy: boolean;
  readonly fieldId: string;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  const t = useTranslations('processes.cancellation');
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        closeLabel={t('close')}
        className={DIALOG_CLASS}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(fieldId)?.focus();
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export interface CancelProcessDialogProps extends CancellationDialogProps {
  /** O painel (PRC-07): aprovações pendentes e documentos em aprovação que o cancelamento encerra. */
  readonly summary: ProcessSummaryDto | undefined;
}

/**
 * `CancelProcessDialog` (US-009 · SCR-116): lista o que será encerrado (FA-02), pede a justificativa
 * (mínimo de 20 caracteres, com contador — o botão só habilita a partir daí, FA-04) e confirma com o
 * PRC-25 (`If-Match` da versão do PRC-04). Erro mantém o texto digitado.
 */
export function CancelProcessDialog({
  processId,
  open,
  onOpenChange,
  summary,
  retry,
}: CancelProcessDialogProps) {
  const t = useTranslations('processes.cancellation');
  const router = useRouter();
  const fieldId = useId();
  const impactId = useId();
  const detail = useProcessVersion(processId, open);
  const mutation = useCancelProcess(retry);
  const after = useAfterCancellation(processId);
  const invalidateProcess = useInvalidateProcess(processId);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [problem, setProblem] = useState<CancellationProblem | null>(null);
  const submitting = mutation.isPending;
  const impact = cancellationImpact(summary);
  const valid = validateCancellationReason(reason) === undefined;

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setError(undefined);
      setProblem(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    if (submitting) return;
    setProblem(null);
    const invalid = validateCancellationReason(reason);
    if (invalid !== undefined) {
      setError(invalid);
      document.getElementById(fieldId)?.focus();
      return;
    }
    const version = detail.data?.version;
    if (version === undefined) return;
    setError(undefined);
    try {
      await mutation.submit({
        processId,
        body: { cancellationReason: reason.trim() },
        version,
      });
    } catch (failure) {
      const found = describeCancellationError(failure, 'cancellationReason');
      if (isClosing(found)) {
        toast({ title: t(`errors.${found.kind}`), tone: 'error' });
        void invalidateProcess();
        handleOpenChange(false);
        if (found.kind === 'notFound') router.push('/processos');
        return;
      }
      if (found.kind === 'field') {
        setError(found.message);
        document.getElementById(fieldId)?.focus();
      }
      setProblem(found);
      return;
    }
    toast({ title: t('canceled'), tone: 'success' });
    after();
    setReason('');
    handleOpenChange(false);
  };

  return (
    <CancellationShell
      open={open}
      onOpenChange={handleOpenChange}
      busy={submitting}
      fieldId={fieldId}
      title={t('cancel.title')}
      description={t('cancel.description')}
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
        <div id={impactId} className="flex flex-col gap-1 text-sm">
          <p className="font-medium">{t('cancel.impactTitle')}</p>
          <ul className="list-disc pl-5">
            {impact.pendingApprovals > 0 ? (
              <li>{t('cancel.impact.approvals', { count: impact.pendingApprovals })}</li>
            ) : null}
            {impact.documentsInApproval > 0 ? (
              <li>{t('cancel.impact.documents', { count: impact.documentsInApproval })}</li>
            ) : null}
            <li>{t('cancel.impact.stage')}</li>
            <li>{t('cancel.impact.final')}</li>
          </ul>
        </div>
        <ReasonField
          id={fieldId}
          label={t('cancel.reason.label')}
          hint={t('cancel.reason.hint')}
          value={reason}
          max={PROCESS_CANCELLATION_LIMITS.reasonMax}
          required
          error={error}
          describedBy={impactId}
          onChange={(value) => {
            setReason(value);
            setError(undefined);
          }}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            disabled={submitting}
            onClick={() => {
              handleOpenChange(false);
            }}
          >
            {t('back')}
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={!valid || submitting || detail.data === undefined}
          >
            {submitting ? t('cancel.submitting') : t('cancel.submit')}
          </Button>
        </DialogFooter>
      </form>
    </CancellationShell>
  );
}

export interface DiscardDraftDialogProps extends CancellationDialogProps {
  /** FA-01: o rascunho já tem número — fecha este diálogo e abre o "Cancelar processo". */
  readonly onCancelInstead?: (() => void) | undefined;
}

/**
 * `DiscardDraftDialog` (US-009 · SCR-116): confirma a exclusão do rascunho sem número (motivo
 * opcional, até 500 — só na auditoria) com o PRC-06 e volta à lista com "Rascunho descartado".
 * Numerado (409 `CANNOT_DISCARD_NUMBERED_PROCESS`): oferece "Cancelar processo" (FA-01).
 */
export function DiscardDraftDialog({
  processId,
  open,
  onOpenChange,
  onCancelInstead,
  retry,
}: DiscardDraftDialogProps) {
  const t = useTranslations('processes.cancellation');
  const router = useRouter();
  const fieldId = useId();
  const detail = useProcessVersion(processId, open);
  const mutation = useDiscardProcessDraft(retry);
  const queryClient = useQueryClient();
  const tenantId = useShellSession().activeTenant.id;
  const invalidateProcess = useInvalidateProcess(processId);
  const done = useRef(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [problem, setProblem] = useState<CancellationProblem | null>(null);
  const submitting = mutation.isPending;

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setError(undefined);
      setProblem(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    if (submitting || done.current) return;
    setProblem(null);
    const invalid = validateDiscardReason(reason);
    if (invalid !== undefined) {
      setError(invalid);
      document.getElementById(fieldId)?.focus();
      return;
    }
    const version = detail.data?.version;
    if (version === undefined) return;
    setError(undefined);
    const trimmed = reason.trim();
    try {
      await mutation.submit({
        processId,
        body: trimmed === '' ? {} : { reason: trimmed },
        version,
      });
    } catch (failure) {
      const found = describeCancellationError(failure, 'reason');
      if (isClosing(found)) {
        toast({ title: t(`errors.${found.kind}`), tone: 'error' });
        void invalidateProcess();
        handleOpenChange(false);
        if (found.kind === 'notFound') router.push('/processos');
        return;
      }
      if (found.kind === 'field') {
        setError(found.message);
        document.getElementById(fieldId)?.focus();
      }
      setProblem(found);
      return;
    }
    done.current = true;
    toast({ title: t('discarded'), tone: 'success' });
    for (const key of AFTER_KEYS) {
      void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, key) });
    }
    handleOpenChange(false);
    router.push('/processos');
  };

  return (
    <CancellationShell
      open={open}
      onOpenChange={handleOpenChange}
      busy={submitting}
      fieldId={fieldId}
      title={t('discard.title')}
      description={t('discard.description')}
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
              onCancelInstead={
                onCancelInstead === undefined
                  ? undefined
                  : () => {
                      handleOpenChange(false);
                      void invalidateProcess();
                      onCancelInstead();
                    }
              }
            />
          )}
        </div>
        <ReasonField
          id={fieldId}
          label={t('discard.reason.label')}
          hint={t('discard.reason.hint')}
          value={reason}
          max={PROCESS_CANCELLATION_LIMITS.discardReasonMax}
          required={false}
          error={error}
          onChange={(value) => {
            setReason(value);
            setError(undefined);
          }}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            disabled={submitting}
            onClick={() => {
              handleOpenChange(false);
            }}
          >
            {t('back')}
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={submitting || detail.data === undefined}
          >
            {submitting ? t('discard.submitting') : t('discard.submit')}
          </Button>
        </DialogFooter>
      </form>
    </CancellationShell>
  );
}
