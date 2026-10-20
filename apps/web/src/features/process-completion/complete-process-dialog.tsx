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
import { PROCESS_COMPLETION_LIMITS } from '@contrataflow/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import type { RetryOptions } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useShellSession } from '@/lib/session/session-context';

import {
  completionEntry,
  completionRules,
  describeCompletionError,
  pendingWarnings,
  validateCompletionComment,
} from './completion-model';
import type { CompletionProblem } from './completion-model';
import { useCompleteProcess } from './process-completion.api';
import {
  processActionKeys,
  useAvailableActions,
  useProcessChecklist,
} from '../process-actions/process-actions.api';
import { useProcessDocuments } from '../process-documents/process-documents.api';
import type { ForwardRule } from '../process-forward/forward-model';
import { RulesSection } from '../process-forward/forward-sections';
import { useInvalidateProcess } from '../process-panel/process-panel.api';
import { TEXTAREA_CLASS } from '../processes/form-field';
import { fetchProcess, processKeys } from '../processes/processes.api';

/** Listas que a conclusão muda além do processo: caixa de tarefas, lista e painel inicial. */
const AFTER_KEYS = ['processes', 'tasks', 'dashboard'] as const;

/** Tela cheia abaixo de 768 px (utilizável em 360 px — story · "Frontend"). */
const DIALOG_CLASS =
  'max-h-[90vh] overflow-y-auto max-md:inset-0 max-md:h-full max-md:max-h-none max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none';

/** Recusas que encerram o diálogo (o painel relido mostra o motivo). */
type ClosingProblem = Extract<
  CompletionProblem,
  { readonly kind: 'status' | 'notCustodian' | 'permission' | 'notFound' | 'access' | 'transition' }
>;
const CLOSING: ReadonlySet<CompletionProblem['kind']> = new Set([
  'status',
  'notCustodian',
  'permission',
  'notFound',
  'access',
  'transition',
]);
const isClosing = (problem: CompletionProblem): problem is ClosingProblem =>
  CLOSING.has(problem.kind);

export interface CompleteProcessDialogProps {
  readonly processId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Depois do sucesso (o painel devolve o foco ao cabeçalho de status). */
  readonly onDone?: (() => void) | undefined;
  /** Retentativas automáticas da mutação (testes: `{ retries: 0 }`). */
  readonly retry?: RetryOptions | undefined;
}

/**
 * `CompleteProcessDialog` (US-010 · SCR-116): confirma a conclusão do processo com o checklist da
 * etapa (pendências `BLOCKING` desabilitam o botão; cada aviso `WARNING` exige "Entendo os avisos e
 * quero continuar" — FA-01/FA-02) e a observação opcional, pelo PRC-26 (`If-Match` da versão do
 * PRC-04 e `Idempotency-Key` por intenção). As violações são anunciadas em `aria-live`; o erro
 * mantém o texto digitado.
 */
