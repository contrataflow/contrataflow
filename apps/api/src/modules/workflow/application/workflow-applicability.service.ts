import { withSpan } from '@contrataflow/observability';
import type { WorkflowResolutionDto, WorkflowResolve } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { WORKFLOW_REPOSITORY, WORKFLOW_TRANSACTIONS } from './ports.js';
import type { WorkflowRepository, WorkflowTransactions } from './ports.js';
import { recordResolution } from './workflow-telemetry.js';
import { noApplicableWorkflow } from './workflow.errors.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { resolveApplicableWorkflow } from '../domain/workflow-applicability.js';
import type { ApplicabilityProcess } from '../domain/workflow-applicability.js';

/**
 * `WorkflowApplicabilityService` (US-042 · RN-WF-39 · RN-PROC-06): resolve, no `tx` do chamador e
 * sob a RLS do tenant (só workflows do próprio tenant entram na avaliação), o workflow aplicável e a
 * versão publicada a fixar no processo, com a etapa inicial lida do snapshot imutável. Sem nenhum
 * → 422 `NO_APPLICABLE_WORKFLOW`. Regra que não pôde ser avaliada não casa e vai para o log
 * (`error workflow.applicability_rule_failed`). Quem chama autoriza.
 */
@Injectable()
export class WorkflowApplicabilityService {
  private readonly logger = new Logger('Workflows');

  constructor(@Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository) {}

  async resolveIn(tx: TenantTx, process: ApplicabilityProcess): Promise<WorkflowResolutionDto> {
    const startedAt = performance.now();
    const context = requireRequestContext();
    return withSpan(
      'workflow.resolve_applicable',
      { 'cf.tenant.id': context.tenantId },
      async () => {
        const resolution = resolveApplicableWorkflow(
          await this.workflows.listAllWorkflows(tx),
          process,
        );
        for (const { workflowId, problem } of resolution.problems) {
          this.logger.error(
            {
              event: 'workflow.applicability_rule_failed',
              workflowId,
              kind: problem.kind,
              detail: problem.detail,
              tenantId: context.tenantId,
              correlationId: context.correlationId,
            },
            'workflow.applicability_rule_failed',
          );
        }
        const workflow = resolution.workflow;
        const version = workflow?.currentPublishedVersionId
          ? await this.workflows.findVersion(tx, workflow.currentPublishedVersionId)
          : null;
        const snapshot = version?.definitionSnapshot ?? null;
        const initialStage = snapshot?.stages.find((stage) => stage.id === snapshot.initialStageId);
        recordResolution(resolution.via ?? 'NONE', performance.now() - startedAt);
        if (!workflow || !version || !initialStage) throw noApplicableWorkflow();
        return {
          workflowId: workflow.id,
          workflowVersionId: version.id,
          name: workflow.name,
          versionNumber: version.versionNumber,
          initialStage: { id: initialStage.id, key: initialStage.key, name: initialStage.name },
        };
      },
    );
  }
}

/**
 * `ResolveWorkflowQuery` — WF-06 (US-042 · fluxo principal, passo 5 · FA-04): `WORKFLOW_VIEW`;
 * traduz os itens de catálogo do tenant (inexistente, de outro tenant ou inativo → 422
 * `VALIDATION_ERROR`) nos códigos do `RuleContext.process` e resolve. `modalityId` ausente = "A
 * definir" (`modalityCode = null`): nenhuma regra que exija modalidade casa e vale o padrão.
 */
@Injectable()
export class ResolveWorkflowQuery {
  constructor(
    @Inject(WORKFLOW_TRANSACTIONS) private readonly transactions: WorkflowTransactions,
    private readonly applicability: WorkflowApplicabilityService,
    private readonly catalog: CatalogFacade,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(body: WorkflowResolve): Promise<WorkflowResolutionDto> {
    this.access.assertCan('WORKFLOW_VIEW', { mfaPolicy: await this.identity.mfaPolicy() });
    return this.transactions.read(async (tx) => {
      const contractingType = await this.catalog.assertActive(
        tx,
        'CONTRACTING_TYPE',
        body.contractingTypeId,
        'contractingTypeId',
      );
      const modality = body.modalityId
        ? await this.catalog.assertActive(tx, 'MODALITY', body.modalityId, 'modalityId')
        : null;
      const origin = await this.catalog.assertActive(
        tx,
        'PROCESS_ORIGIN',
        body.originId,
        'originId',
      );
      return this.applicability.resolveIn(tx, {
        contractingTypeCode: contractingType.code,
        modalityCode: modality?.code ?? null,
        originCode: origin.code,
        estimatedValue:
          body.estimatedValue === null || body.estimatedValue === undefined
            ? null
            : Number(body.estimatedValue),
        isPriceRegistration: body.isPriceRegistration,
        organizationId: body.organizationId,
      });
    });
  }
}
