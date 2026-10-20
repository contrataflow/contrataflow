import { workflowRuleIssues, workflowStageIssues } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PREPARATORY_KEY,
  DEFAULT_WORKFLOWS,
  DIRECT_CONTRACTING_KEY,
  materializeSeedDefinition,
} from './default-workflows.js';
import type { SeedWorkflow } from './default-workflows.js';
import { resolveApplicableWorkflow } from './workflow-applicability.js';
import { WorkflowDefinitionValidator } from './workflow-definition.validator.js';
import { buildWorkflowSnapshot, workflowSnapshotHash } from './workflow-snapshot.js';
import { openReferences } from '../../../../test/support/workflow-fixtures.js';

/* US-042 · DEC-015 · RN-WF-34..38 — conteúdo dos dois workflows semeados. */

const ROLE = '0192c000-0000-7000-8000-00000000a0b1';
const TENANT = '0192c000-0000-7000-8000-00000000a0a0';

let sequence = 0;
const newId = () => {
  sequence += 1;
  return `0192c000-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
};

const specOf = (key: string): SeedWorkflow => {
  const spec = DEFAULT_WORKFLOWS.find((workflow) => workflow.key === key);
  if (!spec) throw new Error(key);
  return spec;
};

const materialize = (spec: SeedWorkflow) =>
  materializeSeedDefinition(spec, {
    tenantId: TENANT,
    workflowVersionId: newId(),
    now: new Date('2026-10-15T12:00:00Z'),
    newId,
    roleIdOf: (key) => {
      expect(key).toBe('AUTORIDADE_COMPETENTE');
      return ROLE;
    },
  });

const references = openReferences({
  activeDocumentTypeCodes: new Set([
    'DFD',
    'ETP',
    'TR',
    'RISK_MAP',
    'PRICE_RESEARCH',
    'NOTA_TECNICA',
  ]),
  roles: new Map([[ROLE, { isActive: true, canDecideApprovals: true }]]),
});

describe('Workflows semeados (US-042 · DEC-015)', () => {
  it('RN-WF-34/35: exatamente dois, com as chaves estáveis; só o padrão nasce isDefault', () => {
    expect(DEFAULT_WORKFLOWS.map((workflow) => [workflow.key, workflow.isDefault])).toEqual([
      [DEFAULT_PREPARATORY_KEY, true],
      [DIRECT_CONTRACTING_KEY, false],
    ]);
    expect(specOf(DEFAULT_PREPARATORY_KEY)).toMatchObject({
      name: 'Fase preparatória — Lei 14.133/2021',
      applicabilityPriority: 100,
      applicabilityRule: null,
    });
    expect(specOf(DIRECT_CONTRACTING_KEY)).toMatchObject({
      name: 'Contratação direta — Lei 14.133/2021, art. 72',
      applicabilityPriority: 50,
    });
  });

  it('RN-WF-37: as 7 etapas do padrão, com os SLAs sugeridos em dias úteis', () => {
    const { stages } = materialize(specOf(DEFAULT_PREPARATORY_KEY));
    expect(stages.map((stage) => [stage.key, stage.type, stage.slaDays, stage.slaType])).toEqual([
      ['ABERTURA', 'START', 5, 'BUSINESS'],
      ['APROVACAO_DFD', 'APPROVAL', 3, 'BUSINESS'],
      ['ESTUDOS_PRELIMINARES', 'TASK', 15, 'BUSINESS'],
      ['PESQUISA_PRECOS', 'TASK', 10, 'BUSINESS'],
      ['TERMO_REFERENCIA', 'TASK', 10, 'BUSINESS'],
      ['APROVACAO_AUTORIDADE', 'APPROVAL', 5, 'BUSINESS'],
      ['CONCLUSAO', 'END', null, 'BUSINESS'],
    ]);
    const byKey = new Map(stages.map((stage) => [stage.key, stage]));
    expect(byKey.get('ABERTURA')?.name).toBe('Formalização da demanda');
    expect(byKey.get('ABERTURA')?.departmentResolution).toBe('REQUESTING_DEPARTMENT');
    expect(byKey.get('APROVACAO_DFD')).toMatchObject({
      approverType: 'DEPARTMENT_HEAD',
      approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
      approvalDocumentTypeCodes: ['DFD'],
    });
    // entities.md §7: até o administrador configurar a unidade de Compras.
    expect(byKey.get('PESQUISA_PRECOS')?.departmentResolution).toBe('CHOSEN_ON_FORWARD');
    expect(byKey.get('APROVACAO_AUTORIDADE')).toMatchObject({
      approverType: 'ROLE',
      approverRoleId: ROLE,
      approvalDocumentTypeCodes: ['ETP', 'RISK_MAP', 'PRICE_RESEARCH', 'TR'],
    });
    expect(stages.every((stage) => (stage.instructions ?? '').length > 0)).toBe(true);
  });

  it('RN-WF-37: regras de saída do padrão (ETP BLOCKING, mapa de riscos WARNING)', () => {
    const { stages, rules } = materialize(specOf(DEFAULT_PREPARATORY_KEY));
    const keyOf = new Map(stages.map((stage) => [stage.id, stage.key]));
    expect(rules.map((rule) => [keyOf.get(rule.stageId ?? ''), rule.type, rule.severity])).toEqual([
      ['ABERTURA', 'REQUIRED_DOCUMENT', 'BLOCKING'],
      ['ESTUDOS_PRELIMINARES', 'REQUIRED_DOCUMENT', 'BLOCKING'],
      ['ESTUDOS_PRELIMINARES', 'REQUIRED_DOCUMENT', 'WARNING'],
      ['PESQUISA_PRECOS', 'CONDITION', 'BLOCKING'],
      ['TERMO_REFERENCIA', 'REQUIRED_DOCUMENT', 'BLOCKING'],
    ]);
  });

  it('RN-WF-38: contratação direta — 5 etapas, "TR ou ETP" WARNING e pesquisa BLOCKING na INSTRUCAO', () => {
    const { stages, rules } = materialize(specOf(DIRECT_CONTRACTING_KEY));
    expect(stages.map((stage) => stage.key)).toEqual([
      'ABERTURA',
      'APROVACAO_DFD',
      'INSTRUCAO',
      'AUTORIZACAO',
      'CONCLUSAO',
    ]);
    const instrucao = stages.find((stage) => stage.key === 'INSTRUCAO');
    const exit = rules.filter((rule) => rule.stageId === instrucao?.id);
    expect(exit.map((rule) => [rule.name, rule.severity])).toEqual([
      ['TR ou ETP (art. 72, I)', 'WARNING'],
      ['Pesquisa de preços concluída', 'BLOCKING'],
    ]);
  });

  it.each(DEFAULT_WORKFLOWS.map((spec) => [spec.key, spec] as const))(
    '%s passa no validador da publicação, sem erros nem avisos, com campos coerentes',
    (_key, spec) => {
      const definition = materialize(spec);
      expect(new WorkflowDefinitionValidator().validate(definition, references)).toEqual({
        valid: true,
        errors: [],
        warnings: [],
      });
      for (const stage of definition.stages) expect(workflowStageIssues(stage)).toEqual([]);
      for (const rule of definition.rules) expect(workflowRuleIssues(rule)).toEqual([]);
      // RN-WF-09: devolver/indeferir pedem comentário.
      for (const transition of definition.transitions) {
        expect(transition.requiresComment).toBe(
          transition.action === 'RETURN' || transition.action === 'REJECT',
        );
      }
    },
  );

  it('DEC-084: o snapshot da carga tem hash SHA-256 reprodutível', () => {
    const definition = materialize(specOf(DEFAULT_PREPARATORY_KEY));
    const snapshot = buildWorkflowSnapshot(definition);
    expect(workflowSnapshotHash(snapshot)).toMatch(/^[0-9a-f]{64}$/);
    expect(workflowSnapshotHash(buildWorkflowSnapshot(definition))).toBe(
      workflowSnapshotHash(snapshot),
    );
  });

  it('a regra de aplicabilidade semeada escolhe a direta para DISPENSA/INEXIGIBILIDADE e o padrão nos demais', () => {
    const at = new Date('2026-10-15T12:00:00Z');
    const workflows = DEFAULT_WORKFLOWS.map((spec, index) => ({
      id: `w${index}`,
      key: spec.key,
      isActive: true,
      isDefault: spec.isDefault,
      applicabilityRule: spec.applicabilityRule,
      applicabilityPriority: spec.applicabilityPriority,
      createdAt: at,
      currentPublishedVersionId: `v${index}`,
    }));
    const keyFor = (modalityCode: string | null) =>
      resolveApplicableWorkflow(workflows, { modalityCode }).workflow?.key;
    expect(keyFor('DISPENSA')).toBe(DIRECT_CONTRACTING_KEY);
    expect(keyFor('INEXIGIBILIDADE')).toBe(DIRECT_CONTRACTING_KEY);
    expect(keyFor('PREGAO')).toBe(DEFAULT_PREPARATORY_KEY);
    expect(keyFor(null)).toBe(DEFAULT_PREPARATORY_KEY);
  });
});
