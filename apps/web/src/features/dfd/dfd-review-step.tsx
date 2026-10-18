'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import type {
  DfdHeaderValues,
  DfdWizardStep,
  DocumentValidationDto,
  Violation,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { useTenantId } from '@/lib/session/session-context';

import { fieldAnchor, violationsByStep } from './dfd-model';
import { documentKeys, fetchDocumentValidation } from '../documents/documents.api';
import { GeneratePdfButton } from '../documents/generate-pdf-button';

/** DOC-08 do DFD (`['t', tenantId, 'documents', id, 'validation']`), invalidado a cada gravação. */
export function useDfdValidation(documentId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: documentKeys.validation(tenantId, documentId),
    queryFn: ({ signal }) => fetchDocumentValidation(documentId, signal),
    throwOnError: false,
  });
}

export interface DfdReviewStepProps {
  readonly documentId: string;
  readonly header: DfdHeaderValues;
  readonly departmentName: string;
  readonly responsibleName: string;
  readonly itemsCount: number;
  readonly onGoTo: (step: DfdWizardStep, anchor: string) => void;
}

/**
 * `DfdReviewStep` (SCR-007 · passo 4 · RN-DFD-18/19): o checklist do DOC-08 agrupado por passo —
 * "Pendências obrigatórias" e "Alertas", cada item com "Ir para o campo" (abre o passo e foca o
 * campo ou a seção) — anunciado em região `aria-live`; o resumo em modo leitura e a prévia em PDF
 * (DOC-20 → DOC-22 a cada 2 s → DOC-23, marca d'água "RASCUNHO").
 */
export function DfdReviewStep({
  documentId,
  header,
  departmentName,
  responsibleName,
  itemsCount,
  onGoTo,
}: DfdReviewStepProps) {
  const t = useTranslations('dfd');
  const validation = useDfdValidation(documentId);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section aria-labelledby="dfd-checklist-title" className="flex flex-col gap-3">
        <h3 id="dfd-checklist-title" className="text-base font-semibold">
          {t('review.title')}
        </h3>
        <div aria-live="polite">
          <Checklist
            validation={validation.data}
            error={validation.error !== null}
            onRetry={() => {
              void validation.refetch();
            }}
            onGoTo={onGoTo}
          />
        </div>
      </section>
      <section aria-labelledby="dfd-summary-title" className="flex flex-col gap-3">
        <h3 id="dfd-summary-title" className="text-base font-semibold">
          {t('review.summaryTitle')}
        </h3>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm md:grid-cols-2">
          <SummaryRow label={t('identification.requestDate')} value={header.requestDate} />
          <SummaryRow label={t('identification.department')} value={departmentName} />
          <SummaryRow label={t('identification.responsible')} value={responsibleName} />
          <SummaryRow
            label={t('identification.priority')}
            value={
              header.priority === null ? null : t(`identification.priorities.${header.priority}`)
            }
          />
          <SummaryRow label={t('identification.object')} value={header.objectSummary} wide />
          <SummaryRow label={t('planning.expectedDate')} value={header.expectedDate} />
          <SummaryRow
            label={t('planning.estimatedValue')}
            value={
              header.estimatedValueMasked === true
                ? t('planning.confidentialValue')
                : header.estimatedValue
            }
          />
          <SummaryRow
            label={t('planning.itemsTitle')}
            value={t('review.itemsCount', { count: itemsCount })}
          />
        </dl>
      </section>
      <section aria-labelledby="dfd-preview-title" className="flex flex-col gap-2">
        <h3 id="dfd-preview-title" className="text-base font-semibold">
          {t('review.previewTitle')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('review.previewHint')}</p>
        <GeneratePdfButton
          source={{ kind: 'preview', documentId }}
          label={t('review.previewAction')}
        />
      </section>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  wide = false,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly wide?: boolean;
}) {
  const t = useTranslations('dfd.summary');
  return (
    <div className={wide ? 'md:col-span-2' : undefined}>
      <dt className="font-medium">{label.replace(' *', '')}</dt>
      <dd className="text-muted-foreground">
        {value === null || value === '' ? t('empty') : value}
      </dd>
    </div>
  );
}

