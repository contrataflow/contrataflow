// Construtores dos testes do ciclo de vida do documento (US-065): documento, tipo, versão e versão
// de template com valores padrão válidos, sobrescritos por campo. Fica fora de `src/modules`
// porque os specs de outros módulos também os usam (DEC-041 · dependency-cruiser) e não é código
// de produção.
import { DEFAULT_TEMPLATE_LAYOUT } from '@contrataflow/validation';
import type { DraftSection, SectionDefinition } from '@contrataflow/validation';

import { InMemoryApprovalRepository } from '#modules/approval/infrastructure/approval.repositories.js';
import { DocumentFacade } from '#modules/document/application/document.facade.js';
import type { CreateDocumentInput } from '#modules/document/application/document.facade.js';
import { InMemoryDocumentTypeRepository } from '#modules/document/infrastructure/in-memory-document-type.repository.js';
import { InMemoryDocumentRepository } from '#modules/document/infrastructure/in-memory-document.repository.js';
import { DocumentProcessContextLoader } from '#modules/process/application/document-process-context.loader.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentProcessContextRegistry } from '#shared/document/document-process-context.js';

import type { TestApi } from './api-test-app.js';
import type { DocumentVersionRecord } from '../../src/modules/document/domain/document-snapshot.js';
import type { DocumentTemplateVersion } from '../../src/modules/document/domain/document-template.js';
import type { DocumentType } from '../../src/modules/document/domain/document-type.js';
import type { Document } from '../../src/modules/document/domain/document.js';

export const FIXTURE_NOW = new Date('2026-10-16T13:00:00.000Z');
export const FIXTURE_USER = '0192f065-0000-7000-8000-0000000000a1';

export function buildDocumentType(overrides: Partial<DocumentType> = {}): DocumentType {
  return {
    id: newId(),
    tenantId: '0192f065-0000-7000-8000-00000000000a',
    code: 'DESPACHO',
    name: 'Despacho',
    description: null,
    kind: 'FREE_TEXT',
    systemModule: null,
    isSystem: false,
    isActive: true,
    allowMultiplePerProcess: true,
    numberingEnabled: false,
    numberingMask: null,
    requiresApproval: false,
    approvalPolicy: null,
    defaultTemplateId: null,
    defaultConfidentiality: 'INTERNAL',
    sortOrder: 0,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    createdById: null,
    updatedById: null,
    version: 1,
    ...overrides,
  };
}

