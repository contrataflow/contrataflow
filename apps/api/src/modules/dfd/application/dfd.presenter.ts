import type {
  DfdDecisionDto,
  DfdDto,
  DfdMeta,
  DfdSummaryDto,
  DocumentAction,
} from '@contrataflow/validation';

import type { Document, TypedDocumentView } from '../../document/application/document.facade.js';
import type { Dfd } from '../domain/dfd.js';

/*
 * Serialização do DFD (US-014 · api/05-dfd.md DFD-01..03): o cabeçalho tipado + o resumo do
 * documento. POL-09 (RN-DFD-16): com o orçamento do processo sigiloso e o usuário sem a política, a
 * estimativa sai `null` com `estimatedValueMasked: true` (DEC-030 — o DFD revela o orçamento).
 */

export function toDfdDto(
  dfd: Dfd,
  document: Pick<
    Document,
    'code' | 'title' | 'status' | 'templateVersionId' | 'version' | 'draftRevision'
  >,
  options: { readonly masked: boolean },
): DfdDto {
  return {
    id: dfd.id,
    documentId: dfd.documentId,
    processId: dfd.processId,
    code: document.code,
    title: document.title,
    status: document.status,
    templateVersionId: document.templateVersionId,
    documentVersion: document.version,
    draftRevision: document.draftRevision,
    requestDate: dfd.requestDate,
    requestingDepartmentId: dfd.requestingDepartmentId,
    responsibleId: dfd.responsibleId,
    objectSummary: dfd.objectSummary,
    priority: dfd.priority,
    expectedDate: dfd.expectedDate,
    estimatedValue: options.masked ? null : dfd.estimatedValue,
    estimatedValueMasked: options.masked,
    pcaStatus: dfd.pcaStatus,
    pcaYear: dfd.pcaYear,
    pcaItemCode: dfd.pcaItemCode,
    pcaJustification: dfd.pcaJustification,
    wizardStep: dfd.wizardStep,
    completedSteps: [...dfd.completedSteps],
    createdAt: dfd.createdAt.toISOString(),
    updatedAt: dfd.updatedAt.toISOString(),
    version: dfd.version,
  };
}

export function toDfdSummaryDto(
  dfd: Dfd,
  document: { readonly code: string | null; readonly status: Document['status'] },
): DfdSummaryDto {
  return {
    id: dfd.id,
    documentId: dfd.documentId,
    code: document.code,
    status: document.status,
    requestDate: dfd.requestDate,
    priority: dfd.priority,
    version: dfd.version,
  };
}

/**
 * `meta` do DFD-02/03: ações e a versão de template fixada no documento (seções e `fieldConfig`); no
 * DFD-03, também a decisão mais recente (US-017 · `DecisionBanner`).
 */
export function toDfdMeta(
  template: TypedDocumentView['template'],
  allowedActions: readonly DocumentAction[],
  decision?: DfdDecisionDto | null,
): DfdMeta {
  return {
    allowedActions: [...allowedActions],
    ...(decision === undefined ? {} : { decision }),
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
              })),
            fieldConfig: Object.fromEntries(
              Object.entries(template.fieldConfig).map(([field, entry]) => [
                field,
                {
                  ...(entry.label === undefined ? {} : { label: entry.label }),
                  ...(entry.required === undefined ? {} : { required: entry.required }),
                },
              ]),
            ),
          },
  };
}
