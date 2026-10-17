import { describe, expect, it } from 'vitest';

import { maskConfidentialRecord } from './confidential-snapshot.js';
import { createPermissionOf } from './document-permissions.js';
import type { DocumentType } from './document-type.js';
import type { Document } from './document.js';
import {
  filterPanelDocuments,
  panelTypes,
  sortPanelDocuments,
  typeAllowedInStage,
} from './process-documents-panel.js';
import type { PanelTypesInput } from './process-documents-panel.js';

/*
 * US-062 — regras puras do painel (RN-DOC-13..20): tipos pendentes = tipos ativos ∩
 * `documentTypeCodes` ∖ singulares já existentes; menu "Criar documento"; ordenação e filtros; e
 * POL-09 no resumo (RN-DOC-17).
 */

type PanelType = PanelTypesInput['types'][number];

const type = (code: string, overrides: Partial<DocumentType> = {}): PanelType => ({
  id: `type-${code}`,
  code,
  name: code,
  kind: 'FREE_TEXT',
  systemModule: null,
  isActive: true,
  allowMultiplePerProcess: true,
  sortOrder: 100,
  ...overrides,
});

const ETP = type('ETP', {
  name: 'Estudo Técnico Preliminar',
  kind: 'STRUCTURED',
  systemModule: 'ETP',
  allowMultiplePerProcess: false,
  sortOrder: 20,
});
const DFD = type('DFD', {
  kind: 'STRUCTURED',
  systemModule: 'DFD',
  allowMultiplePerProcess: false,
  sortOrder: 10,
});
const DESPACHO = type('DESPACHO', { name: 'Despacho', sortOrder: 60 });
const OFICIO = type('OFICIO', { name: 'Ofício', sortOrder: 70 });
const INATIVO = type('MEMORANDO', { isActive: false, sortOrder: 80 });
const TYPES = [OFICIO, DESPACHO, ETP, DFD, INATIVO];

const doc = (
  id: string,
  documentTypeId: string,
  overrides: Partial<Pick<Document, 'title' | 'code' | 'status' | 'responsibleId'>> = {},
) => ({
  id,
  documentTypeId,
  title: `Documento ${id}`,
  code: null,
  status: 'DRAFT' as Document['status'],
  responsibleId: 'u-1',
  ...overrides,
});

const base = (overrides: Partial<PanelTypesInput> = {}): PanelTypesInput => ({
  types: TYPES,
  stage: { documentTypeCodes: ['ETP', 'DESPACHO', 'OFICIO'] },
  processEditable: true,
  documents: [],
  canCreate: () => true,
  ...overrides,
});

describe('panelTypes (RN-DOC-13/14/16 · FA-01/02/05)', () => {
  it('menu = ativos da etapa com permissão, na ordem de exibição; singular sem documento fica pendente', () => {
    expect(panelTypes(base())).toEqual({
      creatableTypeIds: [ETP.id, DESPACHO.id, OFICIO.id],
      pendingTypeIds: [ETP.id],
    });
  });

  it('singular já existente (não cancelado) sai do menu e da pendência; tipo múltiplo continua', () => {
    const result = panelTypes(
      base({
        documents: [
          { documentTypeId: ETP.id, status: 'APPROVED' },
          { documentTypeId: DESPACHO.id, status: 'DRAFT' },
        ],
      }),
    );
    expect(result).toEqual({ creatableTypeIds: [DESPACHO.id, OFICIO.id], pendingTypeIds: [] });
  });

  it('documento cancelado libera a vaga do tipo singular (RN-DOC-19)', () => {
    const result = panelTypes(
      base({ documents: [{ documentTypeId: ETP.id, status: 'CANCELED' }] }),
    );
    expect(result.creatableTypeIds).toContain(ETP.id);
    expect(result.pendingTypeIds).toEqual([ETP.id]);
  });

  it('etapa sem `documentTypeCodes` (ou sem etapa) admite todo tipo ativo; o inativo nunca entra', () => {
    for (const stage of [{ documentTypeCodes: [] }, null]) {
      const result = panelTypes(base({ stage }));
      expect(result.creatableTypeIds).toEqual([DFD.id, ETP.id, DESPACHO.id, OFICIO.id]);
      expect(result.pendingTypeIds).toEqual([DFD.id, ETP.id]);
    }
  });

  it('sem permissão de criação o item some, mas o pendente continua (situação do processo)', () => {
    const result = panelTypes(base({ canCreate: (candidate) => candidate.kind !== 'STRUCTURED' }));
    expect(result).toEqual({
      creatableTypeIds: [DESPACHO.id, OFICIO.id],
      pendingTypeIds: [ETP.id],
    });
  });

  it('processo fora de status editável: nada a criar nem pendente', () => {
    expect(panelTypes(base({ processEditable: false }))).toEqual({
      creatableTypeIds: [],
      pendingTypeIds: [],
    });
  });

  it('typeAllowedInStage: lista vazia ou etapa nula = todos', () => {
    expect(typeAllowedInStage(null, 'X')).toBe(true);
    expect(typeAllowedInStage({ documentTypeCodes: [] }, 'X')).toBe(true);
    expect(typeAllowedInStage({ documentTypeCodes: ['Y'] }, 'X')).toBe(false);
  });
});

