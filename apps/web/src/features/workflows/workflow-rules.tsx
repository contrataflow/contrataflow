'use client';

import {
  Alert,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Ellipsis,
  EmptyState,
  Field,
  InfoTooltip,
  Input,
  Label,
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Skeleton,
  StatusChip,
  Switch,
  Table,
  TableBody,
  TableContainer,
  TableFooter,
  TableHead,
  Td,
  Textarea,
  Th,
  Tr,
  Workflow,
} from '@contrataflow/ui';
import type {
  DocumentTypeDto,
  RuleContextSchemaDto,
  WorkflowDto,
  WorkflowRuleDto,
  WorkflowStageDto,
  WorkflowVersionDetailDto,
} from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';
import { isApiError } from '@/lib/api/api-error';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import { ConditionBuilder } from './condition-builder';
import { RuleTestPanel } from './rule-test-panel';
import { outcomeOf } from './workflow-editor-errors';
import type { EditorProblem } from './workflow-editor-errors';
import {
  approvalStagesOf,
  EMPTY_RULE,
  fieldTypesOf,
  MIN_STATUS_OPTIONS,
  RULE_MESSAGE_MAX,
  RULE_NAME_MAX,
  RULE_TYPE_OPTIONS,
  ruleConfigOf,
  ruleCreateBody,
  ruleDraftOf,
  ruleDraftProblems,
  rulePatch,
  ruleReorderPatches,
  rulesOf,
  ruleSummaryOf,
  ruleTargets,
  ruleCountOf,
} from './workflow-rules-model';
import type { RuleDraft, RuleFieldProblem, RuleTarget } from './workflow-rules-model';
import {
  createRule,
  deleteRule,
  fetchRuleContextSchema,
  fetchWorkflow,
  fetchWorkflowDocumentTypes,
  fetchWorkflowVersion,
  updateRule,
  workflowEditorHref,
  workflowKeys,
  WORKFLOWS_STALE_TIME_MS,
} from './workflows.api';

/** O `Select` do kit não aceita valor vazio: "nenhum/selecione" usa este marcador. */
const NONE = 'none';

const targetKeyOf = (target: RuleTarget) => `${target.scope}:${target.id}`;

/**
 * SCR-035 (`/admin/workflows/[id]/regras` — US-044): regras de saída de etapa e de transição da
 * versão em edição (o rascunho; senão a publicada, só leitura). Carrega WF-03/WF-09 (as mesmas
 * chaves do editor), o schema do RuleContext (WF-19) e os tipos de documento. Sem
 * `WORKFLOW_MANAGE`, só consulta: "Nova regra", editar, excluir, reordenar e testar ficam ocultos;
 * a API decide (RN-FND-92).
 */
