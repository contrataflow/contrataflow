import type { DocumentStatus } from '@contrataflow/validation';

import type { DocumentType } from './document-type.js';
import type { Document } from './document.js';

/*
 * Painel de documentos do processo (US-062 · RN-DOC-13..20): regras puras sobre a lista já
 * carregada — ordenação por tipo, filtros, tipos que o menu "Criar documento" oferece e tipos
 * singulares ainda "Não iniciado". Sem I/O: quem chama traz os tipos do tenant, a etapa atual e a
 * decisão de permissão de criação por tipo.
 */

type PanelType = Pick<
  DocumentType,
  | 'id'
  | 'code'
  | 'name'
  | 'kind'
  | 'systemModule'
  | 'isActive'
  | 'allowMultiplePerProcess'
  | 'sortOrder'
>;
type PanelDocument = Pick<
  Document,
  'id' | 'documentTypeId' | 'title' | 'code' | 'status' | 'responsibleId'
>;

/** Minúsculas e sem acentos (a busca do painel ignora ambos). */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

/** RN-DOC-13: por `sortOrder` do tipo, depois nome do tipo e título do documento. */
export function sortPanelDocuments<D extends PanelDocument>(
  documents: readonly D[],
  typeOf: (document: D) => PanelType,
): D[] {
  return [...documents].sort((left, right) => {
    const a = typeOf(left);
    const b = typeOf(right);
    return (
      a.sortOrder - b.sortOrder ||
      collator.compare(a.name, b.name) ||
      collator.compare(left.title, right.title) ||
      left.id.localeCompare(right.id)
    );
  });
}

export interface PanelFilter {
  readonly typeIds?: readonly string[] | undefined;
  readonly statuses?: readonly DocumentStatus[] | undefined;
  readonly responsibleId?: string | undefined;
  /** Busca no título e no código (mín. 2 caracteres — validado no contrato). */
  readonly q?: string | undefined;
}

/** RN-DOC-20: filtros combinados por E sobre a lista do processo (sem paginação). */
export function filterPanelDocuments<D extends PanelDocument>(
  documents: readonly D[],
  filter: PanelFilter,
): D[] {
  const needle = filter.q === undefined ? null : fold(filter.q);
  return documents.filter(
    (document) =>
      (filter.typeIds === undefined || filter.typeIds.includes(document.documentTypeId)) &&
      (filter.statuses === undefined || filter.statuses.includes(document.status)) &&
      (filter.responsibleId === undefined || document.responsibleId === filter.responsibleId) &&
      (needle === null ||
        fold(document.title).includes(needle) ||
        (document.code !== null && fold(document.code).includes(needle))),
  );
}

/** A etapa atual como o painel a vê: `null` = sem etapa (processo sem workflow em execução). */
export interface PanelStage {
  /** Vazio = qualquer tipo ativo do tenant (POL-02). */
  readonly documentTypeCodes: readonly string[];
}

export interface PanelTypesInput {
  /** Tipos do tenant (ativos e inativos — os inativos nunca entram no menu: FA-02). */
  readonly types: readonly PanelType[];
  readonly stage: PanelStage | null;
  /** Processo em status que admite documento novo (`DOCUMENT_EDITABLE_PROCESS_STATUSES`). */
  readonly processEditable: boolean;
  /** Documentos do processo (inclui cancelados — eles não ocupam a vaga do tipo singular). */
  readonly documents: readonly Pick<PanelDocument, 'documentTypeId' | 'status'>[];
  /** Permissão de criação do tipo (+ POL-02) para o usuário — decidida por quem chama. */
  readonly canCreate: (type: PanelType) => boolean;
}

export interface PanelTypes {
  /** Menu "Criar documento" (RN-DOC-16), na ordem de exibição dos tipos. */
  readonly creatableTypeIds: string[];
  /** Tipos singulares permitidos na etapa e ainda sem documento não cancelado (FA-01). */
  readonly pendingTypeIds: string[];
}

export function typeAllowedInStage(stage: PanelStage | null, code: string): boolean {
  return (
    stage === null || stage.documentTypeCodes.length === 0 || stage.documentTypeCodes.includes(code)
  );
}

/**
 * RN-DOC-13/14/16 · FA-01/02/05: tipos ativos ∩ etapa atual; singulares já ocupados (documento não
 * cancelado) saem do menu e não ficam pendentes; o menu ainda exige a permissão de criação. Processo
 * fora de status editável (suspenso, concluído, cancelado…) não cria nem tem pendência (RN-DOC-19).
 */
export function panelTypes(input: PanelTypesInput): PanelTypes {
  const occupied = new Set(
    input.documents
      .filter((document) => document.status !== 'CANCELED')
      .map((document) => document.documentTypeId),
  );
  const ordered = [...input.types].sort(
    (a, b) => a.sortOrder - b.sortOrder || collator.compare(a.name, b.name),
  );
  const creatableTypeIds: string[] = [];
  const pendingTypeIds: string[] = [];
  for (const type of ordered) {
    if (!input.processEditable) break;
    if (!type.isActive || !typeAllowedInStage(input.stage, type.code)) continue;
    const singular = !type.allowMultiplePerProcess;
    if (singular && occupied.has(type.id)) continue;
    if (singular) pendingTypeIds.push(type.id);
    if (input.canCreate(type)) creatableTypeIds.push(type.id);
  }
  return { creatableTypeIds, pendingTypeIds };
}
