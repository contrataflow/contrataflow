import type { Confidentiality, DocumentKind, SystemDocumentModule } from '@contrataflow/validation';

import type { DocumentType } from './document-type.js';

/*
 * Tipos de documento semeados no provisionamento (entities.md §7 · US-061 pré-condições · US-099):
 * todos com `requiresApproval = false` (DEC-018: a aprovação formal acontece nas etapas APPROVAL do
 * workflow). Máscaras de `DESPACHO`..`DECLARACAO` e a numeração desligada de `DOCUMENTO_EXTERNO`
 * seguem a proposta da lacuna 2 da US-061 (a confirmar em entities.md §7); os demais ficam com a
 * máscara padrão do tenant (`numbering.document.defaultMask`).
 */

interface SystemTypeSpec {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly kind: DocumentKind;
  readonly systemModule: SystemDocumentModule | null;
  readonly numberingEnabled?: boolean;
  readonly numberingMask?: string;
  readonly defaultConfidentiality?: Confidentiality;
}

export const SYSTEM_DOCUMENT_TYPES: readonly SystemTypeSpec[] = [
  {
    code: 'DFD',
    name: 'Documento de Formalização da Demanda',
    description: 'Formaliza a necessidade da contratação (DFD).',
    kind: 'STRUCTURED',
    systemModule: 'DFD',
  },
  {
    code: 'ETP',
    name: 'Estudo Técnico Preliminar',
    description: 'Estudo técnico preliminar da contratação (ETP).',
    kind: 'STRUCTURED',
    systemModule: 'ETP',
  },
  {
    code: 'TR',
    name: 'Termo de Referência',
    description: 'Termo de referência da contratação (TR).',
    kind: 'STRUCTURED',
    systemModule: 'TERM_OF_REFERENCE',
  },
  {
    code: 'RISK_MAP',
    name: 'Mapa de Riscos',
    description: 'Matriz de riscos da contratação.',
    kind: 'STRUCTURED',
    systemModule: 'RISK_MAP',
    numberingMask: 'MR {seq:4}/{year}',
  },
  {
    code: 'PRICE_RESEARCH',
    name: 'Pesquisa de Preços',
    description: 'Pesquisa de preços e valor estimado da contratação.',
    kind: 'STRUCTURED',
    systemModule: 'PRICE_RESEARCH',
    numberingMask: 'PP {seq:4}/{year}',
    defaultConfidentiality: 'INTERNAL',
  },
  {
    code: 'DESPACHO',
    name: 'Despacho',
    description: 'Ato de encaminhamento ou decisão em texto livre.',
    kind: 'FREE_TEXT',
    systemModule: null,
    numberingMask: 'DESP {seq:4}/{year}',
  },
  {
    code: 'OFICIO',
    name: 'Ofício',
    description: 'Comunicação oficial em texto livre.',
    kind: 'FREE_TEXT',
    systemModule: null,
    numberingMask: 'OF {seq:4}/{year}',
  },
  {
    code: 'NOTA_TECNICA',
    name: 'Nota técnica',
    description: 'Manifestação técnica em texto livre.',
    kind: 'FREE_TEXT',
    systemModule: null,
    numberingMask: 'NT {seq:4}/{year}',
  },
  {
    code: 'AUTORIZACAO',
    name: 'Autorização',
    description: 'Autorização formal em texto livre.',
    kind: 'FREE_TEXT',
    systemModule: null,
    numberingMask: 'AUT {seq:4}/{year}',
  },
  {
    code: 'DECLARACAO',
    name: 'Declaração',
    description: 'Declaração em texto livre.',
    kind: 'FREE_TEXT',
    systemModule: null,
    numberingMask: 'DECL {seq:4}/{year}',
  },
  {
    code: 'DOCUMENTO_EXTERNO',
    name: 'Documento externo',
    description: 'Arquivo produzido fora da plataforma e anexado ao processo.',
    kind: 'UPLOADED',
    systemModule: null,
    numberingEnabled: false,
  },
];

/** Tipos de sistema do tenant (ids novos), na ordem de exibição de 10 em 10. */
export function buildSystemDocumentTypes(
  tenantId: string,
  now: Date,
  newId: () => string,
): DocumentType[] {
  return SYSTEM_DOCUMENT_TYPES.map((spec, index) => ({
    id: newId(),
    tenantId,
    code: spec.code,
    name: spec.name,
    description: spec.description,
    kind: spec.kind,
    systemModule: spec.systemModule,
    isSystem: true,
    isActive: true,
    allowMultiplePerProcess: spec.kind !== 'STRUCTURED',
    numberingEnabled: spec.numberingEnabled ?? true,
    numberingMask: spec.numberingMask ?? null,
    requiresApproval: false,
    approvalPolicy: null,
    defaultTemplateId: null,
    defaultConfidentiality: spec.defaultConfidentiality ?? 'INTERNAL',
    sortOrder: (index + 1) * 10,
    createdAt: now,
    updatedAt: now,
    createdById: null,
    updatedById: null,
    version: 1,
  }));
}
