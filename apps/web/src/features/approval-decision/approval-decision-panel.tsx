'use client';

import { Alert, Button, cx, toast } from '@contrataflow/ui';
import type {
  ApprovalDecision,
  ApprovalDocumentDto,
  ApprovalDto,
  ApprovalMeta,
  DecidedApprovalDto,
} from '@contrataflow/validation';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useState } from 'react';

import { Icon } from '@/components/shell/icons';
import type { RetryOptions } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

import { approvalKeys, useDecideApproval } from './approval-decision.api';
import { CommentField, TargetSelector, WarningsChecklist } from './decision-fields';
import {
  DECISION_FIELD_ORDER,
  buildDecisionBody,
  commentRequired,
  describeDecisionError,
  groupDecisionOptions,
  isConfirmEnabled,
  isNoticeProblem,
  needsRefresh,
  needsTargetChoice,
  resolveOption,
  validateDecision,
  violationDocumentId,
  warningsOf,
  withoutTrailingPeriod,
} from './decision-model';
import type {
  DecisionField,
  DecisionFieldMessages,
  DecisionGroup,
  DecisionProblem,
} from './decision-model';

export interface ApprovalDecisionPanelProps {
  readonly approval: ApprovalDto;
  readonly meta: ApprovalMeta;
  /** Recusa que a tela inteira explica (aprovação decidida, versão antiga…); `null` limpa o aviso. */
  readonly onNotice: (problem: DecisionProblem | null) => void;
  /** Relê a aprovação (opções, avisos e bloqueios podem ter mudado). */
  readonly onRefresh: () => void;
  /** Retentativas automáticas da mutação (testes: `{ retries: 0 }`). */
  readonly retry?: RetryOptions | undefined;
}

/**
 * `ApprovalDecisionPanel` (US-052 · SCR-015): três botões grandes (Aprovar, Devolver para ajuste,
 * Indeferir) com `aria-pressed`; etapa de destino quando há mais de uma opção; comentário
 * obrigatório para devolver e indeferir (RN-TRAM-55); avisos `WARNING` com ciência antes de
 * habilitar o botão de confirmar (FA-03); opção com regra `BLOCKING` desabilitada com a mensagem
 * da regra. Confirma com o APV-03 (`If-Match` da última leitura, `Idempotency-Key` por intenção),
 * invalida aprovação, processo e caixa de tarefas, avisa e volta ao processo. Erros em `aria-live`
 * com foco no primeiro campo inválido; o formulário continua preenchido nas falhas temporárias.
 */
