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
import type { ApprovalDto, ApprovalMeta } from '@contrataflow/validation';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';

import type { RetryOptions } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

import {
  approvalKeys,
  useApproverCandidates,
  useReassignApproval,
  useWithdrawApproval,
} from './approval-decision.api';
import {
  REASSIGN_TARGET_TYPES,
  canReassign,
  canWithdraw,
  describePendingActionError,
  isClosingProblem,
  reassignBodyOf,
  validateReassign,
  withdrawBodyOf,
} from './pending-actions-model';
import type {
  PendingActionProblem,
  ReassignFieldMessages,
  ReassignTargetType,
} from './pending-actions-model';
import { INPUT_CLASS, TEXTAREA_CLASS } from '../processes/form-field';

/** Recusa que a tela inteira explica (o diálogo fecha e a aprovação é relida). */
export type PendingActionNotice = Extract<
  PendingActionProblem,
  {
    readonly kind:
      'notPending' | 'stale' | 'precondition' | 'processStatus' | 'notFound' | 'denied';
  }
>;

/** Coluna única abaixo de 768 px (story · Acessibilidade e responsividade). */
const DIALOG_CLASS =
  'max-h-[90vh] overflow-y-auto max-md:inset-0 max-md:h-full max-md:max-h-none max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none';

/** Espera da busca de candidatos (debounce). */
const SEARCH_DEBOUNCE_MS = 300;

export interface ApprovalPendingActionsProps {
  readonly approval: ApprovalDto;
  readonly meta: ApprovalMeta;
  readonly retry?: RetryOptions | undefined;
  /** Recusa explicada pela tela (já decidida, atualizada, sem permissão…). */
  readonly onNotice: (notice: PendingActionNotice | null) => void;
  readonly onRefresh: () => void;
}

/**
 * Ações sobre a aprovação pendente (US-053 · SCR-015): "Retirar aprovação" (APV-04 — POL-17) e
 * "Redirecionar aprovação" (APV-05 — `APPROVAL_REASSIGN`), cada uma só com a ação em
 * `meta.allowedActions` (sem permissão, o botão nem aparece). Sucesso invalida as aprovações, o
 * processo e a caixa de tarefas.
 */
export function ApprovalPendingActions({
  approval,
  meta,
  retry,
  onNotice,
  onRefresh,
}: ApprovalPendingActionsProps) {
  const t = useTranslations('approvals.pendingActions');
  const headingId = useId();
  const [open, setOpen] = useState<'withdraw' | 'reassign' | null>(null);
  const withdrawable = canWithdraw(meta);
  const reassignable = canReassign(meta);
  if (approval.status !== 'PENDING' || (!withdrawable && !reassignable)) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4 md:p-6"
    >
      <h2 id={headingId} className="text-base font-semibold">
        {t('heading')}
      </h2>
      <div className="flex flex-col gap-2 sm:flex-row">
        {withdrawable ? (
          <Button
            variant="secondary"
            onClick={() => {
              setOpen('withdraw');
            }}
          >
            {t('withdraw')}
          </Button>
        ) : null}
        {reassignable ? (
          <Button
            variant="secondary"
            onClick={() => {
              setOpen('reassign');
            }}
          >
            {t('reassign')}
          </Button>
        ) : null}
      </div>
      {withdrawable ? (
        <WithdrawApprovalDialog
          approval={approval}
          open={open === 'withdraw'}
          retry={retry}
          onOpenChange={(next) => {
            setOpen(next ? 'withdraw' : null);
          }}
          onNotice={onNotice}
          onRefresh={onRefresh}
        />
      ) : null}
      {reassignable ? (
        <ReassignApprovalDialog
          approval={approval}
          open={open === 'reassign'}
          retry={retry}
          onOpenChange={(next) => {
            setOpen(next ? 'reassign' : null);
          }}
          onNotice={onNotice}
          onRefresh={onRefresh}
        />
      ) : null}
    </section>
  );
}

interface DialogProps {
  readonly approval: ApprovalDto;
  readonly open: boolean;
  readonly retry: RetryOptions | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onNotice: (notice: PendingActionNotice | null) => void;
  readonly onRefresh: () => void;
}

/** Invalidações depois do sucesso (`['t', tenantId, 'approvals'|'processes'|'tasks']`). */
function useInvalidateAfterAction(processId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  return () => {
    void queryClient.invalidateQueries({ queryKey: approvalKeys.all(tenantId) });
    void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, 'processes', processId) });
    void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, 'tasks') });
  };
}

