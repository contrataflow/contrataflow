'use client';

import { Alert, Button } from '@contrataflow/ui';
import {
  STAGE_ASSIGNMENT_POLICIES,
  STAGE_DEPARTMENT_RESOLUTIONS,
  STAGE_TYPES,
} from '@contrataflow/validation';
import type { WorkflowStageDto } from '@contrataflow/validation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { useTenantId } from '@/lib/session/session-context';

import { outcomeOf } from './workflow-editor-errors';
import type { EditorProblem } from './workflow-editor-errors';
import {
  EMPTY_STAGE,
  keyFromName,
  sortStages,
  STAGE_COLORS,
  stageCreateBody,
  stageDraftOf,
  stageDraftProblems,
  stagePatch,
  uniqueKey,
} from './workflow-editor-model';
import type { FieldProblem, StageDraft } from './workflow-editor-model';
import {
  createStage,
  deleteStage,
  fetchActiveDepartments,
  fetchApproverRoles,
  fetchApproverUsers,
  fetchWorkflowDocumentTypes,
  updateStage,
  workflowKeys,
  WORKFLOWS_STALE_TIME_MS,
} from './workflows.api';

const INPUT = 'h-10 w-full rounded-control border border-border bg-surface px-3 text-sm';
const APPROVER_TYPES = ['USER', 'ROLE', 'DEPARTMENT_HEAD'] as const;
const APPROVER_RESOLUTIONS = ['REQUESTING_DEPARTMENT', 'REQUESTING_SECRETARIAT', 'FIXED'] as const;
const DAY_COUNT_TYPES = ['BUSINESS', 'CALENDAR'] as const;

type SaveState = 'idle' | 'saving' | 'saved';

export interface StagePropertiesPanelProps {
  readonly versionId: string;
  /** `null` = etapa nova (WF-10). */
  readonly stage: WorkflowStageDto | null;
  readonly stages: readonly WorkflowStageDto[];
  readonly readOnly: boolean;
  readonly onSaved: (stage: WorkflowStageDto, created: boolean) => void;
  readonly onDeleted: (stageId: string) => void;
  readonly onProblem: (problem: EditorProblem) => void;
  readonly onClose: () => void;
}

/**
 * `StagePropertiesPanel` (SCR-034 · US-043 passos 3–5 e 9): propriedades da etapa selecionada. A
 * etapa existente salva campo a campo ao perder o foco ou ao trocar uma seleção (WF-11 com o
 * `If-Match` da etapa), só depois de passar pelos mesmos condicionais da API — "Selecione quem aprova
 * esta etapa." aparece sem chamar a API (V-03). A etapa nova entra ao final da ordem (WF-10).
 */
