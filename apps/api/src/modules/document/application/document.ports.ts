import type { SystemDocumentModule, Violation } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import type { DocumentVersionRecord } from '../domain/document-snapshot.js';
import type { DocumentTemplateVersion } from '../domain/document-template.js';
import type { DocumentType } from '../domain/document-type.js';
import type { Document } from '../domain/document.js';

/*
 * Portas do ciclo de vida do documento (US-065): repositório de `documents`/`document_versions`
 * (PostgreSQL ou memória) e a extensão por módulo tipado (`DocumentValidator`).
 */

/**
 * Segundo documento ativo de tipo singular no processo (índice único parcial `documents_singleton_key`
 * — RN-DOC-50 · V-08): a defesa definitiva sob concorrência.
 */
export class DocumentAlreadyExistsError extends Error {
  constructor(readonly documentTypeId: string) {
    super('O processo já tem um documento ativo deste tipo.');
    this.name = 'DocumentAlreadyExistsError';
  }
}

/** Rótulo do documento para a timeline (`documentLabel` — nomes congelados, RN-TML-04). */
export interface DocumentLabel {
  readonly code: string | null;
  readonly title: string;
  readonly documentTypeId: string;
}

export interface DocumentRepository {
  /** `null` se inexistente, excluído (lógico) ou de outro tenant (RLS) — indistinguíveis (404). */
  findById(tx: TenantTx, id: string): Promise<Document | null>;
  /** O documento ativo (não cancelado nem excluído) do tipo no processo, se houver (RN-DOC-50). */
  findActiveOfType(
    tx: TenantTx,
    processId: string,
    documentTypeId: string,
  ): Promise<Document | null>;
  /**
   * Documentos não cancelados nem excluídos do processo, com o número da versão atual, por
   * criação (painel situacional — US-004 · RN-PROC-48(6)).
   */
  listActiveByProcess(tx: TenantTx, processId: string): Promise<Document[]>;
  /** @throws DocumentAlreadyExistsError */
  insert(tx: TenantTx, document: Document): Promise<void>;
  /**
   * Grava o documento com `version = expectedVersion + 1`, condicionado a `expectedVersion`
   * (DEC-055): o perdedor de uma corrida recebe `VersionConflictError` (412) antes de criar versão.
   * @throws VersionConflictError
   */
  update(tx: TenantTx, document: Document, expectedVersion: number): Promise<void>;
  /**
   * Trava a linha do documento até o fim da transação (`SELECT … FOR UPDATE` — RN-DOC-58): dois
   * "Salvar versão" simultâneos serializam e leem o máximo de `version_number` um depois do outro.
   * Documento inexistente/de outro tenant: nada a travar (a leitura seguinte responde 404).
   */
  lockForUpdate(tx: TenantTx, documentId: string): Promise<void>;
  /** Maior `version_number` + 1 do documento (1 sem versões). */
  nextVersionNumber(tx: TenantTx, documentId: string): Promise<number>;
  insertVersion(tx: TenantTx, version: DocumentVersionRecord): Promise<void>;
  findVersion(tx: TenantTx, versionId: string): Promise<DocumentVersionRecord | null>;
  /** Versões do documento por `versionNumber` desc (DOC-15 · RN-DOC-59), por página. */
  listVersions(
    tx: TenantTx,
    documentId: string,
    window: { readonly skip: number; readonly take: number },
  ): Promise<{ readonly items: DocumentVersionRecord[]; readonly total: number }>;
  /** Documentos não excluídos do tipo (RN-DOC-04 · prévia de impacto da US-061). */
  countByType(tx: TenantTx, documentTypeId: string): Promise<number>;
  /** Rótulos para a timeline (inclui excluídos: o fato já aconteceu). */
  labels(tx: TenantTx, ids: readonly string[]): Promise<Map<string, DocumentLabel>>;
  /** Números das versões (fonte `DOCUMENT_VERSION` da timeline). */
  versionNumbers(tx: TenantTx, versionIds: readonly string[]): Promise<Map<string, number>>;
}

export const DOCUMENT_REPOSITORY = Symbol('DocumentRepository');

/** O que o módulo tipado recebe para validar/resumir/congelar o seu documento. */
export interface DocumentValidationSubject {
  readonly document: Document;
  readonly type: DocumentType;
  /** Versão de template do documento (`null` para `UPLOADED`). */
  readonly template: DocumentTemplateVersion | null;
}

/** Cabeçalho tipado e coleções que entram no snapshot da versão (entities.md §5.3.2). */
export interface TypedSnapshotParts {
  readonly header: Readonly<Record<string, unknown>>;
  readonly collections: Readonly<Record<string, readonly unknown[]>>;
}

/**
 * Porta de extensão dos módulos tipados (DFD, ETP, TR, mapa de riscos, pesquisa de preços — fora do
 * EP-011): declarada aqui, implementada pelo módulo dono e registrada no `onModuleInit` dele com
 * `DocumentFacade.registerValidator(...)`. Tudo roda no `tx` do caso de uso (RLS do tenant), sem
 * I/O externo. Tipo `STRUCTURED` sem validador registrado usa só as regras genéricas — a ausência
 * de registro nunca falha a ação (Impacto técnico da US-065).
 */
export interface DocumentValidator {
  readonly module: SystemDocumentModule;
  /**
   * Regras específicas (RN-DOC-51 b): códigos com o prefixo do módulo (`DFD_*`, `ETP_*`…), no
   * formato único de `violations[]` (api.md §2.1.2). Somadas às genéricas pelo serviço.
   */
  validate(tx: TenantTx, subject: DocumentValidationSubject): Promise<readonly Violation[]>;
  /**
   * Resumo serializável para o evento `DocumentFinalized` (RN-DOC-52 — ex.: valores da pesquisa de
   * preços concluída). `null`/ausente = sem resumo (campo omitido do evento).
   */
  typedSummary?(
    tx: TenantTx,
    subject: DocumentValidationSubject,
  ): Promise<Readonly<Record<string, unknown>> | null>;
  /** Cabeçalho (`Dfd`, `Etp`…) e coleções (`items`, `risks`…) congelados na versão. */
  snapshotParts?(tx: TenantTx, subject: DocumentValidationSubject): Promise<TypedSnapshotParts>;
}

/** Registro único: no máximo um validador por `SystemDocumentModule`. */
@Injectable()
export class DocumentValidatorRegistry {
  private readonly validators = new Map<SystemDocumentModule, DocumentValidator>();

  register(validator: DocumentValidator): void {
    const existing = this.validators.get(validator.module);
    if (existing !== undefined && existing !== validator) {
      throw new Error(`DocumentValidator do módulo ${validator.module} já registrado.`);
    }
    this.validators.set(validator.module, validator);
  }

  find(module: SystemDocumentModule | null): DocumentValidator | null {
    return module === null ? null : (this.validators.get(module) ?? null);
  }
}
