import {
  dataEnvelope,
  pageEnvelope,
  pageQuerySchema,
  workflowCreateSchema,
  workflowIdParamsSchema,
  workflowRuleDtoSchema,
  workflowRuleIdParamsSchema,
  workflowRuleSchema,
  workflowRuleUpdateSchema,
  workflowSchema,
  workflowStageDtoSchema,
  workflowStageIdParamsSchema,
  workflowStageSchema,
  workflowStageUpdateSchema,
  workflowTransitionDtoSchema,
  workflowTransitionIdParamsSchema,
  workflowTransitionSchema,
  workflowTransitionUpdateSchema,
  workflowUpdateSchema,
  workflowVersionCreateSchema,
  workflowVersionDetailSchema,
  workflowVersionIdParamsSchema,
  workflowVersionSummarySchema,
} from '@contrataflow/validation';
import type {
  PageQuery,
  WorkflowCreate,
  WorkflowDto,
  WorkflowRuleCreate,
  WorkflowRuleDto,
  WorkflowRuleUpdate,
  WorkflowStageCreate,
  WorkflowStageDto,
  WorkflowStageUpdate,
  WorkflowTransitionCreate,
  WorkflowTransitionDto,
  WorkflowTransitionUpdate,
  WorkflowUpdate,
  WorkflowVersionCreate,
  WorkflowVersionDetailDto,
} from '@contrataflow/validation';
import { Controller, Delete, Get, Headers, HttpCode, Patch, Post, Res } from '@nestjs/common';

import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import {
  CreateWorkflowRuleCommand,
  DeleteWorkflowRuleCommand,
  UpdateWorkflowRuleCommand,
} from '../application/workflow-rule.commands.js';
import {
  CreateWorkflowStageCommand,
  DeleteWorkflowStageCommand,
  UpdateWorkflowStageCommand,
} from '../application/workflow-stage.commands.js';
import {
  CreateWorkflowTransitionCommand,
  DeleteWorkflowTransitionCommand,
  UpdateWorkflowTransitionCommand,
} from '../application/workflow-transition.commands.js';
import {
  CreateWorkflowCommand,
  CreateWorkflowVersionCommand,
  UpdateWorkflowCommand,
} from '../application/workflow.commands.js';
import {
  GetWorkflowQuery,
  GetWorkflowVersionQuery,
  ListWorkflowVersionsQuery,
} from '../application/workflow.queries.js';

const TAGS = ['Workflows'];
const AUDIT_UPDATE = ['workflow.update'] as const;

const ifMatchVersion = (ifMatch: IfMatchValue | null) => ifMatch?.value ?? 0;

/**
 * Definição de workflow versionada (api/10-workflow.md WF-02..04, WF-07..18 · US-040): metadados
 * do workflow, versões e manutenção do rascunho (etapas, transições, regras). Leitura exige
 * `WORKFLOW_VIEW`; escrita, `WORKFLOW_MANAGE` + MFA (POL-14). Alterar e excluir exigem `If-Match`.
 */
@Controller()
@TenantScope('TENANT')
export class WorkflowController {
  constructor(
    private readonly createWorkflow: CreateWorkflowCommand,
    private readonly getWorkflowQuery: GetWorkflowQuery,
    private readonly updateWorkflowCommand: UpdateWorkflowCommand,
    private readonly listVersions: ListWorkflowVersionsQuery,
    private readonly createVersion: CreateWorkflowVersionCommand,
    private readonly getVersion: GetWorkflowVersionQuery,
    private readonly createStage: CreateWorkflowStageCommand,
    private readonly updateStage: UpdateWorkflowStageCommand,
    private readonly deleteStage: DeleteWorkflowStageCommand,
    private readonly createTransition: CreateWorkflowTransitionCommand,
    private readonly updateTransition: UpdateWorkflowTransitionCommand,
    private readonly deleteTransition: DeleteWorkflowTransitionCommand,
    private readonly createRule: CreateWorkflowRuleCommand,
    private readonly updateRule: UpdateWorkflowRuleCommand,
    private readonly deleteRule: DeleteWorkflowRuleCommand,
  ) {}

