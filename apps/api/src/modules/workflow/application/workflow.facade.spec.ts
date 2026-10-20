import { describe, expect, it, vi } from 'vitest';

import { RuleContextContributorRegistry } from './rule-context.js';
import type { WorkflowApplicabilityService } from './workflow-applicability.service.js';
import type { WorkflowDefinitionService } from './workflow-definition.service.js';
import type { WorkflowEngineService } from './workflow-engine.service.js';
import {
  RuleTestProcessSourceRegistrationError,
  RuleTestProcessSourceRegistry,
} from './workflow-rule-test.js';
import type { WorkflowVersionPublisher } from './workflow-version.publisher.js';
import { WorkflowFacade } from './workflow.facade.js';

/* US-041 — a fachada expõe a resolução de destino (RN-WF-30/31) e o registro de contribuidores. */

describe('WorkflowFacade (US-041)', () => {
  const registry = new RuleContextContributorRegistry();
  const resolveIn = vi.fn(() => Promise.resolve({ workflowId: 'w' }));
  const ruleTestProcesses = new RuleTestProcessSourceRegistry();
  const facade = new WorkflowFacade(
    {} as WorkflowDefinitionService,
    {} as WorkflowVersionPublisher,
    {} as WorkflowEngineService,
    registry,
    { resolveIn } as unknown as WorkflowApplicabilityService,
    ruleTestProcesses,
  );
  const stage = {
    id: 'etapa',
    departmentResolution: 'CHOSEN_ON_FORWARD' as const,
    fixedDepartmentId: null,
    assignmentPolicy: 'CREATOR' as const,
  };
  const units = { requestingDepartmentId: 'setor', requestingSecretariatId: 'secretaria' };

  it('resolveStageDepartment (sem e com a unidade escolhida no comando)', () => {
    expect(facade.resolveStageDepartment(stage, units)).toEqual({
      mode: 'CHOSEN_ON_FORWARD',
      departmentId: null,
    });
    expect(facade.resolveStageDepartment(stage, units, 'juridico').departmentId).toBe('juridico');
  });

  it('resolveStageAssignee', () => {
    expect(
      facade.resolveStageAssignee(stage, {
        creatorId: 'criador',
        departmentHeadId: null,
        passes: [],
      }),
    ).toBe('criador');
  });

  it('registerRuleContextContributor registra no registro único', () => {
    const contributor = { name: 'risk', contribute: vi.fn() };
    facade.registerRuleContextContributor(contributor);
    expect(registry.all()).toEqual([contributor]);
  });

  it('registerRuleTestProcessSource: sem fonte = nenhum processo; fonte única (US-044)', async () => {
    const tx = {} as Parameters<WorkflowFacade['resolveApplicable']>[0];
    await expect(ruleTestProcesses.load(tx, 'p')).resolves.toBeNull();
    const load = vi.fn(() => Promise.resolve(null));
    facade.registerRuleTestProcessSource({ load });
    await ruleTestProcesses.load(tx, 'p');
    expect(load).toHaveBeenCalledWith(tx, 'p');
    expect(() => {
      facade.registerRuleTestProcessSource({ load });
    }).toThrow(RuleTestProcessSourceRegistrationError);
  });

  it('resolveApplicable delega ao serviço de aplicabilidade no tx do chamador (US-042)', async () => {
    const tx = {} as Parameters<WorkflowFacade['resolveApplicable']>[0];
    await expect(facade.resolveApplicable(tx, { modalityCode: 'DISPENSA' })).resolves.toEqual({
      workflowId: 'w',
    });
    expect(resolveIn).toHaveBeenCalledWith(tx, { modalityCode: 'DISPENSA' });
  });
});
