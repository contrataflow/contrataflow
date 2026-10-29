'use client';

import type { CatalogType } from '@contrataflow/types';
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Input,
  Label,
  PageHeader,
  Skeleton,
  Textarea,
  WizardShell,
  cx,
  fromIsoDate,
  toIsoDate,
  toast,
} from '@contrataflow/ui';
import { PRIORITIES } from '@contrataflow/validation';
import type {
  CatalogItemDto,
  CreateProcessInput,
  DepartmentDto,
  DuplicateCandidate,
} from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { isApiError } from '@/lib/api/api-error';
import { newCorrelationId, newIdempotencyKey } from '@/lib/api/client';
import { formatMoney } from '@/lib/i18n/format';
import { scopesOf, useEffectivePermissions } from '@/lib/permissions/use-permission';
import { tenantKey } from '@/lib/query/keys';
import { useShellSession } from '@/lib/session/session-context';

import { DuplicateWarningPanel } from './duplicate-warning-panel';
import { FormField, SelectField } from './form-field';
import type { SelectGroup, SelectOption } from './form-field';
import { toDecimalMoney } from './money';
import { MoneyInput } from './money-input';
import { PcaFieldset } from './pca-fieldset';
import {
  STEP_FIELDS,
  WIZARD_STEPS,
  buildCreateBody,
  buildDuplicateCheckBody,
  buildResolveBody,
  clearDraft,
  completeValues,
  draftStorageKey,
  firstErrorField,
  firstInvalidStep,
  hasUserContent,
  initialValues,
  isFormField,
  loadDraft,
  prefillFromLotation,
  saveDraft,
  sectorOptions,
  secretariatOptions,
  stepOfField,
  validateStep,
  validationContext,
} from './process-form-model';
import type {
  FieldMessages,
  ProcessFormField,
  ProcessFormValues,
  ScopeContext,
  WizardStep,
} from './process-form-model';
import {
  WIZARD_CATALOG_STALE_TIME_MS,
  WIZARD_LOOKUP_STALE_TIME_MS,
  checkDuplicates,
  createProcess,
  duplicateCandidatesOf,
  fetchActiveCatalog,
  fetchActiveDepartments,
  lotationsOf,
  processKeys,
  readNumberingByOrganization,
  readRequireInternalCode,
  resolveWorkflow,
} from './processes.api';
import { ReviewSummary } from './review-summary';
import type { SummarySection } from './review-summary';
import { WorkflowPreviewCard } from './workflow-preview-card';
import type { WorkflowPreviewState } from './workflow-preview-card';
import { labelsFrom } from '../departments/department-tree-model';
import {
  ORGANIZATIONS_STALE_TIME_MS,
  fetchOrganizations,
  organizationKeys,
} from '../organizations/organizations.api';
import {
  SETTINGS_STALE_TIME_MS,
  fetchPublicSettings,
  settingsKeys,
} from '../settings/settings.api';

/** Espera antes de repetir uma criação que a API ainda está concluindo (`IDEMPOTENCY_IN_PROGRESS`). */
export const IN_PROGRESS_RETRY_MS = 2000;
const MAX_IN_PROGRESS_ATTEMPTS = 5;
/** Destino de "Cancelar": a lista de processos (SCR-004). */
const LIST_PATH = '/processos';

const NO_DEPARTMENTS: readonly DepartmentDto[] = [];

/** Rótulo sem o asterisco de obrigatório (resumo da revisão). */
const plain = (label: string) => label.replace(/\s*\*$/, '');
const INDENT = String.fromCharCode(160).repeat(2);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const subscribeNothing = () => () => undefined;

/** `false` no servidor e na hidratação; `true` depois — o rascunho local só existe no navegador. */
function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
}

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
    // Erro e vazio são mostrados no próprio campo (com "Tentar novamente").
    throwOnError: false,
  });
}

const catalogOptions = (items: readonly CatalogItemDto[] | undefined): SelectOption[] =>
  (items ?? []).map((item) => ({ value: item.id, label: item.label }));

type Banner =
  | { readonly kind: 'formErrors' }
  | { readonly kind: 'permission' }
  | { readonly kind: 'keyReused' }
  | { readonly kind: 'referenceInvalid' }
  | {
      readonly kind: 'unavailable' | 'unexpected' | 'generic';
      readonly correlationId: string | null;
    };

export interface ProcessWizardProps {
  /** Espera entre as repetições de `IDEMPOTENCY_IN_PROGRESS` (padrão 2 s; testes encurtam). */
  readonly inProgressDelayMs?: number | undefined;
}

/**
 * Wizard "Novo processo" (SCR-005 · US-001): Identificação → Origem e planejamento → Revisão, num
 * formulário único (React Hook Form) validado por passo com os mesmos schemas da API. Carrega
 * catálogos, órgãos, unidades e lotações do usuário; pré-preenche órgão, secretaria e setor; no
 * passo 3 verifica duplicidade (PRC-03) e o fluxo aplicável (WF-06) e cria com `POST /processes`
 * (PRC-02) usando uma `Idempotency-Key` por sessão do wizard. O rascunho fica em `sessionStorage`.
 */