export function WorkflowRulesView({ workflowId }: { readonly workflowId: string }) {
  const t = useTranslations('workflows.rules');
  const tShell = useTranslations('shell');
  const tenantId = useTenantId();
  const canManage = usePermission('WORKFLOW_MANAGE').allowed;
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
    <div className="flex min-w-0 flex-col gap-5">
      {workflow.data && !failure ? (
        <AppPageHeader
          breadcrumbs={[
            { label: tShell('admin.title'), href: '/admin' },
            { label: t('breadcrumb.workflows'), href: '/admin/workflows' },
            { label: workflow.data.name, href: workflowEditorHref(workflowId) },
            { label: t('breadcrumb.rules') },
          ]}
          title={t('title', { name: workflow.data.name })}
          description={t('description')}
        />
      ) : (
        <Link
          href={workflowEditorHref(workflowId)}
          className="text-sm text-muted-foreground underline"
        >
          {t('back')}
        </Link>
      )}
      {loading && !failure ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}
      {failure ? (
        isApiError(failure) && failure.status === 404 ? (
          <Alert tone="error" title={t('notFound')} />
        ) : isApiError(failure) && failure.status === 403 ? (
          <Alert tone="error" title={t('problems.forbidden')} />
        ) : (
          <Alert tone="error" title={t('loadFailed')}>
            <Button variant="secondary" size="sm" onClick={reload}>
              {t('schema.retry')}
            </Button>
          </Alert>
        )
      ) : null}
      {workflow.data && !failure ? (
        <>
          {versionId === null ? <EmptyState icon={<Workflow />} title={t('noVersion')} /> : null}
          {version.data ? (
            <RulesEditor
              key={`${version.data.id}:${String(generation)}`}
              workflow={workflow.data}
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

function RulesEditor({
  workflow,
  version,
  readOnly,
  onReload,
}: {
  readonly workflow: WorkflowDto;
  readonly version: WorkflowVersionDetailDto;
  readonly readOnly: boolean;
  readonly onReload: () => void;
}) {
  const t = useTranslations('workflows.rules');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const ids = useId();
  const targets = ruleTargets(version);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const target =
    targets.find((candidate) => targetKeyOf(candidate) === selectedKey) ?? targets[0] ?? null;
  const [editing, setEditing] = useState<WorkflowRuleDto | 'new' | null>(null);
  const [problem, setProblem] = useState<EditorProblem | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [moving, setMoving] = useState(false);
  const versionKey = workflowKeys.version(tenantId, version.id);

  const schema = useQuery({
    queryKey: workflowKeys.ruleContextSchema(tenantId),
    queryFn: async ({ signal }) => (await fetchRuleContextSchema(signal)).data,
    staleTime: WORKFLOWS_STALE_TIME_MS,
    enabled: !readOnly,
    retry: false,
    throwOnError: false,
  });
  const documentTypes = useQuery({
    queryKey: workflowKeys.lookups(tenantId, 'documentTypes'),
    queryFn: async ({ signal }) => (await fetchWorkflowDocumentTypes(signal)).data,
    staleTime: WORKFLOWS_STALE_TIME_MS,
    enabled: !readOnly,
    throwOnError: false,
  });

  const updateCache = (change: (rules: readonly WorkflowRuleDto[]) => WorkflowRuleDto[]) => {
    queryClient.setQueryData<WorkflowVersionDetailDto>(versionKey, (current) =>
      current ? { ...current, rules: change(current.rules) } : current,
    );
  };
  const putRule = (rule: WorkflowRuleDto) => {
    updateCache((rules) =>
      rules.some((item) => item.id === rule.id)
        ? rules.map((item) => (item.id === rule.id ? rule : item))
        : [...rules, rule],
    );
  };

  const rules = target ? rulesOf(version.rules, target) : [];

  const remove = useMutation({
    mutationFn: (rule: WorkflowRuleDto) => deleteRule(rule),
    onSuccess: (_result, rule) => {
      updateCache((current) => current.filter((item) => item.id !== rule.id));
      setProblem(null);
      setAnnouncement(t('list.deleted'));
    },
    onError: (error) => {
      const outcome = outcomeOf(error);
      setProblem(outcome.kind === 'screen' ? outcome.problem : { kind: 'generic', message: null });
    },
  });

  /** FA-01: um PATCH de `displayOrder` por regra que mudou de posição, cada um com o seu If-Match. */
  const move = async (from: number, to: number) => {
    if (readOnly || moving) return;
    const patches = ruleReorderPatches(rules, from, to);
    if (patches.length === 0) return;
    setMoving(true);
    setProblem(null);
    try {
      for (const { rule, displayOrder } of patches) {
        putRule((await updateRule(rule, { displayOrder })).data);
      }
      const moved = rules[from];
      if (moved) setAnnouncement(t('list.moved', { name: moved.name, position: to + 1 }));
    } catch (error) {
      const outcome = outcomeOf(error);
      setProblem(outcome.kind === 'screen' ? outcome.problem : { kind: 'generic', message: null });
    } finally {
      setMoving(false);
    }
  };

  const stageTargets = targets.filter((item) => item.scope === 'STAGE_EXIT');
  const transitionTargets = targets.filter((item) => item.scope === 'TRANSITION');
  const targetButton = (item: RuleTarget) => {
    const current = target !== null && targetKeyOf(item) === targetKeyOf(target);
    return (
      <li key={targetKeyOf(item)}>
        <button
          type="button"
          aria-current={current ? 'true' : undefined}
          className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-control px-3 py-2 text-left text-sm md:min-h-9 ${
            current
              ? 'bg-primary-soft font-semibold text-primary-soft-foreground'
              : 'hover:bg-muted'
          }`}
          onClick={() => {
            setSelectedKey(targetKeyOf(item));
            setEditing(null);
          }}
        >
          <span>{item.name}</span>
          <span className="text-xs text-muted-foreground">
            {t('targets.count', { count: ruleCountOf(version.rules, item) })}
          </span>
        </button>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {version.status !== 'DRAFT' ? <Alert tone="info" title={t('readOnly')} /> : null}
      <div aria-live="assertive" className="empty:hidden">
        {problem ? (
          <RulesProblem problem={problem} workflowId={workflow.id} onReload={onReload} />
        ) : null}
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {targets.length === 0 ? (
        <EmptyState icon={<Workflow />} title={t('targets.none')} />
      ) : (
        <div className="flex flex-col gap-4 md:flex-row md:items-start">
          <nav
            aria-label={t('targets.label')}
            className="flex flex-col gap-3 rounded-card bg-surface p-3 shadow-card md:w-72 md:flex-none"
          >
            <div>
              <h2 className="px-3 py-1 text-label text-muted-foreground uppercase">
                {t('targets.stages')}
              </h2>
              <ul className="flex flex-col">{stageTargets.map(targetButton)}</ul>
            </div>
            {transitionTargets.length > 0 ? (
              <div>
                <h2 className="px-3 py-1 text-label text-muted-foreground uppercase">
                  {t('targets.transitions')}
                </h2>
                <ul className="flex flex-col">{transitionTargets.map(targetButton)}</ul>
              </div>
            ) : null}
          </nav>
          {target ? (
            <section aria-labelledby={`${ids}-list`} className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id={`${ids}-list`} className="text-lg font-bold text-brand-ink">
                  {t('list.title', { name: target.name })}
                </h2>
                {readOnly ? null : (
                  <Button
                    iconLeft={<Plus />}
                    onClick={() => {
                      setEditing('new');
                    }}
                  >
                    {t('list.add')}
                  </Button>
                )}
              </div>
              {rules.length === 0 ? (
                <EmptyState
                  icon={<Workflow />}
                  title={
                    target.scope === 'STAGE_EXIT' ? t('list.empty') : t('list.emptyTransition')
                  }
                />
              ) : (
                <RuleList
                  rules={rules}
                  readOnly={readOnly}
                  busy={moving || remove.isPending}
                  onEdit={setEditing}
                  onDelete={(rule) => {
                    remove.mutate(rule);
                  }}
                  onMove={(from, to) => void move(from, to)}
                />
              )}
            </section>
          ) : null}
        </div>
      )}
      <Sheet
        open={editing !== null && !readOnly}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <SheetContent closeLabel={t('form.close')}>
          {editing && !readOnly && target ? (
            <RuleForm
              key={editing === 'new' ? `new:${targetKeyOf(target)}` : editing.id}
              versionId={version.id}
              target={target}
              rule={editing === 'new' ? null : editing}
              rules={rules}
              stages={version.stages}
              schema={schema.data ?? null}
              schemaFailed={schema.isError}
              onRetrySchema={() => void schema.refetch()}
              documentTypes={(documentTypes.data ?? []).filter((type) => type.isActive)}
              onSaved={(rule, created) => {
                putRule(rule);
                setProblem(null);
                setEditing(null);
                setAnnouncement(
                  created
                    ? t('list.created', { name: rule.name })
                    : t('list.saved', { name: rule.name }),
                );
              }}
              onProblem={(next) => {
                setEditing(null);
                setProblem(next);
              }}
              onCancel={() => {
                setEditing(null);
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function RulesProblem({
  problem,
  workflowId,
  onReload,
}: {
  readonly problem: EditorProblem;
  readonly workflowId: string;
  readonly onReload: () => void;
}) {
  const t = useTranslations('workflows.rules.problems');
  switch (problem.kind) {
    case 'conflict':
      return (
        <Alert tone="error" title={t('conflict')}>
          <Button variant="secondary" size="sm" onClick={onReload}>
            {t('reload')}
          </Button>
        </Alert>
      );
    case 'notDraft':
      // FA-05: a versão foi publicada por outra pessoa — o rascunho novo nasce no editor (US-045).
      return (
        <Alert tone="error" title={t('notDraft')}>
          <Link href={workflowEditorHref(workflowId)} className="text-sm underline">
            {t('createDraft')}
          </Link>
        </Alert>
      );
    case 'forbidden':
      return <Alert tone="error" title={t('forbidden')} />;
    case 'mfa':
      return <Alert tone="error" title={t('mfa')} />;
    case 'unavailable':
      return <Alert tone="error" title={t('unavailable')} />;
    default:
      return <Alert tone="error" title={problem.message ?? t('generic')} />;
  }
}

/**
 * `RuleList` (tabela do kit): arrastar ou setas ↑/↓ no ícone de reordenar (alternativa ao
 * arrastar); "Editar" e "Excluir" no menu ⋯ da linha. Só o `TableContainer` rola.
 */
function RuleList({
  rules,
  readOnly,
  busy,
  onEdit,
  onDelete,
  onMove,
}: {
  readonly rules: readonly WorkflowRuleDto[];
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly onEdit: (rule: WorkflowRuleDto) => void;
  readonly onDelete: (rule: WorkflowRuleDto) => void;
  readonly onMove: (from: number, to: number) => void;
}) {
  const t = useTranslations('workflows.rules');
  const ids = useId();
  const dragFrom = useRef<number | null>(null);
  const onHandleKey = (event: KeyboardEvent, index: number) => {
    if (event.key === 'ArrowUp' && index > 0) {
      event.preventDefault();
      onMove(index, index - 1);
    } else if (event.key === 'ArrowDown' && index < rules.length - 1) {
      event.preventDefault();
      onMove(index, index + 1);
    }
  };
  return (
    <TableContainer
      label={t('list.caption')}
      footer={
        <TableFooter
          summary={
            <span id={`${ids}-hint`}>
              {t('list.count', { count: rules.length })}
              {readOnly ? null : <> · {t('list.reorderHint')}</>}
            </span>
          }
        />
      }
    >
      <Table aria-describedby={`${ids}-hint`}>
        <caption className="sr-only">{t('list.caption')}</caption>
        <TableHead>
          <Tr>
            <Th>{t('list.columns.order')}</Th>
            <Th>{t('list.columns.rule')}</Th>
            <Th>{t('list.columns.type')}</Th>
            <Th>{t('list.columns.severity')}</Th>
            {readOnly ? null : (
              <Th className="w-12">
                <span className="sr-only">{t('list.columns.actions')}</span>
              </Th>
            )}
          </Tr>
        </TableHead>
        <TableBody>
          {rules.map((rule, index) => (
            <Tr
              key={rule.id}
              draggable={!readOnly && !busy}
              className="align-top"
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
              <Td className="whitespace-nowrap">
                <div className="flex items-center gap-1">
                  {readOnly ? null : (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={t('list.reorder', { name: rule.name, position: index + 1 })}
                      className="grid size-9 cursor-grab place-items-center rounded-control text-muted-foreground hover:bg-muted"
                      onKeyDown={(event) => {
                        onHandleKey(event, index);
                      }}
                    >
                      <span aria-hidden="true">⠿</span>
                    </button>
                  )}
                  <span>{index + 1}</span>
                </div>
              </Td>
              <Td className="min-w-64">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-bold text-foreground">{rule.name}</span>
                  <span className="font-mono text-xs break-all text-muted-foreground">
                    {ruleSummaryOf(rule)}
                  </span>
                  <span className="text-muted-foreground">{rule.message}</span>
                </div>
              </Td>
              <Td>
                <StatusChip>{t(`types.${rule.type}`)}</StatusChip>
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1.5">
                  <StatusChip tone={rule.severity === 'BLOCKING' ? 'danger' : 'warning'}>
                    {t(`severities.${rule.severity}`)}
                  </StatusChip>
                  {rule.isActive ? null : <StatusChip>{t('list.inactive')}</StatusChip>}
                </div>
              </Td>
              {readOnly ? null : (
                <Td className="w-12 py-1.5 text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={t('list.rowMenu', { name: rule.name })}
                        className="inline-grid size-11 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
                      >
                        <Ellipsis aria-hidden="true" className="size-[1.125rem]" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() => {
                          onEdit(rule);
                        }}
                      >
                        {t('list.edit')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={busy}
                        onSelect={() => {
                          onDelete(rule);
                        }}
                      >
                        {t('list.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </Td>
              )}
            </Tr>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

/**
 * Formulário da regra (passos 3–5, 7–8) no painel lateral (`Sheet`): tipo, configuração por tipo
 * (`RequiredDocumentFields`, `RequiredFieldPicker`, `RequiredApprovalFields`, `ConditionBuilder`),
 * severidade, nome, mensagem e "Ativa"; envia WF-16 (nova) ou WF-17 (só o que mudou). O
 * `RuleTestPanel` fica no corpo, fora do `<form>`. Sem o schema do RuleContext (WF-19), o "Salvar"
 * fica desabilitado com o aviso e "Tentar novamente" (Falha de integração).
 */
function RuleForm({
  versionId,
  target,
  rule,
  rules,
  stages,
  schema,
  schemaFailed,
  onRetrySchema,
  documentTypes,
  onSaved,
  onProblem,
  onCancel,
}: {
  readonly versionId: string;
  readonly target: RuleTarget;
  readonly rule: WorkflowRuleDto | null;
  readonly rules: readonly WorkflowRuleDto[];
  readonly stages: readonly WorkflowStageDto[];
  readonly schema: RuleContextSchemaDto | null;
  readonly schemaFailed: boolean;
  readonly onRetrySchema: () => void;
  readonly documentTypes: readonly DocumentTypeDto[];
  readonly onSaved: (rule: WorkflowRuleDto, created: boolean) => void;
  readonly onProblem: (problem: EditorProblem) => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('workflows.rules');
  const ids = useId();
  const [draft, setDraft] = useState<RuleDraft>(() => (rule ? ruleDraftOf(rule) : EMPTY_RULE));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const types = fieldTypesOf(schema);
  const approvalStages = approvalStagesOf(stages);

  const requiredKey = (field: string) =>
    (field.startsWith('config.') ? field.slice(7) : field) as
      'name' | 'message' | 'documentTypeCode' | 'field' | 'stageKey';
  const messageOf = (problem: RuleFieldProblem) => {
    if (problem.field.startsWith('condition.')) {
      return t('validation.condition', { position: Number(problem.field.slice(10)) + 1 });
    }
    if (problem.field === 'config.expression') {
      return problem.code === 'REQUIRED' ? t('condition.empty') : t('validation.json');
    }
    if (problem.field === 'config.minCount') return t('validation.minCount');
    switch (problem.code) {
      case 'REQUIRED':
        return t(`validation.requiredFields.${requiredKey(problem.field)}`);
      case 'NAME_LENGTH':
        return t('validation.nameLength');
      case 'MESSAGE_LENGTH':
        return t('validation.messageLength');
      default:
        return t('validation.invalid');
    }
  };

  const save = useMutation({
    mutationFn: async (config: Record<string, unknown>) => {
      if (!rule) {
        const order = rules.reduce((max, item) => Math.max(max, item.displayOrder + 1), 0);
        return {
          rule: (await createRule(versionId, ruleCreateBody(draft, target, order, config))).data,
          created: true,
        };
      }
      const patch = rulePatch(rule, draft, config);
      if (Object.keys(patch).length === 0) return { rule, created: false };
      return { rule: (await updateRule(rule, patch)).data, created: false };
    },
    onSuccess: (result) => {
      onSaved(result.rule, result.created);
    },
    onError: (error) => {
      const outcome = outcomeOf(error);
      if (outcome.kind === 'fields') {
        setErrors(Object.fromEntries(outcome.errors.map((item) => [item.field, item.message])));
      } else if (outcome.kind === 'rule') {
        setFormError(outcome.message);
      } else if (outcome.kind === 'screen') {
        onProblem(outcome.problem);
      } else {
        setFormError(t('problems.generic'));
      }
    },
  });

  const change = (patch: Partial<RuleDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const onSubmit = () => {
    setFormError(null);
    const problems = ruleDraftProblems(draft, types);
    const found = Object.fromEntries(
      problems.map((problem) => [problem.field, messageOf(problem)]),
    );
    setErrors(found);
    const config = ruleConfigOf(draft, types);
    if (problems.length > 0 || !config.ok) return;
    save.mutate(config.config);
  };

  const schemaReady = schema !== null;
  const formId = `${ids}-form`;
  const activeId = `${ids}-active`;

  return (
    <>
      <SheetHeader>
        <SheetTitle>
          {rule ? t('form.editTitle', { name: rule.name }) : t('form.newTitle')}
        </SheetTitle>
        <SheetDescription>{t('form.hint')}</SheetDescription>
      </SheetHeader>

      <SheetBody>
        {schemaFailed ? (
          <Alert tone="error" title={t('schema.failed')}>
            <Button type="button" variant="secondary" size="sm" onClick={onRetrySchema}>
              {t('schema.retry')}
            </Button>
          </Alert>
        ) : !schemaReady ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('schema.loading')}
          </p>
        ) : null}
        <form
          id={formId}
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <Field label={t('form.type')} error={errors.type}>
            <Select
              value={draft.type}
              onValueChange={(value) => {
                change({ type: value as RuleDraft['type'] });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RULE_TYPE_OPTIONS.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(`types.${type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {draft.type === 'REQUIRED_DOCUMENT' ? (
            <>
              <Field label={t('form.documentTypeCode')} error={errors['config.documentTypeCode']}>
                <Select
                  value={draft.documentTypeCode === '' ? NONE : draft.documentTypeCode}
                  onValueChange={(value) => {
                    change({ documentTypeCode: value === NONE ? '' : value });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('form.select')}</SelectItem>
                    {documentTypes.some((type) => type.code === draft.documentTypeCode) ||
                    draft.documentTypeCode === '' ? null : (
                      <SelectItem value={draft.documentTypeCode}>
                        {draft.documentTypeCode}
                      </SelectItem>
                    )}
                    {documentTypes.map((type) => (
                      <SelectItem key={type.code} value={type.code}>
                        {type.code} — {type.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('form.minStatus')} error={errors['config.minStatus']}>
                  <Select
                    value={draft.minStatus}
                    onValueChange={(value) => {
                      change({ minStatus: value as RuleDraft['minStatus'] });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MIN_STATUS_OPTIONS.map((status) => (
                        <SelectItem key={status} value={status}>
                          {t(`minStatuses.${status}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field
                  label={t('form.minCount')}
                  error={errors['config.minCount']}
                  labelAddon={
                    <InfoTooltip label={t('form.minCountHelpLabel')}>
                      {t('form.minCountHint')}
                    </InfoTooltip>
                  }
                >
                  <Input
                    type="number"
                    min={1}
                    value={draft.minCount}
                    onChange={(event) => {
                      change({ minCount: event.target.value });
                    }}
                  />
                </Field>
              </div>
            </>
          ) : null}
          {draft.type === 'REQUIRED_FIELD' ? (
            <Field
              label={t('form.field')}
              error={errors['config.field']}
              labelAddon={
                <InfoTooltip label={t('form.fieldHelpLabel')}>{t('form.fieldHint')}</InfoTooltip>
              }
            >
              <Input
                className="font-mono"
                list={`${ids}-fields`}
                value={draft.field}
                onChange={(event) => {
                  change({ field: event.target.value });
                }}
              />
              <datalist id={`${ids}-fields`}>
                {(schema?.fields ?? []).map((item) => (
                  <option key={item.path} value={item.path}>
                    {item.label}
                  </option>
                ))}
              </datalist>
            </Field>
          ) : null}
          {draft.type === 'REQUIRED_APPROVAL' ? (
            <Field
              label={t('form.stageKey')}
              error={errors['config.stageKey']}
              description={approvalStages.length === 0 ? t('form.noApprovalStages') : undefined}
            >
              <Select
                value={draft.stageKey === '' ? NONE : draft.stageKey}
                onValueChange={(value) => {
                  change({ stageKey: value === NONE ? '' : value });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('form.select')}</SelectItem>
                  {approvalStages.map((stage) => (
                    <SelectItem key={stage.id} value={stage.key}>
                      {stage.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {draft.type === 'CONDITION' && schema ? (
            <ConditionBuilder
              draft={draft}
              schema={schema}
              errors={errors}
              disabled={false}
              onChange={change}
            />
          ) : null}
          <Field label={t('form.name')} error={errors.name}>
            <Input
              value={draft.name}
              maxLength={RULE_NAME_MAX}
              onChange={(event) => {
                change({ name: event.target.value });
              }}
            />
          </Field>
          <Field label={t('form.severity')} error={errors.severity}>
            <Select
              value={draft.severity}
              onValueChange={(value) => {
                change({ severity: value as RuleDraft['severity'] });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BLOCKING">{t('severities.BLOCKING')}</SelectItem>
                <SelectItem value="WARNING">{t('severities.WARNING')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field
            label={t('form.message')}
            error={errors.message}
            description={t('form.messageHint')}
          >
            <Input
              value={draft.message}
              maxLength={RULE_MESSAGE_MAX}
              onChange={(event) => {
                change({ message: event.target.value });
              }}
            />
          </Field>
          <Field label={t('form.description')} error={errors.description}>
            <Textarea
              rows={3}
              value={draft.description}
              onChange={(event) => {
                change({ description: event.target.value });
              }}
            />
          </Field>
          <div className="flex items-center gap-3">
            <Switch
              id={activeId}
              checked={draft.isActive}
              onCheckedChange={(checked) => {
                change({ isActive: checked });
              }}
            />
            <Label htmlFor={activeId}>{t('form.isActive')}</Label>
            <InfoTooltip label={t('form.isActiveHelpLabel')}>{t('form.isActiveHint')}</InfoTooltip>
          </div>
          <div aria-live="assertive" className="empty:hidden">
            {formError ? <Alert tone="error" title={formError} /> : null}
          </div>
        </form>
        <RuleTestPanel
          versionId={versionId}
          buildRequest={() => {
            const config = ruleConfigOf(draft, types);
            if (!config.ok) return null;
            return {
              type: draft.type,
              config: config.config,
              severity: draft.severity,
              ...(draft.message.trim() === '' ? {} : { message: draft.message.trim() }),
            };
          }}
        />
      </SheetBody>

      <SheetFooter>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('form.cancel')}
        </Button>
        <Button
          type="submit"
          form={formId}
          disabled={!schemaReady || save.isPending}
          aria-busy={save.isPending}
        >
          {rule ? t('form.save') : t('form.create')}
        </Button>
      </SheetFooter>
    </>
  );
}
