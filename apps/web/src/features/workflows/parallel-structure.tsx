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
  InfoTooltip,
  Input,
  Skeleton,
  StatusChip,
  toast,
} from '@contrataflow/ui';
import type {
  WorkflowBranchIssueDto,
  WorkflowParallelBlockDto,
  WorkflowStageDto,
  WorkflowTransitionDto,
  WorkflowVersionDetailDto,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useTenantId } from '@/lib/session/session-context';

import { OptionSelect } from './option-select';
import {
  blockDraftProblems,
  blockRemovalPlan,
  destinationCandidates,
  EMPTY_BLOCK,
  originCandidates,
  parallelBlockPlan,
} from './parallel-block-model';
import type { BlockField, BlockProblem, ParallelBlockDraft } from './parallel-block-model';
import type { IssueTarget } from './workflow-versions-model';
import {
  createStage,
  createTransition,
  deleteStage,
  deleteTransition,
  fetchVersionBranches,
  workflowKeys,
  WORKFLOWS_STALE_TIME_MS,
} from './workflows.api';

/*
 * Etapas paralelas no editor (US-123 · SCR-034 · DEC-194): o painel "Ramificações"
 * (`ParallelStructurePanel`, WF-24), o chip "Ramo: {branchKey}" (`BranchChip`), o assistente
 * "Adicionar ramificação" (`ParallelBlockWizard`) e a confirmação de "Remover ramificação"
 * (`RemoveBlockConfirmDialog`). O rascunho aceita estados intermediários (FA-06): quem barra é a
 * validação/publicação.
 */

/** WF-24 da versão; a chave inclui o `ETag` da versão — toda escrita no rascunho recalcula. */
export function useVersionBranches(
  version: Pick<WorkflowVersionDetailDto, 'id' | 'version'> | null,
) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: [...workflowKeys.branches(tenantId, version?.id ?? ''), version?.version ?? 0],
    queryFn: async ({ signal }) => (await fetchVersionBranches(version?.id ?? '', signal)).data,
    staleTime: WORKFLOWS_STALE_TIME_MS,
    enabled: version !== null,
    throwOnError: false,
  });
}

/**
 * Etapas com o ramo (RN-WF2-07): o `branchKey` gravado (publicada) ou o calculado pelo WF-24
 * (rascunho), para o diagrama e a lista alternativa.
 */
export function withBranchKeys<T extends Pick<WorkflowStageDto, 'key' | 'branchKey'>>(
  stages: readonly T[],
  stageBranch: Readonly<Record<string, string>> | undefined,
): T[] {
  return stages.map((stage) => ({
    ...stage,
    branchKey: stage.branchKey ?? stageBranch?.[stage.key] ?? null,
  }));
}

/** "Ramo: JURIDICO" — texto (nunca só cor) com rótulo acessível (RN-WF2-12). */
export function BranchChip({ branchKey }: { readonly branchKey: string }) {
  const t = useTranslations('workflows.editor.parallel');
  return (
    <StatusChip tone="info" aria-label={t('branchChipLabel', { branch: branchKey })}>
      {t('branchChip', { branch: branchKey })}
    </StatusChip>
  );
}

