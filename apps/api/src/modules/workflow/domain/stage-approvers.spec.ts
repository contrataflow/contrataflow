import type { ApprovalDecisionPolicy, ApproverLineFields } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  approversAuditValue,
  buildStageApprovers,
  decisionConfigurationProblems,
  mirrorFirstLine,
  sameDecisionConfiguration,
} from './stage-approvers.js';
import type { WorkflowStageApprover } from './stage-approvers.js';
import { cloneDefinition } from './workflow-clone.js';
import type { WorkflowDefinition } from './workflow-definition.js';
import { WorkflowDefinitionValidator } from './workflow-definition.validator.js';
import { buildWorkflowSnapshot, workflowSnapshotHash } from './workflow-snapshot.js';
import {
  DefinitionBuilder,
  fixtureId,
  FIXTURE_TENANT,
  FIXTURE_VERSION,
  openReferences,
  validFourStageWorkflow,
} from '../../../../test/support/workflow-fixtures.js';

/*
 * US-132 — `StageApproversPolicy` (RN-APV-01..10): substituição da lista com `sequence` 1..n,
 * alçada preservada, espelho da linha 1, no-op, problemas da validação (mínimo, unicidade, fora
 * de `APPROVAL`), snapshot/hash das versões do MVP 1 inalterados e cópia com ids novos.
 */

const NOW = new Date('2026-11-11T12:00:00.000Z');
const SECRETARIA = '0192c132-0000-7000-8000-0000000000d1';
const MARCOS = '0192c132-0000-7000-8000-0000000000a1';
const ROBERTO = '0192c132-0000-7000-8000-0000000000a2';
const PERFIL = '0192c132-0000-7000-8000-0000000000e1';

const line = (overrides: Partial<ApproverLineFields>): ApproverLineFields => ({
  approverType: 'USER',
  approverUserId: MARCOS,
  approverRoleId: null,
  approverDepartmentResolution: null,
  approverFixedDepartmentId: null,
  allowDeputy: true,
  label: null,
  ...overrides,
});
const head = line({
  approverType: 'DEPARTMENT_HEAD',
  approverUserId: null,
  approverDepartmentResolution: 'FIXED',
  approverFixedDepartmentId: SECRETARIA,
  label: 'Secretário de Administração',
});
const marcos = line({ label: 'Procurador-Geral' });

const target = (stageId: string) => ({
  tenantId: FIXTURE_TENANT,
  workflowVersionId: FIXTURE_VERSION,
  workflowStageId: stageId,
  now: NOW,
  userId: null,
  newId: fixtureId,
});

function withApprovers(
  definition: WorkflowDefinition,
  key: string,
  policy: ApprovalDecisionPolicy,
  lines: readonly ApproverLineFields[],
  previous: readonly WorkflowStageApprover[] = [],
): WorkflowDefinition {
  return {
    ...definition,
    stages: definition.stages.map((stage) =>
      stage.key === key
        ? {
            ...stage,
            ...mirrorFirstLine(stage, lines),
            decisionPolicy: policy,
            approvers: buildStageApprovers(lines, previous, target(stage.id)),
          }
        : stage,
    ),
  };
}

