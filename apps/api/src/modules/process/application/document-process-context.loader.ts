import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import type {
  DocumentProcessContext,
  DocumentProcessContextReader,
  DocumentProcessStage,
} from '#shared/document/document-process-context.js';

import { PROCESS_REPOSITORY } from './ports.js';
import type { ProcessRepository } from './ports.js';
import { accessGrantsOf } from './process-runtime.loader.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';

const HISTORICAL_SETTING = 'access.historicalDepartmentsCanView';

/**
 * Lado `process` da porta `DocumentProcessContextRegistry` (US-065): o processo como o ciclo de
 * vida do documento o vê — status, custódia (POL-01), etapa atual com os tipos editáveis e os
 * cobertos pela aprovação (POL-02/RN-DOC-44, do snapshot da versão de workflow fixada), concessões
 * de acesso (DEC-024) e os nomes que a versão do documento congela (entities.md §5.3.2). Tudo no
 * `tx` do caso de uso (RLS: de outro tenant = inexistente).
 */
@Injectable()
export class DocumentProcessContextLoader implements DocumentProcessContextReader {
  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    private readonly workflow: WorkflowFacade,
    private readonly tenancy: TenancyFacade,
    private readonly organization: OrganizationFacade,
  ) {}

  async load(tx: TenantTx, processId: string): Promise<DocumentProcessContext | null> {
    const rows = await this.processes.loadAggregate(tx, processId);
    if (rows === null) return null;
    const { process } = rows;
    const settings = await this.tenancy.settingValues(tx, [HISTORICAL_SETTING]);
    const grants = accessGrantsOf(rows.access, settings.get(HISTORICAL_SETTING) !== false);
    const organization = await this.tenancy.organizationSummary(tx, process.organizationId);
    const names = await this.organization.departmentNames(tx, [
      process.requestingSecretariatId,
      process.requestingDepartmentId,
    ]);
    return {
      id: process.id,
      status: process.status,
      code: process.code,
      title: process.title,
      object: process.object,
      organizationId: process.organizationId,
      organizationName: organization?.name ?? null,
      organizationCnpj: organization?.cnpj ?? null,
      requestingSecretariatId: process.requestingSecretariatId,
      requestingSecretariatName: names.get(process.requestingSecretariatId) ?? null,
      requestingDepartmentId: process.requestingDepartmentId,
      requestingDepartmentName: names.get(process.requestingDepartmentId) ?? null,
      isBudgetConfidential: process.isBudgetConfidential,
      currentDepartmentId: process.currentDepartmentId,
      currentResponsibleId: process.currentResponsibleId,
      currentStage: await this.currentStage(tx, process),
      access: {
        processId: process.id,
        organizationId: process.organizationId,
        departmentIds: grants.departmentIds,
        userIds: grants.userIds,
        participations: grants.participations ?? [],
      },
    };
  }

  private async currentStage(
    tx: TenantTx,
    process: {
      readonly workflowVersionId: string;
      readonly currentWorkflowStageId: string | null;
      readonly currentStageId: string | null;
    },
  ): Promise<DocumentProcessStage | null> {
    if (process.currentWorkflowStageId === null) return null;
    const definition = await this.workflow.publishedDefinitionIn(tx, process.workflowVersionId);
    const stage = definition?.stages.find((item) => item.id === process.currentWorkflowStageId);
    if (stage === undefined) return null;
    return {
      processStageId: process.currentStageId,
      workflowStageId: stage.id,
      key: stage.key,
      name: stage.name,
      type: stage.type,
      documentTypeCodes: stage.documentTypeCodes,
      approvalDocumentTypeCodes: stage.approvalDocumentTypeCodes,
    };
  }
}
