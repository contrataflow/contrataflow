import type { Confidentiality, DocumentStatus } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { DocumentAiTargets } from './document-ai-target.js';
import type { AiDocumentTarget, AiDocumentTargetInput } from './document-ai-target.js';
import type {
  ApprovalDecisionInput,
  StageEntryInput,
  StageEntryResult,
} from './document-approval.transitions.js';
import { DocumentApprovalTransitions } from './document-approval.transitions.js';
import { DocumentCreationService } from './document-creation.service.js';
import type { CreateDocumentInput } from './document-creation.service.js';
import { DOCUMENT_REPOSITORY, DocumentValidatorRegistry } from './document.ports.js';
import type { DocumentRepository, DocumentValidator } from './document.ports.js';
import { DOCUMENT_TYPE_REPOSITORY } from './ports.js';
import type { DocumentTypeRepository } from './ports.js';
import type { Document } from '../domain/document.js';

export type {
  DocumentValidationSubject,
  DocumentValidator,
  TypedSnapshotParts,
} from './document.ports.js';
export type { CreateDocumentInput } from './document-creation.service.js';
export type { AiDocumentTarget, AiDocumentTargetInput } from './document-ai-target.js';
export type {
  ApprovalDecisionInput,
  StageEntryInput,
  StageEntryResult,
} from './document-approval.transitions.js';

/** Documento como o painel situacional o lista (sem conteúdo). */
export interface SummaryDocumentFact {
  readonly id: string;
  readonly typeCode: string;
  readonly typeName: string;
  readonly code: string | null;
  readonly title: string;
  readonly status: DocumentStatus;
  readonly versionNumber: number | null;
  readonly confidentiality: Confidentiality;
  readonly inApproval: boolean;
}

/**
 * API pública do módulo `document` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório. US-065: a extensão dos módulos tipados (`registerValidator`), a
 * criação com singularidade e numeração (`createIn` — DOC-02 e criações tipadas), as transições
 * acionadas pela tramitação/aprovação (`enterApprovalStageIn`/`applyApprovalDecisionIn`) e os
 * nomes congelados da timeline (`documentLabels`/`versionNumbers`), sempre no `tx` do chamador.
 */
@Injectable()
export class DocumentFacade {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(DOCUMENT_TYPE_REPOSITORY) private readonly types: DocumentTypeRepository,
    private readonly validators: DocumentValidatorRegistry,
    private readonly creation: DocumentCreationService,
    private readonly approvals: DocumentApprovalTransitions,
    private readonly aiTargets: DocumentAiTargets,
  ) {}

  /**
   * Registra o `DocumentValidator` do módulo tipado (no `onModuleInit` dele): validação de
   * completude, `typedSummary` e partes do snapshot. Um por `SystemDocumentModule`.
   */
  registerValidator(validator: DocumentValidator): void {
    this.validators.register(validator);
  }

  /** Cria o documento em `DRAFT` (RN-DOC-50: tipo singular → 409 `DOCUMENT_ALREADY_EXISTS`). */
  createIn(tx: TenantTx, input: CreateDocumentInput): Promise<Document> {
    return this.creation.create(tx, input);
  }

  /** RN-DOC-44: o documento entra na aprovação de etapa que o cobre (US-047/US-051). */
  enterApprovalStageIn(tx: TenantTx, input: StageEntryInput): Promise<StageEntryResult> {
    return this.approvals.enterApprovalStage(tx, input);
  }

  /** RN-DOC-45: a decisão da aprovação pendente do documento (US-052). */
  applyApprovalDecisionIn(tx: TenantTx, input: ApprovalDecisionInput): Promise<Document> {
    return this.approvals.applyApprovalDecision(tx, input);
  }

  /**
   * Alvo de uma geração com IA (US-115 · POL-02 de edição para o usuário da requisição): lança
   * 403/409/422 como a edição do documento e devolve o que o pedido e o gerador precisam. Leitura.
   */
  aiTargetIn(tx: TenantTx, input: AiDocumentTargetInput): Promise<AiDocumentTarget> {
    return this.aiTargets.resolve(tx, input);
  }

  /** Fonte `DOCUMENT` da timeline: código, título e nome do tipo (RN-TML-04). */
  async documentLabels(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<
    Map<string, { readonly code: string | null; readonly title: string; readonly typeName: string }>
  > {
    const labels = await this.documents.labels(tx, ids);
    const typeNames = new Map((await this.types.list(tx)).map((type) => [type.id, type.name]));
    return new Map(
      [...labels].map(([id, label]) => [
        id,
        {
          code: label.code,
          title: label.title,
          typeName: typeNames.get(label.documentTypeId) ?? '',
        },
      ]),
    );
  }

  /**
   * Documentos do painel situacional (US-004 · RN-PROC-48(6)): não cancelados nem excluídos, com
   * tipo, código, título, status, versão atual, sigilo e o selo "Em aprovação"
   * (`pendingApprovalId` — DEC-018). Quem chama decide o que mascarar (POL-09).
   */
  async listForSummary(tx: TenantTx, processId: string): Promise<SummaryDocumentFact[]> {
    const documents = await this.documents.listActiveByProcess(tx, processId);
    if (documents.length === 0) return [];
    const types = new Map((await this.types.list(tx)).map((type) => [type.id, type]));
    return documents.map((document) => {
      const type = types.get(document.documentTypeId);
      return {
        id: document.id,
        typeCode: type?.code ?? '',
        typeName: type?.name ?? '',
        code: document.code,
        title: document.title,
        status: document.status,
        versionNumber: document.currentVersionNumber,
        confidentiality: document.confidentiality,
        inApproval: document.pendingApprovalId !== null,
      };
    });
  }

  /** Fonte `DOCUMENT_VERSION` da timeline: número da versão. */
  versionNumbers(tx: TenantTx, versionIds: readonly string[]): Promise<Map<string, number>> {
    return this.documents.versionNumbers(tx, versionIds);
  }
}
