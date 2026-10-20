import type {
  DocumentAction,
  EtpDetailDto,
  EtpDetailMeta,
  EtpDto,
  EtpMeta,
  EtpSummaryDto,
  ImportableDfdDto,
} from '@contrataflow/validation';

import type {
  Document,
  DocumentState,
  ImportableDfdSource,
  TypedDocumentView,
} from '../../document/application/document.facade.js';
import { dfdImportPreview } from '../domain/etp.js';
import type { Etp } from '../domain/etp.js';

/* Serialização do ETP (US-019/020 · api/06-etp.md ETP-01/02/03): o cabeçalho tipado + o resumo do documento. */

export function toEtpDto(
  etp: Etp,
  document: Pick<
    Document,
    'code' | 'title' | 'status' | 'templateVersionId' | 'version' | 'responsibleId'
  >,
  itemsCount: number,
): EtpDto {
  return {
    id: etp.id,
    documentId: etp.documentId,
    processId: etp.processId,
    code: document.code,
    title: document.title,
    status: document.status,
    conclusion: etp.conclusion,
    importedFromDfdVersionId: etp.importedFromDfdVersionId,
    responsibleId: document.responsibleId,
    templateVersionId: document.templateVersionId,
    documentVersion: document.version,
    itemsCount,
    createdAt: etp.createdAt.toISOString(),
    updatedAt: etp.updatedAt.toISOString(),
    version: etp.version,
  };
}

/**
 * ETP-03 (US-020): o `Etp` + conclusão/estimativa e o rascunho por seção. POL-09: sem a política
 * em processo sigiloso, `estimatedTotalValue = null` e `estimatedTotalValueMasked = true`.
 */
export function toEtpDetailDto(
  etp: Etp,
  document: Document,
  itemsCount: number,
  options: { readonly masked: boolean },
): EtpDetailDto {
  return {
    ...toEtpDto(etp, document, itemsCount),
    recommendedAlternativeId: etp.recommendedAlternativeId,
    parcelingDecision: etp.parcelingDecision,
    estimatedValueSource: etp.estimatedValueSource,
    estimatedTotalValue: options.masked ? null : etp.estimatedTotalValue,
    estimatedTotalValueMasked: options.masked,
    priceResearchId: etp.priceResearchId,
    draftRevision: document.draftRevision,
    draftContent: document.draftContent,
  };
}

/** `meta` do ETP-03: ações e a versão do template FIXADA no documento (seções com `render`). */
export function toEtpDetailMeta(
  template: TypedDocumentView['template'],
  allowedActions: readonly DocumentAction[],
): EtpDetailMeta {
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

export function toEtpMeta(allowedActions: readonly DocumentAction[]): EtpMeta {
  return { allowedActions: [...allowedActions] };
}

export function toEtpSummaryDto(etp: Etp, document: DocumentState): EtpSummaryDto {
  return {
    id: etp.id,
    documentId: etp.documentId,
    code: document.code,
    status: document.status,
    conclusion: etp.conclusion,
    version: etp.version,
  };
}

/** O cartão "Importar dados do DFD 0005/2026?" (objeto, nº de itens e situação no PCA). */
export function toImportableDfdDto(source: ImportableDfdSource): ImportableDfdDto {
  return {
    documentId: source.documentId,
    code: source.code,
    status: source.status,
    versionId: source.versionId,
    versionNumber: source.versionNumber,
    ...dfdImportPreview(source.snapshot),
  };
}
