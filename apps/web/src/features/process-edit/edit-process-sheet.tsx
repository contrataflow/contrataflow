'use client';

import type { CatalogType } from '@contrataflow/types';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  SheetContent,
  Skeleton,
  cx,
  toast,
} from '@contrataflow/ui';
import {
  ESTIMATED_VALUE_SOURCE_LABELS,
  PRIORITIES,
  PROCESS_UPDATE_MESSAGES,
} from '@contrataflow/validation';
import type {
  CatalogItemDto,
  DepartmentDto,
  ProcessConflictCurrent,
  ProcessDto,
  UpdateProcessInput,
} from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { isApiError } from '@/lib/api/api-error';
import { scopesOf, useEffectivePermissions } from '@/lib/permissions/use-permission';
import { useShellSession } from '@/lib/session/session-context';

import {
  buildUpdatePatch,
  conflictCurrentOf,
  editValuesOf,
  estimatedValueLock,
  isProcessEditable,
  lockedFieldsOf,
  resolveConflict,
  typedTexts,
  validateEdit,
} from './edit-process-model';
import type { ConflictRow, LockReason } from './edit-process-model';
import { updateProcess } from './process-edit.api';
import { labelsFrom } from '../departments/department-tree-model';
import {
  ORGANIZATIONS_STALE_TIME_MS,
  fetchOrganizations,
  organizationKeys,
} from '../organizations/organizations.api';
import { FormField, INPUT_CLASS, SelectField, TEXTAREA_CLASS } from '../processes/form-field';
import type { SelectOption } from '../processes/form-field';
import { MoneyInput } from '../processes/money-input';
import { PcaFieldset } from '../processes/pca-fieldset';
import {
  completeValues,
  isFormField,
  sectorOptions,
  secretariatOptions,
  validationContext,
} from '../processes/process-form-model';
import type {
  FieldMessages,
  ProcessFormField,
  ProcessFormValues,
  ScopeContext,
} from '../processes/process-form-model';
import {
  WIZARD_CATALOG_STALE_TIME_MS,
  WIZARD_LOOKUP_STALE_TIME_MS,
  fetchActiveCatalog,
  fetchActiveDepartments,
  fetchProcess,
  processKeys,
  readNumberingByOrganization,
  readRequireInternalCode,
} from '../processes/processes.api';
import {
  SETTINGS_STALE_TIME_MS,
  fetchPublicSettings,
  settingsKeys,
} from '../settings/settings.api';

/** RN-PROC-69: campos que alimentam a aplicabilidade do workflow (o fluxo fixado não muda). */
const WORKFLOW_FIELDS = new Set([
  'contractingTypeId',
  'modalityId',
  'originId',
  'isPriceRegistration',
  'estimatedValue',
]);
const NO_DEPARTMENTS: readonly DepartmentDto[] = [];

const plain = (label: string) => label.replace(/\s*\*$/, '');

function lookupStatus(
  query: Pick<UseQueryResult, 'data' | 'isError'>,
): 'pending' | 'error' | 'ready' {
  if (query.data !== undefined) return 'ready';
  return query.isError ? 'error' : 'pending';
}

function useActiveCatalog(type: CatalogType) {
  const session = useShellSession();
  return useQuery({
    queryKey: processKeys.activeCatalog(session.activeTenant.id, type),
    queryFn: ({ signal }) => fetchActiveCatalog(type, signal),
    staleTime: WIZARD_CATALOG_STALE_TIME_MS,
    throwOnError: false,
  });
}

/**
 * Opções do catálogo ativo + o valor atual (mesmo inativo: só é revalidado se alterado — RN-PROC-64).
 */
function catalogOptions(
  items: readonly CatalogItemDto[] | undefined,
  current: { readonly id: string; readonly label: string } | null,
): SelectOption[] {
  const options = (items ?? []).map((item) => ({ value: item.id, label: item.label }));
  if (current !== null && !options.some((option) => option.value === current.id)) {
    options.unshift({ value: current.id, label: current.label });
  }
  return options;
}

