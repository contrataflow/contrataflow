import type { ApprovalCancelReason, ApprovalDecision } from '@contrataflow/validation';

import type { TenantTx } from '#shared/database/prisma.js';

import type { Approval, ApprovalCoverage, ApprovalStatus } from '../domain/approval.js';

/*
 * Portas do módulo `approval` (US-065 → US-051/052): `approvals` e `approval_documents` no
 * PostgreSQL ou em memória (testes e modo de identidade fake).
 */

/** Já existe aprovação `PENDING` para a etapa/documento (índices únicos parciais — RN-TRAM-43). */
export class PendingApprovalExistsError extends Error {
  constructor(readonly subjectId: string) {
    super('Já existe uma aprovação pendente para a etapa ou o documento.');
    this.name = 'PendingApprovalExistsError';
  }
}

/** Resumo de uma aprovação (US-054 · FA-03 — link "Ver decisão" no histórico de tramitações). */
export interface ApprovalSummaryRow {
  readonly id: string;
  readonly title: string;
  readonly status: ApprovalStatus;
  readonly decision: ApprovalDecision | null;
}

export interface ApprovalRepository {
  /**
   * Grava a aprovação e os documentos cobertos no `tx` do chamador.
   * @throws PendingApprovalExistsError
   */
  insert(tx: TenantTx, approval: Approval, coverage: readonly ApprovalCoverage[]): Promise<void>;
  /** Aprovações `PENDING` do processo, mais antigas primeiro (painel situacional — US-004). */
  listPendingByProcess(tx: TenantTx, processId: string): Promise<Approval[]>;
  /** US-008: a aprovação `PENDING` da passagem (`processStageId`), se houver. */
  findPendingForStage(tx: TenantTx, processStageId: string): Promise<Approval | null>;
  /**
   * US-008 (RN-PROC-99): novo `dueAt` da aprovação ainda `PENDING` (`updatedAt`, `updatedById`,
   * `version + 1`). `false` = deixou de estar pendente.
   */
  updatePendingDueAt(
    tx: TenantTx,
    approvalId: string,
    dueAt: Date,
    at: Date,
    userId: string | null,
  ): Promise<boolean>;
  /**
   * US-009 (RN-PROC-106): cancela TODAS as aprovações `PENDING` do processo (`canceledAt`,
   * `canceledById`, `cancellationReason` = o motivo, `version + 1`) e devolve cada uma com os
   * documentos que cobria (`ApprovalDocument` e o sujeito da avulsa), mais antigas primeiro.
   */
  cancelPendingByProcess(
    tx: TenantTx,
    processId: string,
    reason: ApprovalCancelReason,
    at: Date,
    userId: string,
  ): Promise<{ readonly approvalId: string; readonly documentIds: readonly string[] }[]>;
  /** Resumos das aprovações do tenant da transação por id, numa leitura; ids de fora não voltam. */
  summariesByIds(tx: TenantTx, ids: readonly string[]): Promise<ApprovalSummaryRow[]>;
  /** A aprovação cobre exatamente esta versão do documento (selo de aprovação — US-067)? */
  coversDocumentVersion(
    tx: TenantTx,
    approvalId: string,
    documentId: string,
    documentVersionId: string,
  ): Promise<boolean>;
}

export const APPROVAL_REPOSITORY = Symbol('ApprovalRepository');
