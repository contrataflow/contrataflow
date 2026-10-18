'use client';

import { localDateOf } from '@contrataflow/types';
import { Alert, AutosaveIndicator, Button, Skeleton, Stepper } from '@contrataflow/ui';
import { DFD_WIZARD_STEPS, dfdStepIssues } from '@contrataflow/validation';
import type {
  DfdDto,
  DfdHeaderField,
  DfdHeaderValues,
  DfdMeta,
  DfdWizardStep,
  DocumentDto,
  ProcessDto,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useShellSession } from '@/lib/session/session-context';

import { resumeStep } from './dfd-autosave';
import type { DfdHeaderDraft } from './dfd-autosave';
import { DfdAutosavePanels } from './dfd-autosave-panels';
import { DfdIdentificationStep } from './dfd-identification-step';
import { DfdJustificationStep } from './dfd-justification-step';
import {
  DFD_STEP_SLUGS,
  canEditDfd,
  departmentsOfSecretariat,
  headerOf,
  stepFromSlug,
  stepIndex,
} from './dfd-model';
import { DfdPlanningStep, estimatedValueOf } from './dfd-planning-step';
import { DfdConclusionStep, DfdReviewStep, useDfdValidation } from './dfd-review-step';
import { useDfd, useDocumentItems } from './dfd.api';
import { sectionText, useDfdAutosave } from './use-dfd-autosave';
import { AiAssistant } from '../ai/ai-assistant';
import type { UploadDeps } from '../attachments/use-attachment-uploads';
import { DocumentStatusBadge } from '../documents/document-status-badge';
import { documentKeys, fetchDocument } from '../documents/documents.api';
import { formatMoneyText } from '../processes/money';
import {
  WIZARD_LOOKUP_STALE_TIME_MS,
  fetchActiveDepartments,
  fetchProcess,
  processKeys,
} from '../processes/processes.api';

export interface DfdWizardProps {
  readonly processId: string;
  readonly dfdId: string;
  /** Testes: sondagem e XHR simulados do upload de anexos. */
  readonly uploadDeps?: UploadDeps | undefined;
}

/**
 * SCR-007 — DFD em wizard (`/processos/[id]/dfd/[dfdId]?passo=…`, US-014 · DEC-181/183): carrega
 * em paralelo DFD-03 (cabeçalho, ações e a versão de template fixada), DOC-03 (rascunho das seções),
 * o processo e as unidades; os itens (DOC-06/07), o checklist (DOC-08) e a prévia (DOC-20) ficam nos
 * passos. Stepper navegável por teclado com `aria-current="step"`; o foco vai ao título do passo a
 * cada troca; "Continuar" valida os campos do passo no cliente (`dfdStepIssues` — V-05) e "Voltar"
 * é sempre livre (RN-DFD-21). Sem `UPDATE` em `meta.allowedActions`, todos os passos abrem em modo
 * leitura com a faixa de status (FA-05). US-015: autosave do cabeçalho (DFD-04) e das seções
 * (DOC-05) com indicador, conflito, contingência local e retomada do passo (`wizardStep` —
 * RN-DFD-34); os itens gravam pelo DOC-07 na própria grade.
 */
export function DfdWizard({ processId, dfdId, uploadDeps }: DfdWizardProps) {
  const t = useTranslations('dfd');
  const dfd = useDfd(dfdId);
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const documentId = dfd.data?.dfd.documentId ?? dfdId;
  const document = useQuery({
    queryKey: documentKeys.detail(tenantId, documentId),
    queryFn: ({ signal }) => fetchDocument(documentId, signal),
    throwOnError: false,
  });
  const process = useQuery({
    queryKey: processKeys.detail(tenantId, processId),
    queryFn: ({ signal }) => fetchProcess(processId, signal),
    throwOnError: false,
  });

  if (dfd.data === undefined || document.data === undefined) {
    const error = dfd.error ?? document.error;
    if (error === null) {
      return (
        <div role="status" className="mx-auto flex w-full max-w-5xl flex-col gap-3">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      );
    }
    return (
      <div className="mx-auto w-full max-w-5xl">
        <Alert
          tone="error"
          title={isApiError(error) && error.status === 404 ? t('notFound') : t('loadError')}
        >
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => {
              void dfd.refetch();
              void document.refetch();
            }}
          >
            {t('retry')}
          </Button>
        </Alert>
      </div>
    );
  }
  return (
    <LoadedWizard
      processId={processId}
      dfd={dfd.data.dfd}
      meta={dfd.data.meta}
      document={document.data.document}
      process={process.data}
      uploadDeps={uploadDeps}
    />
  );
}

