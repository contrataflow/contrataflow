'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DatePicker,
  DialogTitle,
  Field,
  SheetContent,
  Skeleton,
  fromIsoDate,
  toIsoDate,
  toast,
} from '@contrataflow/ui';
import { PROCESS_FORWARD_LIMITS } from '@contrataflow/validation';
import type { ForwardedProcessDto } from '@contrataflow/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { isApiError } from '@/lib/api/api-error';
import type { RetryOptions } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useShellSession } from '@/lib/session/session-context';

import {
  EMPTY_DUE_OVERRIDE,
  FORWARD_FIELD_ORDER,
  buildForwardBody,
  choosesDepartment,
  currentStageEnteredAt,
  deadlineMessage,
  defaultDepartment,
  defaultDocumentIds,
  describeForwardError,
  effectiveDocumentIds,
  forwardEntries,
  formatLocalDate,
  forwardedToast,
  initialTransitionId,
  isApprovalDestination,
  localToday,
  lockedDocumentIds,
  mergeRules,
  overrideLimit,
  rulesFor,
  summaryOf,
  validateForward,
} from './forward-model';
import type {
  DueOverride,
  ForwardDraft,
  ForwardField,
  ForwardFieldMessages,
  ForwardMessage,
  ForwardProblem,
  ForwardRule,
  PickedItem,
} from './forward-model';
import {
  DocumentsChecklist,
  LookupPicker,
  RulesSection,
  TransitionGroup,
} from './forward-sections';
import {
  forwardKeys,
  lookupOrganizationDepartments,
  useForwardProcess,
} from './process-forward.api';
import {
  processActionKeys,
  useAvailableActions,
  useProcessChecklist,
} from '../process-actions/process-actions.api';
import { useProcessDocuments } from '../process-documents/process-documents.api';
import { useInvalidateProcess, useProcessStages } from '../process-panel/process-panel.api';
import { lookupUsers } from '../process-participants/process-participants.api';
import { FormField, TEXTAREA_CLASS } from '../processes/form-field';
import { fetchProcess, processKeys } from '../processes/processes.api';

/** Consultas do tenant invalidadas depois do encaminhamento (a caixa e o painel mudam de contagem). */
const AFTER_FORWARD_KEYS = ['processes', 'tasks', 'dashboard'] as const;

export interface ForwardPanelProps {
  readonly processId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `transitionKey` da ação que abriu o painel: tem precedência sobre a transição primária. */
  readonly initialTransitionKey?: string | null | undefined;
  /** Depois de encaminhar e fechar: quem abriu devolve o foco ao cabeçalho de status. */
  readonly onForwarded?: (() => void) | undefined;
  /** Retentativas automáticas da mutação (padrão do cliente); os testes as zeram. */
  readonly retry?: RetryOptions | undefined;
}

/**
 * `ForwardPanel` (US-047 · SCR-103): painel lateral "Encaminhar processo" aberto pela ação primária
 * do SCR-006. Carrega PRC-08 (transições e prévias), PRC-09 (pendências e avisos) e DOC-01
 * (documentos), mostra "Para onde", unidade e responsável, prazo, comentário, documentos,
 * pendências e o resumo, e envia o PRC-19 com `If-Match` (versão do PRC-04) e `Idempotency-Key`.
 * Fechar com dados digitados pede confirmação; abaixo de 768 px ocupa a tela com as ações no rodapé.
 */
