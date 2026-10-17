// Carga dos testes de rota do painel situacional (US-004) em memória: documentos (com a versão
// atual), aprovações pendentes e o processo do Background do Gherkin sobre o workflow DEC-015 das
// fixtures do motor (US-041). Fica fora de `src/modules` porque os specs de um módulo não importam
// internos de outro (DEC-041 · dependency-cruiser).
import type { Confidentiality, DocumentStatus } from '@contrataflow/validation';

import type { Approval } from '#modules/approval/domain/approval.js';
import { InMemoryApprovalRepository } from '#modules/approval/infrastructure/approval.repositories.js';
import type { DocumentVersionRecord } from '#modules/document/domain/document-snapshot.js';
import type { Document } from '#modules/document/domain/document.js';
import { InMemoryDocumentTypeRepository } from '#modules/document/infrastructure/in-memory-document-type.repository.js';
import { InMemoryDocumentRepository } from '#modules/document/infrastructure/in-memory-document.repository.js';
import { runAsSystem } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { newId } from '#shared/database/ids.js';

import type { TestApi } from './api-test-app.js';

export interface PanelDocument {
  readonly tenantId: string;
  readonly processId: string;
  readonly typeCode: string;
  readonly code: string | null;
  readonly title: string;
  readonly status: DocumentStatus;
  readonly versionNumber?: number;
  readonly confidentiality?: Confidentiality;
  readonly pendingApprovalId?: string | null;
  readonly createdById: string;
}

/** Documento do processo (tipo do seeder `document.systemTypes`) com a versão atual. */
export async function seedPanelDocument(api: TestApi, input: PanelDocument): Promise<string> {
  const types = api.app.get(InMemoryDocumentTypeRepository, { strict: false });
  const documents = api.app.get(InMemoryDocumentRepository, { strict: false });
  const type = types
    .snapshot()
    .find(
      (candidate) => candidate.tenantId === input.tenantId && candidate.code === input.typeCode,
    );
  if (!type) throw new Error(`tipo ${input.typeCode} ausente no tenant ${input.tenantId}`);
  const id = newId();
  const now = new Date('2026-10-02T12:00:00.000Z');
  const versionId = input.versionNumber === undefined ? null : newId();
  const document: Document = {
    id,
    tenantId: input.tenantId,
    processId: input.processId,
    documentTypeId: type.id,
    templateVersionId: null,
    number: null,
    year: 2026,
    code: input.code,
    title: input.title,
    status: input.status,
    confidentiality: input.confidentiality ?? 'INTERNAL',
    draftContent: { sections: {} },
    draftRevision: 1,
    singletonKey: null,
    currentVersionId: versionId,
    currentVersionNumber: input.versionNumber ?? null,
    approvedVersionId: null,
    pendingApprovalId: input.pendingApprovalId ?? null,
    responsibleId: null,
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
    createdAt: now,
    updatedAt: now,
    createdById: input.createdById,
    updatedById: null,
    deletedAt: null,
    version: 1,
  };
  await runAsSystem({ name: 'test.seed', tenantId: input.tenantId }, () =>
    runSimulatedTransaction(async (tx) => {
      await documents.insert(tx, document);
      if (versionId !== null) {
        const version: DocumentVersionRecord = {
          id: versionId,
          tenantId: input.tenantId,
          documentId: id,
          processId: input.processId,
          versionNumber: input.versionNumber ?? 1,
          reason: 'SUBMISSION',
          statusAtCreation: input.status,
          content: null,
          contentHash: 'a'.repeat(64),
          attachmentId: null,
          templateVersionId: null,
          changeSummary: null,
          createdById: input.createdById,
          createdAt: now,
        };
        await documents.insertVersion(tx, version);
      }
    }),
  );
  return id;
}

/** Documento como está no repositório em memória (sigilo e versão — US-013 · RN-PROC-139). */
export function storedPanelDocument(api: TestApi, documentId: string): Document {
  const documents = api.app.get(InMemoryDocumentRepository, { strict: false });
  const document = documents.allDocuments().find((candidate) => candidate.id === documentId);
  if (!document) throw new Error(`documento ${documentId} ausente`);
  return document;
}

/** Aprovação pendente de etapa (a abertura é da US-051): designada a um usuário, perfil ou unidade. */
export function seedPanelApproval(
  api: TestApi,
  input: Pick<Approval, 'tenantId' | 'processId' | 'title' | 'approverType'> & Partial<Approval>,
): Approval {
  const approval: Approval = {
    id: newId(),
    subjectType: 'PROCESS_STAGE',
    processStageId: null,
    documentId: null,
    requestedById: input.approverUserId ?? newId(),
    requestedAt: new Date('2026-10-04T12:00:00.000Z'),
    requestComment: null,
    approverUserId: null,
    approverRoleId: null,
    approverDepartmentId: null,
    allowDeputy: false,
    dueAt: null,
    status: 'PENDING',
    createdAt: new Date('2026-10-04T12:00:00.000Z'),
    createdById: input.approverUserId ?? newId(),
    ...input,
  };
  api.app.get(InMemoryApprovalRepository, { strict: false }).seed(approval);
  return approval;
}