describe('sortPanelDocuments / filterPanelDocuments (RN-DOC-13 · RN-DOC-20)', () => {
  const byId = new Map(TYPES.map((item) => [item.id, item]));
  const typeOf = (document: { documentTypeId: string }) => byId.get(document.documentTypeId) ?? DFD;
  const documents = [
    doc('3', OFICIO.id, { title: 'Ofício à Saúde', code: 'OF-0001/2026' }),
    doc('2', DESPACHO.id, { title: 'Despacho B', status: 'CANCELED' }),
    doc('1', DESPACHO.id, { title: 'despacho a', responsibleId: 'u-2' }),
    doc('4', ETP.id, { title: 'Estudo', status: 'IN_REVIEW' }),
  ];

  it('ordena por sortOrder do tipo e depois título (sem diferenciar maiúsculas)', () => {
    expect(sortPanelDocuments(documents, typeOf).map((item) => item.id)).toEqual([
      '4',
      '1',
      '2',
      '3',
    ]);
  });

  it('filtros combinados por E; busca sem acento no título e no código', () => {
    const ids = (filter: Parameters<typeof filterPanelDocuments>[1]) =>
      filterPanelDocuments(documents, filter).map((item) => item.id);
    expect(ids({})).toEqual(['3', '2', '1', '4']);
    expect(ids({ statuses: ['CANCELED', 'IN_REVIEW'] })).toEqual(['2', '4']);
    expect(ids({ typeIds: [DESPACHO.id] })).toEqual(['2', '1']);
    expect(ids({ responsibleId: 'u-2' })).toEqual(['1']);
    expect(ids({ q: 'saude' })).toEqual(['3']);
    expect(ids({ q: 'of-0001' })).toEqual(['3']);
    expect(ids({ typeIds: [DESPACHO.id], statuses: ['DRAFT'] })).toEqual(['1']);
  });
});

describe('createPermissionOf (RN-DOC-16)', () => {
  it('livres/externos: DOCUMENT_CREATE; tipados: a permissão do módulo dono', () => {
    expect(createPermissionOf(null)).toBe('DOCUMENT_CREATE');
    expect(createPermissionOf('DFD')).toBe('DFD_CREATE');
    expect(createPermissionOf('ETP')).toBe('ETP_CREATE');
    expect(createPermissionOf('TERM_OF_REFERENCE')).toBe('TERM_CREATE');
    expect(createPermissionOf('RISK_MAP')).toBe('RISK_MANAGE');
    expect(createPermissionOf('PRICE_RESEARCH')).toBe('PRICE_RESEARCH_CREATE');
  });
});

describe('maskConfidentialRecord (POL-09 · RN-DOC-17)', () => {
  it('campo monetário vira null + <campo>Masked; os demais ficam', () => {
    expect(
      maskConfidentialRecord({
        estimatedTotalValue: '125000.00',
        itemsCount: 3,
        items: [{ unitPrice: '10.00', description: 'Cimento' }],
      }),
    ).toEqual({
      estimatedTotalValue: null,
      estimatedTotalValueMasked: true,
      itemsCount: 3,
      items: [{ unitPrice: null, unitPriceMasked: true, description: 'Cimento' }],
    });
  });
});