/** `LockedField`: valor somente leitura com cadeado e a explicação (RN-PROC-60 · FA-01/FA-03). */
function LockedField({
  id,
  label,
  value,
  reason,
  className,
}: {
  readonly id: string;
  readonly label: ReactNode;
  readonly value: string;
  readonly reason: string;
  readonly className?: string | undefined;
}) {
  return (
    <FormField id={id} label={label} hint={reason} className={className}>
      {(control) => (
        <div className="relative">
          <input
            {...control}
            readOnly
            aria-readonly="true"
            className={cx(INPUT_CLASS, 'cursor-not-allowed bg-muted pr-9 text-muted-foreground')}
            value={value}
          />
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </div>
      )}
    </FormField>
  );
}

type Problem =
  | { readonly kind: 'formErrors' }
  | { readonly kind: 'status'; readonly detail: string }
  | { readonly kind: 'custody' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

interface Conflict {
  readonly current: ProcessConflictCurrent;
  readonly conflicts: readonly ConflictRow[];
  readonly reapply: UpdateProcessInput;
}

export interface EditProcessSheetProps {
  readonly processId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * `EditProcessSheet` (US-005 · SCR-006): painel lateral "Editar dados" sobre o PRC-04 (ETag = versão
 * lida). Campos bloqueados pelo status com cadeado e explicação; valor estimado somente leitura
 * com fonte superior; destaca os campos alterados e envia SÓ eles no PATCH (PRC-05, `If-Match`).
 * 412 abre a comparação com `meta.current` ("Reaplicar minhas alterações" / "Descartar e
 * recarregar"); perda de custódia avisa e oferece copiar os textos; banco fora mantém os dados.
 * Fechar com alterações pede confirmação (FA-07). Foco preso e devolvido ao gatilho (Radix).
 */
export function EditProcessSheet({ processId, open, onOpenChange }: EditProcessSheetProps) {
  const t = useTranslations('processes.edit');
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const [dirty, setDirty] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const detail = useQuery({
    queryKey: processKeys.detail(tenantId, processId),
    queryFn: ({ signal }) => fetchProcess(processId, signal),
    enabled: open,
    throwOnError: false,
  });

  const close = () => {
    setDirty(false);
    setConfirmingClose(false);
    onOpenChange(false);
  };
  const requestClose = () => {
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
        <SheetContent closeLabel={t('close')} aria-describedby={undefined}>
          <div className="border-b border-border p-4 pr-12">
            <DialogTitle>{t('title')}</DialogTitle>
          </div>
          {detail.data === undefined ? (
            <div role="status" className="flex flex-col gap-3 p-4">
              <span className="sr-only">{t('loading')}</span>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <EditForm
              key={`${detail.data.id}:${String(detail.data.version)}`}
              base={detail.data}
              onDirtyChange={setDirty}
              onCancel={requestClose}
              onSaved={close}
            />
          )}
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

function EditForm({
  base: initialBase,
  onDirtyChange,
  onCancel,
  onSaved,
}: {
  readonly base: ProcessDto;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onCancel: () => void;
  readonly onSaved: () => void;
}) {
  const t = useTranslations('processes');
  const te = useTranslations('processes.edit');
  const queryClient = useQueryClient();
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const timeZone = session.activeTenant.timezone;
  const ids = useId();
  const fieldId = (name: string) => `${ids}-${name}`;

  const [base, setBase] = useState(initialBase);
  const [now] = useState(() => new Date());
  const currentYear = now.getFullYear();
  const [initial, setInitial] = useState(() => editValuesOf(initialBase));
  const form = useForm<ProcessFormValues>({ defaultValues: initial });
  const values = completeValues(useWatch({ control: form.control }), currentYear);
  const [messages, setMessages] = useState<FieldMessages>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  // ---- Dados de apoio ------------------------------------------------------------------------
  const isDraft = base.status === 'DRAFT';
  const editable = isProcessEditable(base) && problem?.kind !== 'status';
  const permissions = useEffectivePermissions();
  const publicSettings = useQuery({
    queryKey: settingsKeys.public(tenantId),
    queryFn: async ({ signal }) => (await fetchPublicSettings(signal)).data,
    staleTime: SETTINGS_STALE_TIME_MS,
    throwOnError: false,
  });
  const organizations = useQuery({
    queryKey: organizationKeys.list(tenantId),
    queryFn: async ({ signal }) => (await fetchOrganizations(signal)).data,
    staleTime: ORGANIZATIONS_STALE_TIME_MS,
    enabled: isDraft,
    throwOnError: false,
  });
  const organizationId = values.organizationId;
  const departments = useQuery({
    queryKey: processKeys.activeDepartments(tenantId, organizationId),
    queryFn: ({ signal }) => fetchActiveDepartments(organizationId, signal),
    enabled: isDraft && organizationId !== '',
    staleTime: WIZARD_LOOKUP_STALE_TIME_MS,
    throwOnError: false,
  });
  const contractingTypes = useActiveCatalog('CONTRACTING_TYPE');
  const modalities = useActiveCatalog('MODALITY');
  const origins = useActiveCatalog('PROCESS_ORIGIN');

  const labels = labelsFrom(publicSettings.data);
  const context = validationContext(readRequireInternalCode(publicSettings.data), now);
  const locks = lockedFieldsOf(base, {
    numberingByOrganization: readNumberingByOrganization(publicSettings.data),
  });
  const valueSource = estimatedValueLock(base);
  const locked = new Set<ProcessFormField>([
    ...(Object.keys(locks) as ProcessFormField[]),
    ...(valueSource === null && !base.estimatedValueMasked ? [] : ['estimatedValue' as const]),
  ]);
  const patch = buildUpdatePatch(initial, values, locked);
  const changed = new Set(Object.keys(patch));
  // Alteração = diferença efetiva (trim, decimal), não o texto bruto do RHF (FA-07/FA-08).
  const isDirty = changed.size > 0;
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const departmentList = departments.data ?? NO_DEPARTMENTS;
  const scope: ScopeContext = {
    scopes: scopesOf(permissions.data, 'PROCESS_CREATE'),
    ownDepartmentIds: permissions.data ? [...permissions.data.implicit.ownDepartmentIds] : null,
    departments: departmentList,
  };
  const secretariats = secretariatOptions(departmentList, organizationId, scope);
  const secretariat = secretariats.find((unit) => unit.id === values.requestingSecretariatId);
  const sectors = sectorOptions(departmentList, secretariat, scope);
  const activeOrganizations = (organizations.data ?? []).filter((item) => item.isActive);

  const selectProps = {
    placeholder: t('fields.select'),
    loadingLabel: t('loading.options'),
    errorLabel: t('loading.failed'),
    retryLabel: t('loading.retry'),
  } as const;
  const priorityOptions: SelectOption[] = PRIORITIES.map((priority) => ({
    value: priority,
    label: t(`priorities.${priority}`),
  }));
  const set = (name: ProcessFormField, value: string | boolean) => {
    form.setValue(name, value, { shouldDirty: true });
    if (messages[name] !== undefined)
      setMessages((previous) => ({ ...previous, [name]: undefined }));
  };
  const errorOf = (name: ProcessFormField) => messages[name];
  const modifiedHint = (name: ProcessFormField) =>
    changed.has(name) ? (
      <span className="text-xs font-medium text-primary">{te('modified')}</span>
    ) : null;
  const labelOf = (name: ProcessFormField, label: string) => (
    <span className="flex items-center gap-2">
      {label}
      {modifiedHint(name)}
    </span>
  );
  const lockReason = (reason: LockReason) =>
    reason === 'NUMBERING'
      ? PROCESS_UPDATE_MESSAGES.lockedByNumbering
      : PROCESS_UPDATE_MESSAGES.lockedHint;

  // ---- Gravação ------------------------------------------------------------------------------
  const invalidateAll = () =>
    queryClient.invalidateQueries({ queryKey: processKeys.all(tenantId) });
  const save = useMutation({
    mutationFn: (input: { readonly body: UpdateProcessInput; readonly version: number }) =>
      updateProcess(base.id, input.body, input.version),
    onSuccess: async () => {
      toast({ title: PROCESS_UPDATE_MESSAGES.saved, tone: 'success' });
      await invalidateAll();
      onSaved();
    },
    onError: (error: unknown) => {
      if (!isApiError(error)) {
        setProblem({ kind: 'unexpected', correlationId: '—' });
        return;
      }
      if (error.status === 412 && error.code === 'VERSION_CONFLICT') {
        const current = conflictCurrentOf(error);
        if (current === null) {
          setProblem({ kind: 'unexpected', correlationId: error.correlationId ?? '—' });
          return;
        }
        setConflict({ current, ...resolveConflict(base, current, patch) });
        return;
      }
      if (error.status === 403 && error.code === 'NOT_PROCESS_CUSTODIAN') {
        setProblem({ kind: 'custody' });
        void invalidateAll();
        return;
      }
      if (error.status === 409 && error.code === 'INVALID_PROCESS_STATUS') {
        setProblem({ kind: 'status', detail: error.problem?.detail ?? error.message });
        void invalidateAll();
        return;
      }
      if (error.status === 403) {
        toast({ title: te('errors.permission'), tone: 'error' });
        onSaved();
        return;
      }
      if (error.status === 404) {
        void invalidateAll();
        onSaved();
        return;
      }
      if (error.code === 'BUSINESS_RULE_VIOLATION') {
        setMessages({ estimatedValue: error.problem?.detail ?? error.message });
        setProblem({ kind: 'formErrors' });
        void invalidateAll();
        return;
      }
      if (error.status === 422 || error.code === 'DUPLICATE_INTERNAL_CODE') {
        const next: FieldMessages = {};
        for (const item of error.errors) {
          if (isFormField(item.field)) next[item.field] ??= item.message;
        }
        setMessages(next);
        setProblem({ kind: 'formErrors' });
        // Campo bloqueado (`NOT_ALLOWED`): o status mudou — o processo é recarregado.
        if (error.errors.some((item) => item.code === 'NOT_ALLOWED')) void invalidateAll();
        return;
      }
      if (error.status === 503 || error.status === 429) {
        setProblem({ kind: 'unavailable' });
        return;
      }
      setProblem({ kind: 'unexpected', correlationId: error.correlationId ?? '—' });
    },
  });

  const submit = () => {
    setProblem(null);
    if (!isDirty) {
      toast({ title: PROCESS_UPDATE_MESSAGES.noChanges });
      onSaved();
      return;
    }
    const found = validateEdit(patch, values, context);
    setMessages(found);
    if (Object.keys(found).length > 0) {
      setProblem({ kind: 'formErrors' });
      return;
    }
    save.mutate({ body: patch, version: base.version });
  };

  const reload = (current: ProcessDto) => {
    const next = editValuesOf(current);
    setBase(current);
    setInitial(next);
    form.reset(next);
    setConflict(null);
    setMessages({});
    setProblem(null);
    void invalidateAll();
  };

  // ---- Renderização --------------------------------------------------------------------------
  const requestingChanged =
    changed.has('requestingSecretariatId') || changed.has('requestingDepartmentId');
  const workflowNote = [...changed].some((field) => WORKFLOW_FIELDS.has(field));

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {problem?.kind === 'formErrors' ? (
          <Alert tone="error" title={te('errors.formErrors')} />
        ) : null}
        {problem?.kind === 'status' ? <Alert tone="warning" title={problem.detail} /> : null}
        {problem?.kind === 'unavailable' ? (
          <Alert tone="error" title={te('errors.unavailable')}>
            <Button size="sm" variant="secondary" className="mt-2" onClick={submit}>
              {te('errors.retry')}
            </Button>
          </Alert>
        ) : null}
        {problem?.kind === 'unexpected' ? (
          <Alert
            tone="error"
            title={te('errors.unexpected', { correlationId: problem.correlationId })}
          />
        ) : null}
        {problem?.kind === 'custody' ? (
          <Alert tone="error" title={PROCESS_UPDATE_MESSAGES.notCustodian}>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => {
                void navigator.clipboard.writeText(typedTexts(values)).then(() => {
                  toast({ title: te('copied') });
                });
              }}
            >
              {te('copyTexts')}
            </Button>
          </Alert>
        ) : null}

        {conflict ? (
          <ConflictPanel
            conflict={conflict}
            timeZone={timeZone}
            fieldLabel={(field) =>
              // Os campos editáveis têm todos rótulo em `processes.fields`.
              plain(
                t(`fields.${field}` as 'fields.title', {
                  secretariat: labels.secretariat,
                  department: labels.department,
                }),
              )
            }
            busy={save.isPending}
            onReapply={() => {
              const { current, reapply } = conflict;
              if (Object.keys(reapply).length === 0) {
                reload(current);
                return;
              }
              setConflict(null);
              save.mutate({ body: reapply, version: current.version });
            }}
            onDiscard={() => {
              reload(conflict.current);
            }}
          />
        ) : null}

        <fieldset disabled={!editable || save.isPending} className="flex min-w-0 flex-col gap-4">
          {/* Órgão e unidade solicitante (RN-PROC-60/61/62). */}
          {locks.organizationId ? (
            <LockedField
              id={fieldId('organizationId')}
              label={plain(t('fields.organizationId'))}
              value={base.organization.shortName}
              reason={lockReason(locks.organizationId)}
            />
          ) : isDraft && activeOrganizations.length > 1 ? (
            <SelectField
              {...selectProps}
              id={fieldId('organizationId')}
              label={labelOf('organizationId', t('fields.organizationId'))}
              value={values.organizationId}
              onChange={(value) => {
                set('organizationId', value);
                set('requestingSecretariatId', '');
                set('requestingDepartmentId', '');
              }}
              options={activeOrganizations.map((item) => ({ value: item.id, label: item.name }))}
              status={lookupStatus(organizations)}
              onRetry={() => {
                void organizations.refetch();
              }}
              error={errorOf('organizationId')}
              required
            />
          ) : null}
          {locks.requestingSecretariatId ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <LockedField
                id={fieldId('requestingSecretariatId')}
                label={plain(
                  t('fields.requestingSecretariatId', { secretariat: labels.secretariat }),
                )}
                value={base.requestingSecretariat.name}
                reason={lockReason(locks.requestingSecretariatId)}
              />
              <LockedField
                id={fieldId('requestingDepartmentId')}
                label={plain(t('fields.requestingDepartmentId', { department: labels.department }))}
                value={base.requestingDepartment.name}
                reason={lockReason(locks.requestingSecretariatId)}
              />
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                {...selectProps}
                id={fieldId('requestingSecretariatId')}
                label={labelOf(
                  'requestingSecretariatId',
                  t('fields.requestingSecretariatId', { secretariat: labels.secretariat }),
                )}
                value={values.requestingSecretariatId}
                onChange={(value) => {
                  set('requestingSecretariatId', value);
                  // FA-04: o setor é recarregado da subárvore da nova secretaria.
                  set('requestingDepartmentId', '');
                }}
                options={secretariats.map((unit) => ({ value: unit.id, label: unit.name }))}
                status={lookupStatus(departments)}
                onRetry={() => {
                  void departments.refetch();
                }}
                error={errorOf('requestingSecretariatId')}
                required
              />
              <SelectField
                {...selectProps}
                id={fieldId('requestingDepartmentId')}
                label={labelOf(
                  'requestingDepartmentId',
                  t('fields.requestingDepartmentId', { department: labels.department }),
                )}
                value={values.requestingDepartmentId}
                onChange={(value) => {
                  set('requestingDepartmentId', value);
                }}
                options={sectors.map((option) => ({
                  value: option.department.id,
                  label: option.department.name,
                }))}
                status={lookupStatus(departments)}
                onRetry={() => {
                  void departments.refetch();
                }}
                error={errorOf('requestingDepartmentId')}
                required
              />
            </div>
          )}
          {requestingChanged ? (
            <Alert tone="info" title={te('requestingChanged')}>
              <p className="text-sm">
                {te('requestingStays', { department: base.currentDepartment.name })}
              </p>
            </Alert>
          ) : null}

          <FormField
            id={fieldId('title')}
            label={labelOf('title', t('fields.title'))}
            hint={t('fields.titleHint')}
            error={errorOf('title')}
            required
          >
            {(control) => (
              <input
                {...control}
                type="text"
                className={INPUT_CLASS}
                value={values.title}
                onChange={(event) => {
                  set('title', event.target.value);
                }}
              />
            )}
          </FormField>
          <FormField
            id={fieldId('object')}
            label={labelOf('object', t('fields.object'))}
            hint={t('fields.objectHint')}
            error={errorOf('object')}
            required
          >
            {(control) => (
              <textarea
                {...control}
                rows={4}
                className={TEXTAREA_CLASS}
                value={values.object}
                onChange={(event) => {
                  set('object', event.target.value);
                }}
              />
            )}
          </FormField>
          <FormField
            id={fieldId('description')}
            label={labelOf('description', t('fields.description'))}
            error={errorOf('description')}
          >
            {(control) => (
              <textarea
                {...control}
                rows={3}
                className={TEXTAREA_CLASS}
                value={values.description}
                onChange={(event) => {
                  set('description', event.target.value);
                }}
              />
            )}
          </FormField>
          <SelectField
            {...selectProps}
            id={fieldId('contractingTypeId')}
            label={labelOf('contractingTypeId', t('fields.contractingTypeId'))}
            value={values.contractingTypeId}
            onChange={(value) => {
              set('contractingTypeId', value);
            }}
            options={catalogOptions(contractingTypes.data, base.contractingType)}
            status={lookupStatus(contractingTypes)}
            onRetry={() => {
              void contractingTypes.refetch();
            }}
            error={errorOf('contractingTypeId')}
            required
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              {...selectProps}
              id={fieldId('modalityId')}
              label={labelOf('modalityId', t('fields.modalityId'))}
              placeholder={t('fields.modalityUndefined')}
              value={values.modalityId}
              onChange={(value) => {
                set('modalityId', value);
              }}
              options={catalogOptions(modalities.data, base.modality)}
              status={lookupStatus(modalities)}
              onRetry={() => {
                void modalities.refetch();
              }}
              error={errorOf('modalityId')}
            />
            <div className="flex min-w-0 items-start gap-2 sm:pt-6">
              <input
                id={fieldId('isPriceRegistration')}
                type="checkbox"
                className="mt-1 size-4 flex-none"
                checked={values.isPriceRegistration}
                onChange={(event) => {
                  set('isPriceRegistration', event.target.checked);
                }}
              />
              <label htmlFor={fieldId('isPriceRegistration')} className="text-sm font-medium">
                {labelOf('isPriceRegistration', t('fields.isPriceRegistration'))}
              </label>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              {...selectProps}
              id={fieldId('priority')}
              label={labelOf('priority', t('fields.priority'))}
              value={values.priority}
              onChange={(value) => {
                set('priority', value);
              }}
              options={priorityOptions}
              status="ready"
              onRetry={() => undefined}
              error={errorOf('priority')}
              required
            />
            <FormField
              id={fieldId('targetDate')}
              label={labelOf('targetDate', t('fields.targetDate'))}
              error={errorOf('targetDate')}
            >
              {(control) => (
                <input
                  {...control}
                  type="date"
                  className={INPUT_CLASS}
                  value={values.targetDate}
                  onChange={(event) => {
                    set('targetDate', event.target.value);
                  }}
                />
              )}
            </FormField>
          </div>
          {valueSource !== null || base.estimatedValueMasked ? (
            <LockedField
              id={fieldId('estimatedValue')}
              label={plain(t('fields.estimatedValue'))}
              value={
                base.estimatedValueMasked
                  ? te('confidential')
                  : base.estimatedValue === null
                    ? '—'
                    : `R$ ${values.estimatedValue}`
              }
              reason={
                valueSource === null
                  ? te('confidentialHint')
                  : te('estimatedFromSource', {
                      source: ESTIMATED_VALUE_SOURCE_LABELS[valueSource],
                    })
              }
            />
          ) : (
            <FormField
              id={fieldId('estimatedValue')}
              label={labelOf('estimatedValue', t('fields.estimatedValue'))}
              hint={t('fields.estimatedValueHint')}
              error={errorOf('estimatedValue')}
            >
              {(control) => (
                <MoneyInput
                  {...control}
                  value={values.estimatedValue}
                  onValueChange={(text) => {
                    set('estimatedValue', text);
                  }}
                />
              )}
            </FormField>
          )}
          <SelectField
            {...selectProps}
            id={fieldId('originId')}
            label={labelOf('originId', t('fields.originId'))}
            value={values.originId}
            onChange={(value) => {
              set('originId', value);
            }}
            options={catalogOptions(origins.data, base.origin)}
            status={lookupStatus(origins)}
            onRetry={() => {
              void origins.refetch();
            }}
            error={errorOf('originId')}
            required
          />
          {workflowNote ? (
            <p className="text-xs text-muted-foreground">
              {PROCESS_UPDATE_MESSAGES.workflowUnchanged}
            </p>
          ) : null}
          <PcaFieldset
            idPrefix={ids}
            values={values}
            errors={{
              pcaStatus: errorOf('pcaStatus'),
              pcaYear: errorOf('pcaYear'),
              pcaItemCode: errorOf('pcaItemCode'),
              pcaJustification: errorOf('pcaJustification'),
            }}
            currentYear={currentYear}
            onChange={(field, value) => {
              set(field, value);
            }}
          />
          <FormField
            id={fieldId('internalCode')}
            label={labelOf(
              'internalCode',
              context.requireInternalCode
                ? t('fields.internalCodeRequired')
                : t('fields.internalCode'),
            )}
            hint={t('fields.internalCodeHint')}
            error={errorOf('internalCode')}
            required={context.requireInternalCode}
          >
            {(control) => (
              <input
                {...control}
                type="text"
                className={INPUT_CLASS}
                value={values.internalCode}
                onChange={(event) => {
                  set('internalCode', event.target.value);
                }}
              />
            )}
          </FormField>
          <FormField
            id={fieldId('notes')}
            label={labelOf('notes', t('fields.notes'))}
            error={errorOf('notes')}
          >
            {(control) => (
              <textarea
                {...control}
                rows={3}
                className={TEXTAREA_CLASS}
                value={values.notes}
                onChange={(event) => {
                  set('notes', event.target.value);
                }}
              />
            )}
          </FormField>
        </fieldset>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border bg-surface p-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {te('cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!editable || save.isPending || conflict !== null}
        >
          {save.isPending ? te('saving') : te('save')}
        </Button>
      </div>
    </form>
  );
}

/** FA-05: quem alterou e quando, a comparação campo a campo e as duas saídas. */
function ConflictPanel({
  conflict,
  timeZone,
  fieldLabel,
  busy,
  onReapply,
  onDiscard,
}: {
  readonly conflict: Conflict;
  readonly timeZone: string;
  readonly fieldLabel: (field: string) => string;
  readonly busy: boolean;
  readonly onReapply: () => void;
  readonly onDiscard: () => void;
}) {
  const t = useTranslations('processes.edit.conflict');
  const { current } = conflict;
  const time = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short', timeZone }).format(
    new Date(current.updatedAt),
  );
  const show = (value: unknown) =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value) || '—'
      : '—';
  return (
    <section
      role="alert"
      aria-labelledby="edit-conflict-title"
      className="flex flex-col gap-3 rounded-card border border-warning/40 bg-warning-soft p-3"
    >
      <h3 id="edit-conflict-title" className="text-sm font-semibold">
        {current.updatedBy === null
          ? t('titleUnknown')
          : t('title', { name: current.updatedBy.name, time })}
      </h3>
      {conflict.conflicts.length === 0 ? (
        <p className="text-sm">{t('noOverlap')}</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th scope="col">{t('field')}</th>
              <th scope="col">{t('mine')}</th>
              <th scope="col">{t('current')}</th>
            </tr>
          </thead>
          <tbody>
            {conflict.conflicts.map((row) => (
              <tr key={row.field}>
                <th scope="row" className="font-medium">
                  {fieldLabel(row.field)}
                </th>
                <td>{show(row.mine)}</td>
                <td>{show(row.current)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={onReapply}>
          {t('reapply')}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={onDiscard}>
          {t('discard')}
        </Button>
      </div>
    </section>
  );
}
