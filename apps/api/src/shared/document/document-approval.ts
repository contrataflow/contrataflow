import type { ApprovalPolicy } from '@contrataflow/validation';
import { Injectable, Module } from '@nestjs/common';

import type { TenantTx } from '../database/prisma.js';
import { ApiError } from '../errors/api-error.js';

/*
 * Submissão avulsa de documento (US-065 · DOC-09 · DEC-022 · RN-DOC-43): o tipo com
 * `requiresApproval = true` abre uma `Approval` (`subjectType = DOCUMENT`) conforme
 * `DocumentType.approvalPolicy`, na MESMA transação da submissão. `document` e `approval` estão no
 * mesmo nível (DEC-040): a dependência vira esta porta do shared kernel, que `approval` implementa
 * e registra no `onModuleInit`. A resolução completa do aprovador (titular da unidade, validações)
 * e o evento `ApprovalRequested` são da US-051.
 */

export interface DocumentApprovalRequest {
  /** Id da `Approval` a criar, gerado pelo documento (vai em `pendingApprovalId` no mesmo `tx`). */
  readonly approvalId: string;
  readonly processId: string;
  readonly documentId: string;
  /** Versão `SUBMISSION` recém-criada — a versão exata que o aprovador analisa. */
  readonly documentVersionId: string;
  readonly documentCode: string | null;
  readonly documentTitle: string;
  readonly documentTypeName: string;
  readonly policy: ApprovalPolicy;
  readonly requestedById: string;
  readonly requestedAt: Date;
  /** Unidades do processo para `DEPARTMENT_HEAD` com resolução pela unidade solicitante. */
  readonly requestingSecretariatId: string;
  readonly requestingDepartmentId: string;
}

export interface DocumentApprovalRequester {
  /**
   * Cria a `Approval` `PENDING` e a cobertura (`ApprovalDocument`) no `tx` do chamador; lança
   * `ApiError` (`APPROVER_UNRESOLVED`…) para desfazer a submissão inteira.
   */
  requestForDocumentSubmission(tx: TenantTx, request: DocumentApprovalRequest): Promise<void>;
}

/** Registro do solicitante (implementado pelo módulo `approval`). */
@Injectable()
export class DocumentApprovalRegistry {
  private requester: DocumentApprovalRequester | null = null;

  register(requester: DocumentApprovalRequester): void {
    this.requester = requester;
  }

  /** Sem o módulo de aprovações, nenhuma aprovação pode ser aberta: 422 `APPROVER_UNRESOLVED`. */
  requestForDocumentSubmission(tx: TenantTx, request: DocumentApprovalRequest): Promise<void> {
    if (!this.requester) return Promise.reject(new ApiError('APPROVER_UNRESOLVED'));
    return this.requester.requestForDocumentSubmission(tx, request);
  }
}

/** Importado por `document` (consumidor) e `approval` (implementador); a instância é única. */
@Module({ providers: [DocumentApprovalRegistry], exports: [DocumentApprovalRegistry] })
export class DocumentApprovalModule {}
