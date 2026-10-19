import { withSpan } from '@contrataflow/observability';
import { APPROVAL_LIST_MESSAGES } from '@contrataflow/validation';
import type { ApprovalListItemDto, ApprovalListQuery, PageMeta } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { DatabaseUnavailableError, isStatementTimeout } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { recordApprovalListQuery } from './approval-telemetry.js';
import { APPROVAL_CLOCK, APPROVAL_LIST_READER, APPROVAL_TRANSACTIONS } from './ports.js';
import type { ApprovalClock, ApprovalListReader, ApprovalTransactions } from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { BusinessCalendarFacade } from '../../catalog/application/business-calendar.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { isApprovalOverdue } from '../domain/approval-list.js';
import type { ApprovalListRow, ApproverCoverage } from '../domain/approval-list.js';

/*
 * `ListApprovalsHandler` (APV-01 · US-057 · SCR-014): leitura pura (sem evento nem auditoria) na
 * transação de leitura do tenant. A cobertura de quem consulta (POL-03 — titularidades e
 * substituições do `organization`, competência dos perfis do `access`) é resolvida uma vez e entra
 * na consulta como predicado (RN-INBOX-14): sem cobertura, lista vazia — nunca 403. Logs sem título
 * do processo nem comentários (story · "Logs").
 */

export interface ApprovalListResult {
  readonly items: ApprovalListItemDto[];
  readonly meta: PageMeta;
}

/** Nomes por lote (sem N+1) e o rótulo do aprovador (FA-02). */
@Injectable()
export class ApprovalListPresenter {
  constructor(
    private readonly identity: IdentityFacade,
    private readonly organization: OrganizationFacade,
    private readonly access: AccessFacade,
  ) {}

  async present(
    tx: TenantTx,
    rows: readonly ApprovalListRow[],
    now: Date,
  ): Promise<ApprovalListItemDto[]> {
    if (rows.length === 0) return [];
    const unique = (values: (string | null)[]) => [
      ...new Set(values.filter((value): value is string => value !== null)),
    ];
    // Em sequência: a transação interativa executa uma consulta por vez.
    const userNames = await this.identity.userDisplayNames(
      tx,
      unique(rows.flatMap((row) => [row.requestedById, row.approverUserId])),
    );
    const departmentNames = await this.organization.departmentNames(
      tx,
      unique(rows.flatMap((row) => [row.process.requestingDepartmentId, row.approverDepartmentId])),
    );
    const roleIds = unique(
      rows.map((row) => (row.approverType === 'ROLE' ? row.approverRoleId : null)),
    );
    const roles = await this.access.roleSummaries(tx, roleIds);

    const label = (row: ApprovalListRow): string => {
      switch (row.approverType) {
        case 'USER':
          return userNames.get(row.approverUserId ?? '') ?? 'Aprovador designado';
        case 'ROLE':
          return `Aguardando: qualquer titular de ${
            roles.get(row.approverRoleId ?? '')?.name ?? 'perfil aprovador'
          }`;
        case 'DEPARTMENT_HEAD': {
          const department = departmentNames.get(row.approverDepartmentId ?? '') ?? 'unidade';
          const head = row.approverUserId === null ? undefined : userNames.get(row.approverUserId);
          return head === undefined
            ? `Titular da ${department}`
            : `${head} (titular da ${department})`;
        }
      }
    };

    return rows.map((row) => ({
      id: row.id,
      subjectType: row.subjectType,
      title: row.title,
      status: row.status,
      process: { id: row.processId, code: row.process.code, title: row.process.title },
      document: row.documentId === null ? null : { id: row.documentId },
      requestingDepartment: {
        id: row.process.requestingDepartmentId,
        name:
          departmentNames.get(row.process.requestingDepartmentId) ??
          row.process.requestingDepartmentId,
      },
      requestedBy: {
        id: row.requestedById,
        name: userNames.get(row.requestedById) ?? row.requestedById,
      },
      requestedAt: row.requestedAt.toISOString(),
      dueAt: row.dueAt?.toISOString() ?? null,
      isOverdue: isApprovalOverdue(row, now),
      approver: { type: row.approverType, label: label(row) },
      isBudgetConfidential: row.process.isBudgetConfidential,
    }));
  }
}

@Injectable()
export class ListApprovalsHandler {
  private readonly logger = new Logger('ApprovalList');