function IssueList({
  issues,
  onGoTo,
}: {
  readonly issues: readonly WorkflowBranchIssueDto[];
  readonly onGoTo: (target: IssueTarget) => void;
}) {
  const t = useTranslations('workflows.editor.parallel.structure');
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
      {issues.map((issue, index) => (
        <li key={`${issue.reason}-${String(index)}`}>
          {issue.message}{' '}
          {issue.transitionKey ? (
            <button
              type="button"
              className="font-medium underline"
              onClick={() => {
                onGoTo({ kind: 'transition', key: issue.transitionKey ?? '' });
              }}
            >
              {t('goToTransition')}
            </button>
          ) : issue.stageKey ? (
            <button
              type="button"
              className="font-medium underline"
              onClick={() => {
                onGoTo({ kind: 'stage', key: issue.stageKey ?? '' });
              }}
            >
              {t('goToStage')}
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * `ParallelStructurePanel` (passo 4 · FA-06/FA-07): cada bloco com a ramificação, os ramos (com as
 * etapas na ordem), a junção e os problemas, com link para a etapa ou a transição. Somente leitura
 * em versão publicada; "Remover ramificação" só no rascunho com `WORKFLOW_MANAGE`.
 */
export function ParallelStructurePanel({
  version,
  readOnly,
  onGoTo,
  onRemove,
}: {
  readonly version: WorkflowVersionDetailDto;
  readonly readOnly: boolean;
  readonly onGoTo: (target: IssueTarget) => void;
  readonly onRemove: (block: WorkflowParallelBlockDto) => void;
}) {
  const t = useTranslations('workflows.editor.parallel.structure');
  const ids = useId();
  const branches = useVersionBranches(version);
  const nameOf = (key: string | null) =>
    key === null ? null : (version.stages.find((stage) => stage.key === key)?.name ?? key);

  let body;
  if (branches.isPending) {
    body = (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  } else if (branches.isError) {
    body = (
      <Alert tone="error" live={false} title={t('loadFailed')}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void branches.refetch();
          }}
        >
          {t('retry')}
        </Button>
      </Alert>
    );
  } else if (branches.data.blocks.length === 0 && branches.data.issues.length === 0) {
    body = <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {branches.data.blocks.map((block) => (
          <article
            key={block.splitStageKey}
            aria-label={`${t('split')}: ${nameOf(block.splitStageKey) ?? ''}`}
            className="flex flex-col gap-2 rounded-card border border-border p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                <span aria-hidden>⑂ </span>
                <strong>{t('split')}:</strong> {nameOf(block.splitStageKey)}
                <span className="text-muted-foreground"> → </span>
                <span aria-hidden>⊕ </span>
                <strong>{t('join')}:</strong> {nameOf(block.joinStageKey) ?? t('noJoin')}
              </p>
              {readOnly ? null : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    onRemove(block);
                  }}
                >
                  {t('remove')}
                </Button>
              )}
            </div>
            <ul aria-label={t('branches')} className="flex flex-col gap-1 pl-4 text-sm">
              {block.branches.map((branch) => (
                <li key={branch.branchKey}>
                  <span className="font-medium">{t('branch', { branch: branch.branchKey })}</span>
                  {': '}
                  {branch.stageKeys.map((key) => nameOf(key)).join(' → ')}
                </li>
              ))}
            </ul>
            {block.issues.length > 0 ? (
              <IssueList issues={block.issues} onGoTo={onGoTo} />
            ) : (
              <p className="text-sm text-muted-foreground">{t('noIssues')}</p>
            )}
          </article>
        ))}
        {branches.data.issues.length > 0 ? (
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">{t('orphanTitle')}</h3>
            <IssueList issues={branches.data.issues} onGoTo={onGoTo} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section
      aria-labelledby={`${ids}-title`}
      className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card"
    >
      <div className="flex items-center gap-1.5">
        <h2 id={`${ids}-title`} className="text-sm font-semibold">
          {t('title')}
        </h2>
        <InfoTooltip label={t('title')}>{t('hint')}</InfoTooltip>
      </div>
      {body}
    </section>
  );
}

const PROBLEM_KEYS = {
  REQUIRED: 'required',
  NAME_LENGTH: 'nameLength',
  DUPLICATED: 'duplicated',
  BRANCHES_MIN: 'branchesMin',
} as const satisfies Readonly<Record<BlockProblem['code'], string>>;

/**
 * `ParallelBlockWizard` ("Adicionar ramificação" — passos 1 e 2): nome do bloco, origem, destino da
 * junção e os ramos (mínimo 2) com a primeira etapa de cada um. Cria em sequência as etapas e as
 * transições (cada escrita sobe a versão do rascunho); uma falha no meio deixa o que já foi criado
 * (o painel "Ramificações" mostra o que falta).
 */
export function ParallelBlockWizard({
  open,
  version,
  stages,
  onClose,
  onStageSaved,
  onTransitionSaved,
}: {
  readonly open: boolean;
  readonly version: WorkflowVersionDetailDto;
  readonly stages: readonly WorkflowStageDto[];
  readonly onClose: () => void;
  readonly onStageSaved: (stage: WorkflowStageDto) => void;
  readonly onTransitionSaved: (transition: WorkflowTransitionDto) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        {open ? (
          <WizardBody
            version={version}
            stages={stages}
            onClose={onClose}
            onStageSaved={onStageSaved}
            onTransitionSaved={onTransitionSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function WizardBody({
  version,
  stages,
  onClose,
  onStageSaved,
  onTransitionSaved,
}: {
  readonly version: WorkflowVersionDetailDto;
  readonly stages: readonly WorkflowStageDto[];
  readonly onClose: () => void;
  readonly onStageSaved: (stage: WorkflowStageDto) => void;
  readonly onTransitionSaved: (transition: WorkflowTransitionDto) => void;
}) {
  const t = useTranslations('workflows.editor.parallel.wizard');
  const ids = useId();
  const [draft, setDraft] = useState<ParallelBlockDraft>(EMPTY_BLOCK);
  const [problems, setProblems] = useState<readonly BlockProblem[]>([]);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const errorOf = (field: BlockField) => {
    const problem = problems.find((item) => item.field === field);
    return problem ? t(PROBLEM_KEYS[problem.code]) : undefined;
  };
  const setBranch = (index: number, name: string) => {
    setDraft((current) => ({
      ...current,
      branches: current.branches.map((branch, position) =>
        position === index ? { name } : branch,
      ),
    }));
  };

  const submit = async () => {
    const found = blockDraftProblems(draft);
    setProblems(found);
    setFailed(false);
    if (found.length > 0) return;
    const plan = parallelBlockPlan(
      draft,
      stages,
      new Set(version.transitions.map((transition) => transition.key)),
    );
    setPending(true);
    try {
      const idOf = new Map(stages.map((stage) => [stage.key, stage.id]));
      for (const body of plan.stages) {
        const created = (await createStage(version.id, body)).data;
        idOf.set(created.key, created.id);
        onStageSaved(created);
      }
      for (const planned of plan.transitions) {
        const created = (
          await createTransition(version.id, {
            key: planned.key,
            name: planned.name,
            fromStageId: idOf.get(planned.fromKey) ?? '',
            toStageId: idOf.get(planned.toKey) ?? '',
            action: planned.action,
            displayOrder: 0,
            isPrimary: false,
            requiresComment: false,
            allowDueDateOverride: true,
          })
        ).data;
        onTransitionSaved(created);
      }
      toast({ title: t('created', { name: draft.name.trim() }), tone: 'success' });
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  const stageOptions = (list: readonly WorkflowStageDto[]) =>
    list.map((stage) => ({ value: stage.id, label: stage.name }));

  return (
    <>
      <DialogTitle>{t('title')}</DialogTitle>
      <DialogDescription>{t('description')}</DialogDescription>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label={t('name')}
          id={`${ids}-name`}
          description={t('nameHint')}
          error={errorOf('name')}
          required
        >
          <Input
            value={draft.name}
            maxLength={120}
            onChange={(event) => {
              setDraft((current) => ({ ...current, name: event.target.value }));
            }}
          />
        </Field>
        <Field
          label={t('origin')}
          id={`${ids}-origin`}
          description={t('originHint')}
          error={errorOf('originStageId')}
          required
        >
          <OptionSelect
            value={draft.originStageId}
            noneLabel="—"
            options={stageOptions(originCandidates(stages))}
            onValueChange={(value) => {
              setDraft((current) => ({ ...current, originStageId: value }));
            }}
          />
        </Field>
        <Field
          label={t('destination')}
          id={`${ids}-destination`}
          description={t('destinationHint')}
          error={errorOf('destinationStageId')}
          required
        >
          <OptionSelect
            value={draft.destinationStageId}
            noneLabel="—"
            options={stageOptions(destinationCandidates(stages))}
            onValueChange={(value) => {
              setDraft((current) => ({ ...current, destinationStageId: value }));
            }}
          />
        </Field>
        <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="mb-2 text-sm font-semibold">{t('branches')}</legend>
          {draft.branches.map((branch, index) => (
            <div key={String(index)} className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field
                  label={t('branchName', { position: index + 1 })}
                  id={`${ids}-branch-${String(index)}`}
                  error={errorOf(`branches.${String(index)}`)}
                  required
                >
                  <Input
                    value={branch.name}
                    maxLength={120}
                    onChange={(event) => {
                      setBranch(index, event.target.value);
                    }}
                  />
                </Field>
              </div>
              {draft.branches.length > 2 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDraft((current) => ({
                      ...current,
                      branches: current.branches.filter((_, position) => position !== index),
                    }));
                  }}
                >
                  {t('removeBranch', { position: index + 1 })}
                </Button>
              ) : null}
            </div>
          ))}
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setDraft((current) => ({
                  ...current,
                  branches: [...current.branches, { name: '' }],
                }));
              }}
            >
              {t('addBranch')}
            </Button>
          </div>
        </fieldset>
        <div aria-live="assertive" className="empty:hidden">
          {failed ? <Alert tone="error" title={t('failed')} /> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? t('creating') : t('submit')}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

/**
 * `RemoveBlockConfirmDialog` (FA-04): lista as etapas que saem e quantas transições; remove as
 * transições antes das etapas (RN-WF-50), cada uma com o seu `If-Match`.
 */
export function RemoveBlockConfirmDialog({
  block,
  version,
  onClose,
  onTransitionDeleted,
  onStageDeleted,
}: {
  readonly block: WorkflowParallelBlockDto | null;
  readonly version: WorkflowVersionDetailDto;
  readonly onClose: () => void;
  readonly onTransitionDeleted: (transitionId: string) => void;
  readonly onStageDeleted: (stageId: string) => void;
}) {
  const t = useTranslations('workflows.editor.parallel.remove');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const plan = block ? blockRemovalPlan(block, version.stages, version.transitions) : null;
  const splitName = version.stages.find((stage) => stage.key === block?.splitStageKey)?.name ?? '';

  const confirm = async () => {
    if (!plan) return;
    setPending(true);
    setFailed(false);
    try {
      for (const transition of plan.transitions) {
        await deleteTransition(transition);
        onTransitionDeleted(transition.id);
      }
      for (const stage of plan.stages) {
        await deleteStage(stage);
        onStageDeleted(stage.id);
      }
      toast({ title: t('removed'), tone: 'success' });
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={block !== null}
      onOpenChange={(open) => {
        if (!open) {
          setFailed(false);
          onClose();
        }
      }}
    >
      <DialogContent role="alertdialog">
        <DialogTitle>{t('title', { name: splitName })}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        <ul className="list-disc pl-5 text-sm">
          {plan?.stages.map((stage) => (
            <li key={stage.id}>{stage.name}</li>
          ))}
          <li>{t('transitions', { count: plan?.transitions.length ?? 0 })}</li>
        </ul>
        <div aria-live="assertive" className="empty:hidden">
          {failed ? <Alert tone="error" title={t('failed')} /> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            aria-busy={pending}
            onClick={() => void confirm()}
          >
            {pending ? t('removing') : t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