export function ApprovalDecisionPanel({
  approval,
  meta,
  onNotice,
  onRefresh,
  retry,
}: ApprovalDecisionPanelProps) {
  const t = useTranslations('approvals.panel');
  const tDecided = useTranslations('approvals.record.decisions');
  const router = useRouter();
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  const ids = useId();
  const fieldId = (field: DecisionField) => `${ids}-${field}`;
  const mutation = useDecideApproval(retry);
  const submitting = mutation.isPending;

  const [decision, setDecision] = useState<ApprovalDecision | null>(null);
  const [targetChoice, setTargetChoice] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [acknowledged, setAcknowledged] = useState<readonly string[]>([]);
  const [errors, setErrors] = useState<DecisionFieldMessages>({});
  const [problem, setProblem] = useState<DecisionProblem | null>(null);
  const [focusRequest, setFocusRequest] = useState<{
    fields: readonly DecisionField[];
    n: number;
  } | null>(null);

  const groups = useMemo(() => groupDecisionOptions(meta.decisionOptions), [meta.decisionOptions]);
  const group = groups.find((candidate) => candidate.decision === decision);
  const option = resolveOption(group, targetChoice);
  const warnings = warningsOf(option);
  const confirmEnabled = isConfirmEnabled(option, acknowledged);

  // Foco no primeiro erro (campo na ordem da tela): botões, destino, comentário, avisos.
  useEffect(() => {
    if (focusRequest === null) return;
    for (const field of focusRequest.fields) {
      const element = focusTarget(field, ids);
      if (element !== null) {
        element.focus();
        return;
      }
    }
  }, [focusRequest, ids]);

  const showErrors = (found: DecisionFieldMessages) => {
    setErrors(found);
    const fields = DECISION_FIELD_ORDER.filter((field) => found[field] !== undefined);
    if (fields.length > 0) {
      setFocusRequest((previous) => ({ fields, n: (previous?.n ?? 0) + 1 }));
    }
  };
  const clearError = (field: DecisionField) => {
    setErrors((previous) => {
      if (previous[field] === undefined) return previous;
      const { [field]: _removed, ...rest } = previous;
      return rest;
    });
  };

  const choose = (next: ApprovalDecision) => {
    if (submitting) return;
    setDecision(next);
    setTargetChoice(null);
    setAcknowledged([]);
    setProblem(null);
    setErrors({});
  };

  const handleError = (error: unknown) => {
    const found = describeDecisionError(error);
    if (isNoticeProblem(found)) {
      onNotice(found);
      onRefresh();
      return;
    }
    setProblem(found);
    if (found.kind === 'fields') showErrors(found.messages);
    if (found.kind === 'warnings') showErrors({ warnings: t('errors.warningsNotAcknowledged') });
    if (needsRefresh(found)) onRefresh();
  };

  const finish = (result: DecidedApprovalDto) => {
    const decided = result.decision ?? decision;
    toast({
      title: t('toast', { decision: decided === null ? '' : tDecided(decided) }),
      tone: 'success',
    });
    void queryClient.invalidateQueries({ queryKey: approvalKeys.all(tenantId) });
    void queryClient.invalidateQueries({
      queryKey: tenantKey(tenantId, 'processes', approval.process.id),
    });
    void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, 'tasks') });
    router.push(`/processos/${approval.process.id}`);
  };

  const submit = async () => {
    if (submitting) return;
    setProblem(null);
    onNotice(null);
    const draft = { decision, group, option, comment, acknowledged };
    const found = validateDecision(draft);
    if (Object.keys(found).length > 0 || decision === null || option === undefined) {
      showErrors(found);
      setProblem({ kind: 'fields', messages: found, others: [] });
      return;
    }
    setErrors({});
    let result: DecidedApprovalDto;
    try {
      result = await mutation.submit({
        approvalId: approval.id,
        body: buildDecisionBody({ decision, option, comment, acknowledged }),
        version: approval.version,
      });
    } catch (error) {
      handleError(error);
      return;
    }
    finish(result);
  };

  const headingId = `${ids}-heading`;
  const confirmLabel = submitting ? t('confirm.submitting') : t(`confirm.${decision ?? 'none'}`);

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-surface p-4 md:p-6"
    >
      <h2 id={headingId} className="text-base font-semibold">
        {t('heading')}
      </h2>

      <div aria-live="assertive" className="flex flex-col gap-2">
        {problem === null ? null : (
          <ProblemAlert
            problem={problem}
            documents={approval.documents}
            processId={approval.process.id}
            onRetry={() => {
              void submit();
            }}
          />
        )}
      </div>

      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset
          id={fieldId('decision')}
          className="flex min-w-0 flex-col gap-2"
          aria-describedby={errors.decision ? `${fieldId('decision')}-error` : undefined}
        >
          <legend className="mb-1 text-sm font-medium">{t('decisionLegend')}</legend>
          <div className="grid gap-3 md:grid-cols-3">
            {groups.map((candidate) => (
              <DecisionButton
                key={candidate.decision}
                group={candidate}
                pressed={candidate.decision === decision}
                idPrefix={ids}
                onChoose={choose}
              />
            ))}
          </div>
          {errors.decision ? (
            <p id={`${fieldId('decision')}-error`} className="text-xs text-destructive">
              {errors.decision}
            </p>
          ) : null}
        </fieldset>

        {decision !== null && needsTargetChoice(group) && group ? (
          <TargetSelector
            name={fieldId('transitionId')}
            options={group.options}
            selected={targetChoice}
            error={errors.transitionId}
            onSelect={(key) => {
              setTargetChoice(key);
              setAcknowledged([]);
              clearError('transitionId');
            }}
          />
        ) : null}

        <CommentField
          id={fieldId('comment')}
          value={comment}
          required={commentRequired(decision)}
          error={errors.comment}
          onChange={(value) => {
            setComment(value);
            clearError('comment');
          }}
        />

        <WarningsChecklist
          id={fieldId('warnings')}
          warnings={warnings}
          acknowledged={acknowledged}
          error={errors.warnings}
          onToggle={(ruleId, checked) => {
            setAcknowledged((previous) =>
              checked
                ? [...new Set([...previous, ruleId])]
                : previous.filter((candidate) => candidate !== ruleId),
            );
            clearError('warnings');
          }}
        />

        <div className="flex flex-col gap-2 md:items-end">
          {confirmEnabled ? null : (
            <p id={`${ids}-confirm-hint`} className="text-xs text-muted-foreground">
              {t('warnings.pending')}
            </p>
          )}
          <Button
            type="submit"
            variant={decision === 'REJECT' ? 'destructive' : 'primary'}
            disabled={!confirmEnabled}
            aria-disabled={submitting ? true : undefined}
            aria-describedby={confirmEnabled ? undefined : `${ids}-confirm-hint`}
            className="max-md:min-h-12 max-md:w-full max-md:text-base"
          >
            {confirmLabel}
          </Button>
        </div>
      </form>
    </section>
  );
}

