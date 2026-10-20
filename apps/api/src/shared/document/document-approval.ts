import type { ApprovalPolicy } from '@contrataflow/validation';
import { Injectable, Module } from '@nestjs/common';

import type { TenantTx } from '../database/prisma.js';
import { ApiError } from '../errors/api-error.js';

/*
 * Submissão avulsa de documento (US-065 · DOC-09 · DEC-022 · RN-DOC-43): o tipo com
 * `requiresApproval = true` abre uma `Approval` (`subjectType = DOCUMENT`) conforme
 * `DocumentType.approvalPolicy`, na MESMA transação da submissão. `document` e `approval` estão no
 * mesmo nível (DEC-040): a dependência vira esta porta do shared kernel, que `approval` implementa
 * e registra no `onModuleInit`. US-051: o aprovador é resolvido como na etapa (`USER` com vínculo
 * ativo, `ROLE` com detentor competente no escopo da unidade solicitante, titular da unidade com
 * `allowDeputy`) e a aprovação publica `ApprovalRequested` (timeline, `APPROVER` e o aviso).
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
  /**
   * Órgão e unidades solicitantes do processo: `DEPARTMENT_HEAD` pela unidade solicitante e a
   * competência dos detentores de `ROLE` (RN-TRAM-47).
   */
  readonly organizationId: string;
  readonly requestingSecretariatId: string;
  readonly requestingDepartmentId: string;
}

export interface DocumentApprovalRequester {
  /**
   * Cria a `Approval` `PENDING`, a cobertura (`ApprovalDocument`), `approval.request` e
   * `ApprovalRequested` no `tx` do chamador; lança `ApiError` (`APPROVER_UNRESOLVED`,
   * `APPROVAL_NOT_PENDING`) para desfazer a submissão inteira.
   */
  requestForDocumentSubmission(tx: TenantTx, request: DocumentApprovalRequest): Promise<void>;
  /** A aprovação cobre esta versão do documento (selo de aprovação do PDF — US-067 · FA-02)? */
  coversDocumentVersion(
    tx: TenantTx,
    approvalId: string,
    documentId: string,
    documentVersionId: string,
  ): Promise<boolean>;
  /**
   * DOC-11 (US-053): retira a aprovação pendente `approvalId` que cobre o documento, no `tx` do
   * chamador — as mesmas regras e efeitos do APV-04 (POL-17, `APPROVAL_NOT_PENDING`,
   * `approval.withdraw`, `ApprovalCanceled`; documento `IN_REVIEW` → `DRAFT`). A versão conferida
   * é a do documento (o `If-Match` do DOC-11), não a da aprovação.
   */
  withdrawForDocument(tx: TenantTx, request: DocumentWithdrawalRequest): Promise<void>;
}

export interface DocumentWithdrawalRequest {
  readonly approvalId: string;
  readonly documentId: string;
  readonly reason: string | null;
  readonly idempotencyKey: string | null;
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

  /** Sem o módulo de aprovações, não há aprovação pendente a retirar: 409 `APPROVAL_NOT_PENDING`. */
  withdrawForDocument(tx: TenantTx, request: DocumentWithdrawalRequest): Promise<void> {
    if (!this.requester) return Promise.reject(new ApiError('APPROVAL_NOT_PENDING'));
    return this.requester.withdrawForDocument(tx, request);
  }

  /** Sem o módulo de aprovações, nenhuma aprovação existe para o selo. */
  coversDocumentVersion(
    tx: TenantTx,
    approvalId: string,
    documentId: string,
    documentVersionId: string,
  ): Promise<boolean> {
    if (!this.requester) return Promise.resolve(false);
    return this.requester.coversDocumentVersion(tx, approvalId, documentId, documentVersionId);
  }
}

/** Importado por `document` (consumidor) e `approval` (implementador); a instância é única. */
@Module({ providers: [DocumentApprovalRegistry], exports: [DocumentApprovalRegistry] })
export class DocumentApprovalModule {}
