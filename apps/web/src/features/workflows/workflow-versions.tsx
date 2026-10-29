'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Ellipsis,
  Field,
  Skeleton,
  StatusChip,
  Table,
  TableBody,
  TableContainer,
  TableHead,
  Td,
  Textarea,
  Th,
  Tr,
  toast,
} from '@contrataflow/ui';
import {
  CHANGE_NOTES_REQUIRED_FROM_VERSION,
  workflowValidationResultSchema,
} from '@contrataflow/validation';
import type {
  WorkflowDto,
  WorkflowValidationIssue,
  WorkflowValidationResult,
  WorkflowVersionSummaryDto,
} from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import {
  changeNotesProblem,
  formatDateTime,
  isCurrentVersion,
  issueTarget,
  retireBlocked,
  shortHash,
} from './workflow-versions-model';
import type { IssueTarget } from './workflow-versions-model';
import {
  fetchWorkflowVersions,
  publishWorkflowVersion,
  retireWorkflowVersion,
  validateWorkflowVersion,
  workflowKeys,
  WORKFLOWS_STALE_TIME_MS,
} from './workflows.api';

type Translate = ReturnType<typeof useTranslations>;

/** Mensagem da falha de publicar/aposentar/validar (Casos de erro da US-045). */
function actionErrorMessage(error: unknown, t: Translate): string {
  if (!isApiError(error)) return t('errors.generic');
  if (error.status === 412 || error.status === 428) return t('errors.conflict');
  if (error.code === 'INVALID_STATE' || error.code === 'WORKFLOW_VERSION_NOT_DRAFT') {
    return t('errors.state');
  }
  if (error.code === 'WORKFLOW_IN_USE') return t('errors.inUse');
  if (error.code === 'MFA_REQUIRED') return t('errors.mfa');
  if (error.status === 403) return t('errors.forbidden');
  if (error.status === 503) return t('errors.unavailable');
  return error.message || t('errors.generic');
}

/** `errors[]`/`warnings[]` do 422 `WORKFLOW_INVALID` (extensão `validation` — api.md §2.3). */
function validationOf(error: unknown): WorkflowValidationResult | null {
  if (!isApiError(error) || error.code !== 'WORKFLOW_INVALID') return null;
  const parsed = workflowValidationResultSchema
    .partial({ valid: true })
    .safeParse(error.problem?.validation);
  return parsed.success ? { ...parsed.data, valid: false } : null;
}

/**
 * Aba "Versões" do SCR-034 (US-045): histórico (WF-07), "Validar" o rascunho (WF-20) com a lista
 * de problemas, "Publicar" (WF-21, desabilitado enquanto houver `errors[]`) com as notas da versão
 * e "Aposentar" (WF-22). Sem `WORKFLOW_PUBLISH`, publicar/aposentar ficam visíveis e desabilitados
 * para quem tem `WORKFLOW_MANAGE` e ocultos para quem só consulta. A API decide (RN-FND-92).
 */
