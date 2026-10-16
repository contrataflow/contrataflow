import { DEFAULT_TEMPLATE_LAYOUT, DEFAULT_TR_IMPORT_MAPPINGS } from '@contrataflow/validation';
import type {
  Confidentiality,
  DocumentKind,
  FieldConfig,
  ImportMappings,
  LayoutDefinition,
  SectionDefinition,
  SystemDocumentModule,
  TemplateUpdate,
  TemplateVersionStatus,
  TemplateVersionUpdate,
  Violation,
} from '@contrataflow/validation';

import type { AuditChange } from '#shared/audit/audit-trail.js';
import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';

import { FULL_VALIDATION, validateTemplateContent } from './template-content.validator.js';
import type { TemplateValidationContext } from './template-content.validator.js';

/*
 * `DocumentTemplate` e `DocumentTemplateVersion` (entities.md §4.7 · US-107 · RN-TPL-01..12).
 * Funções puras sobre registros imutáveis: nada aqui lê banco, relógio ou contexto.
 */

export interface DocumentTemplate {
  readonly id: string;
  readonly tenantId: string;
  readonly documentTypeId: string;
  readonly name: string;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly isSystem: boolean;
  readonly currentPublishedVersionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

export interface DocumentTemplateVersion {
  readonly id: string;
  readonly tenantId: string;
  readonly templateId: string;
  readonly versionNumber: number;
  readonly status: TemplateVersionStatus;
  readonly sections: readonly SectionDefinition[];
  readonly layout: LayoutDefinition;
  readonly fieldConfig: FieldConfig;
  readonly importMappings: ImportMappings | null;
  readonly changeNotes: string | null;
  readonly publishedAt: Date | null;
  readonly publishedById: string | null;
  readonly retiredAt: Date | null;
  readonly retiredById: string | null;
  readonly contentHash: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

/** O que o template precisa saber do tipo de documento (via `DocumentTypeFacade`). */
export interface TemplateDocumentType {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: DocumentKind;
  readonly systemModule: SystemDocumentModule | null;
  readonly defaultConfidentiality: Confidentiality;
}

/** RN-TPL-03: conteúdo só muda em `DRAFT`. */
export class TemplateVersionNotDraftError extends Error {
  constructor(readonly status: TemplateVersionStatus) {
    super(`Versão de template em ${status} não é editável.`);
    this.name = 'TemplateVersionNotDraftError';
  }
}

/** RN-TPL-04..09: conteúdo com achados (`TEMPLATE_INVALID`). */
export class TemplateContentInvalidError extends Error {
  constructor(readonly violations: readonly Violation[]) {
    super(`Conteúdo de template inválido: ${violations.map((v) => v.code).join(', ')}`);
    this.name = 'TemplateContentInvalidError';
  }
}

/** RN-TPL-17: só a versão `PUBLISHED` é aposentada (`INVALID_STATE`). */
export class TemplateVersionNotPublishedError extends Error {
  constructor(readonly status: TemplateVersionStatus) {
    super(`Versão de template em ${status} não pode ser aposentada.`);
    this.name = 'TemplateVersionNotPublishedError';
  }
}

/** RN-TPL-14: template inativo não publica versão. */
export class TemplateInactiveError extends Error {
  constructor(readonly templateId: string) {
    super('Template inativo não publica versão.');
    this.name = 'TemplateInactiveError';
  }
}

/**
 * RN-TPL-18: aposentar a versão corrente sem outra publicada para assumir, sendo o template padrão
 * de um tipo de documento ativo (`TEMPLATE_IN_USE`).
 */
export class TemplateInUseError extends Error {
  constructor(readonly documentTypeName: string) {
    super('Template padrão de tipo ativo sem versão substituta.');
    this.name = 'TemplateInUseError';
  }
}

/** Texto sem espaços nas pontas; vazio vira `null`. */
function blankToNull(text: string | null | undefined): string | null {
  const trimmed = text?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** Nome comparável para a unicidade por tipo (RN-TPL-01): sem diferenciar maiúsculas. */
export function templateNameKey(name: string): string {
  return name.trim().toLocaleLowerCase('pt-BR');
}

export interface CreateTemplateInput {
  readonly name: string;
  readonly description?: string | undefined;
}

export interface CreateTemplateContext {
  readonly templateId: string;
  readonly versionId: string;
  readonly tenantId: string;
  readonly now: Date;
  readonly userId: string | null;
}

/**
 * RN-TPL-01/02: template ativo com a versão 1 em `DRAFT` — sem seções, `fieldConfig` vazio, layout
 * padrão do sistema e, no TR, o mapeamento de importação padrão semeado.
 */
export function createDocumentTemplate(
  input: CreateTemplateInput,
  type: TemplateDocumentType,
  context: CreateTemplateContext,
): { readonly template: DocumentTemplate; readonly draft: DocumentTemplateVersion } {
  const audit = {
    createdAt: context.now,
    updatedAt: context.now,
    createdById: context.userId,
    updatedById: context.userId,
    version: 1,
  };
  const template: DocumentTemplate = {
    id: context.templateId,
    tenantId: context.tenantId,
    documentTypeId: type.id,
    name: input.name.trim(),
    description: blankToNull(input.description),
    isActive: true,
    isSystem: false,
    currentPublishedVersionId: null,
    ...audit,
  };
  const draft: DocumentTemplateVersion = {
    id: context.versionId,
    tenantId: context.tenantId,
    templateId: context.templateId,
    versionNumber: 1,
    status: 'DRAFT',
    sections: [],
    layout: structuredClone(DEFAULT_TEMPLATE_LAYOUT),
    fieldConfig: {},
    importMappings:
      type.systemModule === 'TERM_OF_REFERENCE'
        ? structuredClone(DEFAULT_TR_IMPORT_MAPPINGS)
        : null,
    changeNotes: null,
    publishedAt: null,
    publishedById: null,
    retiredAt: null,
    retiredById: null,
    contentHash: null,
    ...audit,
  };
  return { template, draft };
}

export interface UpdateContext {
  readonly now: Date;
  readonly userId: string | null;
}

export interface TemplateMetadataUpdate {
  readonly next: DocumentTemplate;
  readonly changes: readonly AuditChange[];
  readonly changedFields: readonly ('name' | 'description' | 'isActive')[];
}

/** FA-03 (TPL-04): nome, descrição e situação; o tipo é imutável (RN-TPL-01). */
export function updateTemplateMetadata(
  current: DocumentTemplate,
  patch: TemplateUpdate,
  context: UpdateContext,
): TemplateMetadataUpdate {
  const proposed = {
    name: patch.name === undefined ? current.name : patch.name.trim(),
    description:
      patch.description === undefined ? current.description : blankToNull(patch.description),
    isActive: patch.isActive ?? current.isActive,
  };
  const changedFields = (['name', 'description', 'isActive'] as const).filter(
    (field) => proposed[field] !== current[field],
  );
  const changes = changedFields.map((field) => ({
    path: field,
    old: current[field],
    new: proposed[field],
  }));
  return {
    next:
      changedFields.length === 0
        ? current
        : { ...current, ...proposed, updatedAt: context.now, updatedById: context.userId },
    changes,
    changedFields,
  };
}

/** Seção como gravada: textos aparados e opcionais vazios omitidos. */
function normalizeSection(section: SectionDefinition): SectionDefinition {
  const helpText = blankToNull(section.helpText);
  const legalBasis = blankToNull(section.legalBasis);
  return {
    key: section.key.trim(),
    title: section.title.trim(),
    order: section.order,
    requirement: section.requirement,
    ...(helpText === null ? {} : { helpText }),
    ...(legalBasis === null ? {} : { legalBasis }),
    ...(section.defaultContent === undefined ? {} : { defaultContent: section.defaultContent }),
    ...(section.minChars === undefined ? {} : { minChars: section.minChars }),
    maxChars: section.maxChars,
    render: section.render,
    allowNarrative: section.allowNarrative,
  };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Chaves de seções incluídas, removidas, alteradas ou reordenadas (resumo da auditoria). */
export function changedSectionKeys(
  before: readonly SectionDefinition[],
  after: readonly SectionDefinition[],
): string[] {
  const old = new Map(before.map((section) => [section.key, section]));
  const next = new Map(after.map((section) => [section.key, section]));
  const keys = new Set([...old.keys(), ...next.keys()]);
  return [...keys].filter((key) => !same(old.get(key), next.get(key))).sort();
}

export interface TemplateContentUpdate {
  readonly next: DocumentTemplateVersion;
  readonly sectionsChanged: readonly string[];
  readonly fieldConfigChanged: boolean;
  readonly importMappingsChanged: boolean;
  readonly changeNotesChanged: boolean;
  /** Partes alteradas (`sections`, `fieldConfig`, `importMappings`, `changeNotes`). */
  readonly fieldsChanged: readonly string[];
}

/**
 * `DocumentTemplateVersion.updateContent` (TPL-08 · RN-TPL-03..09, 12): só em `DRAFT`; aplica as
 * partes enviadas, confere o conteúdo resultante com o `TemplateContentValidator` (as partes
 * enviadas) e devolve a versão seguinte com o resumo do que mudou.
 * @throws TemplateVersionNotDraftError
 * @throws TemplateContentInvalidError
 */
export function updateTemplateVersionContent(
  current: DocumentTemplateVersion,
  patch: TemplateVersionUpdate,
  validation: TemplateValidationContext,
  context: UpdateContext,
): TemplateContentUpdate {
  if (current.status !== 'DRAFT') throw new TemplateVersionNotDraftError(current.status);

  const sections =
    patch.sections === undefined
      ? current.sections
      : patch.sections.map(normalizeSection).sort((a, b) => a.order - b.order);
  // RN-TPL-07: tipos sem cabeçalho tipado mantêm `fieldConfig = {}` (o validador recusa outro).
  const fieldConfig = patch.fieldConfig ?? current.fieldConfig;
  const importMappings =
    patch.importMappings === undefined ? current.importMappings : patch.importMappings;
  const changeNotes =
    patch.changeNotes === undefined ? current.changeNotes : blankToNull(patch.changeNotes);

  const violations = validateTemplateContent(
    { sections, fieldConfig, importMappings },
    validation,
    {
      sections: patch.sections !== undefined,
      fieldConfig: patch.fieldConfig !== undefined,
      importMappings: patch.importMappings !== undefined,
    },
  );
  if (violations.length > 0) throw new TemplateContentInvalidError(violations);

  const sectionsChanged = changedSectionKeys(current.sections, sections);
  const sectionsReordered = sectionsChanged.length === 0 && !same(current.sections, sections);
  const fieldConfigChanged = !same(current.fieldConfig, fieldConfig);
  const importMappingsChanged = !same(current.importMappings, importMappings);
  const changeNotesChanged = current.changeNotes !== changeNotes;
  const fieldsChanged = [
    ...(sectionsChanged.length > 0 || sectionsReordered ? ['sections'] : []),
    ...(fieldConfigChanged ? ['fieldConfig'] : []),
    ...(importMappingsChanged ? ['importMappings'] : []),
    ...(changeNotesChanged ? ['changeNotes'] : []),
  ];
  return {
    next:
      fieldsChanged.length === 0
        ? current
        : {
            ...current,
            sections,
            fieldConfig,
            importMappings,
            changeNotes,
            updatedAt: context.now,
            updatedById: context.userId,
          },
    sectionsChanged,
    fieldConfigChanged,
    importMappingsChanged,
    changeNotesChanged,
    fieldsChanged,
  };
}

/** Conteúdo que identifica a versão publicada (RN-TPL-15). */
export interface TemplateHashedContent {
  readonly sections: readonly SectionDefinition[];
  readonly layout: LayoutDefinition;
  readonly fieldConfig: FieldConfig;
  readonly importMappings: ImportMappings | null;
}

/**
 * `contentHash` (RN-TPL-15 · DEC-017): SHA-256 (hex minúsculo) do JSON canonicalizado (RFC 8785)
 * de `{ sections, layout, fieldConfig, importMappings }` — a mesma rotina do `definitionHash` dos
 * workflows e do `rowHash` da auditoria. Opcionais ausentes (`undefined`) não entram no hash.
 */
export function templateContentHash(content: TemplateHashedContent): string {
  const plain: unknown = JSON.parse(
    JSON.stringify({
      sections: content.sections,
      layout: content.layout,
      fieldConfig: content.fieldConfig,
      importMappings: content.importMappings,
    }),
  );
  return sha256Hex(canonicalJson(plain));
}

export interface TemplatePublication {
  readonly version: DocumentTemplateVersion;
  readonly template: DocumentTemplate;
}

/**
 * `DocumentTemplateVersion.publish()` (TPL-10 · RN-TPL-14/15): só o rascunho de template ativo;
 * reexecuta o `TemplateContentValidator` com o escopo completo; a versão passa a `PUBLISHED` com
 * `contentHash` e vira a `currentPublishedVersionId` do template. A versão anterior continua
 * publicada (sem efeito retroativo — RN-TPL-16).
 * @throws TemplateVersionNotDraftError
 * @throws TemplateInactiveError
 * @throws TemplateContentInvalidError
 */
export function publishTemplateVersion(
  template: DocumentTemplate,
  draft: DocumentTemplateVersion,
  validation: TemplateValidationContext,
  context: UpdateContext,
): TemplatePublication {
  if (draft.status !== 'DRAFT') throw new TemplateVersionNotDraftError(draft.status);
  if (!template.isActive) throw new TemplateInactiveError(template.id);
  const violations = validateTemplateContent(draft, validation, FULL_VALIDATION);
  if (violations.length > 0) throw new TemplateContentInvalidError(violations);
  return {
    version: {
      ...draft,
      status: 'PUBLISHED',
      publishedAt: context.now,
      publishedById: context.userId,
      contentHash: templateContentHash(draft),
      updatedAt: context.now,
      updatedById: context.userId,
    },
    template: {
      ...template,
      currentPublishedVersionId: draft.id,
      updatedAt: context.now,
      updatedById: context.userId,
    },
  };
}

export interface TemplateRetirement {
  readonly version: DocumentTemplateVersion;
  /** O template com a nova `currentPublishedVersionId`; `null` se ela não muda. */
  readonly template: DocumentTemplate | null;
}

/**
 * `DocumentTemplateVersion.retire()` (TPL-11 · RN-TPL-17/18): só a versão `PUBLISHED`. Se for a
 * corrente do template, a publicada de maior número entre as demais assume; sem nenhuma, a
 * corrente fica nula — salvo quando o template é padrão de um tipo ativo (`TEMPLATE_IN_USE`).
 * @throws TemplateVersionNotPublishedError
 * @throws TemplateInUseError
 */
export function retireTemplateVersion(
  template: DocumentTemplate,
  version: DocumentTemplateVersion,
  otherPublished: readonly DocumentTemplateVersion[],
  defaultOfActiveType: { readonly name: string } | null,
  context: UpdateContext,
): TemplateRetirement {
  if (version.status !== 'PUBLISHED') throw new TemplateVersionNotPublishedError(version.status);
  const retired: DocumentTemplateVersion = {
    ...version,
    status: 'RETIRED',
    retiredAt: context.now,
    retiredById: context.userId,
    updatedAt: context.now,
    updatedById: context.userId,
  };
  if (template.currentPublishedVersionId !== version.id)
    return { version: retired, template: null };

  const successor = otherPublished
    .filter((other) => other.id !== version.id && other.status === 'PUBLISHED')
    .sort((a, b) => b.versionNumber - a.versionNumber)[0];
  if (!successor && defaultOfActiveType) throw new TemplateInUseError(defaultOfActiveType.name);
  return {
    version: retired,
    template: {
      ...template,
      currentPublishedVersionId: successor?.id ?? null,
      updatedAt: context.now,
      updatedById: context.userId,
    },
  };
}

export interface NewVersionContext extends UpdateContext {
  readonly versionId: string;
}

/**
 * Nova versão (TPL-06 · RN-TPL-13): rascunho que clona `sections`/`layout`/`fieldConfig`/
 * `importMappings` da versão de maior número (publicada ou aposentada), com o número seguinte.
 * A unicidade do rascunho é garantida pelo índice parcial (`TEMPLATE_DRAFT_EXISTS`).
 */
export function newTemplateVersionFrom(
  latest: DocumentTemplateVersion,
  context: NewVersionContext,
): DocumentTemplateVersion {
  return {
    id: context.versionId,
    tenantId: latest.tenantId,
    templateId: latest.templateId,
    versionNumber: latest.versionNumber + 1,
    status: 'DRAFT',
    sections: structuredClone(latest.sections),
    layout: structuredClone(latest.layout),
    fieldConfig: structuredClone(latest.fieldConfig),
    importMappings: latest.importMappings === null ? null : structuredClone(latest.importMappings),
    changeNotes: null,
    publishedAt: null,
    publishedById: null,
    retiredAt: null,
    retiredById: null,
    contentHash: null,
    createdAt: context.now,
    updatedAt: context.now,
    createdById: context.userId,
    updatedById: context.userId,
    version: 1,
  };
}