describe('StageApproversPolicy (US-132)', () => {
  it('RN-APV-03: sequence 1..n pela ordem do array, ids novos e autoria da escrita', () => {
    const lines = buildStageApprovers([head, marcos], [], target('stage-1'));
    expect(lines.map((item) => [item.sequence, item.approverType])).toEqual([
      [1, 'DEPARTMENT_HEAD'],
      [2, 'USER'],
    ]);
    expect(new Set(lines.map((item) => item.id)).size).toBe(2);
    expect(lines[0]).toMatchObject({
      workflowStageId: 'stage-1',
      workflowVersionId: FIXTURE_VERSION,
      applicabilityRule: null,
      version: 1,
      createdAt: NOW,
    });
  });

  it('RN-APV-07: a alçada da linha com o mesmo aprovador é preservada na substituição', () => {
    const rule = { kind: 'LIBRARY', ruleDefinitionVersionId: 'r-1' };
    const previous = buildStageApprovers([head, marcos], [], target('stage-1')).map(
      (item, index) => (index === 0 ? { ...item, applicabilityRule: rule } : item),
    );
    const replaced = buildStageApprovers([marcos, head], previous, target('stage-1'));
    expect(replaced.map((item) => [item.sequence, item.applicabilityRule])).toEqual([
      [1, null],
      [2, rule],
    ]);
  });

  it('RN-APV-08: com lista, o aprovador único espelha a linha 1; sem lista, fica como está', () => {
    const single = {
      approverType: 'DEPARTMENT_HEAD' as const,
      approverUserId: null,
      approverRoleId: null,
      approverDepartmentResolution: 'REQUESTING_SECRETARIAT' as const,
      approverFixedDepartmentId: null,
      allowDeputy: true,
    };
    expect(mirrorFirstLine(single, [marcos, head])).toEqual({
      approverType: 'USER',
      approverUserId: MARCOS,
      approverRoleId: null,
      approverDepartmentResolution: null,
      approverFixedDepartmentId: null,
      allowDeputy: true,
    });
    expect(mirrorFirstLine(single, [])).toEqual(single);
  });

  it('RN-APV-09: o mesmo conteúdo é no-op; ordem, política ou rótulo diferentes não', () => {
    const stage = {
      decisionPolicy: 'SEQUENTIAL' as const,
      approvers: buildStageApprovers([head, marcos], [], target('stage-1')),
    };
    expect(sameDecisionConfiguration(stage, 'SEQUENTIAL', [head, marcos])).toBe(true);
    expect(sameDecisionConfiguration(stage, 'ALL', [head, marcos])).toBe(false);
    expect(sameDecisionConfiguration(stage, 'SEQUENTIAL', [marcos, head])).toBe(false);
    expect(
      sameDecisionConfiguration(stage, 'SEQUENTIAL', [head, { ...marcos, label: 'Procurador' }]),
    ).toBe(false);
    // Etapa do MVP 1 (sem campos) = ANY sem linhas.
    expect(sameDecisionConfiguration({}, 'ANY', [])).toBe(true);
  });

  it('auditoria: approvers por sequence, tipo e referência (só ids)', () => {
    expect(
      approversAuditValue([
        head,
        marcos,
        line({ approverType: 'ROLE', approverUserId: null, approverRoleId: PERFIL }),
      ]),
    ).toEqual([
      { sequence: 1, approverType: 'DEPARTMENT_HEAD', reference: `FIXED:${SECRETARIA}` },
      { sequence: 2, approverType: 'USER', reference: MARCOS },
      { sequence: 3, approverType: 'ROLE', reference: PERFIL },
    ]);
  });

  it('RN-APV-01/03/05: problemas da validação por política', () => {
    const approval = (policy: ApprovalDecisionPolicy, lines: ApproverLineFields[]) => ({
      type: 'APPROVAL' as const,
      decisionPolicy: policy,
      approvers: buildStageApprovers(lines, [], target('s')),
    });
    expect(decisionConfigurationProblems(approval('ALL', [marcos]))).toEqual([
      { reason: 'MIN_LINES' },
    ]);
    expect(decisionConfigurationProblems(approval('SEQUENTIAL', []))).toEqual([
      { reason: 'MIN_LINES' },
    ]);
    // FA-02: ANY com lista de um é válido.
    expect(decisionConfigurationProblems(approval('ANY', [marcos]))).toEqual([]);
    expect(decisionConfigurationProblems(approval('ALL', [marcos, head, marcos]))).toEqual([
      { reason: 'DUPLICATE_APPROVER', sequence: 3 },
    ]);
    // Mesmo titular por resolução (sem unidade fixa) também é repetição.
    const requesting = line({
      approverType: 'DEPARTMENT_HEAD',
      approverUserId: null,
      approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
    });
    expect(decisionConfigurationProblems(approval('ALL', [requesting, requesting]))).toEqual([
      { reason: 'DUPLICATE_APPROVER', sequence: 2 },
    ]);
    expect(
      decisionConfigurationProblems({ type: 'TASK', decisionPolicy: 'ALL', approvers: [] }),
    ).toEqual([{ reason: 'POLICY_NOT_ALLOWED' }]);
    expect(decisionConfigurationProblems({ type: 'TASK' })).toEqual([]);
  });
});

