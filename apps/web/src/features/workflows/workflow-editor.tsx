'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Skeleton,
  toast,
} from '@contrataflow/ui';
import type {
  WorkflowDto,
  WorkflowStageDto,
  WorkflowTransitionDto,
  WorkflowVersionDetailDto,
} from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import { StagePropertiesPanel } from './stage-properties-panel';
import { outcomeOf } from './workflow-editor-errors';
import type { EditorProblem } from './workflow-editor-errors';
import { graphWarnings, reorderPatches, sortStages } from './workflow-editor-model';
import { TransitionsSection } from './workflow-transitions';
import {
  createWorkflowDraft,
  fetchWorkflow,
  fetchWorkflowVersion,
  updateStage,
  workflowKeys,
  workflowRulesHref,
  WORKFLOWS_PATH,
  WORKFLOWS_STALE_TIME_MS,
} from './workflows.api';

/** Abaixo de 768 px o painel lateral vira modal (SCR-034 · acessibilidade e responsividade). */
function useIsDesktop(): boolean {
  const query = '(min-width: 768px)';
  const supported = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const [desktop, setDesktop] = useState(() => !supported || window.matchMedia(query).matches);
  useEffect(() => {
    if (!supported) return undefined;
    const media = window.matchMedia(query);
    const onChange = () => {
      setDesktop(media.matches);
    };
    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, [supported]);
  return desktop;
}

/**
 * SCR-034 (`/admin/workflows/[id]` — US-043): carrega o workflow (WF-03) e a versão em edição
 * (WF-09) — o rascunho, se houver; senão a publicada, só leitura, com "Criar rascunho" (WF-08).
 * Sem rascunho nem publicada: "Sem versão em edição" (FA-07). Sem `WORKFLOW_MANAGE`, tudo só
 * leitura e as ações de escrita ocultas; a API decide (RN-FND-92).
 */
export function WorkflowEditorView({ workflowId }: { readonly workflowId: string }) {
  const t = useTranslations('workflows');
  const tenantId = useTenantId();
  const canManage = usePermission('WORKFLOW_MANAGE').allowed;
  // "Recarregar e tentar novamente" (412) remonta o editor com o estado persistido.
  const [generation, setGeneration] = useState(0);

  const workflow = useQuery({
    queryKey: workflowKeys.detail(tenantId, workflowId),
    queryFn: async ({ signal }) => (await fetchWorkflow(workflowId, signal)).data,
    staleTime: WORKFLOWS_STALE_TIME_MS,
    throwOnError: false,
  });
  const versionId =
    workflow.data?.draftVersion?.id ?? workflow.data?.currentPublishedVersion?.id ?? null;
  const version = useQuery({
    queryKey: workflowKeys.version(tenantId, versionId ?? ''),
    queryFn: async ({ signal }) => (await fetchWorkflowVersion(versionId ?? '', signal)).data,
    staleTime: WORKFLOWS_STALE_TIME_MS,
    enabled: versionId !== null,
    throwOnError: false,
  });

  const reload = () => {
    void Promise.all([workflow.refetch(), version.refetch()]).then(() => {
      setGeneration((value) => value + 1);
    });
  };

  const failure = workflow.error ?? version.error;
  const loading = workflow.isPending || (versionId !== null && version.isPending);

  return (
    <div className="flex flex-col gap-6">
      <Link href={WORKFLOWS_PATH} className="text-sm text-muted-foreground underline">
        {t('editor.back')}
      </Link>
      {loading && !failure ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('editor.loading')}</span>
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}
      {failure ? (
        isApiError(failure) && failure.status === 404 ? (
          <Alert tone="error" title={t('editor.notFound')} />
        ) : isApiError(failure) && failure.status === 403 ? (
          <Alert tone="error" title={t('forbidden.title')}>
            {t('forbidden.description')}
          </Alert>
        ) : (
          <Alert tone="error" title={t('editor.loadFailed')}>
            <Button variant="secondary" size="sm" onClick={reload}>
              {t('retry')}
            </Button>
          </Alert>
        )
      ) : null}
      {workflow.data && !failure ? (
        <>
          <EditorHeader workflow={workflow.data} version={version.data ?? null} />
          {version.data ? (
            // SCR-035 (US-044): a aba "Regras" abre a tela própria das regras da versão.
            <Link href={workflowRulesHref(workflowId)} className="text-sm font-medium underline">
              {t('editor.rulesLink')}
            </Link>
          ) : null}
          {versionId === null ? (
            <p className="rounded-card border border-dashed border-border p-6 text-muted-foreground">
              {t('editor.noVersion')}
            </p>
          ) : null}
          {workflow.data.draftVersion === null &&
          workflow.data.currentPublishedVersion !== null &&
          canManage ? (
            <CreateDraftButton workflow={workflow.data} onExisting={reload} />
          ) : null}
          {version.data ? (
            <DraftEditor
              key={`${version.data.id}:${String(generation)}`}
              version={version.data}
              readOnly={version.data.status !== 'DRAFT' || !canManage}
              onReload={reload}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function EditorHeader({
  workflow,
  version,
}: {
  readonly workflow: WorkflowDto;
  readonly version: WorkflowVersionDetailDto | null;
}) {
  const t = useTranslations('workflows');
  return (
    <header className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{workflow.name}</h1>
        {workflow.isDefault ? (
          <span className="rounded-control bg-success-soft px-2 py-0.5 text-xs font-medium">
            {t('badges.default')}
          </span>
        ) : null}
        <span className="rounded-control bg-muted px-2 py-0.5 text-xs font-medium">
          {workflow.isActive ? t('badges.active') : t('badges.inactive')}
        </span>
      </div>
      {workflow.description ? (
        <p className="max-w-3xl text-muted-foreground">{workflow.description}</p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        <span className="font-mono">{workflow.key}</span>
        {version
          ? ` · ${
              version.status === 'DRAFT'
                ? t('editor.versionDraft', { number: version.versionNumber })
                : t('editor.versionReadOnly', { number: version.versionNumber })
            }`
          : null}
      </p>
    </header>
  );
}

/** `CreateDraftButton` (passo 8 · WF-08): rascunho copiado da publicada; já existe → continuar. */
function CreateDraftButton({
  workflow,
  onExisting,
}: {
  readonly workflow: WorkflowDto;
  readonly onExisting: () => void;
}) {
  const t = useTranslations('workflows.editor');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [draftExists, setDraftExists] = useState(false);
  const mutation = useMutation({
    mutationFn: () => createWorkflowDraft(workflow.id),
    onSuccess: (result) => {
      queryClient.setQueryData(workflowKeys.version(tenantId, result.data.id), result.data);
      toast({ title: t('draft.created', { number: result.data.versionNumber }), tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: workflowKeys.all(tenantId) });
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'WORKFLOW_DRAFT_EXISTS') {
        setDraftExists(true);
        setMessage(t('draft.exists'));
      } else if (isApiError(error) && error.code === 'BUSINESS_RULE_VIOLATION') {
        setMessage(t('draft.nothingToCopy'));
      } else if (isApiError(error) && error.code === 'MFA_REQUIRED') {
        setMessage(t('problems.mfa'));
      } else if (isApiError(error) && error.status === 503) {
        setMessage(t('problems.unavailable'));
      } else {
        setMessage(t('draft.failed'));
      }
    },
  });
  return (
    <div className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4">
      <p className="text-sm">{t('draft.hint')}</p>
      <div>
        <Button
          disabled={mutation.isPending}
          aria-busy={mutation.isPending}
          onClick={() => {
            setMessage(null);
            setDraftExists(false);
            mutation.mutate();
          }}
        >
          {t('draft.action')}
        </Button>
      </div>
      <div aria-live="assertive">
        {message ? (
          <Alert tone={draftExists ? 'warning' : 'error'} title={message}>
            {draftExists ? (
              <Button variant="secondary" size="sm" onClick={onExisting}>
                {t('draft.continue')}
              </Button>
            ) : null}
          </Alert>
        ) : null}
      </div>
    </div>
  );
}

type Tab = 'stages' | 'transitions';

/** Tabela de etapas + painel lateral, transições e avisos do grafo da versão carregada. */
function DraftEditor({
  version,
  readOnly,
  onReload,
}: {
  readonly version: WorkflowVersionDetailDto;
  readonly readOnly: boolean;
  readonly onReload: () => void;
}) {
  const t = useTranslations('workflows.editor');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const ids = useId();
  const desktop = useIsDesktop();
  const [tab, setTab] = useState<Tab>('stages');
  // Id da etapa aberta no painel, `'new'` (etapa nova) ou `null`.
  const [selected, setSelected] = useState<string | null>(null);
  const [problem, setProblem] = useState<EditorProblem | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [moving, setMoving] = useState(false);
  const versionKey = workflowKeys.version(tenantId, version.id);

  const updateCache = (change: (current: WorkflowVersionDetailDto) => WorkflowVersionDetailDto) => {
    queryClient.setQueryData<WorkflowVersionDetailDto>(versionKey, (current) =>
      current ? change(current) : current,
    );
  };
  const putStage = (stage: WorkflowStageDto) => {
    updateCache((current) => ({
      ...current,
      stages: current.stages.some((item) => item.id === stage.id)
        ? current.stages.map((item) => (item.id === stage.id ? stage : item))
        : [...current.stages, stage],
    }));
  };
  const putTransition = (transition: WorkflowTransitionDto) => {
    updateCache((current) => ({
      ...current,
      transitions: current.transitions.some((item) => item.id === transition.id)
        ? current.transitions.map((item) => (item.id === transition.id ? transition : item))
        : [...current.transitions, transition],
    }));
  };

  const stages = sortStages(version.stages);
  const warnings = version.status === 'DRAFT' ? graphWarnings(stages, version.transitions) : [];
  const stageName = (id: string) => stages.find((stage) => stage.id === id)?.name ?? '';
  const selectedStage =
    selected && selected !== 'new' ? (stages.find((stage) => stage.id === selected) ?? null) : null;
  const panelOpen = selected === 'new' || selectedStage !== null;

  /** FA-04: um PATCH por etapa que mudou de posição (sem lote), cada um com o seu `If-Match`. */
  const move = async (from: number, to: number) => {
    if (readOnly || moving) return;
    const patches = reorderPatches(stages, from, to);
    if (patches.length === 0) return;
    setMoving(true);
    setProblem(null);
    try {
      for (const { stage, displayOrder } of patches) {
        putStage((await updateStage(stage, { displayOrder })).data);
      }
      const moved = stages[from];
      if (moved) setAnnouncement(t('stages.moved', { name: moved.name, position: to + 1 }));
    } catch (error) {
      const outcome = outcomeOf(error);
      setProblem(outcome.kind === 'screen' ? outcome.problem : { kind: 'generic', message: null });
    } finally {
      setMoving(false);
    }
  };

  const panel = panelOpen ? (
    <StagePropertiesPanel
      key={selectedStage?.id ?? 'new'}
      versionId={version.id}
      stage={selectedStage}
      stages={stages}
      readOnly={readOnly}
      onSaved={(stage, created) => {
        putStage(stage);
        setProblem(null);
        if (created) {
          setSelected(stage.id);
          setAnnouncement(t('stages.created', { name: stage.name }));
        }
      }}
      onDeleted={(stageId) => {
        updateCache((current) => ({
          ...current,
          stages: current.stages.filter((item) => item.id !== stageId),
        }));
        setSelected(null);
        setAnnouncement(t('stages.deleted'));
      }}
      onProblem={setProblem}
      onClose={() => {
        setSelected(null);
      }}
    />
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      {readOnly && version.status !== 'DRAFT' ? (
        <Alert tone="info" title={t('readOnly.published')} />
      ) : null}
      <div aria-live="assertive">
        {problem ? <ProblemBanner problem={problem} onReload={onReload} /> : null}
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {warnings.length > 0 ? (
        <section
          aria-labelledby={`${ids}-warnings`}
          className="rounded-card border border-border bg-warning-soft p-4"
        >
          <h2 id={`${ids}-warnings`} className="font-medium">
            {t('warnings.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('warnings.hint')}</p>
          <ul className="mt-2 list-disc pl-5 text-sm">
            {warnings.map((warning) => (
              <li
                key={
                  warning.kind === 'NO_START' ? 'NO_START' : `${warning.kind}:${warning.stageId}`
                }
              >
                {warning.kind === 'NO_START'
                  ? t('warnings.noStart')
                  : warning.kind === 'NO_EXIT'
                    ? t('warnings.noExit', { name: stageName(warning.stageId) })
                    : t('warnings.unreachable', { name: stageName(warning.stageId) })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div
        role="tablist"
        aria-label={t('tabs.label')}
        className="flex gap-2 border-b border-border"
      >
        {(['stages', 'transitions'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${ids}-tab-${value}`}
            aria-selected={tab === value}
            aria-controls={`${ids}-panel-${value}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === value
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground'
            }`}
            onClick={() => {
              setTab(value);
            }}
          >
            {t(`tabs.${value}`)}
          </button>
        ))}
      </div>

      {tab === 'stages' ? (
        <div
          role="tabpanel"
          id={`${ids}-panel-stages`}
          aria-labelledby={`${ids}-tab-stages`}
          className="flex flex-col gap-4 md:flex-row md:items-start"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {readOnly ? null : (
              <div>
                <Button
                  onClick={() => {
                    setSelected('new');
                  }}
                >
                  {t('stages.add')}
                </Button>
              </div>
            )}
            {stages.length === 0 ? (
              <p className="rounded-card border border-dashed border-border p-6 text-muted-foreground">
                {t('stages.empty')}
              </p>
            ) : (
              <StageTable
                stages={stages}
                selectedId={selectedStage?.id ?? null}
                readOnly={readOnly}
                busy={moving}
                onSelect={setSelected}
                onMove={(from, to) => void move(from, to)}
              />
            )}
          </div>
          {panel && desktop ? (
            <aside className="w-full rounded-card border border-border bg-surface p-4 shadow-card md:w-[26rem]">
              {panel}
            </aside>
          ) : null}
          {panel && !desktop ? (
            <Dialog
              open
              onOpenChange={(open) => {
                if (!open) setSelected(null);
              }}
            >
              <DialogContent closeLabel={t('panel.close')}>
                <DialogTitle className="sr-only">
                  {selectedStage
                    ? t('panel.title', { name: selectedStage.name })
                    : t('panel.newTitle')}
                </DialogTitle>
                <DialogDescription className="sr-only">{t('panel.legend')}</DialogDescription>
                {panel}
              </DialogContent>
            </Dialog>
          ) : null}
        </div>
      ) : (
        <div
          role="tabpanel"
          id={`${ids}-panel-transitions`}
          aria-labelledby={`${ids}-tab-transitions`}
        >
          <TransitionsSection
            version={version}
            stages={stages}
            readOnly={readOnly}
            onSaved={putTransition}
            onDeleted={(transitionId) => {
              updateCache((current) => ({
                ...current,
                transitions: current.transitions.filter((item) => item.id !== transitionId),
              }));
            }}
            onProblem={setProblem}
          />
        </div>
      )}
    </div>
  );
}

function ProblemBanner({
  problem,
  onReload,
}: {
  readonly problem: EditorProblem;
  readonly onReload: () => void;
}) {
  const t = useTranslations('workflows.editor');
  const reloadButton: ReactNode = (
    <Button variant="secondary" size="sm" onClick={onReload}>
      {t('problems.reload')}
    </Button>
  );
  switch (problem.kind) {
    case 'conflict':
      return (
        <Alert tone="error" title={t('problems.conflict')}>
          {reloadButton}
        </Alert>
      );
    case 'notDraft':
      return (
        <Alert tone="error" title={t('problems.notDraft')}>
          {reloadButton}
        </Alert>
      );
    case 'forbidden':
      return <Alert tone="error" title={t('problems.forbidden')} />;
    case 'mfa':
      return <Alert tone="error" title={t('problems.mfa')} />;
    case 'unavailable':
      return <Alert tone="error" title={t('problems.unavailable')} />;
    default:
      return <Alert tone="error" title={problem.message ?? t('problems.generic')} />;
  }
}

/**
 * `StageTable` (ordenável): arrastar a linha ou, pelo teclado, setas ↑/↓ no botão de reordenar
 * (alternativa ao arrastar). O nome abre o painel de propriedades.
 */
function StageTable({
  stages,
  selectedId,
  readOnly,
  busy,
  onSelect,
  onMove,
}: {
  readonly stages: readonly WorkflowStageDto[];
  readonly selectedId: string | null;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly onSelect: (id: string) => void;
  readonly onMove: (from: number, to: number) => void;
}) {
  const t = useTranslations('workflows.editor');
  const ids = useId();
  const dragFrom = useRef<number | null>(null);
  const onHandleKey = (event: KeyboardEvent, index: number) => {
    if (event.key === 'ArrowUp' && index > 0) {
      event.preventDefault();
      onMove(index, index - 1);
    } else if (event.key === 'ArrowDown' && index < stages.length - 1) {
      event.preventDefault();
      onMove(index, index + 1);
    }
  };
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full text-left text-sm"
        aria-describedby={readOnly ? undefined : `${ids}-hint`}
      >
        <caption className="sr-only">{t('stages.caption')}</caption>
        <thead className="text-muted-foreground">
          <tr>
            <th scope="col" className="px-2 py-2">
              {t('stages.columns.order')}
            </th>
            <th scope="col" className="px-2 py-2">
              {t('stages.columns.name')}
            </th>
            <th scope="col" className="hidden px-2 py-2 sm:table-cell">
              {t('stages.columns.type')}
            </th>
            <th scope="col" className="hidden px-2 py-2 md:table-cell">
              {t('stages.columns.department')}
            </th>
            <th scope="col" className="hidden px-2 py-2 sm:table-cell">
              {t('stages.columns.sla')}
            </th>
          </tr>
        </thead>
        <tbody>
          {stages.map((stage, index) => (
            <tr
              key={stage.id}
              draggable={!readOnly && !busy}
              aria-selected={stage.id === selectedId}
              className={`border-t border-border ${stage.id === selectedId ? 'bg-muted' : ''}`}
              onDragStart={() => {
                dragFrom.current = index;
              }}
              onDragOver={(event) => {
                if (!readOnly) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragFrom.current !== null) onMove(dragFrom.current, index);
                dragFrom.current = null;
              }}
            >
              <td className="px-2 py-2">
                <div className="flex items-center gap-1">
                  {readOnly ? null : (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={t('stages.reorder', { name: stage.name, position: index + 1 })}
                      className="cursor-grab rounded-control px-1 text-muted-foreground"
                      onKeyDown={(event) => {
                        onHandleKey(event, index);
                      }}
                    >
                      <span aria-hidden="true">⠿</span>
                    </button>
                  )}
                  <span>{index + 1}</span>
                </div>
              </td>
              <td className="px-2 py-2">
                <button
                  type="button"
                  className="text-left font-medium underline-offset-2 hover:underline"
                  aria-label={t('stages.open', { name: stage.name })}
                  onClick={() => {
                    onSelect(stage.id);
                  }}
                >
                  {stage.name}
                </button>
                {stage.color ? (
                  <span
                    aria-hidden="true"
                    className="ml-2 inline-block h-2.5 w-2.5 rounded-full align-middle"
                    style={{ backgroundColor: stage.color }}
                  />
                ) : null}
              </td>
              <td className="hidden px-2 py-2 sm:table-cell">{t(`stageTypes.${stage.type}`)}</td>
              <td className="hidden px-2 py-2 md:table-cell">
                {t(`departmentResolutions.${stage.departmentResolution}`)}
              </td>
              <td className="hidden px-2 py-2 sm:table-cell">
                {stage.slaDays === null
                  ? '—'
                  : t(`stages.sla.${stage.slaType}`, { days: stage.slaDays })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {readOnly ? null : (
        <p id={`${ids}-hint`} className="mt-1 text-xs text-muted-foreground">
          {t('stages.reorderHint')}
        </p>
      )}
    </div>
  );
}