export function buildDocument(overrides: Partial<Document> = {}): Document {
  return {
    id: newId(),
    tenantId: '0192f065-0000-7000-8000-00000000000a',
    processId: '0192f065-0000-7000-8000-0000000000b1',
    documentTypeId: newId(),
    templateVersionId: null,
    number: null,
    year: null,
    code: null,
    title: 'Documento de teste',
    status: 'DRAFT',
    confidentiality: 'INTERNAL',
    draftContent: { sections: {} },
    draftRevision: 1,
    singletonKey: null,
    currentVersionId: null,
    currentVersionNumber: null,
    approvedVersionId: null,
    pendingApprovalId: null,
    responsibleId: FIXTURE_USER,
    submittedAt: null,
    submittedById: null,
    finalizedAt: null,
    finalizedById: null,
    approvedAt: null,
    returnedAt: null,
    rejectedAt: null,
    reopenedAt: null,
    reopenedById: null,
    reopenReason: null,
    canceledAt: null,
    canceledById: null,
    cancellationReason: null,
    sourceDocumentId: null,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    createdById: FIXTURE_USER,
    updatedById: FIXTURE_USER,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

/** Seção do rascunho preenchida com um parágrafo (ou no estado informado). */
export function filledSection(text: string, overrides: Partial<DraftSection> = {}): DraftSection {
  return {
    state: 'FILLED',
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    justification: null,
    revision: 1,
    updatedAt: FIXTURE_NOW.toISOString(),
    updatedById: FIXTURE_USER,
    ...overrides,
  };
}

export function sectionDefinition(
  key: string,
  overrides: Partial<SectionDefinition> = {},
): SectionDefinition {
  return {
    key,
    title: key.charAt(0) + key.slice(1).toLowerCase().replaceAll('_', ' '),
    order: 1,
    requirement: 'REQUIRED',
    ...overrides,
  } as SectionDefinition;
}

export function buildTemplateVersion(
  overrides: Partial<DocumentTemplateVersion> = {},
): DocumentTemplateVersion {
  return {
    id: newId(),
    tenantId: '0192f065-0000-7000-8000-00000000000a',
    templateId: newId(),
    versionNumber: 1,
    status: 'PUBLISHED',
    sections: [],
    layout: DEFAULT_TEMPLATE_LAYOUT,
    fieldConfig: {},
    importMappings: null,
    changeNotes: null,
    publishedAt: FIXTURE_NOW,
    publishedById: FIXTURE_USER,
    retiredAt: null,
    retiredById: null,
    contentHash: 'a'.repeat(64),
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    createdById: FIXTURE_USER,
    updatedById: FIXTURE_USER,
    version: 1,
    ...overrides,
  };
}

export function buildVersion(
  document: Document,
  overrides: Partial<DocumentVersionRecord> = {},
): DocumentVersionRecord {
  return {
    id: newId(),
    tenantId: document.tenantId,
    documentId: document.id,
    processId: document.processId,
    versionNumber: 1,
    reason: 'FINALIZATION',
    statusAtCreation: 'FINALIZED',
    content: null,
    contentHash: 'b'.repeat(64),
    attachmentId: null,
    templateVersionId: document.templateVersionId,
    changeSummary: null,
    createdById: FIXTURE_USER,
    createdAt: FIXTURE_NOW,
    ...overrides,
  };
}

// --- Helpers do app em memória (testes de rota) -------------------------------------------------

export function documentRepositoryOf(api: TestApi): InMemoryDocumentRepository {
  return api.app.get(InMemoryDocumentRepository, { strict: false });
}

export function documentTypeRepositoryOf(api: TestApi): InMemoryDocumentTypeRepository {
  return api.app.get(InMemoryDocumentTypeRepository, { strict: false });
}

export function approvalRepositoryOf(api: TestApi): InMemoryApprovalRepository {
  return api.app.get(InMemoryApprovalRepository, { strict: false });
}

export function documentFacadeOf(api: TestApi): DocumentFacade {
  return api.app.get(DocumentFacade, { strict: false });
}

/** Quem age fora do pipeline HTTP (o que os guards poriam no contexto). */
export interface FixtureActor {
  readonly tenantId: string;
  readonly userId: string;
  readonly membershipId: string;
}

/** Executa `work` numa transação simulada com o contexto do usuário (tenant, ator, MFA). */
export function runAsUser<T>(actor: FixtureActor, work: (tx: TenantTx) => Promise<T>): Promise<T> {
  return runWithRequestContext(
    { correlationId: newId(), ip: '127.0.0.1', userAgent: 'vitest' },
    () => {
      updateRequestContext({
        tenantId: actor.tenantId,
        actor: { type: 'USER', userId: actor.userId, membershipId: actor.membershipId },
        amr: ['pwd', 'otp'],
      });
      return runSimulatedTransaction(work);
    },
  );
}

/** Cria o documento pela fábrica única (`DocumentFacade.createIn`), como o DOC-02 fará. */
export function createDocumentAs(
  api: TestApi,
  actor: FixtureActor,
  input: CreateDocumentInput,
): Promise<Document> {
  return runAsUser(actor, (tx) => documentFacadeOf(api).createIn(tx, input));
}

/**
 * Processos cuja etapa atual admite qualquer tipo (`documentTypeCodes` vazio — POL-02): o workflow
 * padrão só admite DFD na ABERTURA, e a tramitação (US-047) ainda não move o processo de etapa.
 */
export function openStageForAnyType(api: TestApi): Set<string> {
  const open = new Set<string>();
  const loader = api.app.get(DocumentProcessContextLoader, { strict: false });
  api.app.get(DocumentProcessContextRegistry).register({
    async load(tx, processId) {
      const context = await loader.load(tx, processId);
      if (context === null || !open.has(processId) || context.currentStage === null) return context;
      return { ...context, currentStage: { ...context.currentStage, documentTypeCodes: [] } };
    },
  });
  return open;
}
