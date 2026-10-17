import type { ProcessDto } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { AccessFacade } from '../../access/application/access.facade.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import type { CatalogItemRef } from '../../catalog/application/catalog.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import type { WorkflowSnapshotStage } from '../../workflow/application/workflow.facade.js';
import type { Process } from '../domain/process.js';

/*
 * `ProcessPresenter` (US-001 · api/02-processes.md, esquema `Process`): o agregado com os nomes
 * das referências (órgão, unidades, catálogos, etapa, workflow, pessoas) e o mascaramento do valor
 * estimado sigiloso (DEC-030 · POL-09). As leituras podem ser feitas ANTES de numerar (criação:
 * a sequência fica travada só pelo tempo das gravações) e o DTO montado depois, sem banco.
 */

export interface ProcessLookups {
  readonly organizationShortName: string;
  readonly departmentNames: ReadonlyMap<string, string>;
  readonly catalog: ReadonlyMap<string, CatalogItemRef>;
  readonly stage: WorkflowSnapshotStage | null;
  readonly workflow: { readonly workflowId: string; readonly name: string; versionNumber: number };
  readonly userNames: ReadonlyMap<string, string>;
  /** `PROCESS_VIEW_CONFIDENTIAL_BUDGET` do vínculo da requisição. */
  readonly canSeeConfidentialBudget: boolean;
}

/** Referências do processo que a apresentação resolve. */
export type ProcessLookupKeys = Pick<
  Process,
  | 'organizationId'
  | 'requestingSecretariatId'
  | 'requestingDepartmentId'
  | 'currentDepartmentId'
  | 'contractingTypeId'
  | 'modalityId'
  | 'originId'
  | 'workflowVersionId'
  | 'currentWorkflowStageId'
  | 'createdById'
  | 'currentResponsibleId'
>;

/** Referência ausente na leitura (registro removido fora do fluxo): mostra o id, nunca quebra. */
function nameOr(names: ReadonlyMap<string, string>, id: string): string {
  return names.get(id) ?? id;
}

function catalogRef(catalog: ReadonlyMap<string, CatalogItemRef>, id: string) {
  const item = catalog.get(id);
  return { id, code: item?.code ?? '', label: item?.label ?? '' };
}

/** `ProcessDto` (puro) a partir do agregado e das leituras. */
export function toProcessDto(process: Process, lookups: ProcessLookups): ProcessDto {
  const masked = process.isBudgetConfidential && !lookups.canSeeConfidentialBudget;
  const stage = lookups.stage;
  return {
    id: process.id,
    code: process.code,
    number: process.number,
    year: process.year,
    internalCode: process.internalCode,
    title: process.title,
    object: process.object,
    description: process.description,
    status: process.status,
    priority: process.priority,
    organization: { id: process.organizationId, shortName: lookups.organizationShortName },
    requestingSecretariat: {
      id: process.requestingSecretariatId,
      name: nameOr(lookups.departmentNames, process.requestingSecretariatId),
    },
    requestingDepartment: {
      id: process.requestingDepartmentId,
      name: nameOr(lookups.departmentNames, process.requestingDepartmentId),
    },
    contractingType: catalogRef(lookups.catalog, process.contractingTypeId),
    modality: process.modalityId === null ? null : catalogRef(lookups.catalog, process.modalityId),
    origin: catalogRef(lookups.catalog, process.originId),
    isPriceRegistration: process.isPriceRegistration,
    currentStage:
      process.currentStageId === null || stage === null
        ? null
        : {
            id: process.currentStageId,
            key: stage.key,
            name: stage.name,
            dueAt: process.currentStageDueAt?.toISOString() ?? null,
            instructions: stage.instructions,
            documentTypeCodes: [...stage.documentTypeCodes],
          },
    currentDepartment: {
      id: process.currentDepartmentId,
      name: nameOr(lookups.departmentNames, process.currentDepartmentId),
    },
    currentResponsible:
      process.currentResponsibleId === null
        ? null
        : {
            id: process.currentResponsibleId,
            name: nameOr(lookups.userNames, process.currentResponsibleId),
          },
    workflow: {
      id: lookups.workflow.workflowId,
      name: lookups.workflow.name,
      versionNumber: lookups.workflow.versionNumber,
    },
    targetDate: process.targetDate,
    estimatedValue: masked ? null : process.estimatedValue,
    estimatedValueMasked: masked,
    estimatedValueSource: process.estimatedValueSource,
    isBudgetConfidential: process.isBudgetConfidential,
    pcaStatus: process.pcaStatus,
    pcaYear: process.pcaYear,
    pcaItemCode: process.pcaItemCode,
    pcaJustification: process.pcaJustification,
    notes: process.notes,
    creationChannel: process.creationChannel,
    openedAt: process.openedAt?.toISOString() ?? null,
    createdAt: process.createdAt.toISOString(),
    updatedAt: process.updatedAt.toISOString(),
    createdBy: { id: process.createdById, name: nameOr(lookups.userNames, process.createdById) },
    version: process.version,
  };
}

@Injectable()
export class ProcessPresenter {
  constructor(
    private readonly tenancy: TenancyFacade,
    private readonly organization: OrganizationFacade,
    private readonly catalog: CatalogFacade,
    private readonly workflow: WorkflowFacade,
    private readonly identity: IdentityFacade,
    private readonly access: AccessFacade,
  ) {}

  /** Leituras das referências no `tx` do chamador (lote por tipo). */
  async lookups(tx: TenantTx, keys: ProcessLookupKeys): Promise<ProcessLookups> {
    const organization = await this.tenancy.organizationSummary(tx, keys.organizationId);
    const departmentNames = await this.organization.departmentNames(tx, [
      keys.requestingSecretariatId,
      keys.requestingDepartmentId,
      keys.currentDepartmentId,
    ]);
    const catalog = new Map<string, CatalogItemRef>();
    for (const id of [keys.contractingTypeId, keys.modalityId, keys.originId]) {
      if (id === null || catalog.has(id)) continue;
      const item = await this.catalog.find(tx, id);
      if (item) catalog.set(id, item);
    }
    const snapshot = await this.workflow.publishedDefinitionIn(tx, keys.workflowVersionId);
    const stage =
      snapshot?.stages.find((candidate) => candidate.id === keys.currentWorkflowStageId) ?? null;
    const workflow = (await this.workflow.describeVersion(tx, keys.workflowVersionId)) ?? {
      workflowId: keys.workflowVersionId,
      name: '',
      versionNumber: 0,
    };
    const userIds = [keys.createdById, keys.currentResponsibleId].filter(
      (id): id is string => id !== null,
    );
    const userNames = await this.identity.userDisplayNames(tx, userIds);
    return {
      organizationShortName: organization?.shortName ?? '',
      departmentNames,
      catalog,
      stage,
      workflow,
      userNames,
      canSeeConfidentialBudget: this.access.can('PROCESS_VIEW_CONFIDENTIAL_BUDGET'),
    };
  }

  /**
   * `canSeeConfidentialBudget` informado = POL-09 já resolvida para o processo (escopo que o cubra
   * ou custódia — US-004); sem ele, a permissão do vínculo (criação — US-001).
   */
  async present(
    tx: TenantTx,
    process: Process,
    canSeeConfidentialBudget?: boolean,
  ): Promise<ProcessDto> {
    const lookups = await this.lookups(tx, process);
    return toProcessDto(
      process,
      canSeeConfidentialBudget === undefined ? lookups : { ...lookups, canSeeConfidentialBudget },
    );
  }
}
