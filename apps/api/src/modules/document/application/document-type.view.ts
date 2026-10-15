import { DEFAULT_DOCUMENT_NUMBERING_MASK, renderNumberingMask } from '@contrataflow/validation';
import type { DocumentTypeDto } from '@contrataflow/validation';

import { editableFieldsOf } from '../domain/document-type.js';
import type { DocumentType } from '../domain/document-type.js';

/** Ano corrente no fuso do órgão (a sequência de números é por ano — RN-DOC-05). */
function currentYear(now: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric' }).format(
      now,
    ),
  );
}

/**
 * Prévia do próximo número do tipo (FA-04): a máscara do tipo — ou a padrão — com a primeira
 * posição da sequência. O contador real por tipo/escopo/ano chega com a US-105 (`NumberingFacade`);
 * enquanto nenhum documento é numerado, o próximo número é sempre o 1.
 */
export function nextNumberPreview(type: DocumentType, now: Date): string | null {
  if (!type.numberingEnabled) return null;
  return renderNumberingMask({
    mask: type.numberingMask ?? DEFAULT_DOCUMENT_NUMBERING_MASK,
    typeCode: type.code,
    sequence: 1,
    year: currentYear(now),
  });
}

/** `DocumentType` da resposta de DTY-01..03. */
export function toDocumentTypeDto(type: DocumentType, now: Date): DocumentTypeDto {
  return {
    id: type.id,
    code: type.code,
    name: type.name,
    description: type.description,
    kind: type.kind,
    systemModule: type.systemModule,
    isSystem: type.isSystem,
    isActive: type.isActive,
    allowMultiplePerProcess: type.allowMultiplePerProcess,
    numberingEnabled: type.numberingEnabled,
    numberingMask: type.numberingMask,
    nextNumberPreview: nextNumberPreview(type, now),
    requiresApproval: type.requiresApproval,
    approvalPolicy: type.approvalPolicy,
    defaultConfidentiality: type.defaultConfidentiality,
    // O template padrão como objeto (nome e versão) vem com a US-107/US-108.
    defaultTemplate: null,
    sortOrder: type.sortOrder,
    editableFields: [...editableFieldsOf(type)],
    version: type.version,
  };
}