export function StagePropertiesPanel(props: StagePropertiesPanelProps) {
  const { stage, stages, versionId, readOnly, onSaved, onDeleted, onProblem, onClose } = props;
  const t = useTranslations('workflows.editor');
  const tenantId = useTenantId();
  const ids = useId();
  const [draft, setDraft] = useState<StageDraft>(() => (stage ? stageDraftOf(stage) : EMPTY_STAGE));
  const [keyTouched, setKeyTouched] = useState(stage !== null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [formError, setFormError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<readonly { id: string; name: string }[] | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const needsDepartments =
    draft.departmentResolution === 'FIXED' ||
    (draft.type === 'APPROVAL' &&
      draft.approverType === 'DEPARTMENT_HEAD' &&
      draft.approverDepartmentResolution === 'FIXED');
  const departments = useQuery({
    queryKey: workflowKeys.lookups(tenantId, 'departments'),
    queryFn: async ({ signal }) => (await fetchActiveDepartments(signal)).data,
    staleTime: WORKFLOWS_STALE_TIME_MS,
    enabled: needsDepartments,
    throwOnError: false,
    retry: false,
  });
  const roles = useQuery({
    queryKey: workflowKeys.lookups(tenantId, 'roles'),
    queryFn: async ({ signal }) => (await fetchApproverRoles(signal)).data,
    staleTime: WORKFLOWS_STALE_TIME_MS,
    enabled: draft.type === 'APPROVAL' && draft.approverType === 'ROLE',
    throwOnError: false,
    retry: false,
  });
  const users = useQuery({
    queryKey: workflowKeys.lookups(tenantId, 'users'),
    queryFn: async ({ signal }) => (await fetchApproverUsers(signal)).data,
    staleTime: WORKFLOWS_STALE_TIME_MS,
    enabled: draft.type === 'APPROVAL' && draft.approverType === 'USER',
    throwOnError: false,
    retry: false,
  });
  const documentTypes = useQuery({
    queryKey: workflowKeys.lookups(tenantId, 'documentTypes'),
    queryFn: async ({ signal }) => (await fetchWorkflowDocumentTypes(signal)).data,
    staleTime: WORKFLOWS_STALE_TIME_MS,
    throwOnError: false,
    retry: false,
  });
  const activeTypes = (documentTypes.data ?? []).filter((type) => type.isActive);

  const label = (field: string) => t(`fields.${field as keyof StageDraft}`);
  const messageOf = (problem: FieldProblem): string => {
    switch (problem.code) {
      case 'REQUIRED':
        return t('validation.required', { field: label(problem.field) });
      case 'KEY_PATTERN':
        return t('validation.keyPattern');
      case 'NAME_LENGTH':
        return t('validation.nameLength');
      case 'SLA_RANGE':
        return t('validation.slaRange');
      case 'TOO_LONG':
        return t('validation.tooLong');
      default:
        return problem.message ?? t('validation.invalid');
    }
  };
  const localErrors = (next: StageDraft) =>
    Object.fromEntries(
      stageDraftProblems(next).map((problem) => [problem.field, messageOf(problem)]),
    );

  const handleFailure = (error: unknown) => {
    setSaveState('idle');
    const outcome = outcomeOf(error);
    if (outcome.kind === 'fields') {
      setErrors(Object.fromEntries(outcome.errors.map((item) => [item.field, item.message])));
    } else if (outcome.kind === 'keyTaken') {
      setErrors({ key: t('validation.keyTaken') });
    } else if (outcome.kind === 'blocked') {
      setBlockers(outcome.items);
    } else if (outcome.kind === 'rule') {
      setFormError(outcome.message);
    } else {
      onProblem(outcome.problem);
    }
  };

  const update = useMutation({
    mutationFn: ({
      target,
      patch,
    }: {
      target: WorkflowStageDto;
      patch: ReturnType<typeof stagePatch>;
    }) => updateStage(target, patch),
    onSuccess: (result) => {
      setSaveState('saved');
      onSaved(result.data, false);
    },
    onError: handleFailure,
  });
  const create = useMutation({
    mutationFn: (next: StageDraft) =>
      createStage(
        versionId,
        stageCreateBody(
          next,
          stages.reduce((max, item) => Math.max(max, item.displayOrder + 1), 0),
        ),
      ),
    onSuccess: (result) => {
      setSaveState('saved');
      onSaved(result.data, true);
    },
    onError: handleFailure,
  });
  const remove = useMutation({
    mutationFn: (target: WorkflowStageDto) => deleteStage(target),
    onSuccess: (_result, target) => {
      onDeleted(target.id);
    },
    onError: (error) => {
      setConfirmingDelete(false);
      handleFailure(error);
    },
  });

  /** Passo 9: salva a etapa existente com o que mudou, se o rascunho estiver válido. */
  const commit = (next: StageDraft) => {
    if (!stage || readOnly) return;
    const found = localErrors(next);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;
    const patch = stagePatch(stage, next);
    if (Object.keys(patch).length === 0) return;
    setSaveState('saving');
    update.mutate({ target: stage, patch });
  };

  const change = (patch: Partial<StageDraft>, save: boolean) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    setSaveState('idle');
    if (save) commit(next);
  };

  const onNameChange = (name: string) => {
    if (stage || keyTouched) {
      change({ name }, false);
      return;
    }
    const used = new Set(stages.map((item) => item.key));
    change({ name, key: uniqueKey(keyFromName(name), used) }, false);
  };

  const submitNew = () => {
    const found = localErrors(draft);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;
    setSaveState('saving');
    create.mutate(draft);
  };

  const errorId = (field: string) => `${ids}-${field}-error`;
  const fieldProps = (field: string) => ({
    id: `${ids}-${field}`,
    'aria-invalid': errors[field] ? true : undefined,
    'aria-describedby': errors[field] ? errorId(field) : undefined,
  });
  const blurSave = () => {
    commit(draft);
  };

  const field = (name: string, control: ReactNode, hint?: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${ids}-${name}`} className="text-sm font-medium">
        {label(name)}
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

  const departmentSelect = (name: 'fixedDepartmentId' | 'approverFixedDepartmentId') =>
    field(
      name,
      <select
        {...fieldProps(name)}
        className={INPUT}
        value={draft[name]}
        onChange={(event) => {
          change({ [name]: event.target.value }, true);
        }}
      >
        <option value="">{t('values.select')}</option>
        {draft[name] !== '' && !departments.data?.some((item) => item.id === draft[name]) ? (
          <option value={draft[name]}>{t('values.currentSelection')}</option>
        ) : null}
        {(departments.data ?? []).map((item) => (
          <option key={item.id} value={item.id}>
            {item.path || item.name}
          </option>
        ))}
      </select>,
      departments.isError ? t('values.optionsUnavailable') : undefined,
    );

  const isApproval = draft.type === 'APPROVAL';
  const sorted = sortStages(stages);
  const position = stage ? sorted.findIndex((item) => item.id === stage.id) + 1 : sorted.length + 1;
  const knownColor = STAGE_COLORS.some(
    (color) => color.value.toUpperCase() === draft.color.toUpperCase(),
  );

  return (
    <section aria-labelledby={`${ids}-title`} className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h2 id={`${ids}-title`} className="text-lg font-semibold">
            {stage ? t('panel.title', { name: stage.name }) : t('panel.newTitle')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('panel.position', { position })}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t('panel.close')}
        </Button>
      </header>
      <p aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
        {saveState === 'saving' ? t('panel.saving') : saveState === 'saved' ? t('panel.saved') : ''}
      </p>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (stage) commit(draft);
          else submitNew();
        }}
      >
        <fieldset disabled={readOnly} className="flex flex-col gap-3">
          <legend className="sr-only">{t('panel.legend')}</legend>
          {field(
            'name',
            <input
              {...fieldProps('name')}
              className={INPUT}
              value={draft.name}
              maxLength={150}
              onChange={(event) => {
                onNameChange(event.target.value);
              }}
              onBlur={blurSave}
            />,
          )}
          {field(
            'key',
            <input
              {...fieldProps('key')}
              className={`${INPUT} font-mono`}
              value={draft.key}
              maxLength={60}
              readOnly={stage !== null}
              onChange={(event) => {
                setKeyTouched(true);
                change({ key: event.target.value.toUpperCase() }, false);
              }}
            />,
            stage ? t('hints.keyImmutable') : t('hints.key'),
          )}
          {field(
            'type',
            <select
              {...fieldProps('type')}
              className={INPUT}
              value={draft.type}
              onChange={(event) => {
                change({ type: event.target.value as StageDraft['type'] }, true);
              }}
            >
              {STAGE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`stageTypes.${type}`)}
                </option>
              ))}
            </select>,
          )}
          {field(
            'instructions',
            <textarea
              {...fieldProps('instructions')}
              className="min-h-20 w-full rounded-control border border-border bg-surface px-3 py-2 text-sm"
              value={draft.instructions}
              maxLength={5000}
              onChange={(event) => {
                change({ instructions: event.target.value }, false);
              }}
              onBlur={blurSave}
            />,
          )}
          {field(
            'departmentResolution',
            <select
              {...fieldProps('departmentResolution')}
              className={INPUT}
              value={draft.departmentResolution}
              onChange={(event) => {
                change(
                  {
                    departmentResolution: event.target.value as StageDraft['departmentResolution'],
                  },
                  event.target.value !== 'FIXED' || draft.fixedDepartmentId !== '',
                );
              }}
            >
              {STAGE_DEPARTMENT_RESOLUTIONS.map((resolution) => (
                <option key={resolution} value={resolution}>
                  {t(`departmentResolutions.${resolution}`)}
                </option>
              ))}
            </select>,
          )}
          {draft.departmentResolution === 'FIXED' ? departmentSelect('fixedDepartmentId') : null}
          {field(
            'assignmentPolicy',
            <select
              {...fieldProps('assignmentPolicy')}
              className={INPUT}
              value={draft.assignmentPolicy}
              onChange={(event) => {
                change(
                  { assignmentPolicy: event.target.value as StageDraft['assignmentPolicy'] },
                  true,
                );
              }}
            >
              {STAGE_ASSIGNMENT_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {t(`assignmentPolicies.${policy}`)}
                </option>
              ))}
            </select>,
          )}
          {isApproval ? (
            <>
              {field(
                'approverType',
                <select
                  {...fieldProps('approverType')}
                  className={INPUT}
                  value={draft.approverType}
                  onChange={(event) => {
                    change(
                      { approverType: event.target.value as StageDraft['approverType'] },
                      true,
                    );
                  }}
                >
                  <option value="">{t('values.select')}</option>
                  {APPROVER_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`approverTypes.${type}`)}
                    </option>
                  ))}
                </select>,
              )}
              {draft.approverType === 'USER'
                ? field(
                    'approverUserId',
                    <select
                      {...fieldProps('approverUserId')}
                      className={INPUT}
                      value={draft.approverUserId}
                      onChange={(event) => {
                        change({ approverUserId: event.target.value }, true);
                      }}
                    >
                      <option value="">{t('values.select')}</option>
                      {draft.approverUserId !== '' &&
                      !users.data?.some((item) => item.userId === draft.approverUserId) ? (
                        <option value={draft.approverUserId}>{t('values.currentSelection')}</option>
                      ) : null}
                      {(users.data ?? []).map((item) => (
                        <option key={item.userId} value={item.userId}>
                          {item.socialName ?? item.name}
                        </option>
                      ))}
                    </select>,
                    users.isError ? t('values.optionsUnavailable') : undefined,
                  )
                : null}
              {draft.approverType === 'ROLE'
                ? field(
                    'approverRoleId',
                    <select
                      {...fieldProps('approverRoleId')}
                      className={INPUT}
                      value={draft.approverRoleId}
                      onChange={(event) => {
                        change({ approverRoleId: event.target.value }, true);
                      }}
                    >
                      <option value="">{t('values.select')}</option>
                      {draft.approverRoleId !== '' &&
                      !roles.data?.some((item) => item.id === draft.approverRoleId) ? (
                        <option value={draft.approverRoleId}>{t('values.currentSelection')}</option>
                      ) : null}
                      {(roles.data ?? []).map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>,
                    roles.isError ? t('values.optionsUnavailable') : undefined,
                  )
                : null}
              {draft.approverType === 'DEPARTMENT_HEAD'
                ? field(
                    'approverDepartmentResolution',
                    <select
                      {...fieldProps('approverDepartmentResolution')}
                      className={INPUT}
                      value={draft.approverDepartmentResolution}
                      onChange={(event) => {
                        change(
                          {
                            approverDepartmentResolution: event.target
                              .value as StageDraft['approverDepartmentResolution'],
                          },
                          true,
                        );
                      }}
                    >
                      <option value="">{t('values.select')}</option>
                      {APPROVER_RESOLUTIONS.map((resolution) => (
                        <option key={resolution} value={resolution}>
                          {t(`departmentResolutions.${resolution}`)}
                        </option>
                      ))}
                    </select>,
                  )
                : null}
              {draft.approverType === 'DEPARTMENT_HEAD' &&
              draft.approverDepartmentResolution === 'FIXED'
                ? departmentSelect('approverFixedDepartmentId')
                : null}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.allowDeputy}
                  onChange={(event) => {
                    change({ allowDeputy: event.target.checked }, true);
                  }}
                />
                {label('allowDeputy')}
              </label>
              <CodeChecklist
                legend={label('approvalDocumentTypeCodes')}
                options={activeTypes}
                selected={draft.approvalDocumentTypeCodes}
                onChange={(codes) => {
                  change({ approvalDocumentTypeCodes: codes }, true);
                }}
              />
            </>
          ) : null}
          {draft.type === 'END' ? null : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {field(
                'slaDays',
                <input
                  {...fieldProps('slaDays')}
                  className={INPUT}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={365}
                  value={draft.slaDays}
                  onChange={(event) => {
                    change({ slaDays: event.target.value }, false);
                  }}
                  onBlur={blurSave}
                />,
              )}
              {field(
                'slaType',
                <select
                  {...fieldProps('slaType')}
                  className={INPUT}
                  value={draft.slaType}
                  onChange={(event) => {
                    change({ slaType: event.target.value as StageDraft['slaType'] }, true);
                  }}
                >
                  {DAY_COUNT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`dayCountTypes.${type}`)}
                    </option>
                  ))}
                </select>,
              )}
            </div>
          )}
          <CodeChecklist
            legend={label('documentTypeCodes')}
            hint={t('hints.documentTypeCodes')}
            options={activeTypes}
            selected={draft.documentTypeCodes}
            onChange={(codes) => {
              change({ documentTypeCodes: codes }, true);
            }}
          />
          {field(
            'color',
            <select
              {...fieldProps('color')}
              className={INPUT}
              value={draft.color}
              onChange={(event) => {
                change({ color: event.target.value }, true);
              }}
            >
              <option value="">{t('colors.none')}</option>
              {draft.color !== '' && !knownColor ? (
                <option value={draft.color}>{t('colors.custom', { value: draft.color })}</option>
              ) : null}
              {STAGE_COLORS.map((color) => (
                <option key={color.key} value={color.value}>
                  {t(`colors.${color.key}`)} ({color.value})
                </option>
              ))}
            </select>,
          )}
          <div aria-live="assertive">
            {formError ? <Alert tone="error" title={formError} /> : null}
            {blockers ? (
              <Alert tone="error" title={t('delete.blocked')}>
                <ul className="mt-1 list-disc pl-5">
                  {blockers.map((item) => (
                    <li key={item.id}>{item.name}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
          </div>
          {readOnly ? null : (
            <div className="flex flex-wrap gap-2">
              {stage ? (
                <Button type="submit" variant="secondary">
                  {t('panel.save')}
                </Button>
              ) : (
                <Button type="submit" disabled={create.isPending} aria-busy={create.isPending}>
                  {t('panel.create')}
                </Button>
              )}
              {stage && !confirmingDelete ? (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    setBlockers(null);
                    setConfirmingDelete(true);
                  }}
                >
                  {t('delete.action')}
                </Button>
              ) : null}
            </div>
          )}
        </fieldset>
      </form>
      {stage && confirmingDelete ? (
        <div
          role="group"
          aria-label={t('delete.confirmTitle', { name: stage.name })}
          className="flex flex-col gap-2 rounded-card border border-border p-3"
        >
          <p className="text-sm">{t('delete.confirm', { name: stage.name })}</p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setConfirmingDelete(false);
              }}
            >
              {t('delete.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                remove.mutate(stage);
              }}
            >
              {t('delete.confirmAction')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Tipos de documento (códigos) como caixas de seleção; só os ativos do órgão. */
function CodeChecklist({
  legend,
  hint,
  options,
  selected,
  onChange,
}: {
  readonly legend: string;
  readonly hint?: string;
  readonly options: readonly { code: string; name: string }[];
  readonly selected: readonly string[];
  readonly onChange: (codes: string[]) => void;
}) {
  const t = useTranslations('workflows.editor');
  const missing = selected.filter((code) => !options.some((option) => option.code === code));
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm font-medium">{legend}</legend>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {options.length === 0 && missing.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('values.noDocumentTypes')}</p>
      ) : null}
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {[
          ...options.map((option) => ({ code: option.code, name: option.name })),
          ...missing.map((code) => ({ code, name: code })),
        ].map((option) => (
          <label key={option.code} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(option.code)}
              onChange={(event) => {
                onChange(
                  event.target.checked
                    ? [...selected, option.code]
                    : selected.filter((code) => code !== option.code),
                );
              }}
            />
            <span>
              <span className="font-mono">{option.code}</span> — {option.name}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