/** Erro que fica no diálogo (o formulário continua preenchido). */
function ProblemAlert({
  problem,
  onRetry,
}: {
  readonly problem: PendingActionProblem;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('approvals.pendingActions.errors');
  switch (problem.kind) {
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
    case 'notEligible':
    case 'selfApproval':
    case 'idempotencyReused':
    case 'fields':
      return <Alert tone="error" title={t(problem.kind)} />;
    default:
      return null;
  }
}

/**
 * `WithdrawApprovalDialog` (US-053 · fluxo principal, passos 2–5): explica o efeito (etapa: volta
 * à etapa anterior sob sua responsabilidade; avulsa: o documento volta a rascunho), motivo
 * opcional (≤ 2.000, foco inicial) e confirma com o APV-04 (`If-Match` + `Idempotency-Key`).
 */
function WithdrawApprovalDialog({
  approval,
  open,
  retry,
  onOpenChange,
  onNotice,
  onRefresh,
}: DialogProps) {
  const t = useTranslations('approvals.pendingActions');
  const router = useRouter();
  const reasonId = useId();
  const mutation = useWithdrawApproval(retry);
  const invalidate = useInvalidateAfterAction(approval.process.id);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<PendingActionProblem | null>(null);
  const submitting = mutation.isPending;
  const stage = approval.subjectType === 'PROCESS_STAGE';

  const close = (next: boolean) => {
    if (!next) {
      setReason('');
      setProblem(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    if (submitting) return;
    setProblem(null);
    onNotice(null);
    try {
      await mutation.submit({
        approvalId: approval.id,
        body: withdrawBodyOf(reason),
        version: approval.version,
      });
    } catch (error) {
      const found = describePendingActionError(error);
      if (isClosingProblem(found)) {
        onNotice(found as PendingActionNotice);
        onRefresh();
        close(false);
        return;
      }
      setProblem(found);
      return;
    }
    toast({
      title: t(stage ? 'toast.withdrawnStage' : 'toast.withdrawnDocument'),
      tone: 'success',
    });
    invalidate();
    close(false);
    router.push(`/processos/${approval.process.id}`);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        closeLabel={t('withdrawDialog.cancel')}
        className={DIALOG_CLASS}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(reasonId)?.focus();
        }}
      >
        <DialogTitle>{t('withdrawDialog.title')}</DialogTitle>
        <DialogDescription>
          {t(stage ? 'withdrawDialog.stageEffect' : 'withdrawDialog.documentEffect')}
        </DialogDescription>
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
                onRetry={() => {
                  void submit();
                }}
              />
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={reasonId} className="text-sm font-medium">
              {t('withdrawDialog.reason')}
            </label>
            <textarea
              id={reasonId}
              value={reason}
              maxLength={2000}
              rows={4}
              aria-describedby={`${reasonId}-hint`}
              className={TEXTAREA_CLASS}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <p id={`${reasonId}-hint`} className="text-xs text-muted-foreground">
              {t('withdrawDialog.reasonHint')}
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                close(false);
              }}
            >
              {t('withdrawDialog.cancel')}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? t('withdrawDialog.submitting') : t('withdrawDialog.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * `ReassignApprovalDialog` (US-053 · FA-02): o tipo do novo aprovador (pessoa ou titular de outra
 * unidade), a busca assíncrona com debounce (USR-02/DEP-02 — a elegibilidade final é da API: 422
 * `APPROVER_NOT_ELIGIBLE` recarrega a lista) e o motivo obrigatório (≥ 10). Confirma com o APV-05.
 */
function ReassignApprovalDialog({
  approval,
  open,
  retry,
  onOpenChange,
  onNotice,
  onRefresh,
}: DialogProps) {
  const t = useTranslations('approvals.pendingActions');
  const ids = useId();
  const searchId = `${ids}-search`;
  const reasonId = `${ids}-reason`;
  const mutation = useReassignApproval(retry);
  const invalidate = useInvalidateAfterAction(approval.process.id);
  const [approverType, setApproverType] = useState<ReassignTargetType>('USER');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [targetId, setTargetId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<ReassignFieldMessages>({});
  const [problem, setProblem] = useState<PendingActionProblem | null>(null);
  const candidates = useApproverCandidates(approverType, term);
  const submitting = mutation.isPending;

  useEffect(() => {
    const timer = setTimeout(() => {
      setTerm(search);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [search]);

  const close = (next: boolean) => {
    if (!next) {
      setApproverType('USER');
      setSearch('');
      setTerm('');
      setTargetId(null);
      setReason('');
      setErrors({});
      setProblem(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    if (submitting) return;
    setProblem(null);
    onNotice(null);
    const draft = { approverType, targetId, reason };
    const invalid = validateReassign(draft);
    if (invalid.target !== undefined || invalid.reason !== undefined) {
      setErrors(invalid);
      setProblem({ kind: 'fields', messages: invalid });
      document.getElementById(invalid.target === undefined ? reasonId : searchId)?.focus();
      return;
    }
    setErrors({});
    try {
      await mutation.submit({
        approvalId: approval.id,
        body: reassignBodyOf(draft),
        version: approval.version,
      });
    } catch (error) {
      const found = describePendingActionError(error);
      if (isClosingProblem(found)) {
        onNotice(found as PendingActionNotice);
        onRefresh();
        close(false);
        return;
      }
      if (found.kind === 'fields') setErrors(found.messages);
      if (found.kind === 'notEligible') {
        // "Recarrega lista de aprovadores possíveis" (Casos de erro).
        setTargetId(null);
        void candidates.refetch();
      }
      setProblem(found);
      return;
    }
    toast({ title: t('toast.reassigned'), tone: 'success' });
    invalidate();
    onRefresh();
    close(false);
  };

  const options = candidates.data ?? [];
  const searching = candidates.isFetching;
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        closeLabel={t('reassignDialog.cancel')}
        className={DIALOG_CLASS}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(searchId)?.focus();
        }}
      >
        <DialogTitle>{t('reassignDialog.title')}</DialogTitle>
        <DialogDescription>{t('reassignDialog.description')}</DialogDescription>
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
                onRetry={() => {
                  void submit();
                }}
              />
            )}
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">{t('reassignDialog.typeLegend')}</legend>
            <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
              {REASSIGN_TARGET_TYPES.map((type) => (
                <label key={type} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`${ids}-type`}
                    value={type}
                    checked={approverType === type}
                    onChange={() => {
                      setApproverType(type);
                      setTargetId(null);
                      setSearch('');
                      setTerm('');
                    }}
                  />
                  {t(`reassignDialog.types.${type}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={searchId} className="text-sm font-medium">
              {t(`reassignDialog.search.${approverType}`)}
            </label>
            <input
              id={searchId}
              type="search"
              value={search}
              aria-required
              aria-invalid={errors.target ? true : undefined}
              aria-describedby={[
                `${searchId}-hint`,
                errors.target ? `${searchId}-error` : undefined,
              ]
                .filter(Boolean)
                .join(' ')}
              className={`${INPUT_CLASS} min-h-11`}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
            <p id={`${searchId}-hint`} className="text-xs text-muted-foreground">
              {t('reassignDialog.searchHint')}
            </p>
            {errors.target ? (
              <p id={`${searchId}-error`} className="text-xs text-destructive">
                {errors.target}
              </p>
            ) : null}
            <div aria-live="polite" className="text-xs text-muted-foreground">
              {searching ? t('reassignDialog.searching') : null}
              {candidates.isError ? t('reassignDialog.searchFailed') : null}
              {!searching && candidates.isSuccess && options.length === 0
                ? t('reassignDialog.noResults')
                : null}
            </div>
            {options.length > 0 ? (
              <fieldset className="flex flex-col gap-1">
                <legend className="sr-only">{t('reassignDialog.resultsLegend')}</legend>
                {options.map((option) => (
                  <label
                    key={option.id}
                    className="flex min-h-11 min-w-0 items-center gap-2 text-sm break-words"
                  >
                    <input
                      type="radio"
                      name={`${ids}-target`}
                      value={option.id}
                      checked={targetId === option.id}
                      onChange={() => {
                        setTargetId(option.id);
                        setErrors(({ reason: current }) =>
                          current === undefined ? {} : { reason: current },
                        );
                      }}
                    />
                    <span className="min-w-0">
                      {option.label}
                      {option.hint === null ? null : (
                        <span className="block text-xs text-muted-foreground">{option.hint}</span>
                      )}
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={reasonId} className="text-sm font-medium">
              {t('reassignDialog.reason')}
            </label>
            <textarea
              id={reasonId}
              value={reason}
              rows={4}
              maxLength={2000}
              aria-required
              aria-invalid={errors.reason ? true : undefined}
              aria-describedby={[
                `${reasonId}-hint`,
                errors.reason ? `${reasonId}-error` : undefined,
              ]
                .filter(Boolean)
                .join(' ')}
              className={TEXTAREA_CLASS}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <p id={`${reasonId}-hint`} className="text-xs text-muted-foreground">
              {t('reassignDialog.reasonHint')}
            </p>
            {errors.reason ? (
              <p id={`${reasonId}-error`} className="text-xs text-destructive">
                {errors.reason}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                close(false);
              }}
            >
              {t('reassignDialog.cancel')}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? t('reassignDialog.submitting') : t('reassignDialog.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