  @Post('workflows')
  @Idempotent()
  @ApiOperation({
    operationId: 'WF-02',
    summary: 'Criar workflow',
    tags: TAGS,
    idempotent: true,
    auditActions: ['workflow.create'],
    responses: {
      201: {
        description: 'Workflow criado com a versão 1 em rascunho (`Location` e `ETag` = versão).',
        schema: dataEnvelope(workflowSchema),
      },
    },
  })
  async postWorkflow(
    @ZodBody(workflowCreateSchema) body: WorkflowCreate,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WorkflowDto> {
    const created = await this.createWorkflow.execute({
      body,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('Location', `/api/v1/workflows/${created.id}`);
    response.setHeader('ETag', `"${created.version}"`);
    return created;
  }

  @Get('workflows/:id')
  @ApiOperation({
    operationId: 'WF-03',
    summary: 'Obter workflow',
    tags: TAGS,
    responses: {
      200: {
        description: 'Workflow com a versão publicada corrente e o rascunho (`ETag` = versão).',
        schema: dataEnvelope(workflowSchema),
      },
    },
  })
  async getWorkflow(
    @ZodParams(workflowIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WorkflowDto> {
    const workflow = await this.getWorkflowQuery.execute(params.id);
    response.setHeader('ETag', `"${workflow.version}"`);
    return workflow;
  }

  @Patch('workflows/:id')
  @HttpCode(200)
  @RequireIfMatch()
  @ApiOperation({
    operationId: 'WF-04',
    summary: 'Atualizar workflow',
    tags: TAGS,
    auditActions: [...AUDIT_UPDATE],
    responses: {
      200: {
        description: 'Workflow atualizado (novo `ETag`).',
        schema: dataEnvelope(workflowSchema),
      },
    },
  })
  async patchWorkflow(
    @ZodParams(workflowIdParamsSchema) params: { id: string },
    @ZodBody(workflowUpdateSchema) body: WorkflowUpdate,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WorkflowDto> {
    const workflow = await this.updateWorkflowCommand.execute({
      id: params.id,
      patch: body,
      expectedVersion: ifMatchVersion(ifMatch),
    });
    response.setHeader('ETag', `"${workflow.version}"`);
    return workflow;
  }

  @Get('workflows/:id/versions')
  @ApiOperation({
    operationId: 'WF-07',
    summary: 'Listar versões do workflow',
    tags: TAGS,
    responses: {
      200: {
        description: 'Versões por número decrescente (status, datas, autores e `definitionHash`).',
        schema: pageEnvelope(workflowVersionSummarySchema),
      },
    },
  })
  getWorkflowVersions(
    @ZodParams(workflowIdParamsSchema) params: { id: string },
    @ZodQuery(pageQuerySchema) query: PageQuery,
  ) {
    return this.listVersions.execute(params.id, query);
  }

  @Post('workflows/:id/versions')
  @ApiOperation({
    operationId: 'WF-08',
    summary: 'Criar nova versão do workflow',
    tags: TAGS,
    auditActions: ['workflow.version_create'],
    responses: {
      201: {
        description:
          'Rascunho nº máx + 1 clonado da versão de origem (padrão: a publicada corrente), com ids novos.',
        schema: dataEnvelope(workflowVersionDetailSchema),
      },
    },
  })
  async postWorkflowVersion(
    @ZodParams(workflowIdParamsSchema) params: { id: string },
    @ZodBody(workflowVersionCreateSchema) body: WorkflowVersionCreate,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WorkflowVersionDetailDto> {
    const version = await this.createVersion.execute({ workflowId: params.id, body });
    response.setHeader('Location', `/api/v1/workflow-versions/${version.id}`);
    response.setHeader('ETag', `"${version.version}"`);
    return version;
  }

  @Get('workflow-versions/:versionId')
  @ApiOperation({
    operationId: 'WF-09',
    summary: 'Obter versão do workflow',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Versão com etapas, transições e regras (rascunho: das tabelas; publicada: do snapshot). `ETag` = versão.',
        schema: dataEnvelope(workflowVersionDetailSchema),
      },
    },
  })
  async getWorkflowVersion(
    @ZodParams(workflowVersionIdParamsSchema) params: { versionId: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WorkflowVersionDetailDto> {
    const version = await this.getVersion.execute(params.versionId);
    response.setHeader('ETag', `"${version.version}"`);
    return version;
  }

  @Post('workflow-versions/:versionId/stages')
  @ApiOperation({
    operationId: 'WF-10',
    summary: 'Criar etapa',
    tags: TAGS,
    auditActions: [...AUDIT_UPDATE],
    responses: {
      201: {
        description: 'Etapa criada no rascunho.',
        schema: dataEnvelope(workflowStageDtoSchema),
      },
    },
  })
  async postStage(
    @ZodParams(workflowVersionIdParamsSchema) params: { versionId: string },
    @ZodBody(workflowStageSchema) body: WorkflowStageCreate,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WorkflowStageDto> {
    const stage = await this.createStage.execute({ versionId: params.versionId, body });
    response.setHeader('Location', `/api/v1/workflow-stages/${stage.id}`);
    response.setHeader('ETag', `"${stage.version ?? 1}"`);
    return stage;
  }

  @Patch('workflow-stages/:stageId')
  @HttpCode(200)
  @RequireIfMatch()
  @ApiOperation({
    operationId: 'WF-11',
    summary: 'Atualizar etapa',
    tags: TAGS,
    auditActions: [...AUDIT_UPDATE],
    responses: {
      200: {
        description: 'Etapa atualizada (novo `ETag`).',
        schema: dataEnvelope(workflowStageDtoSchema),
      },
    },
  })
  async patchStage(
    @ZodParams(workflowStageIdParamsSchema) params: { stageId: string },
    @ZodBody(workflowStageUpdateSchema) body: WorkflowStageUpdate,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WorkflowStageDto> {
    const stage = await this.updateStage.execute({
      stageId: params.stageId,
      patch: body,
      expectedVersion: ifMatchVersion(ifMatch),
    });
    response.setHeader('ETag', `"${stage.version ?? 1}"`);
    return stage;
  }

  @Delete('workflow-stages/:stageId')
  @HttpCode(204)
  @RequireIfMatch()
  @ApiOperation({
    operationId: 'WF-12',
    summary: 'Excluir etapa',
    tags: TAGS,
    auditActions: [...AUDIT_UPDATE],
    responses: { 204: { description: 'Etapa excluída com as suas transições e regras.' } },
  })
  async removeStage(
    @ZodParams(workflowStageIdParamsSchema) params: { stageId: string },
    @IfMatch() ifMatch: IfMatchValue | null,
  ): Promise<void> {
    await this.deleteStage.execute({
      stageId: params.stageId,
      expectedVersion: ifMatchVersion(ifMatch),
    });
  }

  @Post('workflow-versions/:versionId/transitions')
  @ApiOperation({
    operationId: 'WF-13',
    summary: 'Criar transição',
    tags: TAGS,
    auditActions: [...AUDIT_UPDATE],
    responses: {
      201: {
        description: 'Transição criada no rascunho.',
        schema: dataEnvelope(workflowTransitionDtoSchema),
      },
    },
  })
  async postTransition(
    @ZodParams(workflowVersionIdParamsSchema) params: { versionId: string },
    @ZodBody(workflowTransitionSchema) body: WorkflowTransitionCreate,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WorkflowTransitionDto> {
    const transition = await this.createTransition.execute({ versionId: params.versionId, body });
    response.setHeader('Location', `/api/v1/workflow-transitions/${transition.id}`);
    response.setHeader('ETag', `"${transition.version ?? 1}"`);
    return transition;
  }

  @Patch('workflow-transitions/:transitionId')
  @HttpCode(200)
  @RequireIfMatch()
  @ApiOperation({
    operationId: 'WF-14',
    summary: 'Atualizar transição',
    tags: TAGS,
    auditActions: [...AUDIT_UPDATE],
    responses: {
      200: {
        description: 'Transição atualizada (novo `ETag`).',
        schema: dataEnvelope(workflowTransitionDtoSchema),
      },
    },
  })
  async patchTransition(
    @ZodParams(workflowTransitionIdParamsSchema) params: { transitionId: string },
    @ZodBody(workflowTransitionUpdateSchema) body: WorkflowTransitionUpdate,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WorkflowTransitionDto> {
    const transition = await this.updateTransition.execute({
      transitionId: params.transitionId,
      patch: body,
      expectedVersion: ifMatchVersion(ifMatch),
    });
    response.setHeader('ETag', `"${transition.version ?? 1}"`);
    return transition;
  }

  @Delete('workflow-transitions/:transitionId')
  @HttpCode(204)
  @RequireIfMatch()
  @ApiOperation({
    operationId: 'WF-15',
    summary: 'Excluir transição',
    tags: TAGS,
    auditActions: [...AUDIT_UPDATE],
    responses: { 204: { description: 'Transição excluída com as suas regras.' } },
  })
  async removeTransition(
    @ZodParams(workflowTransitionIdParamsSchema) params: { transitionId: string },
    @IfMatch() ifMatch: IfMatchValue | null,
  ): Promise<void> {
    await this.deleteTransition.execute({
      transitionId: params.transitionId,
      expectedVersion: ifMatchVersion(ifMatch),
    });
  }

  @Post('workflow-versions/:versionId/rules')
  @ApiOperation({
    operationId: 'WF-16',
    summary: 'Criar regra',
    tags: TAGS,
    auditActions: [...AUDIT_UPDATE],
    responses: {
      201: {
        description: 'Regra criada no rascunho.',
        schema: dataEnvelope(workflowRuleDtoSchema),
      },
    },
  })
  async postRule(
    @ZodParams(workflowVersionIdParamsSchema) params: { versionId: string },
    @ZodBody(workflowRuleSchema) body: WorkflowRuleCreate,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WorkflowRuleDto> {
    const rule = await this.createRule.execute({ versionId: params.versionId, body });
    response.setHeader('Location', `/api/v1/workflow-rules/${rule.id}`);
    response.setHeader('ETag', `"${rule.version ?? 1}"`);
    return rule;
  }

  @Patch('workflow-rules/:ruleId')
  @HttpCode(200)
  @RequireIfMatch()
  @ApiOperation({
    operationId: 'WF-17',
    summary: 'Atualizar regra',
    tags: TAGS,
    auditActions: [...AUDIT_UPDATE],
    responses: {
      200: {
        description: 'Regra atualizada (novo `ETag`).',
        schema: dataEnvelope(workflowRuleDtoSchema),
      },
    },
  })
  async patchRule(
    @ZodParams(workflowRuleIdParamsSchema) params: { ruleId: string },
    @ZodBody(workflowRuleUpdateSchema) body: WorkflowRuleUpdate,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WorkflowRuleDto> {
    const rule = await this.updateRule.execute({
      ruleId: params.ruleId,
      patch: body,
      expectedVersion: ifMatchVersion(ifMatch),
    });
    response.setHeader('ETag', `"${rule.version ?? 1}"`);
    return rule;
  }

  @Delete('workflow-rules/:ruleId')
  @HttpCode(204)
  @RequireIfMatch()
  @ApiOperation({
    operationId: 'WF-18',
    summary: 'Excluir regra',
    tags: TAGS,
    auditActions: [...AUDIT_UPDATE],
    responses: { 204: { description: 'Regra excluída.' } },
  })
  async removeRule(
    @ZodParams(workflowRuleIdParamsSchema) params: { ruleId: string },
    @IfMatch() ifMatch: IfMatchValue | null,
  ): Promise<void> {
    await this.deleteRule.execute({
      ruleId: params.ruleId,
      expectedVersion: ifMatchVersion(ifMatch),
    });
  }
}
