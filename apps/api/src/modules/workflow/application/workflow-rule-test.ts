import {
  inspectJsonLogic,
  isRuleContextPath,
  RULE_CONTEXT_VERSION,
  ruleContextFields,
  WORKFLOW_RULE_CONFIG_SCHEMAS,
} from '@contrataflow/validation';
import type {
  FieldError,
  RuleContextSchemaDto,
  WorkflowRuleTest,
  WorkflowRuleTestResult,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentTypeCatalog } from '#shared/document/document-type-catalog.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { WORKFLOW_REPOSITORY, WORKFLOW_TRANSACTIONS } from './ports.js';
import type { WorkflowRepository, WorkflowTransactions } from './ports.js';
import { WorkflowEngineService } from './workflow-engine.service.js';
import type { ProcessExecutionState } from './workflow-engine.service.js';
import { workflowVersionNotFound } from './workflow.errors.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { ruleTestWarningOf } from '../domain/rule-test.js';

/*
 * US-044 — apoio ao editor de regras: o schema do RuleContext v1 (WF-19) e "Testar regra" (WF-23 ·
 * RN-WF-59). O processo usado no teste é do módulo `process` (nível 3, que depende de `workflow`):
 * a dependência no sentido contrário vira a porta `RuleTestProcessSource`, que o `process` registra
 * no `onModuleInit` (o mesmo arranjo dos contribuidores do RuleContext). Sem fonte registrada,
 * falha fechado — nenhum processo existe (404). Tudo somente leitura: nada é persistido nem auditado.
 */

/** O processo de referência do teste, já autorizado pela visibilidade (DEC-024). */
export interface RuleTestProcess {
  readonly state: ProcessExecutionState;
  /** O usuário pode ver o orçamento estimado (não sigiloso ou com a permissão — POL-09). */
  readonly budgetVisible: boolean;
}

export interface RuleTestProcessSource {
  /** `null` = inexistente, de outro tenant ou não visível ao usuário (indistinguíveis). */
  load(tx: TenantTx, processId: string): Promise<RuleTestProcess | null>;
}

export class RuleTestProcessSourceRegistrationError extends Error {
  constructor() {
    super('Fonte de processos do teste de regra já registrada.');
    this.name = 'RuleTestProcessSourceRegistrationError';
  }
}

@Injectable()
export class RuleTestProcessSourceRegistry {
  private source: RuleTestProcessSource | null = null;

  register(source: RuleTestProcessSource): void {
    if (this.source !== null) throw new RuleTestProcessSourceRegistrationError();
    this.source = source;
  }

  load(tx: TenantTx, processId: string): Promise<RuleTestProcess | null> {
    return this.source === null ? Promise.resolve(null) : this.source.load(tx, processId);
  }
}

/** V-08: processo inexistente, de outro tenant ou não visível respondem igual. */
function ruleTestProcessNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Selecione um processo válido.' });
}

/** V-09: 422 `WORKFLOW_INVALID` com `WF_RULE_OPERATOR_FORBIDDEN` em `validation.errors[]`. */
function ruleOperatorForbidden(): ApiError {
  const message = 'Esta condição usa um operador não permitido.';
  return new ApiError('WORKFLOW_INVALID', {
    detail: message,
    extensions: {
      validation: {
        errors: [
          {
            code: 'WF_RULE_OPERATOR_FORBIDDEN',
            message,
            stageKey: null,
            transitionKey: null,
            ruleId: null,
          },
        ],
        warnings: [],
      },
    },
  });
}

/**
 * Forma da `config` pelo schema do tipo (o mesmo do WF-16/17) e a whitelist de operações JSON
 * Logic (RN-WF-58 — nunca confia no front). Caminho fora do RuleContext NÃO barra o teste: a regra
 * sai "não satisfeita" com o aviso "Campo não reconhecido" (FA-04).
 */
