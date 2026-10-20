import type {
  DocumentStatus,
  DocumentTypeDto,
  ProcessDocumentDto,
  ProcessDocumentsMeta,
  SystemDocumentModule,
} from '@contrataflow/validation';

/*
 * Modelo puro do painel de documentos (US-062 · RN-DOC-13..20): agrupamento por tipo (cartão único
 * nos singulares, lista nos múltiplos), filtros sobre a lista já carregada e os destinos de
 * navegação. A UI nunca recalcula permissões: o menu vem de `meta.creatableTypeIds` e as ações de
 * cada documento, de `meta.allowedActions`.
 */

/** O tipo como o painel o exibe (do DTY-01 ou, se desativado, do resumo do próprio documento). */
export interface PanelType {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: DocumentTypeDto['kind'];
  readonly systemModule: SystemDocumentModule | null;
  /** Singular (`allowMultiplePerProcess = false`): um cartão só. */
  readonly singular: boolean;
  readonly sortOrder: number;
}

export interface DocumentGroup {
  readonly type: PanelType;
  readonly documents: readonly ProcessDocumentDto[];
  /** Singular permitido na etapa ainda sem documento ("Não iniciado" — FA-01). */
  readonly pending: boolean;
  /** O menu "Criar documento" oferece este tipo (botão do cartão "Não iniciado"). */
  readonly creatable: boolean;
}

export interface PanelFilter {
  readonly typeId: string | null;
  readonly status: DocumentStatus | null;
  readonly responsibleId: string | null;
  readonly q: string;
}

export const EMPTY_FILTER: PanelFilter = { typeId: null, status: null, responsibleId: null, q: '' };

/** V-02: busca com menos de 2 caracteres é ignorada. */
export const MIN_QUERY_LENGTH = 2;

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function fromCatalog(type: DocumentTypeDto): PanelType {
  return {
    id: type.id,
    code: type.code,
    name: type.name,
    kind: type.kind,
    systemModule: type.systemModule,
    singular: !type.allowMultiplePerProcess,
    sortOrder: type.sortOrder,
  };
}

/** Tipo desativado (fora do DTY-01): o resumo do documento basta; vai para o fim (FA-02). */
function fromDocument(document: ProcessDocumentDto): PanelType {
  const summary = document.documentType;
  return {
    id: summary.id,
    code: summary.code,
    name: summary.name,
    kind: summary.kind,
    systemModule: summary.systemModule,
    singular: summary.kind === 'STRUCTURED',
    sortOrder: Number.MAX_SAFE_INTEGER,
  };
}

/** RN-DOC-20: filtros combinados por E sobre a lista carregada. */
export function filterDocuments(
  documents: readonly ProcessDocumentDto[],
  filter: PanelFilter,
): ProcessDocumentDto[] {
  const query = filter.q.trim();
  const needle = query.length >= MIN_QUERY_LENGTH ? fold(query) : null;
  return documents.filter(
    (document) =>
      (filter.typeId === null || document.documentType.id === filter.typeId) &&
      (filter.status === null || document.status === filter.status) &&
      (filter.responsibleId === null || document.responsibleId === filter.responsibleId) &&
      (needle === null ||
        fold(document.title).includes(needle) ||
        (document.code !== null && fold(document.code).includes(needle))),
  );
}

export function isFiltering(filter: PanelFilter): boolean {
  return (
    filter.typeId !== null ||
    filter.status !== null ||
    filter.responsibleId !== null ||
    filter.q.trim().length >= MIN_QUERY_LENGTH
  );
}

/**
 * RN-DOC-13/14: grupos por tipo, ordenados por `sortOrder` e nome; documentos por título. Tipos
 * sem documento só aparecem quando pendentes (e nunca durante uma filtragem).
 */