  constructor(
    @Inject(APPROVAL_TRANSACTIONS) private readonly transactions: ApprovalTransactions,
    @Inject(APPROVAL_LIST_READER) private readonly reader: ApprovalListReader,
    @Inject(APPROVAL_CLOCK) private readonly clock: ApprovalClock,
    private readonly access: AccessFacade,
    private readonly organization: OrganizationFacade,
    private readonly calendar: BusinessCalendarFacade,
    private readonly presenter: ApprovalListPresenter,
  ) {}

  execute(query: ApprovalListQuery): Promise<ApprovalListResult> {
    return withSpan('approvals.query', {}, async () => {
      const startedAt = performance.now();
      try {
        const result = await this.run(query);
        const durationMs = Math.round(performance.now() - startedAt);
        const context = requireRequestContext();
        this.logger.log(
          {
            event: 'approvals.query',
            // Só a forma dos filtros: a busca textual (`q`) pode conter dados do processo.
            filters: {
              statuses: query.statuses,
              subjectType: query.subjectType,
              requestingDepartmentId: query.requestingDepartmentId,
              requestedFrom: query.requestedFrom,
              requestedTo: query.requestedTo,
              hasSearch: query.q !== null,
              sort: `${query.sort.direction === 'desc' ? '-' : ''}${query.sort.field}`,
              page: query.page,
              pageSize: query.pageSize,
            },
            resultCount: result.items.length,
            durationMs,
            tenantId: context.tenantId,
            userId: context.actor.userId,
            correlationId: context.correlationId,
          },
          'approvals.query',
        );
        recordApprovalListQuery(durationMs, 'ok');
        return result;
      } catch (error) {
        recordApprovalListQuery(Math.round(performance.now() - startedAt), 'error');
        throw this.failure(error);
      }
    });
  }

  private run(query: ApprovalListQuery): Promise<ApprovalListResult> {
    return this.transactions.read(async (tx) => {
      const now = this.clock();
      if (query.requestingDepartmentId !== null) {
        await this.assertDepartment(tx, query.requestingDepartmentId);
      }
      const coverage = await this.coverageIn(tx, now);
      const page = await this.reader.page(tx, {
        coverage,
        criteria: {
          statuses: query.statuses,
          subjectType: query.subjectType,
          requestingDepartmentId: query.requestingDepartmentId,
          requestedFrom: query.requestedFrom,
          requestedTo: query.requestedTo,
          q: query.q,
          timezone: await this.calendar.timezone(tx),
        },
        sort: query.sort,
        page: query.page,
        pageSize: query.pageSize,
      });
      return {
        items: await this.presenter.present(tx, page.rows, now),
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          totalItems: page.totalItems,
          totalPages: Math.ceil(page.totalItems / query.pageSize),
        },
      };
    });
  }

  /** POL-03 de quem consulta: titularidades/substituições atuais e a competência dos perfis. */
  private async coverageIn(tx: TenantTx, now: Date): Promise<ApproverCoverage> {
    const userId = requireRequestContext().actor.userId;
    if (userId === null) throw new ApiError('UNAUTHENTICATED');
    const leadership = await this.organization.departmentLeadership(tx, userId);
    const roles = await this.access.approverCompetenceIn(tx, now);
    return { userId, headOf: leadership.headOf, deputyOf: leadership.deputyOf, roles };
  }

  /** V-04: unidade de outro tenant ou inexistente → 422 `REFERENCE_NOT_FOUND`. */
  private async assertDepartment(tx: TenantTx, departmentId: string): Promise<void> {
    const found = await this.organization.departmentReferences(tx, [departmentId]);
    if (!found.has(departmentId)) {
      throw validationError([
        {
          field: 'requestingDepartmentId',
          code: 'REFERENCE_NOT_FOUND',
          message: APPROVAL_LIST_MESSAGES.invalidDepartment,
        },
      ]);
    }
  }

  private failure(error: unknown): unknown {
    const translated = isStatementTimeout(error) ? new DatabaseUnavailableError(error) : error;
    if (!(translated instanceof ApiError) || translated.status >= 500) {
      this.logger.error(
        {
          event: 'approvals.query_failed',
          errorCode: translated instanceof ApiError ? translated.code : 'INTERNAL_ERROR',
          cause: error instanceof Error ? error.name : typeof error,
          correlationId: requireRequestContext().correlationId,
        },
        'approvals.query_failed',
      );
    }
    return translated;
  }
}
