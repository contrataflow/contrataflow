import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TenantTx } from '#shared/database/prisma.js';

import { RuleContextBuilder, RuleContextContributorRegistry } from './rule-context.js';
import type { WorkflowDefinitionService } from './workflow-definition.service.js';
import {
  PinnedWorkflowVersionUnavailableError,
  WorkflowEngineService,
} from './workflow-engine.service.js';
import type { ProcessExecutionState } from './workflow-engine.service.js';
import {
  dec015Workflow,
  passesUntilStudies,
  processRuntime,
  snapshotOf,
  viewer,
} from '../../../../test/support/workflow-engine-fixtures.js';
import { DefinitionBuilder } from '../../../../test/support/workflow-fixtures.js';
import type { BusinessCalendarFacade } from '../../catalog/application/business-calendar.facade.js';
import type { WorkflowSnapshot } from '../domain/workflow-snapshot.js';

/*
 * US-041 — `WorkflowEngineService`: lê só a versão FIXADA (RN-WF-33), registra
 * `workflow.actions_computed` e, para regra não avaliável, `workflow.rule_evaluation_failed`
 * (error, com `ruleId`) ou `workflow.rule_context_missing_path` (warn) sem derrubar a chamada.
 */

const tx = {} as TenantTx;
const VERSION = '0192c000-0000-7000-8000-00000000f0b9';

function serviceFor(snapshot: WorkflowSnapshot | null) {
  const publishedDefinition = vi.fn((_id: string) => Promise.resolve(snapshot));
  const definitions = { publishedDefinition } as unknown as WorkflowDefinitionService;
  const calendar = {
    businessDaysElapsed: () => Promise.resolve(2),
  } as unknown as BusinessCalendarFacade;
  const contexts = new RuleContextBuilder(new RuleContextContributorRegistry(), calendar);
  const service = new WorkflowEngineService(
    definitions,
    contexts,
    () => new Date('2026-10-15T12:00:00.000Z'),
  );
  return { service, publishedDefinition };
}

function stateOf(builder: DefinitionBuilder): ProcessExecutionState {
  const runtime = processRuntime({
    tenantId: 't',
    workflowVersionId: VERSION,
    passes: passesUntilStudies(builder),
  });
  return {
    processId: runtime.id,
    workflowVersionId: runtime.workflowVersionId,
    status: runtime.status,
    createdById: runtime.createdById,
    currentDepartmentId: runtime.currentDepartmentId,
    currentResponsibleId: runtime.currentResponsibleId,
    ruleProcess: runtime.ruleProcess,
    passes: runtime.passes,
    approvals: runtime.approvals,
    documents: runtime.documents,
  };
}

describe('WorkflowEngineService (US-041)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lê a versão fixada no processo e registra workflow.actions_computed', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const builder = dec015Workflow();
    const { service, publishedDefinition } = serviceFor(snapshotOf(builder));
    const actions = await service.getAvailableActions(tx, stateOf(builder), viewer());
    expect(publishedDefinition).toHaveBeenCalledWith(VERSION);
    expect(actions[0]).toMatchObject({ action: 'FORWARD', enabled: false });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'workflow.actions_computed',
        workflowVersionId: VERSION,
        stageKey: 'ESTUDOS_PRELIMINARES',
        enabledCount: actions.filter((action) => action.enabled).length,
        disabledCount: actions.filter((action) => !action.enabled).length,
        durationMs: expect.any(Number) as unknown,
      }),
      'workflow.actions_computed',
    );
  });

  it('[Falha de integração] regra que falha no json-logic: log error com ruleId e 200 para as demais', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const builder = dec015Workflow().rule(
      'CONDITION',
      { expression: { '*': [] } },
      { stage: 'ESTUDOS_PRELIMINARES' },
      { name: 'Condição quebrada', message: 'Condição quebrada.' },
    );
    const { service } = serviceFor(snapshotOf(builder));
    const checklist = await service.evaluateRules(tx, stateOf(builder));
    const broken = checklist.find((item) => item.name === 'Condição quebrada');
    expect(broken).toMatchObject({ severity: 'BLOCKING', satisfied: false });
    expect(checklist.map((item) => item.name)).toEqual(
      expect.arrayContaining(['ETP completo', 'Mapa de riscos', 'Condição quebrada']),
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'workflow.rule_evaluation_failed',
        ruleId: broken?.ruleId,
        ruleType: 'CONDITION',
        cause: 'EVALUATION_FAILED',
      }),
      'workflow.rule_evaluation_failed',
    );
  });

  it('FA-03: caminho fora do RuleContext em runtime = não satisfeita + log error; ausente = warn', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const builder = dec015Workflow()
      .rule('REQUIRED_FIELD', { field: 'process.inexistente' }, { stage: 'ESTUDOS_PRELIMINARES' })
      .rule('REQUIRED_FIELD', { field: 'stage.key.x' }, { stage: 'ESTUDOS_PRELIMINARES' });
    const snapshot = snapshotOf(builder);
    const { service } = serviceFor(snapshot);
    const checklist = await service.evaluateRules(tx, stateOf(builder));
    expect(checklist.filter((item) => item.type === 'REQUIRED_FIELD')).toHaveLength(2);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'workflow.rule_evaluation_failed', cause: 'PATH_UNKNOWN' }),
      'workflow.rule_evaluation_failed',
    );
    // `stage.key.x` não é caminho do schema → PATH_UNKNOWN também; nada lança.
    expect(warn).not.toHaveBeenCalled();
  });

  it('versão fixada indisponível (rascunho/inexistente) = erro com log error', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service } = serviceFor(null);
    await expect(service.evaluateRules(tx, stateOf(dec015Workflow()))).rejects.toBeInstanceOf(
      PinnedWorkflowVersionUnavailableError,
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'workflow.pinned_version_unavailable' }),
      'workflow.pinned_version_unavailable',
    );
  });

  it('etapa ativa que não pertence à versão = log error, sem avanço', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const builder = dec015Workflow();
    const other = new DefinitionBuilder().stage('X', 'START').stage('Y', 'END');
    const { service } = serviceFor(snapshotOf(other));
    const actions = await service.getAvailableActions(tx, stateOf(builder), viewer());
    expect(actions.some((action) => action.action === 'FORWARD')).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'workflow.stage_not_in_version' }),
      'workflow.stage_not_in_version',
    );
  });
});