describe('Validação, snapshot e cópia com a política (US-132)', () => {
  const validator = new WorkflowDefinitionValidator();
  const references = openReferences({
    activeUserIds: new Set([MARCOS, ROBERTO]),
    departments: new Map([[SECRETARIA, { isActive: true, headUserId: ROBERTO }]]),
  });

  it('WF-20: SEQUENTIAL com duas linhas resolvíveis é válido; ALL com uma linha → WF_APPROVERS_INVALID MIN_LINES', () => {
    const base = validFourStageWorkflow().build();
    expect(
      validator.validate(withApprovers(base, 'APROVACAO', 'SEQUENTIAL', [head, marcos]), references)
        .errors,
    ).toEqual([]);
    const result = validator.validate(
      withApprovers(base, 'APROVACAO', 'ALL', [marcos]),
      references,
    );
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'WF_APPROVERS_INVALID',
        stageKey: 'APROVACAO',
        params: { reason: 'MIN_LINES' },
      }),
    ]);
  });

  it('RN-APV-06: linha não resolvível → WF_APPROVER_UNRESOLVABLE com params.sequence; sem titular → aviso', () => {
    const base = validFourStageWorkflow().build();
    const unknownUser = line({ approverUserId: '0192c132-0000-7000-8000-0000000000ff' });
    const noHead = line({
      approverType: 'DEPARTMENT_HEAD',
      approverUserId: null,
      approverDepartmentResolution: 'FIXED',
      approverFixedDepartmentId: SECRETARIA,
    });
    const result = validator.validate(
      withApprovers(base, 'APROVACAO', 'ALL', [noHead, unknownUser]),
      openReferences({
        activeUserIds: new Set([MARCOS]),
        departments: new Map([[SECRETARIA, { isActive: true, headUserId: null }]]),
      }),
    );
    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'WF_APPROVER_UNRESOLVABLE', params: { sequence: 2 } }),
    ]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'WF_APPROVER_HEAD_MISSING', params: { sequence: 1 } }),
    );
  });

  it('RN-APV-10: versão do MVP 1 (ANY, sem linhas) mantém snapshot e definitionHash', () => {
    const definition = validFourStageWorkflow(
      new DefinitionBuilder(FIXTURE_VERSION, () => fixtureId()),
    ).build();
    const explicitAny: WorkflowDefinition = {
      ...definition,
      stages: definition.stages.map((stage) => ({
        ...stage,
        decisionPolicy: 'ANY',
        decisionPolicyRules: [],
        approvers: [],
      })),
    };
    const snapshot = buildWorkflowSnapshot(explicitAny);
    expect(snapshot).toEqual(buildWorkflowSnapshot(definition));
    expect(workflowSnapshotHash(snapshot)).toBe(
      workflowSnapshotHash(buildWorkflowSnapshot(definition)),
    );
    for (const stage of snapshot.stages) {
      expect(stage).not.toHaveProperty('decisionPolicy');
      expect(stage).not.toHaveProperty('approvers');
    }
  });

  it('RN-APV-10: a publicação grava a política e as linhas por sequence (sem ids) no snapshot e no hash', () => {
    const base = validFourStageWorkflow().build();
    const sequential = withApprovers(base, 'APROVACAO', 'SEQUENTIAL', [head, marcos]);
    const snapshot = buildWorkflowSnapshot(sequential);
    const stage = snapshot.stages.find((item) => item.key === 'APROVACAO');
    expect(stage?.decisionPolicy).toBe('SEQUENTIAL');
    expect(stage?.approvers).toEqual([
      { sequence: 1, ...head },
      { sequence: 2, ...marcos },
    ]);
    expect(workflowSnapshotHash(snapshot)).not.toBe(
      workflowSnapshotHash(buildWorkflowSnapshot(base)),
    );
    const reordered = withApprovers(base, 'APROVACAO', 'SEQUENTIAL', [marcos, head]);
    expect(workflowSnapshotHash(buildWorkflowSnapshot(reordered))).not.toBe(
      workflowSnapshotHash(snapshot),
    );
  });

  it('FA-05: a cópia leva as linhas com ids novos, a etapa nova e a alçada intacta', () => {
    const rule = { kind: 'LIBRARY', ruleDefinitionVersionId: 'r-1' };
    const base = withApprovers(validFourStageWorkflow().build(), 'APROVACAO', 'ALL', [
      head,
      marcos,
    ]);
    const source: WorkflowDefinition = {
      ...base,
      stages: base.stages.map((stage) =>
        stage.approvers?.length
          ? {
              ...stage,
              decisionPolicyRules: [{ when: rule, policy: 'ANY' }],
              approvers: stage.approvers.map((item, index) =>
                index === 0 ? { ...item, applicabilityRule: rule } : item,
              ),
            }
          : stage,
      ),
    };
    const clone = cloneDefinition(source, {
      workflowVersionId: '0192c132-0000-7000-8000-00000000bb01',
      now: NOW,
      userId: null,
      newId: fixtureId,
    });
    const original = source.stages.find((stage) => stage.key === 'APROVACAO');
    const copied = clone.stages.find((stage) => stage.key === 'APROVACAO');
    expect(copied?.decisionPolicy).toBe('ALL');
    expect(copied?.decisionPolicyRules).toEqual([{ when: rule, policy: 'ANY' }]);
    expect(copied?.approvers?.map((item) => [item.sequence, item.applicabilityRule])).toEqual([
      [1, rule],
      [2, null],
    ]);
    for (const item of copied?.approvers ?? []) {
      expect(item.workflowStageId).toBe(copied?.id);
      expect(item.workflowVersionId).toBe('0192c132-0000-7000-8000-00000000bb01');
      expect(original?.approvers?.some((source) => source.id === item.id)).toBe(false);
    }
  });
});