export function CompleteProcessDialog({
  processId,
  open,
  onOpenChange,
  onDone,
  retry,
}: CompleteProcessDialogProps) {
  const t = useTranslations('processes.completion');
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const commentId = useId();
  const rulesId = useId();
  const detail = useQuery({
    queryKey: processKeys.detail(tenantId, processId),
    queryFn: ({ signal }) => fetchProcess(processId, signal),
    enabled: open,
    throwOnError: false,
  });
  const actions = useAvailableActions(processId);
  const checklist = useProcessChecklist(processId);
  const documents = useProcessDocuments(processId);
  const invalidateProcess = useInvalidateProcess(processId);
  const mutation = useCompleteProcess(retry);
  const submitting = mutation.isPending;

  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState<string | undefined>();
  const [acknowledged, setAcknowledged] = useState<readonly string[]>([]);
  const [problem, setProblem] = useState<CompletionProblem | null>(null);
  // Regras que a API apontou (FA-01/FA-02); valem até o diálogo fechar.
  const [serverRules, setServerRules] = useState<readonly ForwardRule[]>([]);

  const entry = completionEntry(actions.data);
  const rules = completionRules(checklist.data, entry, serverRules);
  const blocking = rules.filter((rule) => rule.severity === 'BLOCKING');
  const pending = pendingWarnings(rules, acknowledged);
  const version = detail.data?.version;
  const canSubmit =
    !submitting && version !== undefined && blocking.length === 0 && pending.length === 0;

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      if (submitting) return;
      setProblem(null);
      setServerRules([]);
      setCommentError(undefined);
    }
    onOpenChange(next);
  };

  const after = () => {
    void invalidateProcess();
    void queryClient.invalidateQueries({ queryKey: processActionKeys.all(tenantId, processId) });
    for (const key of AFTER_KEYS) {
      void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, key) });
    }
  };

  const submit = async () => {
    if (submitting) return;
    setProblem(null);
    const invalid = validateCompletionComment(comment);
    if (invalid !== undefined) {
      setCommentError(invalid);
      document.getElementById(commentId)?.focus();
      return;
    }
    if (version === undefined) return;
    const trimmed = comment.trim();
    const warnings = rules
      .filter((rule) => rule.severity === 'WARNING' && acknowledged.includes(rule.ruleId))
      .map((rule) => rule.ruleId);
    try {
      await mutation.submit({
        processId,
        body: {
          ...(trimmed === '' ? {} : { comment: trimmed }),
          ...(warnings.length === 0 ? {} : { acknowledgedWarnings: warnings }),
        },
        version,
      });
    } catch (failure) {
      const found = describeCompletionError(failure);
      if (isClosing(found)) {
        toast({ title: t(`errors.${found.kind}`), tone: 'error' });
        after();
        handleOpenChange(false);
        if (found.kind === 'notFound') router.push('/processos');
        return;
      }
      if (found.kind === 'blocked' || found.kind === 'warnings') {
        setServerRules(found.rules);
        void checklist.refetch();
        document.getElementById(rulesId)?.focus();
      }
      if (found.kind === 'field') {
        setCommentError(found.message);
        document.getElementById(commentId)?.focus();
      }
      setProblem(found);
      return;
    }
    toast({ title: t('completed'), tone: 'success' });
    after();
    setComment('');
    setAcknowledged([]);
    handleOpenChange(false);
    onDone?.();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        closeLabel={t('close')}
        className={DIALOG_CLASS}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(commentId)?.focus();
        }}
      >
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        <form
          noValidate
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div aria-live="assertive" className="flex flex-col gap-2">
            {problem === null ? null : (
              <CompletionAlert
                problem={problem}
                onReload={() => {
                  setProblem(null);
                  void detail.refetch();
                  void actions.refetch();
                  void checklist.refetch();
                }}
                onRetry={() => {
                  void submit();
                }}
              />
            )}
          </div>
          {entry?.toStageName === undefined ? null : (
            <p className="text-sm">{t('finalStage', { stage: entry.toStageName })}</p>
          )}
          <RulesSection
            id={rulesId}
            processId={processId}
            rules={rules}
            documents={documents.data?.items ?? []}
            acknowledged={acknowledged}
            error={
              blocking.length > 0
                ? t('blockedHint')
                : pending.length > 0 && problem?.kind === 'warnings'
                  ? t('warningsHint')
                  : undefined
            }
            acknowledgeLabel={t('acknowledge')}
            onAcknowledge={(ruleId, checked) => {
              setAcknowledged((previous) =>
                checked
                  ? [...previous.filter((id) => id !== ruleId), ruleId]
                  : previous.filter((id) => id !== ruleId),
              );
            }}
            onResolve={() => {
              handleOpenChange(false);
            }}
          />
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={commentId} className="text-sm font-medium">
              {t('comment.label')}
            </label>
            <textarea
              id={commentId}
              value={comment}
              maxLength={PROCESS_COMPLETION_LIMITS.commentMax}
              aria-invalid={commentError ? true : undefined}
              aria-describedby={[
                `${commentId}-hint`,
                `${commentId}-counter`,
                commentError ? `${commentId}-error` : undefined,
              ]
                .filter(Boolean)
                .join(' ')}
              className={TEXTAREA_CLASS}
              onChange={(event) => {
                setComment(event.target.value);
                setCommentError(undefined);
              }}
            />
            <p className="flex justify-between gap-2 text-xs text-muted-foreground">
              <span id={`${commentId}-hint`}>{t('comment.hint')}</span>
              <span id={`${commentId}-counter`} aria-live="polite">
                {t('counter', {
                  count: comment.trim().length,
                  max: PROCESS_COMPLETION_LIMITS.commentMax,
                })}
              </span>
            </p>
            {commentError ? (
              <p id={`${commentId}-error`} className="text-xs text-destructive">
                {commentError}
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
              {t('back')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? t('submitting') : t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Mensagem do erro com a ação da tabela "Casos de erro" (Recarregar, Tentar novamente, Copiar). */
function CompletionAlert({
  problem,
  onReload,
  onRetry,
}: {
  readonly problem: CompletionProblem;
  readonly onReload: () => void;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('processes.completion.errors');
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
    case 'blocked':
      return <Alert tone="error" title={t('blocked')} />;
    case 'warnings':
      return <Alert tone="warning" title={t('warnings')} />;
    default:
      return <Alert tone="error" title={t(problem.kind)} />;
  }
}
