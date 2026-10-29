'use client';

import {
  Alert,
  Button,
  Checkbox,
  Combobox,
  Field,
  Input,
  InfoTooltip,
  Label,
  SheetBody,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Switch,
  Textarea,
} from '@contrataflow/ui';
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

import { OptionSelect } from './option-select';
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
  /**
   * `aside`: coluna lateral do editor (telas largas); `sheet`: dentro de um `SheetContent` (telas
   * estreitas), com cabeçalho, corpo e rodapé do kit.
   */
  readonly variant?: 'aside' | 'sheet';
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
  const variant = props.variant ?? 'aside';
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

  const blurSave = () => {
    commit(draft);
  };

  const help = (name: string, text: string) => (
    <InfoTooltip label={t('helpLabel', { field: label(name) })}>{text}</InfoTooltip>
  );
  const field = (
    name: string,
    control: ReactNode,
    options?: { help?: string | undefined; note?: string | undefined },
  ) => (
    <Field
      label={label(name)}
      id={`${ids}-${name}`}
      error={errors[name]}
      description={options?.note}
      labelAddon={options?.help ? help(name, options.help) : undefined}
    >
      {control}
    </Field>
  );

  const comboLabels = {
    placeholder: t('values.select'),
    search: t('values.search'),
    empty: t('values.noResults'),
  };
  /** Opções de uma lista de apoio; a seleção que saiu da lista continua escolhível. */
  const lookupOptions = (
    current: string,
    items: readonly { value: string; label: string }[] | undefined,
  ) => [
    ...(current !== '' && !items?.some((item) => item.value === current)
      ? [{ value: current, label: t('values.currentSelection') }]
      : []),
    ...(items ?? []),
  ];

  const departmentSelect = (name: 'fixedDepartmentId' | 'approverFixedDepartmentId') =>
    field(
      name,
      <Combobox
        options={lookupOptions(
          draft[name],
          departments.data?.map((item) => ({ value: item.id, label: item.path || item.name })),
        )}
        value={draft[name]}
        labels={comboLabels}
        clearable
        onValueChange={(value) => {
          change({ [name]: value ?? '' }, true);
        }}
      />,
      { note: departments.isError ? t('values.optionsUnavailable') : undefined },
    );

  const isApproval = draft.type === 'APPROVAL';
  const sorted = sortStages(stages);
  const position = stage ? sorted.findIndex((item) => item.id === stage.id) + 1 : sorted.length + 1;
  const knownColor = STAGE_COLORS.some(
    (color) => color.value.toUpperCase() === draft.color.toUpperCase(),
  );
  const title = stage ? t('panel.title', { name: stage.name }) : t('panel.newTitle');

  const status = (
    <p aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
      {saveState === 'saving' ? t('panel.saving') : saveState === 'saved' ? t('panel.saved') : ''}
    </p>
  );

  const fields = (
    <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
      <legend className="sr-only">{t('panel.legend')}</legend>
      {field(
        'name',
        <Input
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
        <Input
          className="font-mono"
          value={draft.key}
          maxLength={60}
          readOnly={stage !== null}
          onChange={(event) => {
            setKeyTouched(true);
            change({ key: event.target.value.toUpperCase() }, false);
          }}
        />,
        { help: stage ? t('hints.keyImmutable') : t('hints.key') },
      )}
      {field(
        'type',
        <OptionSelect
          value={draft.type}
          options={STAGE_TYPES.map((type) => ({ value: type, label: t(`stageTypes.${type}`) }))}
          onValueChange={(value) => {
            change({ type: value as StageDraft['type'] }, true);
          }}
        />,
      )}
      {field(
        'instructions',
        <Textarea
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
        <OptionSelect
          value={draft.departmentResolution}
          options={STAGE_DEPARTMENT_RESOLUTIONS.map((resolution) => ({
            value: resolution,
            label: t(`departmentResolutions.${resolution}`),
          }))}
          onValueChange={(value) => {
            change(
              { departmentResolution: value as StageDraft['departmentResolution'] },
              value !== 'FIXED' || draft.fixedDepartmentId !== '',
            );
          }}
        />,
      )}
      {draft.departmentResolution === 'FIXED' ? departmentSelect('fixedDepartmentId') : null}
      {field(
        'assignmentPolicy',
        <OptionSelect
          value={draft.assignmentPolicy}
          options={STAGE_ASSIGNMENT_POLICIES.map((policy) => ({
            value: policy,
            label: t(`assignmentPolicies.${policy}`),
          }))}
          onValueChange={(value) => {
            change({ assignmentPolicy: value as StageDraft['assignmentPolicy'] }, true);
          }}
        />,
      )}
      {isApproval ? (
        <>
          {field(
            'approverType',
            <OptionSelect
              value={draft.approverType}
              noneLabel={t('values.select')}
              options={APPROVER_TYPES.map((type) => ({
                value: type,
                label: t(`approverTypes.${type}`),
              }))}
              onValueChange={(value) => {
                change({ approverType: value as StageDraft['approverType'] }, true);
              }}
            />,
          )}
          {draft.approverType === 'USER'
            ? field(
                'approverUserId',
                <Combobox
                  options={lookupOptions(
                    draft.approverUserId,
                    users.data?.map((item) => ({
                      value: item.userId,
                      label: item.socialName ?? item.name,
                    })),
                  )}
                  value={draft.approverUserId}
                  labels={comboLabels}
                  clearable
                  onValueChange={(value) => {
                    change({ approverUserId: value ?? '' }, true);
                  }}
                />,
                { note: users.isError ? t('values.optionsUnavailable') : undefined },
              )
            : null}
          {draft.approverType === 'ROLE'
            ? field(
                'approverRoleId',
                <Combobox
                  options={lookupOptions(
                    draft.approverRoleId,
                    roles.data?.map((item) => ({ value: item.id, label: item.name })),
                  )}
                  value={draft.approverRoleId}
                  labels={comboLabels}
                  clearable
                  onValueChange={(value) => {
                    change({ approverRoleId: value ?? '' }, true);
                  }}
                />,
                { note: roles.isError ? t('values.optionsUnavailable') : undefined },
              )
            : null}
          {draft.approverType === 'DEPARTMENT_HEAD'
            ? field(
                'approverDepartmentResolution',
                <OptionSelect
                  value={draft.approverDepartmentResolution}
                  noneLabel={t('values.select')}
                  options={APPROVER_RESOLUTIONS.map((resolution) => ({
                    value: resolution,
                    label: t(`departmentResolutions.${resolution}`),
                  }))}
                  onValueChange={(value) => {
                    change(
                      {
                        approverDepartmentResolution:
                          value as StageDraft['approverDepartmentResolution'],
                      },
                      true,
                    );
                  }}
                />,
              )
            : null}
          {draft.approverType === 'DEPARTMENT_HEAD' &&
          draft.approverDepartmentResolution === 'FIXED'
            ? departmentSelect('approverFixedDepartmentId')
            : null}
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={`${ids}-allowDeputy`}>{label('allowDeputy')}</Label>
            <Switch
              id={`${ids}-allowDeputy`}
              checked={draft.allowDeputy}
              onCheckedChange={(checked) => {
                change({ allowDeputy: checked }, true);
              }}
            />
          </div>
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {field(
            'slaDays',
            <Input
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
            <OptionSelect
              value={draft.slaType}
              options={DAY_COUNT_TYPES.map((type) => ({
                value: type,
                label: t(`dayCountTypes.${type}`),
              }))}
              onValueChange={(value) => {
                change({ slaType: value as StageDraft['slaType'] }, true);
              }}
            />,
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
        <OptionSelect
          value={draft.color}
          noneLabel={t('colors.none')}
          options={[
            ...(draft.color !== '' && !knownColor
              ? [{ value: draft.color, label: t('colors.custom', { value: draft.color }) }]
              : []),
            ...STAGE_COLORS.map((color) => ({
              value: color.value,
              label: `${t(`colors.${color.key}`)} (${color.value})`,
            })),
          ]}
          onValueChange={(value) => {
            change({ color: value }, true);
          }}
        />,
      )}
      <div aria-live="assertive" className="flex flex-col gap-3 empty:hidden">
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
    </fieldset>
  );

  const confirmDelete =
    stage && confirmingDelete ? (
      <div
        role="group"
        aria-label={t('delete.confirmTitle', { name: stage.name })}
        className="flex flex-col gap-2 border-t border-border pt-4"
      >
        <p className="text-sm">{t('delete.confirm', { name: stage.name })}</p>
        <div className="flex flex-wrap gap-2">
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
    ) : null;

  const buttons = readOnly ? null : (
    <>
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
      {stage ? (
        <Button type="submit" variant="secondary">
          {t('panel.save')}
        </Button>
      ) : (
        <Button type="submit" disabled={create.isPending} aria-busy={create.isPending}>
          {t('panel.create')}
        </Button>
      )}
    </>
  );

  const onSubmit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (stage) commit(draft);
    else submitNew();
  };

  if (variant === 'sheet') {
    return (
      <form noValidate onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{t('panel.position', { position })}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          {status}
          {fields}
          {confirmDelete}
        </SheetBody>
        {buttons ? <SheetFooter>{buttons}</SheetFooter> : null}
      </form>
    );
  }

  return (
    <section aria-labelledby={`${ids}-title`} className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h2 id={`${ids}-title`} className="text-lg font-bold text-brand-ink">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{t('panel.position', { position })}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t('panel.close')}
        </Button>
      </header>
      {status}
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        {fields}
        {confirmDelete}
        {buttons ? <div className="flex flex-wrap gap-2">{buttons}</div> : null}
      </form>
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
  const ids = useId();
  const missing = selected.filter((code) => !options.some((option) => option.code === code));
  return (
    <Field
      group
      label={legend}
      labelAddon={
        hint ? <InfoTooltip label={t('helpLabel', { field: legend })}>{hint}</InfoTooltip> : null
      }
    >
      {options.length === 0 && missing.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('values.noDocumentTypes')}</p>
      ) : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {[
          ...options.map((option) => ({ code: option.code, name: option.name })),
          ...missing.map((code) => ({ code, name: code })),
        ].map((option) => (
          <div key={option.code} className="flex items-start gap-2">
            <Checkbox
              id={`${ids}-${option.code}`}
              checked={selected.includes(option.code)}
              onCheckedChange={(checked) => {
                onChange(
                  checked === true
                    ? [...selected, option.code]
                    : selected.filter((code) => code !== option.code),
                );
              }}
            />
            <Label htmlFor={`${ids}-${option.code}`} className="font-normal">
              <span className="font-mono">{option.code}</span> — {option.name}
            </Label>
          </div>
        ))}
      </div>
    </Field>
  );
}
