'use client';

import {
  Alert,
  Button,
  ChevronDown,
  DetailPage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  InfoTooltip,
  Sheet,
  SheetContent,
  Skeleton,
  StatusChip,
  Table,
  TableBody,
  TableContainer,
  TableHead,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Td,
  Th,
  Tr,
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
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import { StagePropertiesPanel } from './stage-properties-panel';
import { useIsDesktop } from './use-is-desktop';
import { WorkflowDiagramSection } from './workflow-diagram';
import { outcomeOf } from './workflow-editor-errors';
import type { EditorProblem } from './workflow-editor-errors';
import { graphWarnings, reorderPatches, sortStages } from './workflow-editor-model';
import { TransitionsSection } from './workflow-transitions';
import { WorkflowVersionsSection } from './workflow-versions';
import type { IssueTarget } from './workflow-versions-model';
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

/**
 * SCR-034 (`/admin/workflows/[id]` — US-043) no modelo `DetailPage` (prd-5): carrega o workflow
 * (WF-03) e a versão em edição (WF-09) — o rascunho, se houver; senão a publicada, só leitura, com
 * "Criar rascunho" (WF-08) como ação primária. Sem rascunho nem publicada: "Sem versão em edição"
 * (FA-07). Sem `WORKFLOW_MANAGE`, tudo só leitura e as ações de escrita ocultas; a API decide
 * (RN-FND-92).
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

  if (failure || workflow.isPending || !workflow.data) {
    return (
      <div className="flex flex-col gap-5">
        <Link href={WORKFLOWS_PATH} className="text-sm text-muted-foreground underline">
          {t('editor.back')}
        </Link>
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
        ) : (
          <div role="status" className="flex flex-col gap-3">
            <span className="sr-only">{t('editor.loading')}</span>
            <Skeleton className="h-4 w-48 max-w-full" />
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
      </div>
    );
  }

  if (version.data) {
    return (
      <DraftEditor
        key={`${version.data.id}:${String(generation)}`}
        workflow={workflow.data}
        version={version.data}
        canManage={canManage}
        readOnly={version.data.status !== 'DRAFT' || !canManage}
        onReload={reload}
      />
    );
  }

  return (
    <EditorFrame workflow={workflow.data} version={null}>
      {versionId === null ? (
        <EmptyState title={t('editor.noVersion')} />
      ) : (
        <div role="status" className="flex flex-col gap-3">
          <span className="sr-only">{t('editor.loading')}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}
    </EditorFrame>
  );
}

/**
 * Moldura do editor (`DetailPage`): trilha, nome, chips de situação (padrão, ativo, versão) e a
 * linha com a chave e a descrição. As ações e os avisos vêm de quem a usa.
 */
function EditorFrame({
  workflow,
  version,
  actions,
  notices,
  children,
}: {
  readonly workflow: WorkflowDto;
  readonly version: WorkflowVersionDetailDto | null;
  readonly actions?: ReactNode;
  readonly notices?: ReactNode;
  readonly children?: ReactNode;
}) {
  const t = useTranslations('workflows');
  const tShell = useTranslations('shell');
  return (
    <DetailPage
      breadcrumbs={[
        { label: tShell('admin.title'), href: '/admin' },
        { label: t('title'), href: WORKFLOWS_PATH },
        { label: workflow.name },
      ]}
      breadcrumbLabel={t('editor.breadcrumbLabel')}
      linkComponent={Link}
      title={workflow.name}
      status={
        <>
          {workflow.isDefault ? (
            <StatusChip tone="success">{t('badges.default')}</StatusChip>
          ) : null}
          <StatusChip tone={workflow.isActive ? 'info' : 'neutral'}>
            {workflow.isActive ? t('badges.active') : t('badges.inactive')}
          </StatusChip>
          {version ? (
            <StatusChip tone={version.status === 'DRAFT' ? 'warning' : 'neutral'}>
              {version.status === 'DRAFT'
                ? t('editor.versionDraft', { number: version.versionNumber })
                : t('editor.versionReadOnly', { number: version.versionNumber })}
            </StatusChip>
          ) : null}
        </>
      }
      subtitle={
        <>
          <span className="font-mono">{workflow.key}</span>
          {workflow.description ? ` · ${workflow.description}` : null}
        </>
      }
      actions={actions}
      notices={notices}
    >
      {children}
    </DetailPage>
  );
}

/** `CreateDraft` (passo 8 · WF-08): rascunho copiado da publicada; já existe → continuar. */
function useCreateDraft(workflow: WorkflowDto, onExisting: () => void) {
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
  const start = () => {
    setMessage(null);
    setDraftExists(false);
    mutation.mutate();
  };
  const notice = message ? (
    <Alert tone={draftExists ? 'warning' : 'error'} title={message}>
      {draftExists ? (
        <Button variant="secondary" size="sm" onClick={onExisting}>
          {t('draft.continue')}
        </Button>
      ) : null}
    </Alert>
  ) : null;
  return { pending: mutation.isPending, start, notice };
}

type Tab = 'stages' | 'transitions' | 'versions' | 'diagram';

/**
 * Tabela de etapas + painel de propriedades, transições, avisos do grafo da versão carregada, a aba
 * "Versões" (US-045: validar, publicar e aposentar) e a aba "Diagrama" (US-046: só leitura, oculta
 * sem `WORKFLOW_VIEW`). A ação primária da faixa é "Adicionar etapa" (ou "Adicionar transição" na
 * aba Transições) no rascunho e "Criar rascunho" na versão publicada; o resto fica em "Mais".
 */
function DraftEditor({
  workflow,
  version,
  canManage,
  readOnly,
  onReload,
}: {
  readonly workflow: WorkflowDto;
  readonly version: WorkflowVersionDetailDto;
  readonly canManage: boolean;
  readonly readOnly: boolean;
  readonly onReload: () => void;
}) {
  const t = useTranslations('workflows.editor');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const router = useRouter();
  const ids = useId();
  const desktop = useIsDesktop();
  const canView = usePermission('WORKFLOW_VIEW').allowed;
  const createDraft = useCreateDraft(workflow, onReload);
  const [tab, setTab] = useState<Tab>('stages');
  // Id da etapa aberta no painel, `'new'` (etapa nova) ou `null`.
  const [selected, setSelected] = useState<string | null>(null);
  // Transição aberta no painel: a própria, `'new'` ou `null`.
  const [editingTransition, setEditingTransition] = useState<WorkflowTransitionDto | 'new' | null>(
    null,
  );
  const [problem, setProblem] = useState<EditorProblem | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [moving, setMoving] = useState(false);
  const versionKey = workflowKeys.version(tenantId, version.id);

  const updateCache = (change: (current: WorkflowVersionDetailDto) => WorkflowVersionDetailDto) => {
    queryClient.setQueryData<WorkflowVersionDetailDto>(versionKey, (current) =>
      current ? change(current) : current,
    );
    // Toda escrita sobe a `version` do rascunho (RN-WF-06): o histórico (WF-07) relê ao abrir
    // "Versões"/"Diagrama", senão "Publicar" iria com o If-Match antigo (412).
    void queryClient.invalidateQueries({ queryKey: workflowKeys.versions(tenantId, workflow.id) });
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
  const canCreateDraft =
    workflow.draftVersion === null && workflow.currentPublishedVersion !== null && canManage;
  const needStagesId = `${ids}-need-stages`;
  const needStages = stages.length < 2;

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

  /** FA-05: do painel de validação para onde o problema se corrige. */
  const goTo = (target: IssueTarget) => {
    if (target.kind === 'rule') {
      router.push(workflowRulesHref(workflow.id));
    } else if (target.kind === 'transition') {
      setTab('transitions');
    } else if (target.kind === 'stage') {
      setTab('stages');
      const stage = stages.find((item) => item.key === target.key);
      if (stage) setSelected(stage.id);
    }
  };

  const panelProps = {
    versionId: version.id,
    stage: selectedStage,
    stages,
    readOnly,
    onSaved: (stage: WorkflowStageDto, created: boolean) => {
      putStage(stage);
      setProblem(null);
      if (created) {
        setSelected(stage.id);
        setAnnouncement(t('stages.created', { name: stage.name }));
      }
    },
    onDeleted: (stageId: string) => {
      updateCache((current) => ({
        ...current,
        stages: current.stages.filter((item) => item.id !== stageId),
      }));
      setSelected(null);
      setAnnouncement(t('stages.deleted'));
    },
    onProblem: setProblem,
    onClose: () => {
      setSelected(null);
    },
  };

  const primary: ReactNode = !readOnly ? (
    tab === 'transitions' ? (
      <Button
        disabled={needStages}
        aria-describedby={needStages ? needStagesId : undefined}
        onClick={() => {
          setEditingTransition('new');
        }}
      >
        {t('transitions.add')}
      </Button>
    ) : (
      <Button
        onClick={() => {
          setTab('stages');
          setSelected('new');
        }}
      >
        {t('stages.add')}
      </Button>
    )
  ) : canCreateDraft ? (
    <>
      <InfoTooltip label={t('draft.helpLabel')}>{t('draft.hint')}</InfoTooltip>
      <Button
        disabled={createDraft.pending}
        aria-busy={createDraft.pending}
        onClick={createDraft.start}
      >
        {t('draft.action')}
      </Button>
    </>
  ) : null;

  const actions = (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" iconRight={<ChevronDown />}>
            {t('menu.more')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={workflowRulesHref(workflow.id)}>{t('rulesLink')}</Link>
          </DropdownMenuItem>
          {canView ? (
            <DropdownMenuItem
              onSelect={() => {
                setTab('diagram');
              }}
            >
              {t('menu.diagram')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onSelect={() => {
              setTab('versions');
            }}
          >
            {t('menu.versions')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {primary}
    </>
  );

  const notices = (
    <>
      {readOnly && version.status !== 'DRAFT' ? (
        <Alert tone="info" title={t('readOnly.published')} />
      ) : null}
      <div aria-live="assertive" className="flex flex-col gap-3 empty:hidden">
        {createDraft.notice}
        {problem ? <ProblemBanner problem={problem} onReload={onReload} /> : null}
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {warnings.length > 0 ? (
        <section
          aria-labelledby={`${ids}-warnings`}
          className="rounded-card border border-warning/30 bg-warning-soft p-4"
        >
          <div className="flex items-center gap-1.5">
            <h2 id={`${ids}-warnings`} className="text-sm font-semibold">
              {t('warnings.title')}
            </h2>
            <InfoTooltip label={t('helpLabel', { field: t('warnings.title') })}>
              {t('warnings.hint')}
            </InfoTooltip>
          </div>
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
    </>
  );

  return (
    <EditorFrame workflow={workflow} version={version} actions={actions} notices={notices}>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value as Tab);
        }}
      >
        <TabsList aria-label={t('tabs.label')}>
          {(canView
            ? (['stages', 'transitions', 'versions', 'diagram'] as const)
            : (['stages', 'transitions', 'versions'] as const)
          ).map((value) => (
            <TabsTrigger key={value} value={value}>
              {t(`tabs.${value}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="stages" className="flex flex-col gap-5 md:flex-row md:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {stages.length === 0 ? (
              <EmptyState title={t('stages.empty')} />
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
          {panelOpen && desktop ? (
            <aside className="w-full rounded-card bg-surface p-5 shadow-card md:w-[26rem] md:flex-none">
              <StagePropertiesPanel
                key={selectedStage?.id ?? 'new'}
                variant="aside"
                {...panelProps}
              />
            </aside>
          ) : null}
          {panelOpen && !desktop ? (
            <Sheet
              open
              onOpenChange={(open) => {
                if (!open) setSelected(null);
              }}
            >
              <SheetContent closeLabel={t('panel.close')}>
                <StagePropertiesPanel
                  key={selectedStage?.id ?? 'new'}
                  variant="sheet"
                  {...panelProps}
                />
              </SheetContent>
            </Sheet>
          ) : null}
        </TabsContent>

        <TabsContent value="transitions">
          <TransitionsSection
            version={version}
            stages={stages}
            readOnly={readOnly}
            editing={editingTransition}
            onEditingChange={setEditingTransition}
            needStagesId={needStagesId}
            onSaved={putTransition}
            onDeleted={(transitionId) => {
              updateCache((current) => ({
                ...current,
                transitions: current.transitions.filter((item) => item.id !== transitionId),
              }));
            }}
            onProblem={setProblem}
          />
        </TabsContent>

        <TabsContent value="versions">
          <WorkflowVersionsSection workflow={workflow} onGoTo={goTo} />
        </TabsContent>

        {canView ? (
          <TabsContent value="diagram">
            <WorkflowDiagramSection workflow={workflow} defaultVersionId={version.id} />
          </TabsContent>
        ) : null}
      </Tabs>
    </EditorFrame>
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
    <TableContainer
      label={t('stages.caption')}
      footer={
        readOnly ? undefined : (
          <p
            id={`${ids}-hint`}
            className="border-t border-border px-3.5 py-2.5 text-xs text-muted-foreground"
          >
            {t('stages.reorderHint')}
          </p>
        )
      }
    >
      <Table aria-describedby={readOnly ? undefined : `${ids}-hint`}>
        <caption className="sr-only">{t('stages.caption')}</caption>
        <TableHead>
          <tr>
            <Th>{t('stages.columns.order')}</Th>
            <Th>{t('stages.columns.name')}</Th>
            <Th className="hidden sm:table-cell">{t('stages.columns.type')}</Th>
            <Th className="hidden md:table-cell">{t('stages.columns.department')}</Th>
            <Th className="hidden sm:table-cell">{t('stages.columns.sla')}</Th>
          </tr>
        </TableHead>
        <TableBody>
          {stages.map((stage, index) => (
            <Tr
              key={stage.id}
              draggable={!readOnly && !busy}
              aria-selected={stage.id === selectedId}
              className={stage.id === selectedId ? 'bg-primary-soft' : undefined}
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
              <Td>
                <div className="flex items-center gap-1">
                  {readOnly ? null : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={t('stages.reorder', { name: stage.name, position: index + 1 })}
                      className="cursor-grab px-2 text-muted-foreground"
                      onKeyDown={(event) => {
                        onHandleKey(event, index);
                      }}
                    >
                      <span aria-hidden="true">⠿</span>
                    </Button>
                  )}
                  <span>{index + 1}</span>
                </div>
              </Td>
              <Td>
                <button
                  type="button"
                  className="text-left font-semibold text-brand-ink underline-offset-2 hover:underline"
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
                    className="ml-2 inline-block size-2.5 rounded-full align-middle"
                    style={{ backgroundColor: stage.color }}
                  />
                ) : null}
              </Td>
              <Td className="hidden sm:table-cell">{t(`stageTypes.${stage.type}`)}</Td>
              <Td className="hidden md:table-cell">
                {t(`departmentResolutions.${stage.departmentResolution}`)}
              </Td>
              <Td className="hidden sm:table-cell">
                {stage.slaDays === null
                  ? '—'
                  : t(`stages.sla.${stage.slaType}`, { days: stage.slaDays })}
              </Td>
            </Tr>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
