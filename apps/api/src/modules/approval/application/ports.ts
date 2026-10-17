import type { TenantTx } from '#shared/database/prisma.js';

import type { Approval, ApprovalCoverage } from '../domain/approval.js';

/*
 * Portas do módulo `approval` (US-065 → US-051/052): `approvals` e `approval_documents` no
 * PostgreSQL ou em memória (testes e modo de identidade fake).
 */

/** Já existe aprovação `PENDING` para o documento (índice único parcial — RN-TRAM-43). */
export class PendingApprovalExistsError extends Error {
  constructor(readonly documentId: string) {
    super('Já existe uma aprovação pendente para o documento.');
    this.name = 'PendingApprovalExistsError';
  }
}

export interface ApprovalRepository {
  /**
   * Grava a aprovação e os documentos cobertos no `tx` do chamador.
   * @throws PendingApprovalExistsError
   */
  insert(tx: TenantTx, approval: Approval, coverage: readonly ApprovalCoverage[]): Promise<void>;
  /** Aprovações `PENDING` do processo, mais antigas primeiro (painel situacional — US-004). */
  listPendingByProcess(tx: TenantTx, processId: string): Promise<Approval[]>;
  /** A aprovação cobre exatamente esta versão do documento (selo de aprovação — US-067)? */
  coversDocumentVersion(
    tx: TenantTx,
    approvalId: string,
    documentId: string,
    documentVersionId: string,
  ): Promise<boolean>;
}

export const APPROVAL_REPOSITORY = Symbol('ApprovalRepository');