export function WorkflowVersionsSection({
  workflow,
  onGoTo,
}: {
  readonly workflow: WorkflowDto;
  /** Leva à aba onde o problema se corrige (FA-05). */
  readonly onGoTo: (target: IssueTarget) => void;
}) {
  const t = useTranslations('workflows.versions');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const ids = useId();
  const canPublish = usePermission('WORKFLOW_PUBLISH').allowed;
  const canManage = usePermission('WORKFLOW_MANAGE').allowed;
  const [validation, setValidation] = useState<WorkflowValidationResult | null>(null);
  const [publishing, setPublishing] = useState<WorkflowVersionSummaryDto | null>(null);
  const [retiring, setRetiring] = useState<WorkflowVersionSummaryDto | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const history = useQuery({
    queryKey: workflowKeys.versions(tenantId, workflow.id),
    queryFn: async ({ signal }) => (await fetchWorkflowVersions(workflow.id, signal)).data,
    staleTime: WORKFLOWS_STALE_TIME_MS,
    throwOnError: false,
  });
  const items = history.data ?? [];
  const draft = items.find((item) => item.status === 'DRAFT') ?? null;

  // Workflow, versão aberta no editor e histórico: a publicação/aposentadoria muda os três.
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: workflowKeys.all(tenantId) });
  };

  const validate = useMutation({
    mutationFn: (versionId: string) => validateWorkflowVersion(versionId),
    onSuccess: (result) => {
      setMessage(null);
      setValidation(result.data);
    },
    onError: (error) => {
      setMessage(actionErrorMessage(error, t));
    },
  });

  // Só "Publicar" (com permissão) quando a última validação do rascunho não tem erros (RN-WF-61).
  const publishDisabledReason = !canPublish
    ? t('publishForbidden')
    : validation === null
      ? t('validateFirst')
      : validation.errors.length > 0
        ? t('publishBlocked')
        : null;

  return (
    <section aria-labelledby={`${ids}-title`} className="flex flex-col gap-4">
      <h2 id={`${ids}-title`} className="text-lg font-semibold">
        {t('title')}
      </h2>
      <div aria-live="assertive">{message ? <Alert tone="error" title={message} /> : null}</div>

      {draft ? (
        <div className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card">
          <p className="text-sm">{t('draftHint', { number: draft.versionNumber })}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={validate.isPending}
              aria-busy={validate.isPending}
              onClick={() => {
                validate.mutate(draft.id);
              }}
            >
              {validate.isPending ? t('validating') : t('validate')}
            </Button>
            {canPublish || canManage ? (
              <>
                <Button
                  disabled={publishDisabledReason !== null}
                  aria-describedby={
                    publishDisabledReason !== null ? `${ids}-publish-reason` : undefined
                  }
                  title={publishDisabledReason ?? undefined}
                  onClick={() => {
                    setPublishing(draft);
                  }}
                >
                  {t('publish')}
                </Button>
                {publishDisabledReason !== null ? (
                  <span id={`${ids}-publish-reason`} className="sr-only">
                    {publishDisabledReason}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {draft && validation ? <ValidationResultPanel result={validation} onGoTo={onGoTo} /> : null}

      {history.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : history.isError ? (
        <Alert tone="error" title={t('loadFailed')}>
          <Button variant="secondary" size="sm" onClick={() => void history.refetch()}>
            {t('retry')}
          </Button>
        </Alert>
      ) : (
        <VersionList
          workflow={workflow}
          items={items}
          canRetire={canPublish}
          showRetire={canPublish || canManage}
          onRetire={setRetiring}
        />
      )}

      <PublishDialog
        item={publishing}
        warnings={validation?.warnings ?? []}
        onClose={() => {
          setPublishing(null);
        }}
        onPublished={(published) => {
          setValidation(null);
          refresh();
          toast({
            title: t('toast.published', { number: published.versionNumber }),
            tone: 'success',
          });
        }}
        onInvalid={(result) => {
          setValidation(result);
          refresh();
        }}
      />
      <RetireConfirmDialog
        item={retiring}
        blocked={retiring !== null && retireBlocked(workflow, retiring, items)}
        onClose={() => {
          setRetiring(null);
        }}
        onDone={(retired) => {
          refresh();
          if (retired) {
            toast({
              title: t('toast.retired', { number: retired.versionNumber }),
              tone: 'success',
            });
          }
        }}
      />
    </section>
  );
}

/**
 * `ValidationResultPanel` (passo 3 · FA-01/FA-05): `errors[]` bloqueantes e `warnings[]`
 * informativos, navegáveis por teclado, com o foco no primeiro item e link para onde corrigir.
 */
function ValidationResultPanel({
  result,
  onGoTo,
}: {
  readonly result: WorkflowValidationResult;
  readonly onGoTo: (target: IssueTarget) => void;
}) {
  const t = useTranslations('workflows.versions');
  const firstRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    firstRef.current?.focus();
  }, [result]);

  if (result.errors.length === 0 && result.warnings.length === 0) {
    return <Alert tone="success" live={false} title={t('validation.ok')} />;
  }
  const list = (issues: readonly WorkflowValidationIssue[], first: boolean) => (
    <ul className="flex list-disc flex-col gap-1 pl-5">
      {issues.map((issue, index) => {
        const target = issueTarget(issue);
        return (
          <li
            key={`${issue.code}-${String(index)}`}
            ref={first && index === 0 ? firstRef : undefined}
            tabIndex={first && index === 0 ? -1 : undefined}
          >
            {issue.message}{' '}
            {target.kind !== 'none' ? (
              <button
                type="button"
                className="font-medium underline"
                onClick={() => {
                  onGoTo(target);
                }}
              >
                {t(`validation.goTo.${target.kind}`)}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
  return (
    <div className="flex flex-col gap-3">
      {result.errors.length > 0 ? (
        <Alert
          tone="error"
          live={false}
          title={t('validation.errorsTitle', { count: result.errors.length })}
        >
          {list(result.errors, true)}
        </Alert>
      ) : (
        <Alert tone="success" live={false} title={t('validation.noErrors')} />
      )}
      {result.warnings.length > 0 ? (
        <Alert
          tone="warning"
          live={false}
          title={t('validation.warningsTitle', { count: result.warnings.length })}
        >
          {list(result.warnings, result.errors.length === 0)}
        </Alert>
      ) : null}
    </div>
  );
}

/**
 * `VersionList` (RN-WF-69): tabela no `TableContainer` (rola só ela, quando mais larga que a tela)
 * com situação, datas e autores, notas, hash resumido sob o número e "Aposentar" no menu ⋯ das
 * publicadas.
 */
function VersionList({
  workflow,
  items,
  canRetire,
  showRetire,
  onRetire,
}: {
  readonly workflow: WorkflowDto;
  readonly items: readonly WorkflowVersionSummaryDto[];
  readonly canRetire: boolean;
  readonly showRetire: boolean;
  readonly onRetire: (item: WorkflowVersionSummaryDto) => void;
}) {
  const t = useTranslations('workflows.versions');
  const ids = useId();
  if (items.length === 0) return <p className="text-muted-foreground">{t('empty')}</p>;

  const empty = t('noValue');
  const when = (iso: string | null, name: string | null | undefined) => {
    const date = formatDateTime(iso);
    if (!date) return empty;
    return name ? t('byWhom', { date, name }) : date;
  };
  const retireMenu = (item: WorkflowVersionSummaryDto) => {
    if (!showRetire || item.status !== 'PUBLISHED') return null;
    const blocked = retireBlocked(workflow, item, items);
    const reason = !canRetire ? t('retireForbidden') : blocked ? t('retireBlocked') : null;
    const reasonId = `${ids}-${item.id}-reason`;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('rowMenu', { number: item.versionNumber })}
            className="inline-grid size-11 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
          >
            <Ellipsis aria-hidden="true" className="size-[1.125rem]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={reason !== null}
            aria-describedby={reason ? reasonId : undefined}
            onSelect={() => {
              onRetire(item);
            }}
          >
            {t('retire')}
          </DropdownMenuItem>
          {reason ? (
            <p id={reasonId} className="max-w-60 px-2.5 py-1.5 text-xs text-muted-foreground">
              {reason}
            </p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  return (
    <TableContainer label={t('caption')}>
      <Table>
        <caption className="sr-only">{t('caption')}</caption>
        <TableHead>
          <Tr>
            <Th>{t('columns.number')}</Th>
            <Th>{t('columns.status')}</Th>
            <Th>{t('columns.publishedAt')}</Th>
            <Th>{t('columns.retiredAt')}</Th>
            <Th>{t('columns.notes')}</Th>
            <Th className="w-12">
              <span className="sr-only">{t('columns.actions')}</span>
            </Th>
          </Tr>
        </TableHead>
        <TableBody>
          {items.map((item) => (
            <Tr key={item.id} className="align-top">
              <th scope="row" className="px-3.5 py-3 text-left font-normal">
                <span className="block font-bold whitespace-nowrap">
                  {t('number', { number: item.versionNumber })}
                </span>
                {item.definitionHash ? (
                  <span
                    className="font-mono text-xs text-muted-foreground"
                    title={item.definitionHash}
                  >
                    {shortHash(item.definitionHash)}
                  </span>
                ) : null}
              </th>
              <Td>
                <div className="flex flex-wrap gap-1.5">
                  <StatusChip tone={item.status === 'PUBLISHED' ? 'success' : 'neutral'}>
                    {t(`status.${item.status}`)}
                  </StatusChip>
                  {isCurrentVersion(workflow, item) ? (
                    <StatusChip tone="success">{t('current')}</StatusChip>
                  ) : null}
                </div>
              </Td>
              <Td>{when(item.publishedAt, item.publishedByName)}</Td>
              <Td>{when(item.retiredAt, item.retiredByName)}</Td>
              <Td className="max-w-xs text-muted-foreground">{item.changeNotes ?? empty}</Td>
              <Td className="w-12 py-1.5 text-right">{retireMenu(item)}</Td>
            </Tr>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

/**
 * `PublishDialog` (passos 4–5 · FA-02): notas da versão (obrigatórias a partir da v2 — RN-WF-63) e
 * os avisos da última validação; a API revalida — erros novos voltam ao painel (`onInvalid`).
 */
function PublishDialog({
  item,
  warnings,
  onClose,
  onPublished,
  onInvalid,
}: {
  readonly item: WorkflowVersionSummaryDto | null;
  readonly warnings: readonly WorkflowValidationIssue[];
  readonly onClose: () => void;
  readonly onPublished: (published: WorkflowVersionSummaryDto) => void;
  readonly onInvalid: (result: WorkflowValidationResult) => void;
}) {
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {item ? (
        <PublishBody
          key={item.id}
          item={item}
          warnings={warnings}
          onClose={onClose}
          onPublished={onPublished}
          onInvalid={onInvalid}
        />
      ) : null}
    </Dialog>
  );
}

function PublishBody({
  item,
  warnings,
  onClose,
  onPublished,
  onInvalid,
}: {
  readonly item: WorkflowVersionSummaryDto;
  readonly warnings: readonly WorkflowValidationIssue[];
  readonly onClose: () => void;
  readonly onPublished: (published: WorkflowVersionSummaryDto) => void;
  readonly onInvalid: (result: WorkflowValidationResult) => void;
}) {
  const t = useTranslations('workflows.versions');
  const ids = useId();
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const [notes, setNotes] = useState('');
  const [notesError, setNotesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const required = item.versionNumber >= CHANGE_NOTES_REQUIRED_FROM_VERSION;

  const publish = useMutation({
    mutationFn: () => publishWorkflowVersion(item, notes),
    onSuccess: (result) => {
      onPublished(result.data);
      onClose();
    },
    onError: (failure) => {
      const invalid = validationOf(failure);
      if (invalid) {
        onInvalid(invalid);
        onClose();
        return;
      }
      const field = isApiError(failure)
        ? failure.errors.find((fieldError) => fieldError.field === 'changeNotes')
        : undefined;
      if (field) {
        setNotesError(field.message);
        notesRef.current?.focus();
        return;
      }
      setError(actionErrorMessage(failure, t));
    },
  });

  const onConfirm = () => {
    setError(null);
    const problem = changeNotesProblem(item.versionNumber, notes);
    setNotesError(problem);
    if (problem) {
      notesRef.current?.focus();
      return;
    }
    publish.mutate();
  };

  return (
    <DialogContent
      aria-describedby={`${ids}-description`}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        notesRef.current?.focus();
      }}
    >
      <DialogTitle>{t('publishDialog.title', { number: item.versionNumber })}</DialogTitle>
      <DialogDescription id={`${ids}-description`}>
        {t('publishDialog.description')}
      </DialogDescription>
      <Field
        label={required ? t('publishDialog.notesRequired') : t('publishDialog.notesOptional')}
        error={notesError ?? undefined}
      >
        <Textarea
          ref={notesRef}
          rows={4}
          value={notes}
          maxLength={5000}
          aria-required={required ? true : undefined}
          onChange={(event) => {
            setNotes(event.target.value);
          }}
        />
      </Field>
      {warnings.length > 0 ? (
        <Alert tone="warning" title={t('publishDialog.warnings', { count: warnings.length })} />
      ) : null}
      {error ? <Alert tone="error" title={error} /> : null}
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {t('publishDialog.cancel')}
        </Button>
        <Button disabled={publish.isPending} aria-busy={publish.isPending} onClick={onConfirm}>
          {publish.isPending ? t('publishDialog.publishing') : t('publishDialog.confirm')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * `RetireConfirmDialog` (passo 7 · FA-03): confirma a aposentadoria; a corrente sem substituta num
 * workflow em uso fica bloqueada com a explicação ("Publique uma nova versão antes…").
 */
function RetireConfirmDialog({
  item,
  blocked,
  onClose,
  onDone,
}: {
  readonly item: WorkflowVersionSummaryDto | null;
  readonly blocked: boolean;
  readonly onClose: () => void;
  readonly onDone: (retired: WorkflowVersionSummaryDto | null) => void;
}) {
  const t = useTranslations('workflows.versions');
  const ids = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [message, setMessage] = useState<string | null>(null);

  const retire = useMutation({
    mutationFn: (target: WorkflowVersionSummaryDto) => retireWorkflowVersion(target),
    onSuccess: (result) => {
      onDone(result.data);
      onClose();
    },
    onError: (error) => {
      setMessage(actionErrorMessage(error, t));
      onDone(null);
    },
  });

  const close = () => {
    setMessage(null);
    onClose();
  };
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {item ? (
        <DialogContent
          aria-describedby={`${ids}-description`}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            confirmRef.current?.focus();
          }}
        >
          <DialogTitle>{t('retireDialog.title', { number: item.versionNumber })}</DialogTitle>
          <DialogDescription id={`${ids}-description`}>
            {blocked ? t('errors.inUse') : t('retireDialog.description')}
          </DialogDescription>
          {message ? <Alert tone="error" title={message} /> : null}
          <DialogFooter>
            <Button variant="secondary" onClick={close}>
              {t('retireDialog.cancel')}
            </Button>
            <Button
              ref={confirmRef}
              variant="destructive"
              disabled={blocked || message !== null || retire.isPending}
              aria-busy={retire.isPending}
              onClick={() => {
                retire.mutate(item);
              }}
            >
              {retire.isPending ? t('retireDialog.retiring') : t('retireDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
