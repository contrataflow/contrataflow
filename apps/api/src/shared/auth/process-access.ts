import { Injectable, Module } from '@nestjs/common';

import type { TenantTx } from '../database/prisma.js';

/*
 * Processo visto pela autorização (US-097 · DEC-024 · permissions.md §1.1, §4, §5). O agregado é do
 * módulo `process` (nível 3), que depende de `access`; a dependência no sentido contrário vira esta
 * porta do shared kernel: o `process` registra o leitor no `onModuleInit` (mesmo arranjo do
 * `MembershipReferences`). Sem leitor registrado, falha fechado — nenhum processo existe (404).
 */

/** Papéis de participação no processo (`ProcessParticipant.role` — permissions.md §4). */
export type ParticipantRole = 'OBSERVER' | 'COLLABORATOR' | 'CONSULTANT';

export interface ProcessParticipation {
  readonly userId: string;
  readonly role: ParticipantRole;
  /** `null` = sem prazo; `CONSULTANT` sempre tem prazo (≤ validade do vínculo). */
  readonly expiresAt: Date | null;
}

/** O que a autorização precisa de um processo: escopo (§1.1), visibilidade (§5) e participação (§4). */
export interface ProcessAccessTarget {
  readonly processId: string;
  /** Órgão do processo (escopo `ORGANIZATION`); `null` enquanto o agregado não o expõe. */
  readonly organizationId: string | null;
  /**
   * Unidades com `ProcessAccess` ativo de motivo `REQUESTING`, `CURRENT` ou — com
   * `access.historicalDepartmentsCanView` — `HISTORICAL`.
   */
  readonly departmentIds: readonly string[];
  /** Usuários com `ProcessAccess` ativo (criador, responsável, participante, aprovador). */
  readonly userIds: readonly string[];
  /** Participações ativas (não revogadas); a expiração é conferida na decisão. */
  readonly participations: readonly ProcessParticipation[];
}

export interface ProcessAccessReader {
  /** `null` = inexistente no tenant da transação (RLS), descartado ou de outro tenant. */
  load(tx: TenantTx, processId: string): Promise<ProcessAccessTarget | null>;
}

/**
 * Escopo de visibilidade de processos do usuário (DEC-024 · permissions.md §5): os escopos de
 * `PROCESS_VIEW` já expandidos (subárvore e lotação). Única entrada do predicado SQL
 * (`buildVisibilityPredicate`) e da checagem em memória (`isProcessVisible`).
 */
export interface ProcessVisibilityScope {
  readonly userId: string;
  /** `PROCESS_VIEW` com escopo `TENANT`. */
  readonly tenantWide: boolean;
  /** Órgãos dos escopos `ORGANIZATION` de `PROCESS_VIEW`. */
  readonly organizationIds: readonly string[];
  /** Unidades dos escopos `DEPARTMENT`/`OWN_DEPARTMENTS` de `PROCESS_VIEW`, expandidas. */
  readonly departmentIds: readonly string[];
}

/**
 * Predicado de visibilidade avaliado em memória — o mesmo de `buildVisibilityPredicate`
 * (permissions.md §5): escopo do tenant, órgão do processo, concessão de unidade ou concessão
 * própria. Não visível = 404 igual ao inexistente.
 */
export function isProcessVisible(
  scope: ProcessVisibilityScope,
  target: Pick<ProcessAccessTarget, 'organizationId' | 'departmentIds' | 'userIds'>,
): boolean {
  if (scope.tenantWide) return true;
  if (target.organizationId !== null && scope.organizationIds.includes(target.organizationId)) {
    return true;
  }
  if (target.departmentIds.some((departmentId) => scope.departmentIds.includes(departmentId))) {
    return true;
  }
  return target.userIds.includes(scope.userId);
}

/** Registro do leitor de processos (implementado pelo módulo `process`). */
@Injectable()
export class ProcessAccessRegistry {
  private reader: ProcessAccessReader | null = null;

  register(reader: ProcessAccessReader): void {
    this.reader = reader;
  }

  /** Sem leitor registrado, nenhum processo existe (falha fechada → 404). */
  load(tx: TenantTx, processId: string): Promise<ProcessAccessTarget | null> {
    return this.reader ? this.reader.load(tx, processId) : Promise.resolve(null);
  }
}

/** Importado por `access` (consumidor) e `process` (implementador). */
@Module({ providers: [ProcessAccessRegistry], exports: [ProcessAccessRegistry] })
export class ProcessAccessModule {}