export function groupDocuments(
  types: readonly DocumentTypeDto[],
  documents: readonly ProcessDocumentDto[],
  meta: ProcessDocumentsMeta,
  options: { readonly filtering?: boolean } = {},
): DocumentGroup[] {
  const known = new Map(types.map((type) => [type.id, fromCatalog(type)]));
  const byType = new Map<string, { type: PanelType; documents: ProcessDocumentDto[] }>();
  for (const document of documents) {
    const type = known.get(document.documentType.id) ?? fromDocument(document);
    const group = byType.get(type.id) ?? { type, documents: [] };
    group.documents.push(document);
    byType.set(type.id, group);
  }
  if (options.filtering !== true) {
    for (const id of meta.pendingTypeIds) {
      const type = known.get(id);
      if (type !== undefined && !byType.has(id)) byType.set(id, { type, documents: [] });
    }
  }
  const creatable = new Set(meta.creatableTypeIds);
  const pending = new Set(meta.pendingTypeIds);
  return [...byType.values()]
    .sort(
      (a, b) => a.type.sortOrder - b.type.sortOrder || collator.compare(a.type.name, b.type.name),
    )
    .map(({ type, documents: grouped }) => ({
      type,
      documents: [...grouped].sort((a, b) => collator.compare(a.title, b.title)),
      pending: grouped.length === 0 && pending.has(type.id),
      creatable: creatable.has(type.id),
    }));
}

/** Itens do menu "Criar documento" (RN-DOC-16), na ordem do servidor. */
export function creatableTypes(
  types: readonly DocumentTypeDto[],
  meta: ProcessDocumentsMeta,
): PanelType[] {
  const known = new Map(types.map((type) => [type.id, type]));
  return meta.creatableTypeIds.flatMap((id) => {
    const type = known.get(id);
    return type === undefined ? [] : [fromCatalog(type)];
  });
}

/** Responsáveis presentes na lista (opções do filtro "Responsável"). */
export function responsiblesOf(
  documents: readonly ProcessDocumentDto[],
): { readonly id: string; readonly name: string }[] {
  const seen = new Map<string, string>();
  for (const document of documents) {
    if (document.responsibleId !== null && !seen.has(document.responsibleId)) {
      seen.set(document.responsibleId, document.responsibleName ?? document.responsibleId);
    }
  }
  return [...seen]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => collator.compare(a.name, b.name));
}

/** Rotas das telas dos módulos tipados (screens.md SCR-007..012); livres/externos = SCR-105. */
const MODULE_SEGMENTS: Readonly<Record<SystemDocumentModule, string>> = {
  DFD: 'dfd',
  ETP: 'etp',
  TERM_OF_REFERENCE: 'tr',
  RISK_MAP: 'riscos',
  PRICE_RESEARCH: 'pesquisa-precos',
};

/** Passo 6: o visualizador/editor do documento. */
export function documentHref(processId: string, document: ProcessDocumentDto): string {
  const systemModule = document.documentType.systemModule;
  if (systemModule === null) return `/processos/${processId}/documentos/${document.id}`;
  if (systemModule === 'RISK_MAP') return `/processos/${processId}/riscos`;
  return `/processos/${processId}/${MODULE_SEGMENTS[systemModule]}/${document.id}`;
}

/** Campos de valor exibidos no resumo do cartão (o primeiro presente). */
const SUMMARY_VALUE_FIELDS = ['estimatedTotalValue', 'totalEstimatedValue', 'estimatedValue'];

/**
 * Valor do resumo do cartão (RN-DOC-17): o número (string decimal) ou `masked` quando POL-09 o
 * escondeu; `null` sem valor no resumo.
 */
export function summaryValueOf(
  document: ProcessDocumentDto,
): { readonly masked: true } | { readonly masked: false; readonly value: string } | null {
  const summary = document.summary ?? {};
  for (const field of SUMMARY_VALUE_FIELDS) {
    if (summary[`${field}Masked`] === true) return { masked: true };
    const value = summary[field];
    if (typeof value === 'string' || typeof value === 'number') {
      return { masked: false, value: String(value) };
    }
  }
  return null;
}
