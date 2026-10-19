import type {
  ApprovalCancelReason,
  ApprovalDecision,
  ApprovalListSort,
} from '@contrataflow/validation';

import type { TenantTx } from '#shared/database/prisma.js';

import type { ApprovalRecord } from '../domain/approval-decision.js';
import type {
  ApprovalListCriteria,
  ApprovalListRow,
  ApproverCoverage,
} from '../domain/approval-list.js';
import type { Approval, ApprovalCoverage, ApprovalStatus } from '../domain/approval.js';

/*
 * Portas do módulo `approval` (US-065 → US-051/052): `approvals` e `approval_documents` no
 * PostgreSQL ou em memória (testes e modo de identidade fake), as transações do comando de decisão
 * (US-052) e o relógio.
 */

/** Transações de escrita/leitura do módulo (Prisma `TenantTransaction` ou simulada em memória). */
export interface ApprovalTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const APPROVAL_TRANSACTIONS = Symbol('ApprovalTransactions');

export type ApprovalClock = () => Date;

export const APPROVAL_CLOCK = Symbol('ApprovalClock');

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

/** A aprovação com a cobertura (`ApprovalDocument`, na ordem de gravação). */
export interface ApprovalWithCoverage {
  readonly approval: ApprovalRecord;
  readonly coverage: readonly ApprovalCoverage[];
}

export interface ApprovalRepository {
  /** US-052 (APV-02/03): a aprovação do tenant da transação e a cobertura; `null` = inexistente. */
  findById(tx: TenantTx, approvalId: string): Promise<ApprovalWithCoverage | null>;
  /**
   * US-052 (passo 6.1): `SELECT … FOR UPDATE` na aprovação e a releitura sob a trava — o estado é o
   * do vencedor de qualquer corrida. `null` = inexistente no tenant.
   */
  lockForUpdate(tx: TenantTx, approvalId: string): Promise<ApprovalRecord | null>;
  /**
   * US-052 (RN-TRAM-54/63): grava a decisão SE a aprovação ainda está `PENDING` na versão lida
   * (`UPDATE … WHERE status = 'PENDING' AND version = $lida`). `false` = perdeu a corrida.
   */
  recordDecision(tx: TenantTx, decided: ApprovalRecord, expectedVersion: number): Promise<boolean>;
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

/** US-057 (APV-01): a página pedida, já restrita à cobertura de quem consulta (POL-03). */
export interface ApprovalListSearch {
  readonly coverage: ApproverCoverage;
  readonly criteria: ApprovalListCriteria;
  readonly sort: ApprovalListSort;
  readonly page: number;
  readonly pageSize: number;
}

export interface ApprovalListPage {
  readonly rows: ApprovalListRow[];
  readonly totalItems: number;
}

/**
 * Leitura da lista de aprovações (US-057): `approvals` com o processo publicado em
 * `v_inbox_processes` (SQL sobre PostgreSQL ou memória no modo fake). Página e total numa leitura.
 */
export interface ApprovalListReader {
  page(tx: TenantTx, search: ApprovalListSearch): Promise<ApprovalListPage>;
}

export const APPROVAL_LIST_READER = Symbol('ApprovalListReader');
