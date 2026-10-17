import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { PROCESS_REPOSITORY } from './ports.js';
import type {
  ProcessAccessRow,
  ProcessAggregateRows,
  ProcessRepository,
  ProcessRuntimeReader,
} from './ports.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import type { ProcessAccessGrants, ProcessRuntime } from '../domain/process-runtime.js';

const HISTORICAL_SETTING = 'access.historicalDepartmentsCanView';

/** Concessões que dão visibilidade (permissions.md §5): unidades e usuários. */
export function accessGrantsOf(
  rows: readonly ProcessAccessRow[],
  historicalDepartmentsCanView: boolean,
): ProcessAccessGrants {
  const departmentReasons = new Set(
    historicalDepartmentsCanView
      ? ['REQUESTING', 'CURRENT', 'HISTORICAL']
      : ['REQUESTING', 'CURRENT'],
  );
  const departmentIds = new Set<string>();
  const userIds = new Set<string>();
  for (const row of rows) {
    if (row.principalType === 'DEPARTMENT' && row.departmentId !== null) {
      if (departmentReasons.has(row.reason)) departmentIds.add(row.departmentId);
    } else if (row.userId !== null) {
      userIds.add(row.userId);
    }
  }
  return { departmentIds: [...departmentIds], userIds: [...userIds] };
}

/**
 * Leitor do runtime do processo (US-001 — substitui o `PendingProcessRuntimeReader` da US-041):
 * o agregado, as passagens e as concessões ativas lidos pelo repositório numa ÚNICA instrução, mais
 * os códigos dos catálogos para o `RuleContext.process` (entities.md §5.4). Documentos e aprovações
 * entram com as stories donas (US-014/US-051) pelos contribuidores do `RuleContext`.
 */
@Injectable()
export class ProcessRuntimeLoader implements ProcessRuntimeReader {
  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    private readonly catalog: CatalogFacade,
    private readonly tenancy: TenancyFacade,
  ) {}

  async load(tx: TenantTx, processId: string): Promise<ProcessRuntime | null> {
    const rows = await this.processes.loadAggregate(tx, processId);
    return rows === null ? null : this.fromAggregate(tx, rows);
  }

  /** O runtime de um agregado já lido no `tx` (painel situacional — US-004: uma leitura só). */
  async fromAggregate(tx: TenantTx, rows: ProcessAggregateRows): Promise<ProcessRuntime> {
    const { process } = rows;
    const settings = await this.tenancy.settingValues(tx, [HISTORICAL_SETTING]);
    const codeOf = async (id: string | null) =>
      id === null ? null : ((await this.catalog.find(tx, id))?.code ?? null);
    return {
      id: process.id,
      tenantId: process.tenantId,
      workflowVersionId: process.workflowVersionId,
      status: process.status,
      createdById: process.createdById,
      currentDepartmentId: process.currentDepartmentId,
      currentResponsibleId: process.currentResponsibleId,
      organizationId: process.organizationId,
      ruleProcess: {
        status: process.status,
        priority: process.priority,
        estimatedValue: process.estimatedValue === null ? null : Number(process.estimatedValue),
        contractingTypeCode: (await codeOf(process.contractingTypeId)) ?? '',
        modalityCode: await codeOf(process.modalityId),
        originCode: (await codeOf(process.originId)) ?? '',
        isPriceRegistration: process.isPriceRegistration,
        isBudgetConfidential: process.isBudgetConfidential,
        pcaStatus: process.pcaStatus,
        organizationId: process.organizationId,
        requestingSecretariatId: process.requestingSecretariatId,
        requestingDepartmentId: process.requestingDepartmentId,
        tags: [],
        targetDate: process.targetDate,
        year: process.year,
        itemsCount: 0,
        hasLots: false,
      },
      passes: rows.stages.map((stage) => ({
        processStageId: stage.id,
        workflowStageId: stage.workflowStageId,
        sequence: stage.sequence,
        status: stage.status,
        departmentId: stage.departmentId,
        assigneeId: stage.assigneeId,
        enteredAt: stage.enteredAt.toISOString(),
        exitedAt: stage.exitedAt?.toISOString() ?? null,
      })),
      approvals: [],
      documents: [],
      access: accessGrantsOf(rows.access, settings.get(HISTORICAL_SETTING) !== false),
    };
  }
}