/** Texto das seções do rascunho (o editor edita texto simples; DOC-05 grava como TipTap). */
function sectionTexts(document: DocumentDto): Record<string, string> {
  return Object.fromEntries(
    Object.keys(document.draftContent.sections).map((key) => [key, sectionText(document, key)]),
  );
}

function LoadedWizard({
  processId,
  dfd,
  meta,
  document,
  process,
  uploadDeps,
}: {
  readonly processId: string;
  readonly dfd: DfdDto;
  readonly meta: DfdMeta;
  readonly document: DocumentDto;
  readonly process: ProcessDto | undefined;
  readonly uploadDeps: UploadDeps | undefined;
}) {
  const t = useTranslations('dfd');
  const session = useShellSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const heading = useRef<HTMLHeadingElement>(null);
  const focusTarget = useRef<string | null>(null);
  const timeZone = session.activeTenant.timezone;
  const today = localDateOf(new Date(), timeZone);

  const allowed = canEditDfd(meta.allowedActions);
  const [header, setHeader] = useState<DfdHeaderValues>(() => headerOf(dfd));
  const [wizard, setWizard] = useState<Pick<DfdHeaderDraft, 'wizardStep' | 'completedSteps'>>(
    () => ({ wizardStep: dfd.wizardStep, completedSteps: dfd.completedSteps }),
  );
  const [sections, setSections] = useState<Record<string, string>>(() => sectionTexts(document));
  const autosave = useDfdAutosave({
    dfd,
    meta,
    document,
    tenantId: session.activeTenant.id,
    userId: session.user.id,
    today,
    enabled: allowed,
    onSectionText: (key, text) => {
      setSections((previous) => ({ ...previous, [key]: text }));
    },
    onHeader: (draft) => {
      const { wizardStep: _step, completedSteps: _steps, ...values } = draft;
      setHeader(values);
    },
  });
  const editable = allowed && autosave.blocked === null;
  // RN-DFD-34: sem `?passo=`, abre no passo salvo — na Conclusão com pendência, na Revisão.
  const resumeValidation = useDfdValidation(
    dfd.documentId,
    dfd.wizardStep === 'CONCLUSION' && searchParams.get('passo') === null,
  );
  const blocking = (resumeValidation.data?.summary.blocking ?? 0) > 0;
  const step = stepFromSlug(searchParams.get('passo')) ?? resumeStep(dfd.wizardStep, blocking);
  const current = stepIndex(step);
  const [estimatedValueText, setEstimatedValueText] = useState(() =>
    dfd.estimatedValue === null ? '' : formatMoneyText(dfd.estimatedValue),
  );
  const [responsibleName, setResponsibleName] = useState(() =>
    dfd.responsibleId === session.user.id ? session.user.displayName : '',
  );
  const [errors, setErrors] = useState<Partial<Record<DfdHeaderField, string>>>({});
  const items = useDocumentItems(dfd.documentId);
  const departments = useQuery({
    queryKey: processKeys.activeDepartments(
      session.activeTenant.id,
      process?.organization.id ?? '',
    ),
    queryFn: ({ signal }) => fetchActiveDepartments(process?.organization.id ?? '', signal),
    enabled: process !== undefined,
    staleTime: WIZARD_LOOKUP_STALE_TIME_MS,
    throwOnError: false,
  });

  // Foco no título do passo a cada troca, ou no campo indicado pelo "Ir para o campo" — que pode
  // aparecer só depois da carga do passo (a grade de itens): espera-o por até 3 s.
  useEffect(() => {
    const target = focusTarget.current;
    focusTarget.current = null;
    const find = () => (target === null ? null : window.document.getElementById(target));
    const found = find();
    if (found !== null || target === null) {
      (found ?? heading.current)?.focus();
      return;
    }
    heading.current?.focus();
    const observer = new MutationObserver(() => {
      const element = find();
      if (element === null) return;
      observer.disconnect();
      element.focus();
    });
    observer.observe(window.document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
    }, 3000);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [step]);

  /** O cabeçalho como o autosave o grava (campos + passo do wizard). */
  const draftOf = (
    values: DfdHeaderValues,
    steps: Pick<DfdHeaderDraft, 'wizardStep' | 'completedSteps'> = wizard,
  ): DfdHeaderDraft => ({ ...values, ...steps });

  const goTo = (next: DfdWizardStep, anchor: string | null = null, completed?: DfdWizardStep) => {
    focusTarget.current = anchor;
    setErrors({});
    router.replace(`${pathname}?passo=${DFD_STEP_SLUGS[next]}`, { scroll: false });
    if (!editable) return;
    // Troca de passo: descarrega as pendências e grava `{ wizardStep, completedSteps }` (DFD-04).
    const steps = {
      wizardStep: next,
      completedSteps:
        completed === undefined || wizard.completedSteps.includes(completed)
          ? wizard.completedSteps
          : [...wizard.completedSteps, completed],
    };
    setWizard(steps);
    autosave.changeHeader(draftOf(header, steps));
    void autosave.flush();
  };

  // Perda de foco de um campo do passo: grava já o que estiver pendente (RN-DFD-23).
  const stepSection = useRef<HTMLElement>(null);
  const flushOnBlur = useRef<() => void>(() => undefined);
  useEffect(() => {
    flushOnBlur.current = () => {
      if (editable) void autosave.flush();
    };
  });
  useEffect(() => {
    const element = stepSection.current;
    if (element === null) return;
    const listener = () => {
      flushOnBlur.current();
    };
    element.addEventListener('focusout', listener);
    return () => {
      element.removeEventListener('focusout', listener);
    };
  }, []);

  const fieldConfig = meta.template?.fieldConfig ?? {};
  const onContinue = () => {
    const issues = editable ? dfdStepIssues(step, header, { fieldConfig, today }) : {};
    const fields = Object.keys(issues);
    if (fields.length > 0) {
      setErrors(issues);
      window.document.getElementById(`dfd-field-${fields[0] ?? ''}`)?.focus();
      return;
    }
    const next = DFD_WIZARD_STEPS[current + 1];
    if (next !== undefined) goTo(next, null, step);
  };

  const change = (field: DfdHeaderField, value: string | number | null) => {
    const next = { ...header, [field]: value };
    setHeader(next);
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    if (editable) autosave.changeHeader(draftOf(next));
  };
  const changeSection = (key: string, value: string) => {
    setSections((previous) => ({ ...previous, [key]: value }));
    if (editable) autosave.changeSection(key, value);
  };

  const templateSections = meta.template?.sections ?? [];
  const departmentOptions = departmentsOfSecretariat(
    departments.data ?? [],
    process?.requestingSecretariat.id ?? '',
  );
  const departmentName =
    departmentOptions.find((item) => item.id === header.requestingDepartmentId)?.name ??
    (process?.requestingDepartment.id === header.requestingDepartmentId
      ? process.requestingDepartment.name
      : '');

  const steps = DFD_WIZARD_STEPS.map((id) => ({ id, label: t(`steps.${id}`) }));

  return (
    <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link href={`/processos/${processId}`} className="text-sm text-primary underline">
          {t('backToProcess')}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{dfd.code ?? t('title')}</h1>
          <DocumentStatusBadge status={dfd.status} />
          <AiAssistant
            processId={processId}
            documentId={dfd.documentId}
            targetModule="DFD"
            editable={dfd.status === 'DRAFT' || dfd.status === 'RETURNED'}
            initialGenerationId={searchParams.get('ia')}
            onApplied={(applied) => void autosave.adoptSections(applied)}
          />
          {allowed ? (
            <AutosaveIndicator
              className="ml-auto"
              status={autosave.snapshot.status}
              savedAt={autosave.snapshot.savedAt}
              message={autosave.snapshot.message}
              labels={{
                dirty: t('autosave.indicator.dirty'),
                saving: t('autosave.indicator.saving'),
                saved: (time) => t('autosave.indicator.saved', { time }),
                savedShort: t('autosave.indicator.savedShort'),
                error: t('autosave.indicator.error'),
                offline: t('autosave.indicator.offline'),
                offlineShort: t('autosave.indicator.offlineShort'),
                conflict: t('autosave.indicator.conflict'),
                blocked: t('autosave.indicator.blocked'),
              }}
            />
          ) : null}
        </div>
        {process === undefined ? null : (
          <p className="text-sm text-muted-foreground">
            {t('processLine', { code: process.code ?? t('draftCode'), title: process.title })}
          </p>
        )}
      </div>
      <DfdAutosavePanels
        autosave={autosave}
        userId={session.user.id}
        timeZone={timeZone}
        sections={sections}
        templateSections={meta.template?.sections ?? []}
      />
      {allowed ? null : (
        <Alert tone="info" title={t('readOnly.title')}>
          <p>
            {t(`readOnly.status.${dfd.status}`)}
            {dfd.status === 'DRAFT' || dfd.status === 'RETURNED'
              ? ` · ${t('readOnly.noPermission')}`
              : ''}
          </p>
        </Alert>
      )}
      <Stepper
        steps={steps}
        current={current}
        label={t('stepper.label')}
        progressLabel={t('stepper.progress', { current: current + 1, total: steps.length })}
        completeLabel={t('stepper.complete')}
        onStepSelect={(index) => {
          const target = DFD_WIZARD_STEPS[index];
          if (target !== undefined) goTo(target);
        }}
      />
      <section
        ref={stepSection}
        aria-labelledby="dfd-step-title"
        className="flex min-w-0 flex-col gap-4"
      >
        <h2 id="dfd-step-title" ref={heading} tabIndex={-1} className="text-lg font-semibold">
          {t(`steps.${step}`)}
        </h2>
        {step === 'IDENTIFICATION' ? (
          <DfdIdentificationStep
            code={dfd.code}
            header={header}
            errors={errors}
            editable={editable}
            processPriority={process?.priority ?? dfd.priority}
            secretariatName={process?.requestingSecretariat.name ?? ''}
            departments={departmentOptions}
            responsibleName={responsibleName}
            today={today}
            onChange={change}
            onResponsibleChange={(id, name) => {
              change('responsibleId', id === '' ? null : id);
              setResponsibleName(name);
            }}
          />
        ) : null}
        {step === 'JUSTIFICATION' ? (
          <DfdJustificationStep
            processId={processId}
            documentId={dfd.documentId}
            sections={templateSections.filter((section) => section.key !== 'NOTES')}
            values={sections}
            editable={editable}
            allowedActions={meta.allowedActions}
            onChange={changeSection}
            uploadDeps={uploadDeps}
          />
        ) : null}
        {step === 'PLANNING' ? (
          <DfdPlanningStep
            processId={processId}
            documentId={dfd.documentId}
            header={header}
            errors={errors}
            editable={editable}
            process={process}
            currentYear={Number(today.slice(0, 4))}
            notesSection={templateSections.find((section) => section.key === 'NOTES') ?? null}
            notes={sections.NOTES ?? ''}
            estimatedValueText={estimatedValueText}
            onChange={change}
            onEstimatedValueText={(text) => {
              setEstimatedValueText(text);
              change('estimatedValue', estimatedValueOf(text));
            }}
            onSectionChange={changeSection}
          />
        ) : null}
        {step === 'REVIEW' ? (
          <DfdReviewStep
            documentId={dfd.documentId}
            header={header}
            departmentName={departmentName}
            responsibleName={responsibleName}
            itemsCount={items.data?.items.length ?? 0}
            onGoTo={goTo}
          />
        ) : null}
        {step === 'CONCLUSION' ? <DfdConclusionStep documentId={dfd.documentId} /> : null}
      </section>
      <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="secondary"
          disabled={current === 0}
          onClick={() => {
            const previous = DFD_WIZARD_STEPS[current - 1];
            if (previous !== undefined) goTo(previous);
          }}
        >
          {t('nav.back')}
        </Button>
        {current < DFD_WIZARD_STEPS.length - 1 ? (
          <Button variant="primary" onClick={onContinue}>
            {t('nav.continue')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
