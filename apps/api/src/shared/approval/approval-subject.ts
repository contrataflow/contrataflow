import type {
  ApprovalDecision,
  ApprovalDecisionOption,
  ApprovalDocumentDto,
  ProcessStatus,
} from '@contrataflow/validation';
import { Injectable, Module } from '@nestjs/common';

import type { TenantTx } from '../database/prisma.js';

/*
 * `ApprovalSubjectHandler` (architecture.md §3 · domains.md §4.4 · DEC-022 · US-052): ao decidir uma
 * `Approval`, o módulo `approval` (coordenador da transação) delega ao dono do sujeito, NO MESMO
 * `tx`, os efeitos da decisão — `process` para `PROCESS_STAGE` (etapa, status, encadeamento e os
 * documentos cobertos) e `document` para `DOCUMENT` (submissão avulsa). `approval` não conhece o
 * efeito da decisão; `process` (nível 3) e `document` (mesmo nível) não são importados por ele: a
 * dependência vira esta porta do shared kernel, que cada dono registra no `onModuleInit`.
 *
 * Ordem (passos 6.1–6.12 da US-052): `prepareDecision` (trava o processo — ordem de bloqueio
 * processo → aprovação → documentos — e lê o que POL-03 precisa) → POL-03 no `approval` →
 * `planDecision` (regras do workflow, destino e aprovador da próxima etapa, SEM escrita) → a
 * aprovação é decidida → `applyDecision` (as escritas do sujeito) → auditoria. Qualquer erro
 * desfaz tudo; `afterCommit` só roda depois do commit (renderização assíncrona — RN-TRAM-58).
 */

export type ApprovalSubjectKind = 'PROCESS_STAGE' | 'DOCUMENT';

/** Documento coberto e a versão exata analisada (`ApprovalDocument`). */
export interface DecisionCoverage {
  readonly documentId: string;
  readonly documentVersionId: string;
}

/** A aprovação `PENDING` sob decisão, como o dono do sujeito a vê. */
export interface DecisionSubject {
  readonly approvalId: string;
  readonly processId: string;
  readonly subjectType: ApprovalSubjectKind;
  readonly processStageId: string | null;
  readonly documentId: string | null;
  readonly coverage: readonly DecisionCoverage[];
}

/** O que a decisão lê do sujeito: o processo (POL-03 e status) e os autores (segregação). */
export interface DecisionSubjectFacts {
  readonly processCode: string | null;
  readonly processTitle: string;
  readonly processStatus: ProcessStatus;
  readonly organizationId: string;
  readonly requestingSecretariatId: string;
  readonly requestingDepartmentId: string;
  /** `createdById` dos documentos cobertos e das versões analisadas (RN-TRAM-62 · POL-03). */
  readonly authorIds: readonly string[];
}

/** O sujeito como o detalhe da aprovação o mostra (APV-02): fatos e documentos cobertos. */
export interface DecisionSubjectView extends DecisionSubjectFacts {
  readonly documents: readonly ApprovalDocumentDto[];
}

export interface SubjectDecisionInput {
  readonly subject: DecisionSubject;
  readonly decision: ApprovalDecision;
  /** Comentário da decisão (nunca vai a log nem a payload de evento). */
  readonly comment: string | null;
  /** Ids das regras `WARNING` reconhecidas (DEC-016). */
  readonly acknowledgedWarnings: readonly string[];
  /** Transição escolhida (devolução com mais de um destino — RN-TRAM-56). */
  readonly transitionId: string | null;
  readonly decidedById: string;
  readonly now: Date;
}

/** Aviso reconhecido como evidência (`ProcessMovement.metadata` e `AuditLog.metadata`). */
export interface AcknowledgedRuleWarning {
  readonly ruleId: string;
  readonly message: string;
}

/** Efeito aplicado pelo dono do sujeito. */
export interface SubjectDecisionResult {
  readonly fromStatus: ProcessStatus | null;
  readonly toStatus: ProcessStatus | null;
  /** Etapa em que o processo ficou (`null` na avulsa — FA-01). */
  readonly processStage: { readonly key: string; readonly name: string } | null;
  readonly warningsAcknowledged: readonly AcknowledgedRuleWarning[];
  readonly movementId: string | null;
  /** Próxima aprovação aberta pelo encadeamento (RN-TRAM-60). */
  readonly chainedApprovalId: string | null;
  /** Documentos que passaram a `APPROVED` (renderização `APPROVAL_STAMPED` enfileirada). */
  readonly approvedDocumentIds: readonly string[];
  /** Depois do commit (enfileirar renderizações); a falha nunca desfaz a decisão. */
  readonly afterCommit: readonly (() => Promise<void>)[];
}

export interface ApprovalSubjectHandler<P = unknown> {
  readonly subjectType: ApprovalSubjectKind;
  /**
   * Trava o que a decisão muda (o processo, primeiro na ordem de bloqueio) e lê os fatos de POL-03.
   * `null` = processo inexistente no tenant da transação (o comando responde 404).
   */
  prepareDecision(tx: TenantTx, subject: DecisionSubject): Promise<DecisionSubjectFacts | null>;
  /**
   * Resolve a decisão SEM escrever: transição, regras (`TRANSITION_BLOCKED`,
   * `WARNINGS_NOT_ACKNOWLEDGED`), destino e o aprovador da próxima etapa (`APPROVER_UNRESOLVED`).
   */
  planDecision(tx: TenantTx, input: SubjectDecisionInput): Promise<P>;
  /** Aplica o plano: documentos (DEC-018), etapa/status e encadeamento, no `tx` de quem decide. */
  applyDecision(tx: TenantTx, plan: P): Promise<SubjectDecisionResult>;
  /** O sujeito para o detalhe (APV-02), sem trava; `null` = processo inexistente no tenant. */
  describeSubject(tx: TenantTx, subject: DecisionSubject): Promise<DecisionSubjectView | null>;
  /** Opções de decisão para o SCR-015 (APV-02): destinos e regras não satisfeitas. Leitura. */
  decisionOptions(tx: TenantTx, subject: DecisionSubject): Promise<ApprovalDecisionOption[]>;
}

/** Registro dos donos de sujeito (implementado por `process` e `document`). */
@Injectable()
export class ApprovalSubjectRegistry {
  private readonly handlers = new Map<ApprovalSubjectKind, ApprovalSubjectHandler>();

  register(handler: ApprovalSubjectHandler): void {
    this.handlers.set(handler.subjectType, handler);
  }

  /** `null` = nenhum dono registrado (a decisão falha fechado). */
  handlerFor(subjectType: ApprovalSubjectKind): ApprovalSubjectHandler | null {
    return this.handlers.get(subjectType) ?? null;
  }
}

/** Importado por `approval` (consumidor), `process` e `document` (implementadores). */
@Module({ providers: [ApprovalSubjectRegistry], exports: [ApprovalSubjectRegistry] })
export class ApprovalSubjectModule {}