function assertTestableConfig(body: WorkflowRuleTest): void {
  const parsed = WORKFLOW_RULE_CONFIG_SCHEMAS[body.type].safeParse(body.config);
  if (!parsed.success) {
    throw validationError(
      parsed.error.issues.map((issue): FieldError => ({
        field: ['config', ...issue.path.map(String)].join('.'),
        code: 'INVALID_FORMAT',
        message: 'Revise a configuração da regra.',
      })),
    );
  }
  if (body.type !== 'CONDITION') return;
  const { issues } = inspectJsonLogic(body.config.expression, {
    isPathAllowed: isRuleContextPath,
  });
  if (issues.some((issue) => issue.kind === 'OPERATOR_FORBIDDEN')) throw ruleOperatorForbidden();
  if (issues.some((issue) => issue.kind === 'INVALID')) {
    throw validationError([
      {
        field: 'config.expression',
        code: 'INVALID_FORMAT',
        message: 'A condição está malformada ou é grande demais.',
      },
    ]);
  }
}

/** `TestWorkflowRuleQuery` — WF-23: dry-run da regra contra um processo real, sem persistir nada. */
@Injectable()
export class TestWorkflowRuleQuery {
  private readonly logger = new Logger('WorkflowRuleTest');

  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(WORKFLOW_TRANSACTIONS) private readonly transactions: WorkflowTransactions,
    private readonly processes: RuleTestProcessSourceRegistry,
    private readonly engine: WorkflowEngineService,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(input: {
    versionId: string;
    body: WorkflowRuleTest;
  }): Promise<WorkflowRuleTestResult> {
    const { versionId, body } = input;
    this.access.assertCan('WORKFLOW_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    assertTestableConfig(body);
    const startedAt = performance.now();
    const outcome = await this.transactions.read(async (tx) => {
      if ((await this.workflows.findVersion(tx, versionId)) === null) {
        throw workflowVersionNotFound();
      }
      const process = await this.processes.load(tx, body.processId);
      if (process === null) throw ruleTestProcessNotFound();
      return this.engine.testRule(
        tx,
        process.state,
        { type: body.type, config: body.config },
        process.budgetVisible,
      );
    });
    const correlationId = currentRequestContext()?.correlationId;
    if (outcome.problem?.kind === 'PATH_UNKNOWN') {
      this.logger.warn(
        {
          event: 'workflow.rule_path_unknown',
          workflowVersionId: versionId,
          ruleType: body.type,
          processId: body.processId,
          detail: outcome.problem.detail,
          correlationId,
        },
        'workflow.rule_path_unknown',
      );
    }
    this.logger.log(
      {
        event: 'workflow.rule_tested',
        workflowVersionId: versionId,
        ruleType: body.type,
        processId: body.processId,
        satisfied: outcome.satisfied,
        durationMs: Math.round(performance.now() - startedAt),
        correlationId,
      },
      'workflow.rule_tested',
    );
    return {
      satisfied: outcome.satisfied,
      severity: body.severity,
      message: outcome.satisfied
        ? 'Regra satisfeita.'
        : body.message !== undefined && body.message !== ''
          ? body.message
          : 'Regra não satisfeita.',
      contextUsed: outcome.contextUsed,
      warnings: outcome.problem === undefined ? [] : [ruleTestWarningOf(outcome.problem)],
    };
  }
}

/**
 * `GetRuleContextSchemaQuery` — WF-19: campos do RuleContext v1 para o construtor de regras, com
 * `documents.<CÓDIGO>.*` dos tipos de documento ATIVOS do tenant.
 */
@Injectable()
export class GetRuleContextSchemaQuery {
  constructor(
    @Inject(WORKFLOW_TRANSACTIONS) private readonly transactions: WorkflowTransactions,
    private readonly documentTypes: DocumentTypeCatalog,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(): Promise<RuleContextSchemaDto> {
    this.access.assertCan('WORKFLOW_VIEW', { mfaPolicy: await this.identity.mfaPolicy() });
    const codes = await this.transactions.read((tx) => this.documentTypes.codesOf(tx));
    return { version: RULE_CONTEXT_VERSION, fields: ruleContextFields([...codes.active]) };
  }
}