function Checklist({
  validation,
  error,
  onRetry,
  onGoTo,
}: {
  readonly validation: DocumentValidationDto | undefined;
  readonly error: boolean;
  readonly onRetry: () => void;
  readonly onGoTo: (step: DfdWizardStep, anchor: string) => void;
}) {
  const t = useTranslations('dfd');
  if (validation === undefined) {
    if (error) {
      return (
        <Alert tone="error" title={t('review.error')}>
          <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
            {t('retry')}
          </Button>
        </Alert>
      );
    }
    return (
      <div role="status">
        <span className="sr-only">{t('review.loading')}</span>
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (validation.violations.length === 0) {
    return (
      <Alert tone="success" title={`✓ ${t('review.clean')}`}>
        <p>{t('review.cleanHint')}</p>
      </Alert>
    );
  }
  const groups = violationsByStep(validation.violations);
  const blocking = groups.flatMap((group) =>
    group.blocking.map((item) => ({ item, step: group.step })),
  );
  const warnings = groups.flatMap((group) =>
    group.warnings.map((item) => ({ item, step: group.step })),
  );
  return (
    <div className="flex flex-col gap-4">
      {blocking.length > 0 ? (
        <ViolationGroup title={t('review.blocking')} entries={blocking} onGoTo={onGoTo} />
      ) : null}
      {warnings.length > 0 ? (
        <ViolationGroup title={t('review.warnings')} entries={warnings} onGoTo={onGoTo} />
      ) : null}
    </div>
  );
}

function ViolationGroup({
  title,
  entries,
  onGoTo,
}: {
  readonly title: string;
  readonly entries: readonly { readonly item: Violation; readonly step: DfdWizardStep }[];
  readonly onGoTo: (step: DfdWizardStep, anchor: string) => void;
}) {
  const t = useTranslations('dfd');
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold">{title}</h4>
      <ul aria-label={title} className="flex flex-col gap-2">
        {entries.map(({ item, step }, index) => (
          <li
            key={`${item.code}:${item.field ?? ''}:${item.sectionKey ?? ''}:${String(index)}`}
            className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-border p-3 text-sm"
          >
            <span>
              <span aria-hidden="true">{item.severity === 'BLOCKING' ? '⛔ ' : '⚠ '}</span>
              {item.message}
              <span className="ml-1 text-muted-foreground">· {t(`steps.${step}`)}</span>
            </span>
            <Button
              size="sm"
              variant="secondary"
              aria-label={t('review.goToStep', { step: t(`steps.${step}`) })}
              onClick={() => {
                onGoTo(step, fieldAnchor(item));
              }}
            >
              {t('review.goTo')}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * `DfdConclusionStep` (SCR-007 · passo 5): o estado de prontidão ("Sem pendências" ou "Há N
 * pendências obrigatórias") — a mesma avaliação do DOC-08. As ações "Concluir e enviar para
 * aprovação" e "Finalizar DFD" são da US-016 e entram nesta área.
 */
export function DfdConclusionStep({ documentId }: { readonly documentId: string }) {
  const t = useTranslations('dfd.conclusion');
  const validation = useDfdValidation(documentId);
  if (validation.data === undefined) {
    return (
      <div role="status">
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  const blocking = validation.data.summary.blocking;
  return (
    <div aria-live="polite" data-testid="dfd-conclusion-actions">
      {blocking === 0 ? (
        <Alert tone="success" title={`✓ ${t('ready')}`} />
      ) : (
        <Alert tone="warning" title={t('pending', { count: blocking })}>
          <p>{t('pendingHint')}</p>
        </Alert>
      )}
    </div>
  );
}
