'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Skeleton,
  cx,
  toast,
} from '@contrataflow/ui';
import type { DepartmentDto, ProcessDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { newIdempotencyKey } from '@/lib/api/client';
import { scopesOf, useEffectivePermissions } from '@/lib/permissions/use-permission';
import { tenantKey } from '@/lib/query/keys';
import { useShellSession } from '@/lib/session/session-context';

import {
  duplicateBody,
  duplicateValuesOf,
  eligibleDocuments,
  splitErrors,
  validateDuplicate,
} from './duplicate-process-model';
import type {
  DuplicateField,
  DuplicateFormValues,
  DuplicateMessages,
} from './duplicate-process-model';
import { duplicateProcess } from './process-duplicate.api';
import { labelsFrom } from '../departments/department-tree-model';
import { useProcessDocuments } from '../process-documents/process-documents.api';
import { FormField, INPUT_CLASS, SelectField, TEXTAREA_CLASS } from '../processes/form-field';
import { sectorOptions, secretariatOptions } from '../processes/process-form-model';
import type { ScopeContext } from '../processes/process-form-model';
import {
  WIZARD_LOOKUP_STALE_TIME_MS,
  fetchActiveDepartments,
  fetchProcess,
  processKeys,
} from '../processes/processes.api';
import {
  SETTINGS_STALE_TIME_MS,
  fetchPublicSettings,
  settingsKeys,
} from '../settings/settings.api';

const NO_DEPARTMENTS: readonly DepartmentDto[] = [];

type Problem =
  | { readonly kind: 'formErrors' }
  /** FA-01: referência copiada inativa (ou regra do PCA) que só se corrige na origem. */
  | { readonly kind: 'source'; readonly messages: readonly string[] }
  | { readonly kind: 'noWorkflow'; readonly detail: string }
  | { readonly kind: 'permission'; readonly detail: string }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

export interface DuplicateProcessDialogProps {
  readonly processId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * `DuplicateProcessDialog` (US-011 · SCR-113): diálogo "Duplicar processo" sobre o PRC-04 da
 * origem — título, objeto e unidades solicitantes pré-preenchidos e editáveis (o seletor só mostra
 * as unidades cobertas pelo `PROCESS_CREATE` — FA-05) e os interruptores de cópia de documentos
 * estruturados (desabilitado sem documento elegível — FA-03) e de anexos. Confirma com o PRC-27
 * (`Idempotency-Key` fixa por abertura) e leva ao painel do novo processo com o toast "Processo X
 * criado a partir de Y". Foco inicial no título.
 */
export function DuplicateProcessDialog({
  processId,
  open,
  onOpenChange,
}: DuplicateProcessDialogProps) {
  const t = useTranslations('processes.duplicate');
  const session = useShellSession();
  const detail = useQuery({
    queryKey: processKeys.detail(session.activeTenant.id, processId),
    queryFn: ({ signal }) => fetchProcess(processId, signal),
    enabled: open,
    throwOnError: false,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('close')} className="max-h-[90vh] overflow-y-auto">
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        {detail.data === undefined ? (
          <div role="status" className="flex flex-col gap-3">
            <span className="sr-only">{t('loading')}</span>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <DuplicateForm
            key={`${detail.data.id}:${String(detail.data.version)}`}
            source={detail.data}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Interruptor acessível (`role="switch"`) com o texto de ajuda associado. */
function SwitchRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span id={`${id}-label`} className="text-sm font-medium">
          {label}
        </span>
        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </span>
      </div>
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        disabled={disabled}
        onClick={() => {
          onChange(!checked);
        }}
        className={cx(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'border-primary bg-primary' : 'border-border bg-muted',
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            'inline-block size-4 rounded-full bg-surface shadow transition-transform',
            checked ? 'translate-x-6' : 'translate-x-1',
          )}
        />
      </button>
    </div>
  );
}

function DuplicateForm({
  source,
  onClose,
}: {
  readonly source: ProcessDto;
  readonly onClose: () => void;
}) {
  const t = useTranslations('processes');
  const td = useTranslations('processes.duplicate');
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const ids = useId();
  const fieldId = (name: string) => `${ids}-${name}`;
  const titleRef = useRef<HTMLInputElement>(null);

  const [values, setValues] = useState<DuplicateFormValues>(() => duplicateValuesOf(source));
  const [messages, setMessages] = useState<DuplicateMessages>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  // Uma chave por abertura: reenvios (falha transitória) repetem a mesma (Duplicidade).
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const permissions = useEffectivePermissions();
  const publicSettings = useQuery({
    queryKey: settingsKeys.public(tenantId),
    queryFn: async ({ signal }) => (await fetchPublicSettings(signal)).data,
    staleTime: SETTINGS_STALE_TIME_MS,
    throwOnError: false,
  });
  const organizationId = source.organization.id;
  const departments = useQuery({
    queryKey: processKeys.activeDepartments(tenantId, organizationId),
    queryFn: ({ signal }) => fetchActiveDepartments(organizationId, signal),
    staleTime: WIZARD_LOOKUP_STALE_TIME_MS,
    throwOnError: false,
  });
  const documents = useProcessDocuments(source.id);
  const eligible = eligibleDocuments(documents.data?.items ?? []);
  const noDocuments = documents.data !== undefined && eligible.length === 0;

  const labels = labelsFrom(publicSettings.data);
  const departmentList = departments.data ?? NO_DEPARTMENTS;
  const scope: ScopeContext = {
    scopes: scopesOf(permissions.data, 'PROCESS_CREATE'),
    ownDepartmentIds: permissions.data ? [...permissions.data.implicit.ownDepartmentIds] : null,
    departments: departmentList,
  };
  const secretariats = secretariatOptions(departmentList, organizationId, scope);
  const secretariat = secretariats.find((unit) => unit.id === values.requestingSecretariatId);
  const sectors = sectorOptions(departmentList, secretariat, scope);
  const departmentsStatus =
    departments.data !== undefined ? 'ready' : departments.isError ? 'error' : 'pending';

  const set = <K extends keyof DuplicateFormValues>(name: K, value: DuplicateFormValues[K]) => {
    setValues((previous) => ({ ...previous, [name]: value }));
    if (name in messages) setMessages((previous) => ({ ...previous, [name]: undefined }));
  };
  const errorOf = (name: DuplicateField) => messages[name];

  const duplicate = useMutation({
    mutationFn: (current: DuplicateFormValues) =>
      duplicateProcess(source.id, duplicateBody(current), idempotencyKey),
    onSuccess: (created) => {
      toast({
        title:
          created.code === null
            ? td('toastNoNumber', { sourceCode: source.code ?? source.title })
            : td('toast', { code: created.code, sourceCode: source.code ?? source.title }),
        tone: 'success',
      });
      for (const key of ['processes', 'tasks', 'dashboard'] as const) {
        void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, key) });
      }
      onClose();
      router.push(`/processos/${created.id}`);
    },
    onError: (error: unknown) => {
      if (!isApiError(error)) {
        setProblem({ kind: 'unexpected', correlationId: '—' });
        return;
      }
      if (error.status === 422 && error.code === 'VALIDATION_ERROR') {
        const { fields, others } = splitErrors(error.errors);
        setMessages(fields);
        setProblem(
          others.length > 0 ? { kind: 'source', messages: others } : { kind: 'formErrors' },
        );
        return;
      }
      if (error.code === 'NO_APPLICABLE_WORKFLOW') {
        setProblem({ kind: 'noWorkflow', detail: error.problem?.detail ?? error.message });
        return;
      }
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') {
        // Outros dados com a mesma chave: nova chave e o usuário confirma de novo.
        setIdempotencyKey(newIdempotencyKey());
        setProblem({ kind: 'unexpected', correlationId: error.correlationId ?? '—' });
        return;
      }
      if (error.status === 403) {
        setProblem({ kind: 'permission', detail: error.problem?.detail ?? error.message });
        return;
      }
      if (error.status === 404) {
        toast({ title: td('errors.notFound'), tone: 'error' });
        onClose();
        router.push('/processos');
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
    if (duplicate.isPending) return;
    setProblem(null);
    const found = validateDuplicate(values);
    setMessages(found);
    if (Object.keys(found).length > 0) {
      setProblem({ kind: 'formErrors' });
      if (found.title !== undefined) titleRef.current?.focus();
      return;
    }
    duplicate.mutate(values);
  };

  const selectProps = {
    placeholder: t('fields.select'),
    loadingLabel: t('loading.options'),
    errorLabel: t('loading.failed'),
    retryLabel: t('loading.retry'),
  } as const;

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {problem?.kind === 'formErrors' ? (
        <Alert tone="error" title={td('errors.formErrors')} />
      ) : null}
      {problem?.kind === 'source' ? (
        <Alert tone="error" title={td('errors.source')}>
          <ul className="list-disc pl-5 text-sm">
            {problem.messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
          <p className="mt-1 text-sm">{td('errors.sourceHint')}</p>
        </Alert>
      ) : null}
      {problem?.kind === 'noWorkflow' ? <Alert tone="error" title={problem.detail} /> : null}
      {problem?.kind === 'permission' ? (
        <Alert tone="error" title={problem.detail}>
          <p className="text-sm">{td('errors.permissionHint')}</p>
        </Alert>
      ) : null}
      {problem?.kind === 'unavailable' ? (
        <Alert tone="error" title={td('errors.unavailable')}>
          <Button size="sm" variant="secondary" className="mt-2" onClick={submit}>
            {td('errors.retry')}
          </Button>
        </Alert>
      ) : null}
      {problem?.kind === 'unexpected' ? (
        <Alert
          tone="error"
          title={td('errors.unexpected', { correlationId: problem.correlationId })}
        />
      ) : null}

      <FormField
        id={fieldId('title')}
        label={t('fields.title')}
        hint={t('fields.titleHint')}
        error={errorOf('title')}
        required
      >
        {(control) => (
          <input
            {...control}
            ref={titleRef}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- foco inicial no título (SCR-113 · Acessibilidade)
            autoFocus
            className={INPUT_CLASS}
            value={values.title}
            maxLength={200}
            onChange={(event) => {
              set('title', event.target.value);
            }}
          />
        )}
      </FormField>
      <FormField
        id={fieldId('object')}
        label={t('fields.object')}
        hint={t('fields.objectHint')}
        error={errorOf('object')}
        required
      >
        {(control) => (
          <textarea
            {...control}
            className={TEXTAREA_CLASS}
            value={values.object}
            maxLength={2000}
            onChange={(event) => {
              set('object', event.target.value);
            }}
          />
        )}
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          {...selectProps}
          id={fieldId('requestingSecretariatId')}
          label={t('fields.requestingSecretariatId', { secretariat: labels.secretariat })}
          value={values.requestingSecretariatId}
          onChange={(value) => {
            set('requestingSecretariatId', value);
            // O setor é escolhido de novo na subárvore da nova secretaria.
            set('requestingDepartmentId', '');
          }}
          options={secretariats.map((unit) => ({ value: unit.id, label: unit.name }))}
          status={departmentsStatus}
          onRetry={() => {
            void departments.refetch();
          }}
          error={errorOf('requestingSecretariatId')}
          required
        />
        <SelectField
          {...selectProps}
          id={fieldId('requestingDepartmentId')}
          label={t('fields.requestingDepartmentId', { department: labels.department })}
          value={values.requestingDepartmentId}
          onChange={(value) => {
            set('requestingDepartmentId', value);
          }}
          options={sectors.map((option) => ({
            value: option.department.id,
            label: option.department.name,
          }))}
          status={departmentsStatus}
          onRetry={() => {
            void departments.refetch();
          }}
          error={errorOf('requestingDepartmentId')}
          required
        />
      </div>

      <fieldset className="flex flex-col gap-3 rounded-control border border-border p-3">
        <legend className="px-1 text-sm font-medium">{td('options')}</legend>
        <SwitchRow
          id={fieldId('copyDocuments')}
          label={td('copyDocuments')}
          hint={noDocuments ? td('noDocuments') : td('copyDocumentsHint')}
          checked={values.copyDocuments}
          disabled={documents.data === undefined || noDocuments}
          onChange={(checked) => {
            set('copyDocuments', checked);
          }}
        />
        {values.copyDocuments && eligible.length > 0 ? (
          <ul aria-label={td('documentsList')} className="flex flex-col gap-1 pl-1 text-sm">
            {eligible.map((document) => (
              <li key={document.id} className="truncate">
                {document.code === null ? document.title : `${document.code} — ${document.title}`}
              </li>
            ))}
          </ul>
        ) : null}
        <SwitchRow
          id={fieldId('copyAttachments')}
          label={td('copyAttachments')}
          hint={td('copyAttachmentsHint')}
          checked={values.copyAttachments}
          disabled={false}
          onChange={(checked) => {
            set('copyAttachments', checked);
          }}
        />
        <p className="text-xs text-muted-foreground">{td('neverCopied')}</p>
      </fieldset>

      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {td('cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          aria-disabled={problem?.kind === 'noWorkflow' ? true : undefined}
          disabled={duplicate.isPending || problem?.kind === 'noWorkflow'}
        >
          {duplicate.isPending ? td('submitting') : td('submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}
