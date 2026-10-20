import type { DocumentTypeDto, ProcessDocumentDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_FILTER,
  creatableTypes,
  documentHref,
  filterDocuments,
  groupDocuments,
  isFiltering,
  responsiblesOf,
  summaryValueOf,
} from './process-documents-model';

/* US-062 — modelo puro do painel: agrupamento (RN-DOC-13/14), filtros (RN-DOC-20 · V-02), rotas. */

const type = (id: string, extra: Partial<DocumentTypeDto> = {}) =>
  ({
    id,
    code: id.toUpperCase(),
    name: id,
    kind: 'FREE_TEXT',
    systemModule: null,
    allowMultiplePerProcess: true,
    sortOrder: 100,
    ...extra,
  }) as DocumentTypeDto;

const ETP = type('etp', {
  name: 'ETP',
  kind: 'STRUCTURED',
  systemModule: 'ETP',
  allowMultiplePerProcess: false,
  sortOrder: 20,
});
const DFD = type('dfd', {
  name: 'DFD',
  kind: 'STRUCTURED',
  systemModule: 'DFD',
  allowMultiplePerProcess: false,
  sortOrder: 10,
});
const DESPACHO = type('despacho', { name: 'Despacho', sortOrder: 60 });

const doc = (id: string, t: DocumentTypeDto, extra: Partial<ProcessDocumentDto> = {}) =>
  ({
    id,
    documentType: {
      id: t.id,
      code: t.code,
      name: t.name,
      kind: t.kind,
      systemModule: t.systemModule,
      requiresApproval: false,
    },
    title: `Doc ${id}`,
    code: null,
    status: 'DRAFT',
    responsibleId: null,
    responsibleName: null,
    summary: null,
    ...extra,
  }) as ProcessDocumentDto;

const META = { currentStage: null, creatableTypeIds: [DESPACHO.id], pendingTypeIds: [DFD.id] };

describe('groupDocuments', () => {
  it('ordena por sortOrder; pendente sem documento; tipo desativado vai para o fim', () => {
    const inactive = doc('x', type('memorando', { name: 'Memorando' }));
    const groups = groupDocuments(
      [ETP, DFD, DESPACHO],
      [
        doc('b', DESPACHO, { title: 'B' }),
        doc('a', DESPACHO, { title: 'a' }),
        doc('e', ETP),
        inactive,
      ],
      META,
    );
    expect(groups.map((group) => [group.type.id, group.pending, group.creatable])).toEqual([
      ['dfd', true, false],
      ['etp', false, false],
      ['despacho', false, true],
      ['memorando', false, false],
    ]);
    expect(groups[2]?.documents.map((item) => item.id)).toEqual(['a', 'b']);
    expect(groups[1]?.type.singular).toBe(true);
  });

  it('durante a filtragem os pendentes somem', () => {
    expect(groupDocuments([DFD], [], META, { filtering: true })).toEqual([]);
  });
});

describe('filterDocuments / isFiltering', () => {
  const list = [
    doc('1', DESPACHO, { title: 'Despacho à Saúde', status: 'CANCELED', responsibleId: 'u1' }),
    doc('2', ETP, { title: 'Estudo', code: 'ETP-0002/2026' }),
  ];

  it('1 caractere não filtra (V-02); filtros por E', () => {
    expect(filterDocuments(list, { ...EMPTY_FILTER, q: 's' })).toHaveLength(2);
    expect(isFiltering({ ...EMPTY_FILTER, q: 's' })).toBe(false);
    expect(filterDocuments(list, { ...EMPTY_FILTER, q: 'saude' }).map((d) => d.id)).toEqual(['1']);
    expect(filterDocuments(list, { ...EMPTY_FILTER, q: 'etp-0002' }).map((d) => d.id)).toEqual([
      '2',
    ]);
    expect(
      filterDocuments(list, { ...EMPTY_FILTER, status: 'CANCELED', responsibleId: 'u1' }),
    ).toHaveLength(1);
    expect(filterDocuments(list, { ...EMPTY_FILTER, typeId: ETP.id }).map((d) => d.id)).toEqual([
      '2',
    ]);
    expect(isFiltering({ ...EMPTY_FILTER, typeId: ETP.id })).toBe(true);
  });
});

describe('creatableTypes / responsiblesOf / documentHref / summaryValueOf', () => {
  it('menu na ordem do servidor, só tipos conhecidos', () => {
    expect(
      creatableTypes([ETP, DESPACHO], { ...META, creatableTypeIds: ['despacho', 'x', 'etp'] }).map(
        (item) => item.id,
      ),
    ).toEqual(['despacho', 'etp']);
  });

  it('responsáveis distintos por nome', () => {
    expect(
      responsiblesOf([
        doc('1', DESPACHO, { responsibleId: 'u2', responsibleName: 'Zélia' }),
        doc('2', DESPACHO, { responsibleId: 'u1', responsibleName: 'Ana' }),
        doc('3', DESPACHO, { responsibleId: 'u2', responsibleName: 'Zélia' }),
      ]),
    ).toEqual([
      { id: 'u1', name: 'Ana' },
      { id: 'u2', name: 'Zélia' },
    ]);
  });

  it('rotas: SCR-105 para livres/externos, telas dos módulos tipados', () => {
    expect(documentHref('p', doc('d', DESPACHO))).toBe('/processos/p/documentos/d');
    expect(documentHref('p', doc('d', ETP))).toBe('/processos/p/etp/d');
    expect(documentHref('p', doc('d', type('tr', { systemModule: 'TERM_OF_REFERENCE' })))).toBe(
      '/processos/p/tr/d',
    );
    expect(documentHref('p', doc('d', type('r', { systemModule: 'RISK_MAP' })))).toBe(
      '/processos/p/riscos',
    );
  });

  it('valor do resumo: mascarado, número ou ausente', () => {
    expect(
      summaryValueOf(
        doc('d', ETP, { summary: { estimatedTotalValue: null, estimatedTotalValueMasked: true } }),
      ),
    ).toEqual({ masked: true });
    expect(summaryValueOf(doc('d', ETP, { summary: { estimatedValue: '10.50' } }))).toEqual({
      masked: false,
      value: '10.50',
    });
    expect(summaryValueOf(doc('d', ETP))).toBeNull();
  });
});
