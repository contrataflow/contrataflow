'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
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
import type { KeyboardEvent, ReactNode } from 'react';

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

const INPUT = 'h-10 w-full rounded-control border border-border bg-surface px-3 text-sm';

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
    <div className="flex flex-col gap-6">
      <Link
        href={workflowEditorHref(workflowId)}
        className="text-sm text-muted-foreground underline"
      >
        {t('back')}
      </Link>
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
          <header className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {t('title', { name: workflow.data.name })}
            </h1>
            <p className="max-w-3xl text-muted-foreground">{t('description')}</p>
          </header>
          {versionId === null ? (
            <p className="rounded-card border border-dashed border-border p-6 text-muted-foreground">
              {t('noVersion')}
            </p>
          ) : null}
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
          className={`flex w-full items-center justify-between gap-2 rounded-control px-3 py-2 text-left text-sm ${
            current ? 'bg-muted font-medium' : 'hover:bg-muted'
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
      <div aria-live="assertive">
        {problem ? (
          <RulesProblem problem={problem} workflowId={workflow.id} onReload={onReload} />
        ) : null}
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {targets.length === 0 ? (
        <p className="rounded-card border border-dashed border-border p-6 text-muted-foreground">
          {t('targets.none')}
        </p>
      ) : (
        <div className="flex flex-col gap-4 md:flex-row md:items-start">
          <nav aria-label={t('targets.label')} className="flex flex-col gap-3 md:w-72">
            <div>
              <h2 className="px-3 text-xs font-semibold text-muted-foreground uppercase">
                {t('targets.stages')}
              </h2>
              <ul className="flex flex-col">{stageTargets.map(targetButton)}</ul>
            </div>
            {transitionTargets.length > 0 ? (
              <div>
                <h2 className="px-3 text-xs font-semibold text-muted-foreground uppercase">
                  {t('targets.transitions')}
                </h2>
                <ul className="flex flex-col">{transitionTargets.map(targetButton)}</ul>
              </div>
            ) : null}
          </nav>
          {target ? (
            <section aria-labelledby={`${ids}-list`} className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id={`${ids}-list`} className="text-lg font-medium">
                  {t('list.title', { name: target.name })}
                </h2>
                {readOnly ? null : (
                  <Button
                    onClick={() => {
                      setEditing('new');
                    }}
                  >
                    {t('list.add')}
                  </Button>
                )}
              </div>
              {rules.length === 0 ? (
                <p className="rounded-card border border-dashed border-border p-6 text-muted-foreground">
                  {target.scope === 'STAGE_EXIT' ? t('list.empty') : t('list.emptyTransition')}
                </p>
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
              {editing && !readOnly ? (
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
            </section>
          ) : null}
        </div>
      )}
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

/** `RuleList`: arrastar ou setas ↑/↓ no ícone de reordenar (alternativa ao arrastar). */
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
    <div className="flex flex-col gap-1 overflow-x-auto">
      <table
        className="w-full text-left text-sm"
        aria-describedby={readOnly ? undefined : `${ids}-hint`}
      >
        <caption className="sr-only">{t('list.caption')}</caption>
        <thead className="text-muted-foreground">
          <tr>
            <th scope="col" className="px-2 py-2">
              {t('list.columns.order')}
            </th>
            <th scope="col" className="px-2 py-2">
              {t('list.columns.rule')}
            </th>
            {readOnly ? null : (
              <th scope="col" className="px-2 py-2">
                {t('list.columns.actions')}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rules.map((rule, index) => (
            <tr
              key={rule.id}
              draggable={!readOnly && !busy}
              className="border-t border-border align-top"
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
                      aria-label={t('list.reorder', { name: rule.name, position: index + 1 })}
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
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{rule.name}</span>
                    <span className="rounded-control bg-muted px-2 py-0.5 text-xs">
                      {t(`types.${rule.type}`)}
                    </span>
                    <span
                      className={`rounded-control px-2 py-0.5 text-xs ${
                        rule.severity === 'BLOCKING' ? 'bg-destructive-soft' : 'bg-warning-soft'
                      }`}
                    >
                      {t(`severities.${rule.severity}`)}
                    </span>
                    {rule.isActive ? null : (
                      <span className="rounded-control bg-muted px-2 py-0.5 text-xs">
                        {t('list.inactive')}
                      </span>
                    )}
                  </div>
                  <p className="font-mono text-xs break-all text-muted-foreground">
                    {ruleSummaryOf(rule)}
                  </p>
                  <p className="text-muted-foreground">{rule.message}</p>
                </div>
              </td>
              {readOnly ? null : (
                <td className="px-2 py-2">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={t('list.editFor', { name: rule.name })}
                      onClick={() => {
                        onEdit(rule);
                      }}
                    >
                      {t('list.edit')}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      aria-label={t('list.deleteFor', { name: rule.name })}
                      onClick={() => {
                        onDelete(rule);
                      }}
                    >
                      {t('list.delete')}
                    </Button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {readOnly ? null : (
        <p id={`${ids}-hint`} className="text-xs text-muted-foreground">
          {t('list.reorderHint')}
        </p>
      )}
    </div>
  );
}

/**
 * Formulário da regra (passos 3–5, 7–8): tipo, configuração por tipo (`RequiredDocumentFields`,
 * `RequiredFieldPicker`, `RequiredApprovalFields`, `ConditionBuilder`), severidade, nome, mensagem e
 * "Ativa"; envia WF-16 (nova) ou WF-17 (só o que mudou). Sem o schema do RuleContext (WF-19), o
 * "Salvar" fica desabilitado com o aviso e "Tentar novamente" (Falha de integração).
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

  const errorId = (field: string) => `${ids}-${field.replace('.', '-')}-error`;
  const props = (field: string) => ({
    id: `${ids}-${field.replace('.', '-')}`,
    'aria-invalid': errors[field] ? true : undefined,
    'aria-describedby': errors[field] ? errorId(field) : undefined,
  });
  const field = (name: string, label: string, control: ReactNode, hint?: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${ids}-${name.replace('.', '-')}`} className="text-sm font-medium">
        {label}
      </label>
      {control}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {errors[name] ? (
        <p id={errorId(name)} className="text-sm text-destructive">
          {errors[name]}
        </p>
      ) : null}
    </div>
  );

  const schemaReady = schema !== null;

  return (
    <section
      aria-labelledby={`${ids}-title`}
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card"
    >
      <h3 id={`${ids}-title`} className="text-lg font-medium">
        {rule ? t('form.editTitle', { name: rule.name }) : t('form.newTitle')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('form.hint')}</p>
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
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {field(
          'type',
          t('form.type'),
          <select
            {...props('type')}
            className={INPUT}
            value={draft.type}
            onChange={(event) => {
              change({ type: event.target.value as RuleDraft['type'] });
            }}
          >
            {RULE_TYPE_OPTIONS.map((type) => (
              <option key={type} value={type}>
                {t(`types.${type}`)}
              </option>
            ))}
          </select>,
        )}
        {draft.type === 'REQUIRED_DOCUMENT' ? (
          <div className="grid gap-3 md:grid-cols-3">
            {field(
              'config.documentTypeCode',
              t('form.documentTypeCode'),
              <select
                {...props('config.documentTypeCode')}
                className={INPUT}
                value={draft.documentTypeCode}
                onChange={(event) => {
                  change({ documentTypeCode: event.target.value });
                }}
              >
                <option value="">{t('form.select')}</option>
                {documentTypes.some((type) => type.code === draft.documentTypeCode) ||
                draft.documentTypeCode === '' ? null : (
                  <option value={draft.documentTypeCode}>{draft.documentTypeCode}</option>
                )}
                {documentTypes.map((type) => (
                  <option key={type.code} value={type.code}>
                    {type.code} — {type.name}
                  </option>
                ))}
              </select>,
            )}
            {field(
              'config.minStatus',
              t('form.minStatus'),
              <select
                {...props('config.minStatus')}
                className={INPUT}
                value={draft.minStatus}
                onChange={(event) => {
                  change({ minStatus: event.target.value as RuleDraft['minStatus'] });
                }}
              >
                {MIN_STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {t(`minStatuses.${status}`)}
                  </option>
                ))}
              </select>,
            )}
            {field(
              'config.minCount',
              t('form.minCount'),
              <input
                {...props('config.minCount')}
                type="number"
                min={1}
                className={INPUT}
                value={draft.minCount}
                onChange={(event) => {
                  change({ minCount: event.target.value });
                }}
              />,
              t('form.minCountHint'),
            )}
          </div>
        ) : null}
        {draft.type === 'REQUIRED_FIELD'
          ? field(
              'config.field',
              t('form.field'),
              <>
                <input
                  {...props('config.field')}
                  className={`${INPUT} font-mono`}
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
              </>,
              t('form.fieldHint'),
            )
          : null}
        {draft.type === 'REQUIRED_APPROVAL'
          ? field(
              'config.stageKey',
              t('form.stageKey'),
              <select
                {...props('config.stageKey')}
                className={INPUT}
                value={draft.stageKey}
                onChange={(event) => {
                  change({ stageKey: event.target.value });
                }}
              >
                <option value="">{t('form.select')}</option>
                {approvalStages.map((stage) => (
                  <option key={stage.id} value={stage.key}>
                    {stage.name}
                  </option>
                ))}
              </select>,
              approvalStages.length === 0 ? t('form.noApprovalStages') : undefined,
            )
          : null}
        {draft.type === 'CONDITION' && schema ? (
          <ConditionBuilder
            draft={draft}
            schema={schema}
            errors={errors}
            disabled={false}
            onChange={change}
          />
        ) : null}
        <div className="grid gap-3 md:grid-cols-2">
          {field(
            'name',
            t('form.name'),
            <input
              {...props('name')}
              className={INPUT}
              value={draft.name}
              maxLength={RULE_NAME_MAX}
              onChange={(event) => {
                change({ name: event.target.value });
              }}
            />,
          )}
          {field(
            'severity',
            t('form.severity'),
            <select
              {...props('severity')}
              className={INPUT}
              value={draft.severity}
              onChange={(event) => {
                change({ severity: event.target.value as RuleDraft['severity'] });
              }}
            >
              <option value="BLOCKING">{t('severities.BLOCKING')}</option>
              <option value="WARNING">{t('severities.WARNING')}</option>
            </select>,
          )}
        </div>
        {field(
          'message',
          t('form.message'),
          <input
            {...props('message')}
            className={INPUT}
            value={draft.message}
            maxLength={RULE_MESSAGE_MAX}
            onChange={(event) => {
              change({ message: event.target.value });
            }}
          />,
          t('form.messageHint'),
        )}
        {field(
          'description',
          t('form.description'),
          <textarea
            {...props('description')}
            className="min-h-20 w-full rounded-control border border-border bg-surface p-3 text-sm"
            value={draft.description}
            onChange={(event) => {
              change({ description: event.target.value });
            }}
          />,
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.isActive}
            aria-describedby={`${ids}-active-hint`}
            onChange={(event) => {
              change({ isActive: event.target.checked });
            }}
          />
          {t('form.isActive')}
        </label>
        <p id={`${ids}-active-hint`} className="-mt-2 text-xs text-muted-foreground">
          {t('form.isActiveHint')}
        </p>
        <div aria-live="assertive">
          {formError ? <Alert tone="error" title={formError} /> : null}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('form.cancel')}
          </Button>
          <Button
            type="submit"
            disabled={!schemaReady || save.isPending}
            aria-busy={save.isPending}
          >
            {rule ? t('form.save') : t('form.create')}
          </Button>
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
    </section>
  );
}
