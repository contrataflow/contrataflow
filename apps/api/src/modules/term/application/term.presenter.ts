import { completenessPercent } from '@contrataflow/validation';
import type {
  DocumentAction,
  TermCompletenessDto,
  TermDetailDto,
  TermDetailMeta,
  TermDto,
  TermMeta,
  TermPriceResearchRefDto,
  TermSummaryDto,
  TermTemplateOptionDto,
} from '@contrataflow/validation';

import { isCompletedPriceResearch } from '#shared/price-research/price-research-summary.js';
import type { PriceResearchSummary } from '#shared/price-research/price-research-summary.js';

import type {
  Document,
  DocumentState,
  PublishedTemplateOption,
  SectionCompletenessFact,
  TypedDocumentView,
} from '../../document/application/document.facade.js';
import type { TermOfReference } from '../domain/term-of-reference.js';

/*
 * Serialização do TR (US-036 · api/09-term-of-reference.md TRM-01..04): o cabeçalho tipado + o resumo
 * do documento. POL-09 (DEC-030 · RN-TR-09) é aplicada AQUI, no serializador único: sem a política
 * em processo sigiloso, `estimatedTotalValue = null` com `estimatedTotalValueMasked = true` (e o
 * total das pesquisas também sai `null`) — a tela nunca decide a máscara.
 */

export interface TermMasking {
  readonly masked: boolean;
}

type DocumentPart = Pick<
  Document,
  | 'code'
  | 'title'
  | 'status'
  | 'templateVersionId'
  | 'version'
  | 'responsibleId'
  | 'pendingApprovalId'
>;

export function toTermDto(
  term: TermOfReference,
  document: DocumentPart,
  templateVersion: { readonly id: string; readonly versionNumber: number } | null,
  { masked }: TermMasking,
): TermDto {
  return {
    id: term.id,
    documentId: term.documentId,
    processId: term.processId,
    code: document.code,
    title: document.title,
    status: document.status,
    inApproval: document.pendingApprovalId !== null,
    templateVersion:
      templateVersion === null
        ? null
        : { id: templateVersion.id, versionNumber: templateVersion.versionNumber },
    responsibleId: document.responsibleId,
    objectDefinition: term.objectDefinition,
    contractDurationMonths: term.contractDurationMonths,
    executionDeadline: term.executionDeadline,
    executionDeadlineType: term.executionDeadlineType,
    deliveryLocation: term.deliveryLocation,
    paymentTermDays: term.paymentTermDays,
    productWarrantyMonths: term.productWarrantyMonths,
    contractGuaranteePercent: term.contractGuaranteePercent,
    allowsSubcontracting: term.allowsSubcontracting,
    selectionCriterionId: term.selectionCriterionId,
    awardType: term.awardType,
    estimatedTotalValue: masked ? null : term.estimatedTotalValue,
    estimatedTotalValueMasked: masked,
    estimatedValueSource: term.estimatedValueSource,
    priceResearchId: term.priceResearchId,
    importedFromEtpId: term.importedFromEtpId,
    importedFromEtpVersionId: term.importedFromEtpVersionId,
    importedAt: term.importedAt?.toISOString() ?? null,
    importedById: term.importedById,
    documentVersion: document.version,
    createdAt: term.createdAt.toISOString(),
    updatedAt: term.updatedAt.toISOString(),
    version: term.version,
  };
}

export function toTermMeta(allowedActions: readonly DocumentAction[]): TermMeta {
  return { allowedActions: [...allowedActions] };
}

export function toTermSummaryDto(term: TermOfReference, document: DocumentState): TermSummaryDto {
  return {
    id: term.id,
    documentId: term.documentId,
    code: document.code,
    status: document.status,
    title: document.title,
    version: term.version,
  };
}

export function toTermTemplateOption(option: PublishedTemplateOption): TermTemplateOptionDto {
  return {
    id: option.id,
    name: option.name,
    isDefault: option.isDefault,
    versionId: option.versionId,
    versionNumber: option.versionNumber,
  };
}

export function toPriceResearchRef(
  summary: PriceResearchSummary,
  { masked }: TermMasking,
): TermPriceResearchRefDto {
  return {
    id: summary.id,
    code: summary.code,
    status: summary.status,
    totalEstimatedValue: masked ? null : summary.totalEstimatedValue,
    completed: isCompletedPriceResearch(summary),
  };
}

/** RN-TR-13: exigidas satisfeitas ÷ exigidas, a partir da avaliação do DOC-08. */
export function toTermCompleteness(
  sections: readonly SectionCompletenessFact[],
): TermCompletenessDto {
  const required = sections
    .filter((section) => section.requirement !== 'OPTIONAL')
    .map((section) => ({ key: section.key, complete: section.complete }));
  const satisfied = required.filter((section) => section.complete).length;
  return {
    required: required.length,
    satisfied,
    percent: completenessPercent(satisfied, required.length),
    sections: required,
  };
}

/** TRM-03: o `Term` + o rascunho por seção, a completude e as pesquisas (POL-09). */
export function toTermDetailDto(
  term: TermOfReference,
  view: Pick<TypedDocumentView, 'document' | 'template'>,
  extras: {
    readonly completeness: TermCompletenessDto;
    readonly priceResearch: PriceResearchSummary | null;
    readonly completedPriceResearch: PriceResearchSummary | null;
  },
  masking: TermMasking,
): TermDetailDto {
  return {
    ...toTermDto(term, view.document, view.template, masking),
    draftRevision: view.document.draftRevision,
    draftContent: view.document.draftContent,
    completeness: extras.completeness,
    priceResearch:
      extras.priceResearch === null ? null : toPriceResearchRef(extras.priceResearch, masking),
    completedPriceResearch:
      extras.completedPriceResearch === null
        ? null
        : toPriceResearchRef(extras.completedPriceResearch, masking),
    // RN-TR-24 (US-037): sem importação do ETP ainda não há defasagem a sinalizar.
    etpChangedSinceImport: false,
  };
}

/** `meta` do TRM-03: ações e a versão do template FIXADA no documento (seções com `render`). */
export function toTermDetailMeta(
  template: TypedDocumentView['template'],
  allowedActions: readonly DocumentAction[],
): TermDetailMeta {
  return {
    allowedActions: [...allowedActions],
    template:
      template === null
        ? null
        : {
            versionId: template.id,
            versionNumber: template.versionNumber,
            sections: [...template.sections]
              .sort((a, b) => a.order - b.order)
              .map((section) => ({
                key: section.key,
                title: section.title,
                order: section.order,
                requirement: section.requirement,
                helpText: section.helpText ?? null,
                legalBasis: section.legalBasis ?? null,
                minChars: section.minChars ?? null,
                maxChars: section.maxChars,
                render: section.render,
                allowNarrative: section.allowNarrative,
              })),
          },
  };
}