export function ForwardPanel({
  processId,
  open,
  onOpenChange,
  initialTransitionKey,
  onForwarded,
  retry,
}: ForwardPanelProps) {
  const t = useTranslations('processes.forward');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const forwarded = useRef(false);

  const close = () => {
    setDirty(false);
    setConfirmingClose(false);
    onOpenChange(false);
  };
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmingClose(true);
    else close();
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) onOpenChange(true);
          else requestClose();
        }}
      >
        <SheetContent
          closeLabel={t('close')}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            // Encaminhou: o foco vai ao cabeçalho de status, não ao botão que abriu o painel.
            if (!forwarded.current) return;
            forwarded.current = false;
            event.preventDefault();
            onForwarded?.();
          }}
        >
          <div className="border-b border-border p-4 pr-12">
            <DialogTitle>{t('title')}</DialogTitle>
          </div>
          <ForwardContent
            processId={processId}
            initialTransitionKey={initialTransitionKey}
            retry={retry}
            onDirtyChange={setDirty}
            onBusyChange={setBusy}
            onCancel={requestClose}
            onDismiss={close}
            onForwarded={() => {
              forwarded.current = true;
              close();
            }}
          />
        </SheetContent>
      </Dialog>
      <Dialog open={confirmingClose} onOpenChange={setConfirmingClose}>
        <DialogContent closeLabel={null}>
          <DialogTitle>{t('discard.title')}</DialogTitle>
          <DialogDescription>{t('discard.description')}</DialogDescription>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmingClose(false);
              }}
            >
              {t('discard.keep')}
            </Button>
            <Button variant="destructive" onClick={close}>
              {t('discard.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Texto de uma mensagem do modelo (chave relativa a `processes.forward`). */
function useForwardText() {
  const t = useTranslations('processes.forward');
  return {
    text: (message: ForwardMessage): string =>
      t(message.key as Parameters<typeof t>[0], message.values as never),
    rich: (message: ForwardMessage): ReactNode =>
      t.rich(
        message.key as Parameters<typeof t.rich>[0],
        {
          ...message.values,
          b: (chunks: ReactNode) => <strong>{chunks}</strong>,
        } as never,
      ),
  };
}

function loadingStatus(
  query: Pick<UseQueryResult, 'data' | 'isError'>,
): 'error' | 'pending' | 'ready' {
  if (query.data !== undefined) return 'ready';
  return query.isError ? 'error' : 'pending';
}

function ForwardContent({
  processId,
  initialTransitionKey,
  retry,
  onDirtyChange,
  onBusyChange,
  onCancel,
  onDismiss,
  onForwarded,
}: {
  readonly processId: string;
  readonly initialTransitionKey: string | null | undefined;
  readonly retry: RetryOptions | undefined;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onCancel: () => void;
  readonly onDismiss: () => void;
  readonly onForwarded: () => void;
}) {
  const t = useTranslations('processes.forward');
  const { text, rich } = useForwardText();
  const queryClient = useQueryClient();
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const timeZone = session.activeTenant.timezone;
  const ids = useId();
  const fieldId = (field: ForwardField) => `${ids}-${field}`;
  const invalidateProcess = useInvalidateProcess(processId);

  // ---- Dados (PRC-04 · PRC-08 · PRC-09 · DOC-01 · PRC-10) -----------------------------------
  const detail = useQuery({
    queryKey: processKeys.detail(tenantId, processId),
    queryFn: ({ signal }) => fetchProcess(processId, signal),
    throwOnError: false,
  });
  const actions = useAvailableActions(processId);
  const checklist = useProcessChecklist(processId);
  const documents = useProcessDocuments(processId);
  const stages = useProcessStages(processId);
  const mutation = useForwardProcess(retry);
  const submitting = mutation.isPending;

  // ---- Estado do formulário -----------------------------------------------------------------
  const [transitionChoice, setTransitionChoice] = useState<string | null>(null);
  // `undefined` = o usuário ainda não mexeu: vale o padrão (última unidade que executou a etapa).
  const [departmentChoice, setDepartmentChoice] = useState<PickedItem | null | undefined>(
    undefined,
  );
  const [assignee, setAssignee] = useState<PickedItem | null>(null);
  const [dueOverride, setDueOverride] = useState<DueOverride>(EMPTY_DUE_OVERRIDE);
  const [comment, setComment] = useState('');
  // `null` = o usuário não mexeu na lista: a API aplica o padrão (RN-TRAM-12).
  const [documentChoice, setDocumentChoice] = useState<readonly string[] | null>(null);
  const [acknowledged, setAcknowledged] = useState<readonly string[]>([]);
  const [errors, setErrors] = useState<ForwardFieldMessages>({});
  const [problem, setProblem] = useState<ForwardProblem | null>(null);
  // Regras que a API apontou depois da carga (FA-05/FA-06); valem até o PRC-09 ser relido:
  // `at` é o `dataUpdatedAt` da leitura que já existia quando o erro chegou.
  const [serverState, setServerState] = useState<{
    readonly rules: readonly ForwardRule[];
    readonly at: number;
  } | null>(null);
  const [stageChanged, setStageChanged] = useState(false);
  // Campos candidatos ao foco, na ordem da tela: vale o primeiro que existe no DOM.
  const [focusRequest, setFocusRequest] = useState<{
    fields: readonly ForwardField[];
    n: number;
  } | null>(null);

  const entries = forwardEntries(actions.data);
  const initialId = initialTransitionId(entries, initialTransitionKey);
  const selectedId =
    transitionChoice !== null && entries.some((entry) => entry.transitionId === transitionChoice)
      ? transitionChoice
      : initialId;
  const entry = entries.find((candidate) => candidate.transitionId === selectedId);
  const approval = isApprovalDestination(entry);
  const choosesUnit = choosesDepartment(entry);

  const documentList = documents.data?.items ?? [];
  const lockedIds = lockedDocumentIds(documentList, entry);
  const defaultIds = defaultDocumentIds(documentList, currentStageEnteredAt(stages.data));
  const selectedDocuments = effectiveDocumentIds(documentChoice, defaultIds, lockedIds);

  const department = choosesUnit
    ? departmentChoice === undefined
      ? defaultDepartment(entry, stages.data)
      : departmentChoice
    : null;
  const serverRules =
    serverState !== null && serverState.at === checklist.dataUpdatedAt ? serverState.rules : [];
  const rules = mergeRules(rulesFor(checklist.data, entry), serverRules);
  const blocking = rules.filter((rule) => rule.severity === 'BLOCKING');
  const warnings = rules.filter((rule) => rule.severity === 'WARNING');
  const today = localToday(new Date(), timeZone);
  const organizationId = detail.data?.organization.id ?? '';

  const isDirty =
    comment.trim() !== '' ||
    assignee !== null ||
    (departmentChoice !== undefined && departmentChoice !== null) ||
    dueOverride.enabled ||
    documentChoice !== null ||
    (transitionChoice !== null && transitionChoice !== initialId);
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(submitting);
  }, [submitting, onBusyChange]);

  useEffect(() => {
    if (focusRequest === null) return;
    for (const field of focusRequest.fields) {
      const element = document.getElementById(fieldId(field));
      if (element !== null) {
        element.focus();
        return;
      }
    }
    // `fieldId` só depende de `ids`, estável.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);
  const showErrors = (found: ForwardFieldMessages) => {
    setErrors(found);
    const fields = FORWARD_FIELD_ORDER.filter((field) => found[field] !== undefined);
    if (fields.length > 0) {
      setFocusRequest((previous) => ({ fields, n: (previous?.n ?? 0) + 1 }));
    }
  };
  const clearError = (field: ForwardField) => {
    setErrors((previous) => {
      if (previous[field] === undefined) return previous;
      const { [field]: _removed, ...rest } = previous;
      return rest;
    });
  };

  // ---- Envio --------------------------------------------------------------------------------
  const draft: ForwardDraft = {
    entry,
    department,
    assignee,
    dueOverride,
    comment,
    documentSelection: documentChoice === null ? null : selectedDocuments,
    documentCount: selectedDocuments.length,
    warnings,
    acknowledged,
  };
  const expectedStageId = detail.data?.currentStage?.id;

  const refreshChecklist = () =>
    queryClient.invalidateQueries({ queryKey: processActionKeys.checklist(tenantId, processId) });
  // O PRC-09 relido é a fonte da verdade: as regras apontadas pelo erro saem de cena com ele.
  const keepServerRules = (found: readonly ForwardRule[]) => {
    const state = queryClient.getQueryState(processActionKeys.checklist(tenantId, processId));
    setServerState({ rules: found, at: state?.dataUpdatedAt ?? checklist.dataUpdatedAt });
    void refreshChecklist();
  };

  const handleError = (error: unknown) => {
    const found = describeForwardError(error);
    switch (found.kind) {
      case 'stageChanged':
        setStageChanged(true);
        void invalidateProcess();
        return;
      case 'custody':
        toast({ title: t('errors.custody'), tone: 'error' });
        void invalidateProcess();
        onDismiss();
        return;
      case 'notFound':
        toast({ title: t('errors.notFound'), tone: 'error' });
        void invalidateProcess();
        onDismiss();
        return;
      case 'assigneeNotEligible':
        setAssignee(null);
        showErrors({ assignee: t('errors.assigneeNotEligible') });
        return;
      case 'dueNotAllowed':
        setDueOverride(EMPTY_DUE_OVERRIDE);
        setProblem(found);
        void invalidateProcess();
        return;
      case 'blocked':
      case 'warnings':
        setProblem(found);
        keepServerRules(found.rules);
        return;
      case 'fields':
        setProblem(found);
        showErrors(found.messages);
        return;
      case 'versionConflict':
      case 'status':
      case 'transitionNotAvailable':
        // Recarrega o painel (versão, ações, pendências) mantendo o que foi digitado.
        setProblem(found);
        void invalidateProcess();
        return;
      default:
        setProblem(found);
    }
  };

  const finish = (result: ForwardedProcessDto) => {
    toast({ title: text(forwardedToast(result)), tone: 'success' });
    void invalidateProcess();
    for (const key of AFTER_FORWARD_KEYS) {
      void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, key) });
    }
    onForwarded();
  };

  const submit = async () => {
    if (submitting) return;
    setProblem(null);
    const found = validateForward(draft, today);
    if (Object.keys(found).length > 0) {
      showErrors(found);
      setProblem({ kind: 'fields', messages: found, others: [] });
      return;
    }
    setErrors({});
    if (entry === undefined || detail.data === undefined || expectedStageId === undefined) return;
    let result: ForwardedProcessDto;
    try {
      result = await mutation.submit({
        processId,
        body: buildForwardBody(draft, expectedStageId),
        version: detail.data.version,
      });
    } catch (error) {
      handleError(error);
      return;
    }
    finish(result);
  };

  const reloadAfterStageChange = () => {
    setStageChanged(false);
    void invalidateProcess();
    onDismiss();
  };

  // ---- Estados de carga ---------------------------------------------------------------------
  const required = [detail, actions, checklist, documents] as const;
  if (required.some((query) => query.data === undefined)) {
    const failed = required.filter((query) => loadingStatus(query) === 'error');
    if (failed.length === 0) {
      return (
        <div role="status" className="flex flex-col gap-3 p-4">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      );
    }
    const failure = failed[0]?.error;
    return (
      <div className="flex flex-col gap-3 p-4">
        <Alert tone="error" title={t('loadFailed')}>
          {isApiError(failure) && failure.correlationId !== null ? (
            <p className="text-sm">{t('errors.code', { correlationId: failure.correlationId })}</p>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => {
              for (const query of failed) void query.refetch();
            }}
          >
            {t('retry')}
          </Button>
        </Alert>
      </div>
    );
  }

  if (entries.length === 0 || expectedStageId === undefined) {
    return (
      <>
        <div className="min-h-0 flex-1 p-4">
          <Alert tone="info" title={t('empty')} />
        </div>
        <div className="flex justify-end gap-2 border-t border-border bg-surface p-4">
          <Button variant="secondary" onClick={onCancel}>
            {t('cancel')}
          </Button>
        </div>
      </>
    );
  }

  // ---- Derivados da tela --------------------------------------------------------------------
  const deadline = deadlineMessage(entry, stages.data, timeZone);
  const overrideAllowed = entry?.allowDueDateOverride === true;
  const requiresComment = entry?.requiresComment === true;
  const canSubmit = entry !== undefined && entry.enabled && blocking.length === 0 && !submitting;
  const summary = summaryOf({
    entry,
    department,
    assignee,
    dueOverride,
    stages: stages.data,
    submitted: documentList.filter((document) => lockedIds.includes(document.id)),
    timeZone,
  });
  const hintId = `${ids}-submit-hint`;
  const dueLimit = overrideLimit(today);

  const selectTransition = (transitionId: string) => {
    setTransitionChoice(transitionId);
    // Unidade, pessoa e prazo dependem da etapa de destino: voltam ao padrão da nova transição.
    setDepartmentChoice(undefined);
    setAssignee(null);
    setDueOverride(EMPTY_DUE_OVERRIDE);
    setErrors({});
    setProblem(null);
  };

  return (
    <>
      <form
        className="flex min-h-0 flex-1 flex-col"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
          <ProblemAlert
            problem={problem}
            processId={processId}
            documentTitles={new Map(documentList.map((document) => [document.id, document.title]))}
            onRetry={() => {
              void submit();
            }}
          />

          <TransitionGroup
            id={fieldId('transition')}
            entries={entries}
            selectedId={selectedId}
            error={errors.transition}
            onSelect={selectTransition}
          />

          <Section title={t('destination.title')}>
            {choosesUnit ? (
              <LookupPicker
                id={fieldId('department')}
                label={t('destination.department')}
                hint={t('destination.departmentHint')}
                error={errors.department}
                required
                selected={department}
                onSelect={(item) => {
                  setDepartmentChoice(item);
                  clearError('department');
                }}
                queryKeyFor={(q) => forwardKeys.departments(tenantId, organizationId, q)}
                search={async (q, signal) =>
                  (await lookupOrganizationDepartments(organizationId, q, signal)).map((item) => ({
                    id: item.id,
                    name: item.name,
                    detail: null,
                  }))
                }
                minChars={0}
              />
            ) : (
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-sm font-medium">{t('destination.department')}</span>
                <p className="text-sm break-words">
                  {entry?.departmentResolution?.departmentName ?? t('destination.byWorkflow')}
                </p>
              </div>
            )}
            {approval ? (
              <p className="text-sm break-words">
                {(entry?.approverPreview ?? null) === null
                  ? t('destination.approverUndefined')
                  : t('destination.approver', { approver: entry?.approverPreview?.label ?? '' })}
              </p>
            ) : (
              <LookupPicker
                id={fieldId('assignee')}
                label={t('destination.assignee')}
                hint={t('destination.assigneeHint')}
                error={errors.assignee}
                selected={assignee}
                onSelect={(item) => {
                  setAssignee(item);
                  clearError('assignee');
                }}
                queryKeyFor={(q) => tenantKey(tenantId, 'users', 'lookup', q)}
                search={async (q, signal) =>
                  (await lookupUsers(q, signal)).map((user) => ({
                    id: user.id,
                    name: user.name,
                    detail: user.email,
                  }))
                }
                minChars={2}
              />
            )}
          </Section>

          <Section title={t('due.title')}>
            <p className="text-sm">{text(deadline)}</p>
            {overrideAllowed ? (
              dueOverride.enabled ? (
                <div className="flex flex-col gap-3">
                  <Field
                    id={fieldId('dueAt')}
                    label={t('due.date')}
                    description={t('due.dateHint', { limit: formatLocalDate(dueLimit) })}
                    error={errors.dueAt}
                  >
                    <DatePicker
                      value={fromIsoDate(dueOverride.date)}
                      disabledDays={{
                        before: fromIsoDate(today) ?? new Date(),
                        after: fromIsoDate(dueLimit) ?? new Date(),
                      }}
                      onValueChange={(date) => {
                        setDueOverride({
                          ...dueOverride,
                          date: date === undefined ? '' : toIsoDate(date),
                        });
                        clearError('dueAt');
                      }}
                    />
                  </Field>
                  <FormField
                    id={fieldId('dueReason')}
                    label={t('due.reason')}
                    hint={t('due.reasonHint')}
                    error={errors.dueReason}
                    required
                  >
                    {(control) => (
                      <textarea
                        {...control}
                        rows={2}
                        className={TEXTAREA_CLASS}
                        value={dueOverride.reason}
                        onChange={(event) => {
                          setDueOverride({ ...dueOverride, reason: event.target.value });
                          clearError('dueReason');
                        }}
                      />
                    )}
                  </FormField>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="self-start"
                    onClick={() => {
                      setDueOverride(EMPTY_DUE_OVERRIDE);
                      clearError('dueAt');
                      clearError('dueReason');
                    }}
                  >
                    {t('due.keep')}
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  className="self-start"
                  onClick={() => {
                    setDueOverride({ ...EMPTY_DUE_OVERRIDE, enabled: true });
                  }}
                >
                  {t('due.change')}
                </Button>
              )
            ) : null}
          </Section>

          <FormField
            id={fieldId('comment')}
            label={requiresComment ? t('comment.labelRequired') : t('comment.label')}
            hint={
              <>
                {requiresComment ? <span>{t('comment.hintRequired')} </span> : null}
                <span>
                  {t('comment.counter', {
                    count: comment.length,
                    max: PROCESS_FORWARD_LIMITS.commentMax,
                  })}
                </span>
              </>
            }
            error={errors.comment}
            required={requiresComment}
          >
            {(control) => (
              <textarea
                {...control}
                rows={4}
                className={TEXTAREA_CLASS}
                value={comment}
                onChange={(event) => {
                  setComment(event.target.value);
                  clearError('comment');
                }}
              />
            )}
          </FormField>

          <DocumentsChecklist
            id={fieldId('documents')}
            documents={documentList}
            selected={selectedDocuments}
            locked={lockedIds}
            entry={entry}
            error={errors.documents}
            onToggle={(documentId, checked) => {
              setDocumentChoice(
                checked
                  ? [...new Set([...selectedDocuments, documentId])]
                  : selectedDocuments.filter((id) => id !== documentId),
              );
              clearError('documents');
            }}
          />

          <RulesSection
            id={fieldId('warnings')}
            processId={processId}
            rules={rules}
            documents={documentList}
            acknowledged={acknowledged}
            error={errors.warnings}
            onAcknowledge={(ruleId, checked) => {
              setAcknowledged((previous) =>
                checked
                  ? [...new Set([...previous, ruleId])]
                  : previous.filter((id) => id !== ruleId),
              );
              clearError('warnings');
            }}
            onResolve={onCancel}
          />

          {summary === null ? null : (
            <Section title={t('summary.title')}>
              <p className="text-sm break-words">{rich(summary.main)}</p>
              {summary.extra === null ? null : (
                <p className="text-sm break-words">{rich(summary.extra)}</p>
              )}
            </Section>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-border bg-surface p-4">
          {blocking.length > 0 ? (
            <p id={hintId} className="text-xs text-muted-foreground">
              {t('submitBlocked')}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onCancel}>
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!canSubmit}
              aria-describedby={blocking.length > 0 ? hintId : undefined}
            >
              {submitting ? t('submitting') : t('submit')}
            </Button>
          </div>
        </div>
      </form>

      <Dialog
        open={stageChanged}
        onOpenChange={(next) => {
          if (!next) reloadAfterStageChange();
        }}
      >
        <DialogContent closeLabel={null}>
          <DialogTitle>{t('stale.title')}</DialogTitle>
          <DialogDescription>{t('stale.description')}</DialogDescription>
          <DialogFooter>
            <Button variant="primary" onClick={reloadAfterStageChange}>
              {t('stale.reload')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <h3 id={headingId} className="text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Resposta da API que não cabe num campo: orientação no topo do painel ("Casos de erro"). */
function ProblemAlert({
  problem,
  processId,
  documentTitles,
  onRetry,
}: {
  readonly problem: ForwardProblem | null;
  readonly processId: string;
  readonly documentTitles: ReadonlyMap<string, string>;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('processes.forward.errors');
  if (problem === null) return null;
  const retry = (
    <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
      {t('retry')}
    </Button>
  );
  switch (problem.kind) {
    case 'fields':
      return (
        <Alert tone="error" title={t('formErrors')}>
          {problem.others.length > 0 ? (
            <ul className="list-disc pl-5">
              {problem.others.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      );
    case 'versionConflict':
      return (
        <Alert tone="warning" title={t('versionConflict')}>
          <p>{t('versionConflictHint')}</p>
        </Alert>
      );
    case 'status':
      return <Alert tone="warning" title={problem.detail} />;
    case 'transitionNotAvailable':
      return (
        <Alert tone="warning" title={t('transitionNotAvailable')}>
          <p>{t('transitionNotAvailableHint')}</p>
        </Alert>
      );
    case 'blocked':
      return (
        <Alert tone="error" title={t('blocked', { count: problem.count })}>
          <p>{t('blockedHint')}</p>
        </Alert>
      );
    case 'warnings':
      return <Alert tone="warning" title={t('warnings')} />;
    case 'dueNotAllowed':
      return (
        <Alert tone="warning" title={t('dueNotAllowed')}>
          <p>{t('dueRestored')}</p>
        </Alert>
      );
    case 'documents':
      return (
        <Alert tone="error" title={t('documentsIncomplete')}>
          <ul className="flex flex-col gap-2">
            {problem.items.map((item) => {
              const title =
                item.title ??
                (item.documentId === null ? null : (documentTitles.get(item.documentId) ?? null)) ??
                t('documentFallback');
              return (
                <li key={`${item.documentId ?? ''}:${title}`} className="flex flex-col gap-0.5">
                  <span className="font-medium">{t('completeDocument', { document: title })}</span>
                  <ul className="list-disc pl-5">
                    {item.messages.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                  {item.documentId === null ? null : (
                    <Link
                      href={`/processos/${processId}/documentos/${item.documentId}`}
                      className="text-primary underline"
                    >
                      {t('openDocument')}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </Alert>
      );
    case 'approver':
      return (
        <Alert tone="error" title={t('approverUnresolved')}>
          {/* US-051 (V-02): o `detail` padrão da API repete o título — só o diferente aparece. */}
          {problem.detail === null || problem.detail === t('approverUnresolved') ? null : (
            <p>{problem.detail}</p>
          )}
        </Alert>
      );
    case 'idempotencyReused':
      return (
        <Alert tone="error" title={t('idempotencyReused')}>
          {retry}
        </Alert>
      );
    case 'inProgress':
      return (
        <Alert tone="info" title={t('inProgress')}>
          {retry}
        </Alert>
      );
    case 'unavailable':
      return (
        <Alert tone="error" title={t('unavailable')}>
          <p>{t('code', { correlationId: problem.correlationId })}</p>
          {retry}
        </Alert>
      );
    case 'unexpected':
      return (
        <Alert tone="error" title={t('unexpected', { correlationId: problem.correlationId })} />
      );
    default:
      return null;
  }
}
