import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import {
  PROCESS_CLOCK,
  PROCESS_ITEM_REPOSITORY,
  PROCESS_REPOSITORY,
  TAG_REPOSITORY,
} from './ports.js';
import type {
  ProcessAggregateRows,
  ProcessClock,
  ProcessItemRepository,
  ProcessRepository,
  ProcessRuntimeReader,
  TagRepository,
} from './ports.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { isParticipationExpired } from '../domain/process-participants.js';
import type { ProcessAccessGrants, ProcessRuntime } from '../domain/process-runtime.js';

const HISTORICAL_SETTING = 'access.historicalDepartmentsCanView';

/**
 * Concessões que dão visibilidade (permissions.md §5) e as participações que valem (§4 · US-012):
 * unidades (`REQUESTING`/`CURRENT`/`HISTORICAL`), unidades participantes (só visibilidade),
 * usuários e participações não vencidas. A concessão `PARTICIPANT` de consultor vencido não conta
 * (RN-PROC-135), mesmo antes de o job `participants-expire` revogá-la.
 */
export function accessGrantsOf(
  rows: Pick<ProcessAggregateRows, 'access' | 'participants'>,
  historicalDepartmentsCanView: boolean,
  now: Date,
): ProcessAccessGrants {
  const departmentReasons = new Set(
    historicalDepartmentsCanView
      ? ['REQUESTING', 'CURRENT', 'HISTORICAL']
      : ['REQUESTING', 'CURRENT'],
  );
  const live = rows.participants.filter((participant) => !isParticipationExpired(participant, now));
  const expiredUsers = new Set(
    rows.participants.flatMap((participant) =>
      participant.userId !== null && isParticipationExpired(participant, now)
        ? [participant.userId]
        : [],
    ),
  );
  const departmentIds = new Set<string>();
  const participantDepartmentIds = new Set<string>();
  const userIds = new Set<string>();
  for (const row of rows.access) {
    if (row.principalType === 'DEPARTMENT' && row.departmentId !== null) {
      if (departmentReasons.has(row.reason)) departmentIds.add(row.departmentId);
      else if (row.reason === 'PARTICIPANT') participantDepartmentIds.add(row.departmentId);
    } else if (row.userId !== null) {
      if (row.reason === 'PARTICIPANT' && expiredUsers.has(row.userId)) continue;
      userIds.add(row.userId);
    }
  }
  return {
    departmentIds: [...departmentIds],
    userIds: [...userIds],
    participations: live.map(({ userId, departmentId, role, expiresAt }) => ({
      userId,
      departmentId,
      role,
      expiresAt,
    })),
    participantDepartmentIds: [...participantDepartmentIds],
  };
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
    @Inject(PROCESS_ITEM_REPOSITORY) private readonly items: ProcessItemRepository,
    @Inject(TAG_REPOSITORY) private readonly tags: TagRepository,
    private readonly catalog: CatalogFacade,
    private readonly tenancy: TenancyFacade,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
  ) {}

  async load(tx: TenantTx, processId: string): Promise<ProcessRuntime | null> {
    const rows = await this.processes.loadAggregate(tx, processId);
    return rows === null ? null : this.fromAggregate(tx, rows);
  }

  /** O runtime de um agregado já lido no `tx` (painel situacional — US-004: uma leitura só). */
  async fromAggregate(tx: TenantTx, rows: ProcessAggregateRows): Promise<ProcessRuntime> {
    const { process } = rows;
    const settings = await this.tenancy.settingValues(tx, [HISTORICAL_SETTING]);
    // RN-PROC-82: `itemsCount`/`hasLots` refletem os itens ativos nas avaliações (US-006).
    const items = await this.items.stats(tx, process.id);
    // RN-PROC-92: os NOMES das etiquetas (ativas e inativas) no momento da regra.
    const tags = (await this.tags.forProcesses(tx, [process.id])).get(process.id) ?? [];
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
      numbered: process.number !== null || process.code !== null,
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
        tags: tags.map((tag) => tag.name),
        targetDate: process.targetDate,
        year: process.year,
        itemsCount: items.count,
        hasLots: items.hasLots,
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
      access: accessGrantsOf(rows, settings.get(HISTORICAL_SETTING) !== false, this.clock()),
    };
  }
}
