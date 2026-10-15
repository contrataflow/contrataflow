import type { TenantTx } from '#shared/database/prisma.js';

import type { DocumentTemplate, DocumentTemplateVersion } from '../domain/document-template.js';

/*
 * Portas dos templates (US-107): implementadas em `infrastructure/` (Prisma) e em memória nos
 * testes e no modo de identidade fake (local/dev/test sem banco). Leituras e escritas no `tx` do
 * caso de uso, sob a RLS do tenant.
 */

/** Nome já usado no tipo (índice único `(tenant_id, document_type_id, lower(name))` — V-02). */
export class TemplateNameTakenError extends Error {
  constructor(readonly templateName: string) {
    super('Nome de template já usado para o tipo de documento.');
    this.name = 'TemplateNameTakenError';
  }
}

/** Segundo rascunho do mesmo template (índice único parcial — RN-TPL-10). */
export class TemplateDraftExistsError extends Error {
  constructor(readonly templateId: string) {
    super('O template já tem um rascunho.');
    this.name = 'TemplateDraftExistsError';
  }
}

export interface TemplateListFilter {
  readonly documentTypeId?: string | undefined;
  /** Trecho do nome (sem diferenciar maiúsculas). */
  readonly q?: string | undefined;
  readonly isActive?: boolean | undefined;
  readonly skip: number;
  readonly take: number;
}

export interface TemplateRepository {
  /** Página de templates do tenant, por nome. */
  list(
    tx: TenantTx,
    filter: TemplateListFilter,
  ): Promise<{ readonly items: DocumentTemplate[]; readonly totalItems: number }>;
  /** `null` se o id não existe NO TENANT da transação (outro tenant → `null`). */
  findById(tx: TenantTx, id: string): Promise<DocumentTemplate | null>;
  /** Template do tipo com o mesmo nome, sem diferenciar maiúsculas (RN-TPL-01). */
  findByName(tx: TenantTx, documentTypeId: string, name: string): Promise<DocumentTemplate | null>;
  /**
   * Template + versão 1 na mesma transação (RN-TPL-02).
   * @throws TemplateNameTakenError
   */
  insert(tx: TenantTx, template: DocumentTemplate, draft: DocumentTemplateVersion): Promise<void>;
  /**
   * Metadados com `version = version + 1` condicionada a `expectedVersion` (DEC-055).
   * @throws VersionConflictError
   * @throws TemplateNameTakenError
   */
  update(tx: TenantTx, template: DocumentTemplate, expectedVersion: number): Promise<void>;
  /** Rascunhos e versões publicadas dos templates (resumos de TPL-01/03). */
  findCurrentVersions(
    tx: TenantTx,
    templateIds: readonly string[],
  ): Promise<DocumentTemplateVersion[]>;
  findVersionById(tx: TenantTx, id: string): Promise<DocumentTemplateVersion | null>;
  /**
   * Conteúdo do rascunho (`sections`, `fieldConfig`, `importMappings`, `changeNotes`) num `UPDATE`
   * único com checagem de versão (DEC-055).
   * @throws VersionConflictError
   */
  updateVersionContent(
    tx: TenantTx,
    version: DocumentTemplateVersion,
    expectedVersion: number,
  ): Promise<void>;
}

export const TEMPLATE_REPOSITORY = Symbol('TemplateRepository');
