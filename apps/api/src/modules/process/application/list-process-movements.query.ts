import { performance } from 'node:perf_hooks';

import { PROCESS_MOVEMENTS_MESSAGES } from '@contrataflow/validation';
import type {
  MovementItemDto,
  ProcessMovementsMeta,
  ProcessMovementsQuery,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { requireRequestContext } from '#shared/context/request-context.js';
import { DatabaseUnavailableError, isTransientDatabaseError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import { decodeCursor, encodeCursor } from '#shared/http/pagination.js';

import { PROCESS_REPOSITORY, PROCESS_TRANSACTIONS } from './ports.js';
import type { ProcessRepository, ProcessTransactions } from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { ApprovalFacade } from '../../approval/application/approval.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import {
  movementCriteriaOf,
  movementFilterKeys,
  movementReferencesOf,
  toMovementItem,
  unresolvedReferences,
} from '../domain/process-movements.js';
import type { MovementNames, PartyName, StoredMovement } from '../domain/process-movements.js';

/** Posição opaca do cursor de PRC-11 (o cliente nunca interpreta): `sequence` da última. */
const cursorPosition = z.strictObject({ s: z.int().min(1) });

/** V-04: cursor inválido ou expirado → 422 com a mensagem da story (a UI reinicia a lista). */
function decodeMovementsCursor(cursor: string): number {
  try {
    return decodeCursor(cursor, cursorPosition).s;
  } catch {
    throw validationError([
      {
        field: 'cursor',
        code: 'INVALID_FORMAT',
        message: PROCESS_MOVEMENTS_MESSAGES.invalidCursor,
      },
    ]);
  }
}

/**
 * `ListProcessMovementsHandler` — PRC-11 (US-054): o histórico de tramitações do processo, mais
 * recente primeiro (`sequence DESC`), por cursor, com filtros por ação, unidade de origem/destino,
 * ator e período. `PROCESS_VIEW` sobre o processo (DEC-024) já foi conferido pelo guard — não
 * visível, inexistente ou de outro tenant = 404 `PROCESS_NOT_FOUND` com `access.denied`
 * (RN-TRAM-77). Somente leitura (RN-TRAM-76), `READ COMMITTED`, sem eventos nem auditoria própria.
 * Os nomes (etapa, unidade, usuário) e o resumo da aprovação são hidratados em lote por página —
 * uma leitura por tipo, nunca por item.
 */
@Injectable()
export class ListProcessMovementsHandler {
  private readonly logger = new Logger('Process');

  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_TRANSACTIONS) private readonly transactions: ProcessTransactions,
    private readonly access: AccessFacade,
    private readonly workflow: WorkflowFacade,
    private readonly organization: OrganizationFacade,
    private readonly identity: IdentityFacade,
    private readonly approvals: ApprovalFacade,
  ) {}

  async execute(
    processId: string,
    query: ProcessMovementsQuery,
  ): Promise<DataResult<MovementItemDto[], ProcessMovementsMeta>> {
    const beforeSequence = query.cursor === undefined ? null : decodeMovementsCursor(query.cursor);
    const started = performance.now();
    try {
      const canViewIp = await this.canViewIp();
      const page = await this.transactions.read(async (tx) => {
        const fetched = await this.processes.listMovements(tx, {
          processId,
          ...movementCriteriaOf(query),
          beforeSequence,
          take: query.limit + 1,
        });
        const movements = fetched.slice(0, query.limit);
        const names = await this.hydrate(tx, movements);
        this.warnUnresolved(processId, movements, names);
        return {
          items: movements.map((movement) => toMovementItem(movement, names, canViewIp)),
          hasMore: fetched.length > query.limit,
          last: movements.at(-1),
        };
      });
      const nextCursor =
        page.hasMore && page.last !== undefined ? encodeCursor({ s: page.last.sequence }) : null;
      this.logger.log(
        {
          event: 'process.movements_listed',
          processId,
          filterKeys: movementFilterKeys(query),
          itemCount: page.items.length,
          hasMore: page.hasMore,
          durationMs: Math.round(performance.now() - started),
          correlationId: requireRequestContext().correlationId,
        },
        'process.movements_listed',
      );
      return new DataResult(page.items, { nextCursor, hasMore: page.hasMore, canViewIp });
    } catch (error) {
      throw this.failure(error);
    }
  }

  /**
   * RN-TRAM-74: `ip` só com `AUDIT_VIEW` (com o 2º fator exigido, como a POL-09). Postura segura:
   * se a decisão não puder ser tomada (cache e banco das permissões fora), o campo é tratado como
   * não autorizado e a lista segue normalmente.
   */
  private async canViewIp(): Promise<boolean> {
    try {
      return await this.access.revealsField('AUDIT_VIEW');
    } catch (error) {
      this.logger.warn(
        {
          event: 'process.movements_ip_check_failed',
          errorName: error instanceof Error ? error.name : null,
          correlationId: requireRequestContext().correlationId,
        },
        'process.movements_ip_check_failed',
      );
      return false;
    }
  }

  /** Nomes da página: uma leitura por tipo (etapas, unidades, usuários, vínculos, aprovações). */
  private async hydrate(
    tx: TenantTx,
    movements: readonly StoredMovement[],
  ): Promise<MovementNames> {
    if (movements.length === 0) {
      return { stages: new Map(), departments: new Map(), users: new Map(), approvals: new Map() };
    }
    const references = movementReferencesOf(movements);
    const stageIds = new Set(
      movements.flatMap((movement) =>
        [movement.fromWorkflowStageId, movement.toWorkflowStageId].filter(
          (id): id is string => id !== null,
        ),
      ),
    );
    const released = await this.workflow.releasedStages(tx);
    const stages = new Map(
      released.filter((stage) => stageIds.has(stage.id)).map((stage) => [stage.id, stage.name]),
    );
    const departmentRefs = await this.organization.departmentReferences(
      tx,
      references.departmentIds,
    );
    const departments = new Map<string, PartyName>(
      [...departmentRefs].map(([id, department]) => [
        id,
        { name: department.name, isActive: department.isActive },
      ]),
    );
    const userNames = await this.identity.userDisplayNames(tx, references.userIds);
    const members =
      userNames.size === 0 ? [] : await this.identity.membersInTenant(tx, [...userNames.keys()]);
    const activeMembers = new Set(
      members.filter((member) => member.status === 'ACTIVE').map((member) => member.userId),
    );
    const users = new Map<string, PartyName>(
      [...userNames].map(([id, name]) => [id, { name, isActive: activeMembers.has(id) }]),
    );
    const approvals = await this.approvals.approvalSummaries(tx, references.approvalIds);
    return { stages, departments, users, approvals };
  }

  /** `warn process.movements_hydration_partial`: só contagens (nunca nomes, comentário ou IP). */
  private warnUnresolved(
    processId: string,
    movements: readonly StoredMovement[],
    names: MovementNames,
  ): void {
    const missing = unresolvedReferences(movements, names);
    if (missing.stages + missing.departments + missing.users === 0) return;
    this.logger.warn(
      {
        event: 'process.movements_hydration_partial',
        processId,
        missingStages: missing.stages,
        missingDepartments: missing.departments,
        missingUsers: missing.users,
        correlationId: requireRequestContext().correlationId,
      },
      'process.movements_hydration_partial',
    );
  }

  /** `error process.movements_list_failed` (sem filtros nem dados) e banco fora do ar → 503. */
  private failure(error: unknown): unknown {
    if (error instanceof ApiError && error.status < 500) return error;
    const transient = isTransientDatabaseError(error);
    const mapped = transient ? new DatabaseUnavailableError(error) : error;
    this.logger.error(
      {
        event: 'process.movements_list_failed',
        errorCode: mapped instanceof ApiError ? mapped.code : 'INTERNAL_ERROR',
        correlationId: requireRequestContext().correlationId,
      },
      'process.movements_list_failed',
    );
    return mapped;
  }
}
