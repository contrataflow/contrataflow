import {
  dataEnvelope,
  pageEnvelope,
  pageQuerySchema,
  workflowCreateSchema,
  workflowIdParamsSchema,
  workflowListQuerySchema,
  workflowResolutionSchema,
  workflowResolveSchema,
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
  WorkflowListQuery,
  WorkflowResolutionDto,
  WorkflowResolve,
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

import { ImplicitAccess, RequirePermission } from '#shared/auth/authorization.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { ResolveWorkflowQuery } from '../application/workflow-applicability.service.js';
import { SetDefaultWorkflowCommand } from '../application/workflow-default.command.js';
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
  ListWorkflowsQuery,
  ListWorkflowVersionsQuery,
} from '../application/workflow.queries.js';

const TAGS = ['Workflows'];
const AUDIT_UPDATE = ['workflow.update'] as const;

const ifMatchVersion = (ifMatch: IfMatchValue | null) => ifMatch?.value ?? 0;

/**
 * Definição de workflow versionada (api/10-workflow.md WF-01..18 · US-040/US-042): lista,
 * metadados do workflow, padrão e aplicabilidade, versões e manutenção do rascunho (etapas,
 * transições, regras). Leitura exige `WORKFLOW_VIEW`; escrita, `WORKFLOW_MANAGE` + MFA (POL-14);
 * tornar padrão, `WORKFLOW_PUBLISH` + MFA. Alterar, excluir e tornar padrão exigem `If-Match`.
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
    private readonly listWorkflows: ListWorkflowsQuery,
    private readonly setDefault: SetDefaultWorkflowCommand,
    private readonly resolveWorkflow: ResolveWorkflowQuery,
  ) {}

  @Get('workflows')
  @RequirePermission('WORKFLOW_VIEW')
  @ApiOperation({
    operationId: 'WF-01',
    summary: 'Listar workflows',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Workflows do tenant na ordem da aplicabilidade (prioridade, depois criação), com o padrão, a publicada corrente e o rascunho; filtros `q` e `status` (`ACTIVE`/`INACTIVE`).',
        schema: pageEnvelope(workflowSchema),
      },
    },
  })
  getWorkflows(@ZodQuery(workflowListQuerySchema) query: WorkflowListQuery) {
    return this.listWorkflows.execute(query);
  }

  @Post('workflows/resolve')
  @HttpCode(200)
  @ImplicitAccess(
    'WF-06 aceita WORKFLOW_VIEW ou PROCESS_CREATE (wizard da US-001); o ResolveWorkflowQuery confere uma das duas.',
  )
  @ApiOperation({
    operationId: 'WF-06',
    summary: 'Resolver workflow aplicável',
    tags: TAGS,
    auditExempt:
      'Resolução somente de leitura: o POST apenas carrega os dados do processo, sem efeito colateral.',
    responses: {
      200: {
        description:
          'Workflow aplicável (regra de aplicabilidade por prioridade; sem correspondência, o padrão), a versão publicada e a etapa inicial; nenhum → 422 `NO_APPLICABLE_WORKFLOW`.',
        schema: dataEnvelope(workflowResolutionSchema),
      },
    },
  })
  postResolve(
    @ZodBody(workflowResolveSchema) body: WorkflowResolve,
  ): Promise<WorkflowResolutionDto> {
    return this.resolveWorkflow.execute(body);
  }

  @Post('workflows/:id/set-default')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('WORKFLOW_PUBLISH')
  @ApiOperation({
    operationId: 'WF-05',
    summary: 'Definir workflow padrão',
    tags: TAGS,
    auditActions: ['workflow.set_default'],
    responses: {
      200: {
        description:
          'Workflow com `isDefault: true` (novo `ETag`); inativo ou sem versão publicada → 422 `BUSINESS_RULE_VIOLATION`.',
        schema: dataEnvelope(workflowSchema),
      },
    },
  })
  async postSetDefault(
    @ZodParams(workflowIdParamsSchema) params: { id: string },
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WorkflowDto> {
    const workflow = await this.setDefault.execute({
      id: params.id,
      expectedVersion: ifMatchVersion(ifMatch),
    });
    response.setHeader('ETag', `"${workflow.version}"`);
    return workflow;
  }

  @Post('workflows')
  @Idempotent()
  @RequirePermission('WORKFLOW_MANAGE')
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
  @RequirePermission('WORKFLOW_VIEW')
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
  @RequirePermission('WORKFLOW_MANAGE')
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
  @RequirePermission('WORKFLOW_VIEW')
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
  @RequirePermission('WORKFLOW_MANAGE')
  @ApiOperation({
    operationId: 'WF-08',
    summary: 'Criar nova versão do workflow',
    tags: TAGS,
    auditActions: ['workflow.version_create'],
    responses: {
      201: {
        description:
          'Rascunho nº máx + 1 clonado da versão de origem (padrão: a publicada corrente; sem ela → 422 `BUSINESS_RULE_VIOLATION`), com ids novos.',
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
  @RequirePermission('WORKFLOW_VIEW')
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
  @RequirePermission('WORKFLOW_MANAGE')
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
  @RequirePermission('WORKFLOW_MANAGE')
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
  @RequirePermission('WORKFLOW_MANAGE')
  @ApiOperation({
    operationId: 'WF-12',
    summary: 'Excluir etapa',
    tags: TAGS,
    auditActions: [...AUDIT_UPDATE],
    responses: {
      204: {
        description:
          'Etapa excluída; com transições ou regras que a referenciam → 422 `BUSINESS_RULE_VIOLATION` (uma violação por item — RN-WF-50).',
      },
    },
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
  @RequirePermission('WORKFLOW_MANAGE')
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
  @RequirePermission('WORKFLOW_MANAGE')
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
  @RequirePermission('WORKFLOW_MANAGE')
  @ApiOperation({
    operationId: 'WF-15',
    summary: 'Excluir transição',
    tags: TAGS,
    auditActions: [...AUDIT_UPDATE],
    responses: {
      204: {
        description:
          'Transição excluída; com regras que a referenciam → 422 `BUSINESS_RULE_VIOLATION` (RN-WF-50).',
      },
    },
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
  @RequirePermission('WORKFLOW_MANAGE')
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
  @RequirePermission('WORKFLOW_MANAGE')
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
  @RequirePermission('WORKFLOW_MANAGE')
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