export function ProcessWizard(props: ProcessWizardProps) {
  const ready = useIsClient();
  return ready ? <WizardBody {...props} /> : <WizardPlaceholder />;
}

function WizardPlaceholder() {
  const t = useTranslations('processes');
  return (
    <div role="status" className="flex flex-col gap-4">
      <span className="sr-only">{t('loading.label')}</span>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-10 w-full max-w-3xl" />
      <Skeleton className="h-40 w-full max-w-3xl" />
    </div>
  );
}

function WizardBody({ inProgressDelayMs = IN_PROGRESS_RETRY_MS }: ProcessWizardProps) {
  const t = useTranslations('processes');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const draftKey = draftStorageKey(tenantId, session.user.id);
  const ids = useId();
  const fieldId = (name: string) => `${ids}-${name}`;

  const [now] = useState(() => new Date());
  const currentYear = now.getFullYear();
  const [draft] = useState(() => loadDraft(draftKey, currentYear));
  const [recovered, setRecovered] = useState(draft !== null);
  const [step, setStep] = useState<WizardStep>(draft?.step ?? 'identification');
  const form = useForm<ProcessFormValues>({
    defaultValues: draft?.values ?? initialValues(currentYear),
  });
  const values = completeValues(useWatch({ control: form.control }), currentYear);
  const errors = form.formState.errors;
  const errorOf = (name: ProcessFormField): string | undefined => errors[name]?.message;

  const [banner, setBanner] = useState<Banner | null>(null);
  const [notice, setNotice] = useState<'inProgress' | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ field: ProcessFormField; n: number } | null>(
    null,
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirmingExit, setConfirmingExit] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [duplicateConfirmation, setDuplicateConfirmation] = useState<{
    readonly candidates: readonly DuplicateCandidate[];
  } | null>(null);
  const [rejectedWorkflowKey, setRejectedWorkflowKey] = useState<string | null>(null);

  // Uma chave de idempotência por sessão do wizard: reenviar (503, rede, "Criar mesmo assim")
  // usa a mesma; só `IDEMPOTENCY_KEY_REUSED` a troca (FA-07).
  const idempotencyKey = useRef(newIdempotencyKey());
  const finished = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const duplicatePanelRef = useRef<HTMLDivElement>(null);
  const stepFocusReady = useRef(false);

  // ---- Dados de apoio ------------------------------------------------------------------------
  const permissions = useEffectivePermissions();
  const createScopes = scopesOf(permissions.data, 'PROCESS_CREATE');
  const organizations = useQuery({
    queryKey: organizationKeys.list(tenantId),
    queryFn: async ({ signal }) => (await fetchOrganizations(signal)).data,
    staleTime: ORGANIZATIONS_STALE_TIME_MS,
    throwOnError: false,
  });
  const publicSettings = useQuery({
    queryKey: settingsKeys.public(tenantId),
    queryFn: async ({ signal }) => (await fetchPublicSettings(signal)).data,
    staleTime: SETTINGS_STALE_TIME_MS,
    throwOnError: false,
  });
  // Lotações do vínculo (ME-03 — o mesmo retrato dos hooks de permissão).
  const lotationData = useMemo(() => lotationsOf(permissions.data), [permissions.data]);
  const lotations = {
    data: lotationData,
    isSuccess: permissions.status === 'success',
    isError: permissions.status === 'error',
  };
  const contractingTypes = useActiveCatalog('CONTRACTING_TYPE');
  const modalities = useActiveCatalog('MODALITY');
  const origins = useActiveCatalog('PROCESS_ORIGIN');
  const organizationId = values.organizationId;
  const departments = useQuery({
    queryKey: processKeys.activeDepartments(tenantId, organizationId),
    queryFn: ({ signal }) => fetchActiveDepartments(organizationId, signal),
    enabled: organizationId !== '',
    staleTime: WIZARD_LOOKUP_STALE_TIME_MS,
    throwOnError: false,
  });

  const labels = labelsFrom(publicSettings.data);
  const requireInternalCode = readRequireInternalCode(publicSettings.data);
  const context = validationContext(requireInternalCode, now);

  const activeOrganizations = (organizations.data ?? []).filter(
    (organization) => organization.isActive,
  );
  const defaultOrganization =
    activeOrganizations.find((organization) => organization.isPrimary) ?? activeOrganizations[0];
  const departmentList = departments.data ?? NO_DEPARTMENTS;
  const scope: ScopeContext = {
    scopes: createScopes,
    ownDepartmentIds: lotations.data ? lotations.data.map((lotation) => lotation.id) : null,
    departments: departmentList,
  };
  const secretariats = secretariatOptions(departmentList, organizationId, scope);
  const secretariat = secretariats.find((unit) => unit.id === values.requestingSecretariatId);
  const sectors = sectorOptions(departmentList, secretariat, scope);

  // Órgão padrão: o principal do tenant (RN-PROC-01); só aparece para escolha com mais de um.
  useEffect(() => {
    if (defaultOrganization && form.getValues('organizationId') === '') {
      form.setValue('organizationId', defaultOrganization.id);
    }
  }, [defaultOrganization, form]);

  // Pré-preenchimento (uma vez): secretaria e setor da lotação principal do usuário. Um rascunho
  // recuperado já traz as escolhas da pessoa.
  const prefilled = useRef(draft !== null);
  const lotationsSettled = lotations.isSuccess || lotations.isError;
  useEffect(() => {
    if (prefilled.current || departments.data === undefined || !lotationsSettled) return;
    prefilled.current = true;
    if (!lotations.data) return;
    const target = prefillFromLotation(departments.data, organizationId, lotations.data, {
      scopes: createScopes,
      ownDepartmentIds: lotations.data.map((lotation) => lotation.id),
      departments: departments.data,
    });
    if (!target) return;
    form.setValue('requestingSecretariatId', target.secretariatId);
    form.setValue('requestingDepartmentId', target.departmentId);
  }, [departments.data, lotations.data, lotationsSettled, organizationId, createScopes, form]);

  // ---- Passo 3: duplicidade (PRC-03) e fluxo aplicável (WF-06), em paralelo ------------------
  const reviewing = step === 'review';
  const duplicateBody = buildDuplicateCheckBody(values);
  const duplicates = useQuery({
    queryKey: processKeys.duplicates(tenantId, duplicateBody),
    queryFn: ({ signal }) => checkDuplicates(duplicateBody, signal),
    enabled: reviewing,
    retry: false,
    staleTime: 0,
    // Consulta de cortesia: a API repete a heurística no POST (salvaguarda).
    throwOnError: false,
  });
  const resolveBody = buildResolveBody(values);
  const resolveKey = JSON.stringify(resolveBody);
  const workflow = useQuery({
    queryKey: processKeys.workflow(tenantId, resolveBody),
    queryFn: ({ signal }) => resolveWorkflow(resolveBody, signal),
    enabled: reviewing,
    retry: false,
    throwOnError: false,
  });
  const noWorkflow =
    (isApiError(workflow.error) && workflow.error.code === 'NO_APPLICABLE_WORKFLOW') ||
    rejectedWorkflowKey === resolveKey;
  let workflowState: WorkflowPreviewState;
  if (noWorkflow) workflowState = { kind: 'none' };
  else if (workflow.data) {
    workflowState = {
      kind: 'ready',
      name: workflow.data.name,
      stage: workflow.data.initialStage.name,
    };
  } else if (workflow.isError) {
    workflowState = {
      kind: 'unavailable',
      onRetry: () => {
        void workflow.refetch();
      },
    };
  } else workflowState = { kind: 'loading' };

  const candidates = duplicateConfirmation?.candidates ?? duplicates.data ?? [];
  const showDuplicates = duplicateConfirmation !== null || candidates.length > 0;

  // ---- Edição e erros -----------------------------------------------------------------------
  const set = (name: ProcessFormField, value: string | boolean) => {
    form.setValue(name, value, { shouldDirty: true });
    form.clearErrors(name);
  };
  const onOrganizationChange = (id: string) => {
    set('organizationId', id);
    // FA-04: trocar o órgão limpa secretaria e setor; as opções são recarregadas.
    set('requestingSecretariatId', '');
    set('requestingDepartmentId', '');
  };
  const onSecretariatChange = (id: string) => {
    set('requestingSecretariatId', id);
    const next = departmentList.find((unit) => unit.id === id);
    const current = form.getValues('requestingDepartmentId');
    const stillValid = sectorOptions(departmentList, next, scope).some(
      (option) => option.department.id === current,
    );
    if (!stillValid) set('requestingDepartmentId', '');
  };

  const showErrors = (target: WizardStep, messages: FieldMessages): boolean => {
    form.clearErrors([...STEP_FIELDS[target]]);
    const first = firstErrorField(target, messages);
    for (const [field, message] of Object.entries(messages)) {
      if (isFormField(field)) form.setError(field, { type: 'validate', message });
    }
    if (first === undefined) return false;
    if (first === 'notes' || (first === 'internalCode' && !requireInternalCode)) setMoreOpen(true);
    setBanner({ kind: 'formErrors' });
    setFocusRequest((current) => ({ field: first, n: (current?.n ?? 0) + 1 }));
    return true;
  };

  const goTo = (target: WizardStep) => {
    setBanner(null);
    setNotice(null);
    setDuplicateConfirmation(null);
    setStep(target);
  };

  const goNext = () => {
    if (step === 'review') return;
    if (showErrors(step, validateStep(step, form.getValues(), context))) return;
    goTo(step === 'identification' ? 'origin' : 'review');
  };

  // Foco no título do passo a cada troca (não na primeira renderização).
  useEffect(() => {
    if (!stepFocusReady.current) {
      stepFocusReady.current = true;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (!focusRequest) return;
    document.getElementById(fieldId(focusRequest.field))?.focus();
    // `fieldId` só depende de `ids` (estável).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  // Rascunho local (FA-01): só com conteúdo digitado pela pessoa; nada vai ao servidor.
  const snapshot = JSON.stringify(values);
  useEffect(() => {
    if (finished.current) return;
    const current = form.getValues();
    if (hasUserContent(current)) saveDraft(draftKey, { version: 1, step, values: current });
    else clearDraft(draftKey);
  }, [snapshot, step, draftKey, form]);

  const dirty = hasUserContent(values) && !navigating;

  // Sair da rota com alterações (FA-01): links internos pedem confirmação antes de navegar.
  useEffect(() => {
    if (!dirty) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      if (anchor.hasAttribute('data-keep-draft')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setConfirmingExit(`${url.pathname}${url.search}${url.hash}`);
    };
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  const leave = (href: string) => {
    finished.current = true;
    clearDraft(draftKey);
    setConfirmingExit(null);
    setNavigating(true);
    router.push(href);
  };
  const cancel = () => {
    if (dirty) setConfirmingExit(LIST_PATH);
    else router.push(LIST_PATH);
  };
  const restart = () => {
    clearDraft(draftKey);
    form.reset(initialValues(currentYear));
    if (defaultOrganization) form.setValue('organizationId', defaultOrganization.id);
    prefilled.current = false;
    // Recomeçar é uma nova intenção de criar: nova chave de idempotência.
    idempotencyKey.current = newIdempotencyKey();
    setRecovered(false);
    goTo('identification');
  };

  // ---- Criação (PRC-02) ----------------------------------------------------------------------
  const create = useMutation({
    mutationFn: async (input: { body: CreateProcessInput; correlationId: string }) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await createProcess(input.body, idempotencyKey.current, input.correlationId);
        } catch (error) {
          const inProgress = isApiError(error) && error.code === 'IDEMPOTENCY_IN_PROGRESS';
          if (!inProgress || attempt >= MAX_IN_PROGRESS_ATTEMPTS) throw error;
          setNotice('inProgress');
          await sleep(inProgressDelayMs);
        }
      }
    },
  });
  const pending = create.isPending || navigating;

  const applyApiError = (error: unknown) => {
    if (!isApiError(error)) {
      setBanner({ kind: 'generic', correlationId: null });
      return;
    }
    if (error.code === 'POSSIBLE_DUPLICATE_PROCESS') {
      setDuplicateConfirmation({ candidates: duplicateCandidatesOf(error) });
      requestAnimationFrame(() => duplicatePanelRef.current?.focus());
      return;
    }
    if (error.code === 'DUPLICATE_INTERNAL_CODE') {
      const code = form.getValues('internalCode').trim();
      showErrors('review', { internalCode: t('errors.internalCodeDuplicate', { code }) });
      setBanner(null);
      return;
    }
    if (error.code === 'IDEMPOTENCY_KEY_REUSED') {
      idempotencyKey.current = newIdempotencyKey();
      setBanner({ kind: 'keyReused' });
      return;
    }
    if (error.code === 'NO_APPLICABLE_WORKFLOW') {
      setRejectedWorkflowKey(resolveKey);
      setBanner(null);
      return;
    }
    if (error.status === 403) {
      setBanner({ kind: 'permission' });
      return;
    }
    if (error.status === 422) {
      const known = error.errors.filter((item) => isFormField(item.field));
      const references = error.errors.some(
        (item) => item.code === 'REFERENCE_NOT_FOUND' || item.code === 'REFERENCE_INACTIVE',
      );
      if (references) {
        for (const key of ['catalogs', 'departments', 'organizations'] as const) {
          void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, key) });
        }
      }
      const first = known[0];
      const target = first ? stepOfField(first.field) : null;
      if (first && target) {
        setStep(target);
        form.clearErrors();
        for (const item of known) {
          if (isFormField(item.field)) {
            form.setError(item.field, { type: 'server', message: item.message });
          }
        }
        if (first.field === 'notes' || (first.field === 'internalCode' && !requireInternalCode)) {
          setMoreOpen(true);
        }
        setFocusRequest((current) => ({
          field: isFormField(first.field) ? first.field : 'title',
          n: (current?.n ?? 0) + 1,
        }));
        setBanner(references ? { kind: 'referenceInvalid' } : { kind: 'formErrors' });
        return;
      }
      setBanner({ kind: 'generic', correlationId: error.correlationId });
      return;
    }
    const unavailable = error.status === 503 || error.status === 502 || error.status === 504;
    setBanner({
      kind: unavailable ? 'unavailable' : error.status >= 500 ? 'unexpected' : 'generic',
      correlationId: error.correlationId,
    });
  };

  const onCreated = (process: { id: string; code: string | null }) => {
    finished.current = true;
    clearDraft(draftKey);
    toast({
      title: process.code ? t('toast.created', { code: process.code }) : t('toast.createdNoNumber'),
      tone: 'success',
    });
    for (const key of ['processes', 'tasks', 'dashboard'] as const) {
      void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, key) });
    }
    setNavigating(true);
    router.push(`/processos/${process.id}`);
  };

  const submit = async (confirmDuplicate: boolean) => {
    if (pending) return;
    const current = form.getValues();
    const invalid = firstInvalidStep(current, context);
    if (invalid !== null) {
      if (invalid !== 'review') {
        setStep(invalid);
        showErrors(invalid, validateStep(invalid, current, context));
      } else {
        showErrors('review', validateStep('review', current, context));
      }
      return;
    }
    setBanner(null);
    setNotice(null);
    try {
      const result = await create.mutateAsync({
        body: buildCreateBody(current, { confirmDuplicate }),
        correlationId: newCorrelationId(),
      });
      onCreated(result.data);
    } catch (error) {
      applyApiError(error);
    } finally {
      setNotice(null);
    }
  };

  // ---- Apresentação --------------------------------------------------------------------------
  const stepIndex = WIZARD_STEPS.indexOf(step);
  const stepLabel = (id: WizardStep) => t(`wizard.steps.${id}`);
  const invalidStep = reviewing ? firstInvalidStep(values, context) : null;
  const blockedByEarlierStep = invalidStep !== null && invalidStep !== 'review';
  const createDisabled = pending || noWorkflow || blockedByEarlierStep;

  const contractingStatus = lookupStatus(contractingTypes);
  const originStatus = lookupStatus(origins);
  const organizationStatus = lookupStatus(organizations);
  const departmentsStatus =
    organizationStatus !== 'ready'
      ? organizationStatus
      : organizationId === ''
        ? 'pending'
        : lookupStatus(departments);

  const selectProps = {
    placeholder: t('fields.select'),
    loadingLabel: t('loading.options'),
    errorLabel: t('loading.failed'),
    retryLabel: t('loading.retry'),
  } as const;

  const ownSectors = sectors.filter((option) => option.own);
  const sectorLabel = (option: (typeof sectors)[number]) =>
    `${INDENT.repeat(option.level)}${option.department.name}`;
  const sectorGroups: SelectGroup[] | undefined =
    ownSectors.length > 0
      ? [
          {
            label: t('fields.ownDepartments'),
            options: ownSectors.map((option) => ({
              value: option.department.id,
              label: option.department.name,
            })),
          },
          {
            label: t('fields.otherDepartments'),
            options: sectors
              .filter((option) => !option.own)
              .map((option) => ({ value: option.department.id, label: sectorLabel(option) })),
          },
        ]
      : undefined;
  const sectorFlat: SelectOption[] = sectorGroups
    ? []
    : sectors.map((option) => ({ value: option.department.id, label: sectorLabel(option) }));

  const priorityOptions: SelectOption[] = PRIORITIES.map((priority) => ({
    value: priority,
    label: t(`priorities.${priority}`),
  }));

  const summarySections = (): SummarySection[] => {
    const none = t('review.values.none');
    const labelOf = (items: readonly CatalogItemDto[] | undefined, id: string) =>
      items?.find((item) => item.id === id)?.label ?? none;
    const unitName = (id: string) => departmentList.find((unit) => unit.id === id)?.name ?? none;
    const organization = activeOrganizations.find((item) => item.id === values.organizationId);
    const decimal = toDecimalMoney(values.estimatedValue);
    let pca = none;
    if (values.pcaStatus === 'PLANNED') {
      pca = values.pcaItemCode.trim()
        ? t('review.pcaDetail.PLANNED_ITEM', {
            year: values.pcaYear,
            item: values.pcaItemCode.trim(),
          })
        : t('review.pcaDetail.PLANNED', { year: values.pcaYear });
    } else if (values.pcaStatus === 'NOT_PLANNED') {
      pca = t('review.pcaDetail.NOT_PLANNED', { justification: values.pcaJustification.trim() });
    } else if (values.pcaStatus === 'NOT_APPLICABLE') {
      pca = t('review.pcaDetail.NOT_APPLICABLE');
    }
    const origin: SummarySection['rows'] = [
      ...(activeOrganizations.length > 1
        ? [
            {
              key: 'organization',
              label: plain(t('fields.organizationId')),
              value: organization?.name ?? none,
            },
          ]
        : []),
      {
        key: 'secretariat',
        label: plain(t('fields.requestingSecretariatId', { secretariat: labels.secretariat })),
        value: unitName(values.requestingSecretariatId),
      },
      {
        key: 'department',
        label: plain(t('fields.requestingDepartmentId', { department: labels.department })),
        value: unitName(values.requestingDepartmentId),
      },
      {
        key: 'priority',
        label: plain(t('fields.priority')),
        value: values.priority === '' ? none : t(`priorities.${values.priority}`),
      },
      {
        key: 'targetDate',
        label: t('fields.targetDate'),
        value: values.targetDate ? values.targetDate.split('-').reverse().join('/') : none,
      },
      {
        key: 'estimatedValue',
        label: t('fields.estimatedValue'),
        value: decimal ? formatMoney(decimal) : none,
      },
      {
        key: 'origin',
        label: plain(t('fields.originId')),
        value: labelOf(origins.data, values.originId),
      },
      { key: 'pca', label: plain(t('fields.pcaStatus')), value: pca },
    ];
    return [
      {
        step: 'identification',
        rows: [
          { key: 'title', label: plain(t('fields.title')), value: values.title.trim() },
          { key: 'object', label: plain(t('fields.object')), value: values.object.trim() },
          ...(values.description.trim()
            ? [
                {
                  key: 'description',
                  label: t('fields.description'),
                  value: values.description.trim(),
                },
              ]
            : []),
          {
            key: 'contractingType',
            label: plain(t('fields.contractingTypeId')),
            value: labelOf(contractingTypes.data, values.contractingTypeId),
          },
          {
            key: 'modality',
            label: t('fields.modalityId'),
            value:
              values.modalityId === ''
                ? t('fields.modalityUndefined')
                : labelOf(modalities.data, values.modalityId),
          },
          {
            key: 'priceRegistration',
            label: t('fields.isPriceRegistration'),
            value: values.isPriceRegistration ? t('review.values.yes') : t('review.values.no'),
          },
        ],
      },
      { step: 'origin', rows: origin },
    ];
  };

  const bannerView = () => {
    if (!banner) return null;
    const correlation =
      'correlationId' in banner && banner.correlationId ? (
        <CorrelationCode
          correlationId={banner.correlationId}
          labels={{
            code: tErrors('correlation.label', { correlationId: banner.correlationId }),
            copy: tErrors('correlation.copy'),
            copied: tErrors('correlation.copied'),
          }}
        />
      ) : null;
    switch (banner.kind) {
      case 'formErrors':
        // O aviso some quando os campos destacados foram corrigidos.
        return Object.keys(errors).length > 0 ? (
          <Alert tone="error" title={t('wizard.formErrors')} />
        ) : null;
      case 'referenceInvalid':
        return <Alert tone="error" title={t('errors.referenceInvalid')} />;
      case 'keyReused':
        return <Alert tone="warning" title={t('errors.keyReused')} />;
      case 'permission':
        return (
          <Alert tone="error" title={t('errors.permission')}>
            <p>{t('errors.permissionHint')}</p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => {
                goTo('origin');
                setFocusRequest((current) => ({
                  field: 'requestingDepartmentId',
                  n: (current?.n ?? 0) + 1,
                }));
              }}
            >
              {stepLabel('origin')}
            </Button>
          </Alert>
        );
      case 'unavailable':
        return (
          <Alert tone="error" title={t('errors.unavailable')}>
            {correlation}
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              disabled={pending}
              onClick={() => {
                void submit(false);
              }}
            >
              {t('wizard.actions.retry')}
            </Button>
          </Alert>
        );
      case 'unexpected':
        return (
          <Alert tone="error" title={t('errors.unexpected')}>
            {correlation}
          </Alert>
        );
      case 'generic':
        return (
          <Alert tone="error" title={t('errors.generic')}>
            {correlation}
          </Alert>
        );
    }
  };

  const stepAttention = (target: Exclude<WizardStep, 'review'>) => (
    <Alert tone="warning" title={t('wizard.stepInvalid', { step: stepLabel(target) })}>
      <Button
        size="sm"
        variant="secondary"
        className="mt-2"
        onClick={() => {
          goTo(target);
          showErrors(target, validateStep(target, form.getValues(), context));
        }}
      >
        {t('wizard.goToStep', { step: stepLabel(target) })}
      </Button>
    </Alert>
  );

  const internalCodeField = (required: boolean) => (
    <FormField
      id={fieldId('internalCode')}
      label={required ? t('fields.internalCodeRequired') : t('fields.internalCode')}
      hint={t('fields.internalCodeHint')}
      error={errorOf('internalCode')}
      required={required}
    >
      {(control) => (
        <Input
          {...control}
          autoComplete="off"
          value={values.internalCode}
          onChange={(event) => {
            set('internalCode', event.target.value);
          }}
        />
      )}
    </FormField>
  );

  const moreId = fieldId('more');
  const numberingNote = readNumberingByOrganization(publicSettings.data);

  const footerActions = (
    <>
      {step === 'identification' ? null : (
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            goTo(step === 'review' ? 'origin' : 'identification');
          }}
        >
          {t('wizard.actions.back')}
        </Button>
      )}
      <Button
        key={step}
        type="submit"
        aria-busy={pending}
        disabled={step === 'review' ? createDisabled : false}
      >
        {step !== 'review'
          ? t('wizard.actions.next')
          : pending
            ? t('wizard.actions.creating')
            : t('wizard.actions.create')}
      </Button>
    </>
  );

  return (
    <>
      <form
        noValidate
        aria-label={t('wizard.title')}
        onSubmit={(event) => {
          event.preventDefault();
          if (step === 'review') void submit(false);
          else goNext();
        }}
      >
        <WizardShell
          header={<PageHeader title={t('wizard.title')} description={t('wizard.description')} />}
          steps={WIZARD_STEPS.map((id) => ({ id, label: stepLabel(id) }))}
          current={stepIndex}
          stepsLabel={t('wizard.stepperLabel')}
          stepLabels={{
            done: t('wizard.stepDone'),
            position: (current, total) => t('wizard.progress', { current, total }),
          }}
          onStepSelect={(index) => {
            const target = WIZARD_STEPS[index];
            if (target) goTo(target);
          }}
          notices={
            recovered ? (
              <Alert tone="info" title={t('draft.recovered')}>
                <p>{t('draft.recoveredHint')}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={restart}>
                    {t('draft.discard')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setRecovered(false);
                    }}
                  >
                    {t('draft.dismiss')}
                  </Button>
                </div>
              </Alert>
            ) : null
          }
          autosave={
            <Button type="button" variant="ghost" disabled={pending} onClick={cancel}>
              {t('wizard.actions.cancel')}
            </Button>
          }
          actions={footerActions}
          actionsLabel={t('wizard.footerLabel')}
        >
          <section aria-labelledby={fieldId('step-title')} className="flex min-w-0 flex-col gap-4">
            <div>
              <h2
                id={fieldId('step-title')}
                ref={headingRef}
                tabIndex={-1}
                className="text-lg font-semibold outline-none"
              >
                {stepLabel(step)}
              </h2>
              <p className="text-sm text-muted-foreground">{t(`wizard.stepHints.${step}`)}</p>
            </div>

            {bannerView()}
            {notice === 'inProgress' ? <Alert tone="info" title={t('errors.inProgress')} /> : null}

            {step === 'identification' ? (
              <div className="grid gap-4">
                <FormField
                  id={fieldId('title')}
                  label={t('fields.title')}
                  hint={t('fields.titleHint')}
                  error={errorOf('title')}
                  required
                >
                  {(control) => (
                    <Input
                      {...control}
                      autoComplete="off"
                      value={values.title}
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
                    <Textarea
                      {...control}
                      rows={4}
                      value={values.object}
                      onChange={(event) => {
                        set('object', event.target.value);
                      }}
                    />
                  )}
                </FormField>
                <FormField
                  id={fieldId('description')}
                  label={t('fields.description')}
                  hint={t('fields.descriptionHint')}
                  error={errorOf('description')}
                >
                  {(control) => (
                    <Textarea
                      {...control}
                      rows={3}
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
                  label={t('fields.contractingTypeId')}
                  value={values.contractingTypeId}
                  onChange={(value) => {
                    set('contractingTypeId', value);
                  }}
                  options={catalogOptions(contractingTypes.data)}
                  status={contractingStatus}
                  emptyMessage={t('empty.contractingType')}
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
                    label={t('fields.modalityId')}
                    placeholder={t('fields.modalityUndefined')}
                    clearLabel={t('fields.modalityUndefined')}
                    value={values.modalityId}
                    onChange={(value) => {
                      set('modalityId', value);
                    }}
                    options={catalogOptions(modalities.data)}
                    status={lookupStatus(modalities)}
                    onRetry={() => {
                      void modalities.refetch();
                    }}
                    error={errorOf('modalityId')}
                  />
                  <div className="flex min-w-0 items-start gap-2 sm:pt-7">
                    <Checkbox
                      id={fieldId('isPriceRegistration')}
                      className="mt-0.5"
                      checked={values.isPriceRegistration}
                      aria-describedby={fieldId('isPriceRegistration-hint')}
                      onCheckedChange={(checked) => {
                        set('isPriceRegistration', checked === true);
                      }}
                    />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <Label htmlFor={fieldId('isPriceRegistration')}>
                        {t('fields.isPriceRegistration')}
                      </Label>
                      <p
                        id={fieldId('isPriceRegistration-hint')}
                        className="text-xs text-muted-foreground"
                      >
                        {t('fields.isPriceRegistrationHint')}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {step === 'origin' ? (
              <div className="grid gap-4 md:grid-cols-2">
                {organizationStatus === 'ready' && activeOrganizations.length === 0 ? (
                  <p
                    role="status"
                    className="rounded-card border border-dashed border-border p-3 text-sm text-muted-foreground md:col-span-2"
                  >
                    {t('empty.organization')}
                  </p>
                ) : null}
                {organizationStatus !== 'ready' || activeOrganizations.length > 1 ? (
                  <SelectField
                    {...selectProps}
                    id={fieldId('organizationId')}
                    label={t('fields.organizationId')}
                    value={values.organizationId}
                    onChange={onOrganizationChange}
                    options={activeOrganizations.map((organization) => ({
                      value: organization.id,
                      label: organization.name,
                    }))}
                    status={organizationStatus}
                    onRetry={() => {
                      void organizations.refetch();
                    }}
                    error={errorOf('organizationId')}
                    required
                    className="md:col-span-2"
                  />
                ) : null}
                {departmentsStatus === 'ready' &&
                secretariats.length === 0 &&
                organizationStatus === 'ready' &&
                activeOrganizations.length > 0 ? (
                  <p
                    role="status"
                    className="rounded-card border border-dashed border-border p-3 text-sm text-muted-foreground md:col-span-2"
                  >
                    {t('empty.departments')}
                  </p>
                ) : (
                  <>
                    <SelectField
                      {...selectProps}
                      id={fieldId('requestingSecretariatId')}
                      label={t('fields.requestingSecretariatId', {
                        secretariat: labels.secretariat,
                      })}
                      value={values.requestingSecretariatId}
                      onChange={onSecretariatChange}
                      options={secretariats.map((unit) => ({ value: unit.id, label: unit.name }))}
                      status={departmentsStatus}
                      onRetry={() => {
                        void (organizationStatus === 'error'
                          ? organizations.refetch()
                          : departments.refetch());
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
                      options={sectorFlat}
                      groups={sectorGroups}
                      status={departmentsStatus}
                      onRetry={() => {
                        void (organizationStatus === 'error'
                          ? organizations.refetch()
                          : departments.refetch());
                      }}
                      error={errorOf('requestingDepartmentId')}
                      required
                    />
                  </>
                )}
                <SelectField
                  {...selectProps}
                  id={fieldId('priority')}
                  label={t('fields.priority')}
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
                  label={t('fields.targetDate')}
                  hint={t('fields.targetDateHint')}
                  error={errorOf('targetDate')}
                >
                  {(control) => (
                    <DatePicker
                      {...control}
                      clearable
                      value={fromIsoDate(values.targetDate)}
                      disabledDays={{ before: fromIsoDate(context.today) ?? now }}
                      onValueChange={(date) => {
                        set('targetDate', date ? toIsoDate(date) : '');
                      }}
                      labels={{
                        placeholder: t('fields.datePlaceholder'),
                        clear: t('fields.dateClear', { label: t('fields.targetDate') }),
                        calendar: t('fields.dateCalendar', { label: t('fields.targetDate') }),
                      }}
                    />
                  )}
                </FormField>
                <FormField
                  id={fieldId('estimatedValue')}
                  label={t('fields.estimatedValue')}
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
                <SelectField
                  {...selectProps}
                  id={fieldId('originId')}
                  label={t('fields.originId')}
                  value={values.originId}
                  onChange={(value) => {
                    set('originId', value);
                  }}
                  options={catalogOptions(origins.data)}
                  status={originStatus}
                  emptyMessage={t('empty.origin')}
                  onRetry={() => {
                    void origins.refetch();
                  }}
                  error={errorOf('originId')}
                  required
                />
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
              </div>
            ) : null}

            {step === 'review' ? (
              <div className="flex min-w-0 flex-col gap-4">
                {invalidStep !== null && invalidStep !== 'review'
                  ? stepAttention(invalidStep)
                  : null}
                <ReviewSummary sections={summarySections()} onEdit={goTo} />
                {numberingNote ? (
                  <p className="text-sm text-muted-foreground">
                    {t('review.numberingByOrganization')}
                  </p>
                ) : null}
                {showDuplicates ? (
                  <DuplicateWarningPanel
                    ref={duplicatePanelRef}
                    candidates={candidates}
                    timeZone={session.activeTenant.timezone}
                    pending={pending}
                    onCreateAnyway={() => {
                      void submit(true);
                    }}
                  />
                ) : duplicates.isFetching ? (
                  <p role="status" className="sr-only">
                    {t('duplicates.checking')}
                  </p>
                ) : null}
                <WorkflowPreviewCard state={workflowState} />
                {requireInternalCode ? internalCodeField(true) : null}
                <div className="rounded-card border border-border bg-surface">
                  <h3 className="text-sm font-semibold">
                    <button
                      type="button"
                      aria-expanded={moreOpen}
                      aria-controls={moreId}
                      className="flex min-h-10 w-full items-center justify-between gap-2 px-4 text-left"
                      onClick={() => {
                        setMoreOpen((open) => !open);
                      }}
                    >
                      <span>
                        {t('review.moreInfo')}
                        <span className="block text-xs font-normal text-muted-foreground">
                          {t('review.moreInfoHint')}
                        </span>
                      </span>
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className={cx(
                          'size-4 flex-none transition-transform',
                          moreOpen && 'rotate-180',
                        )}
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                  </h3>
                  <div id={moreId} hidden={!moreOpen} className="grid gap-4 px-4 pb-4">
                    {requireInternalCode ? null : internalCodeField(false)}
                    <FormField
                      id={fieldId('notes')}
                      label={t('fields.notes')}
                      error={errorOf('notes')}
                    >
                      {(control) => (
                        <Textarea
                          {...control}
                          rows={3}
                          value={values.notes}
                          onChange={(event) => {
                            set('notes', event.target.value);
                          }}
                        />
                      )}
                    </FormField>
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        </WizardShell>
      </form>

      <Dialog
        open={confirmingExit !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingExit(null);
        }}
      >
        <DialogContent>
          <DialogTitle>{t('cancel.title')}</DialogTitle>
          <DialogDescription>{t('cancel.description')}</DialogDescription>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmingExit(null);
              }}
            >
              {t('cancel.keep')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmingExit) leave(confirmingExit);
              }}
            >
              {t('cancel.discard')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