/** Elemento que recebe o foco quando o campo tem erro. */
function focusTarget(field: DecisionField, ids: string): HTMLElement | null {
  switch (field) {
    case 'decision':
      return (
        document.getElementById(`${ids}-decision`)?.querySelector<HTMLElement>('button:enabled') ??
        null
      );
    case 'transitionId':
      return (
        Array.from(document.getElementsByName(`${ids}-transitionId`)).find(
          (element): element is HTMLInputElement =>
            element instanceof HTMLInputElement && !element.disabled,
        ) ?? null
      );
    case 'comment':
      return document.getElementById(`${ids}-comment`);
    case 'warnings':
      return (
        document
          .getElementById(`${ids}-warnings`)
          ?.querySelector<HTMLElement>('input[type="checkbox"]:not(:checked)') ?? null
      );
  }
}

/** Um dos três botões: rótulo, estado `aria-pressed`, destino ou o motivo de estar indisponível. */
function DecisionButton({
  group,
  pressed,
  idPrefix,
  onChoose,
}: {
  readonly group: DecisionGroup;
  readonly pressed: boolean;
  readonly idPrefix: string;
  readonly onChoose: (decision: ApprovalDecision) => void;
}) {
  const t = useTranslations('approvals.panel');
  const hintId = `${idPrefix}-hint-${group.decision}`;
  const [only] = group.options;
  let hint: string | null = null;
  if (!group.available) {
    hint =
      group.blockedMessages.length > 0
        ? t('blockedBy', { message: group.blockedMessages.map(withoutTrailingPeriod).join(' · ') })
        : t('unavailable');
  } else if (group.options.length === 1 && only?.toStage) {
    hint = t('destination', { stage: only.toStage.name });
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Button
        type="button"
        variant={pressed ? (group.decision === 'REJECT' ? 'destructive' : 'primary') : 'secondary'}
        size="md"
        aria-pressed={pressed}
        aria-describedby={hint === null ? undefined : hintId}
        disabled={!group.available}
        className={cx('min-h-12 text-base max-md:min-h-14')}
        onClick={() => {
          onChoose(group.decision);
        }}
      >
        {pressed ? <Icon name="check" className="size-4" /> : null}
        {t(`decisions.${group.decision}`)}
      </Button>
      {hint === null ? null : (
        <p id={hintId} className="text-xs break-words text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Mensagem do erro com a ação da tabela "Casos de erro" (Tentar novamente, Copiar código…). */
function ProblemAlert({
  problem,
  documents,
  processId,
  onRetry,
}: {
  readonly problem: DecisionProblem;
  readonly documents: readonly ApprovalDocumentDto[];
  readonly processId: string;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('approvals.panel.errors');
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
    case 'warnings':
      return <Alert tone="warning" title={t('warningsNotAcknowledged')} />;
    case 'blocked':
      return (
        <Alert tone="error" title={t('transitionBlocked')}>
          <ul className="list-disc pl-5 text-sm">
            {problem.violations.map((violation, index) => {
              const documentId = violationDocumentId(violation, documents);
              return (
                <li key={`${violation.ruleId ?? 'rule'}-${String(index)}`}>
                  {violation.message}
                  {documentId === null ? null : (
                    <>
                      {' '}
                      <Link
                        href={`/processos/${processId}/documentos/${documentId}`}
                        className="text-primary underline"
                      >
                        {t('openDocument')}
                      </Link>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
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
    case 'transitionNotAvailable':
    case 'approverUnresolved':
    case 'idempotencyReused':
    case 'membership':
      return <Alert tone="error" title={t(problem.kind)} />;
    default:
      // Recusas explicadas pela tela inteira (`onNotice`) não chegam aqui.
      return null;
  }
}
