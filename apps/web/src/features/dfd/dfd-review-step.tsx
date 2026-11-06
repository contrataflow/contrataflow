'use client';

import {
  Alert,
  Button,
  CircleAlert,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Skeleton,
  TriangleAlert,
} from '@contrataflow/ui';
import type {
  DfdHeaderValues,
  DfdWizardStep,
  DocumentValidationDto,
  Violation,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useTenantId } from '@/lib/session/session-context';

import { aiGeneratedSectionsOf } from './dfd-ai-review';
import type { DfdAiReview } from './dfd-ai-review';
import { STEP_CARD } from './dfd-justification-step';
import { fieldAnchor, violationsByStep } from './dfd-model';
import { ReviewAllDialog } from '../documents/ai-review';
import { sectionLabelOf } from '../documents/ai-review-model';
import type { AiSectionState } from '../documents/ai-review-model';
import { documentKeys, fetchDocumentValidation } from '../documents/documents.api';
import { GeneratePdfButton } from '../documents/generate-pdf-button';

/** DOC-08 do DFD (`['t', tenantId, 'documents', id, 'validation']`), invalidado a cada gravação. */
export function useDfdValidation(documentId: string, enabled = true) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: documentKeys.validation(tenantId, documentId),
    queryFn: ({ signal }) => fetchDocumentValidation(documentId, signal),
    enabled,
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
  /** US-122: a revisão do conteúdo de IA no próprio passo (DOC-27); sem ela, só "Ir para o campo". */
  readonly aiReview?: DfdAiReview | undefined;
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
  aiReview,
}: DfdReviewStepProps) {
  const t = useTranslations('dfd');
  const validation = useDfdValidation(documentId);
  const pending = validation.data?.violations.length ?? 0;
  const [reviewing, setReviewing] = useState<readonly AiSectionState[] | null>(null);
  const [announcement, setAnnouncement] = useState('');
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Collapsible defaultOpen asChild>
        <section aria-labelledby="dfd-checklist-title" className={STEP_CARD}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="dfd-checklist-title" className="text-section-title text-brand-ink">
              {t('review.title')}
              {pending > 0 ? (
                <span className="ml-2 text-sm font-semibold text-muted-foreground">
                  {t('review.pendingCount', { count: pending })}
                </span>
              ) : null}
            </h3>
            <CollapsibleTrigger>{t('review.toggle')}</CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <div aria-live="polite">
              <Checklist
                validation={validation.data}
                error={validation.error !== null}
                onRetry={() => {
                  void validation.refetch();
                }}
                onGoTo={onGoTo}
                aiReview={aiReview}
                onReview={setReviewing}
              />
            </div>
            <p aria-live="polite" className="sr-only">
              {announcement}
            </p>
          </CollapsibleContent>
        </section>
      </Collapsible>
      <section aria-labelledby="dfd-summary-title" className={STEP_CARD}>
        <h3 id="dfd-summary-title" className="text-section-title text-brand-ink">
          {t('review.summaryTitle')}
        </h3>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-2">
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
      <section aria-labelledby="dfd-preview-title" className={STEP_CARD}>
        <h3 id="dfd-preview-title" className="text-section-title text-brand-ink">
          {t('review.previewTitle')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('review.previewHint')}</p>
        <GeneratePdfButton
          source={{ kind: 'preview', documentId }}
          label={t('review.previewAction')}
        />
      </section>
      {aiReview !== undefined && reviewing !== null ? (
        <ReviewAllDialog
          document={aiReview.document}
          sections={reviewing}
          host={aiReview.host}
          onClose={() => {
            setReviewing(null);
          }}
          onReviewed={setAnnouncement}
        />
      ) : null}
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
      <dt className="text-label font-semibold text-muted-foreground uppercase">
        {label.replace(' *', '')}
      </dt>
      <dd className="font-medium break-words">
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
  aiReview,
  onReview,
}: {
  readonly validation: DocumentValidationDto | undefined;
  readonly error: boolean;
  readonly onRetry: () => void;
  readonly onGoTo: (step: DfdWizardStep, anchor: string) => void;
  readonly aiReview: DfdAiReview | undefined;
  readonly onReview: (sections: readonly AiSectionState[]) => void;
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
      <Alert tone="success" title={t('review.clean')}>
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
        <ViolationGroup
          title={t('review.blocking')}
          entries={blocking}
          onGoTo={onGoTo}
          aiReview={aiReview}
          onReview={onReview}
        />
      ) : null}
      {warnings.length > 0 ? (
        <ViolationGroup
          title={t('review.warnings')}
          entries={warnings}
          onGoTo={onGoTo}
          aiReview={aiReview}
          onReview={onReview}
        />
      ) : null}
    </div>
  );
}

function ViolationGroup({
  title,
  entries,
  onGoTo,
  aiReview,
  onReview,
}: {
  readonly title: string;
  readonly entries: readonly { readonly item: Violation; readonly step: DfdWizardStep }[];
  readonly onGoTo: (step: DfdWizardStep, anchor: string) => void;
  readonly aiReview: DfdAiReview | undefined;
  readonly onReview: (sections: readonly AiSectionState[]) => void;
}) {
  const t = useTranslations('dfd');
  // US-122: a revisão pendente de cada seção de IA vira ação (DOC-27); com 2+, "Revisar todas".
  const pendingByKey = new Map(
    aiReview?.canReview !== true
      ? []
      : aiGeneratedSectionsOf(aiReview.document)
          .filter((section) => section.pending)
          .map((section) => [section.key, section] as const),
  );
  const reviewable = (item: Violation): AiSectionState | undefined =>
    item.code === 'SECTION_AI_REVIEW_PENDING' && item.sectionKey !== null
      ? pendingByKey.get(item.sectionKey)
      : undefined;
  const reviewables = entries.flatMap(({ item }) => reviewable(item) ?? []);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{title}</h4>
        {reviewables.length >= 2 ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              onReview(reviewables);
            }}
          >
            {t('review.reviewAll', { count: reviewables.length })}
          </Button>
        ) : null}
      </div>
      <ul aria-label={title} className="flex flex-col divide-y divide-border">
        {entries.map(({ item, step }, index) => (
          <li
            key={`${item.code}:${item.field ?? ''}:${item.sectionKey ?? ''}:${String(index)}`}
            className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
          >
            <span className="flex min-w-0 items-start gap-2">
              {item.severity === 'BLOCKING' ? (
                <CircleAlert className="mt-0.5 size-4 flex-none text-destructive" />
              ) : (
                <TriangleAlert className="mt-0.5 size-4 flex-none text-warning" />
              )}
              <span className="min-w-0">
                {item.message}
                <span className="ml-1 text-muted-foreground">· {t(`steps.${step}`)}</span>
              </span>
            </span>
            <span className="flex flex-none flex-wrap items-center gap-1">
              {(() => {
                const section = reviewable(item);
                return section === undefined ? null : (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={t('review.markReviewedOf', {
                      section: sectionLabelOf(section.key, aiReview?.host.titles),
                    })}
                    onClick={() => {
                      onReview([section]);
                    }}
                  >
                    {t('review.markReviewed')}
                  </Button>
                );
              })()}
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('review.goToStep', { step: t(`steps.${step}`) })}
                onClick={() => {
                  onGoTo(step, fieldAnchor(item));
                }}
              >
                {t('review.goTo')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
