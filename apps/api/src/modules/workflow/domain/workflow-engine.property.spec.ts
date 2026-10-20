import { PROCESS_STATUSES } from '@contrataflow/validation';
import type { ProcessStatus, RuleSeverity, RuleType } from '@contrataflow/validation';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { documentsSectionOf } from './rule-facts.js';
import type { RuleDocumentFact, StageApprovalFact, StagePassFact } from './rule-facts.js';
import { availableActions, checklistOf, evaluateStage } from './workflow-engine.js';
import type { EngineInput, EngineViewer } from './workflow-engine.js';
import { buildWorkflowSnapshot } from './workflow-snapshot.js';
import {
  DEPARTMENTS,
  engineProcess,
  ruleContext,
  viewer,
} from '../../../../test/support/workflow-engine-fixtures.js';
import { DefinitionBuilder } from '../../../../test/support/workflow-fixtures.js';

/*
 * Property-based (US-041 · Testes necessários · DoD): para grafos gerados — etapa atual com 1..4
 * saídas de avanço, regras dos 4 `RuleType` na saída da etapa e nas transições, severidades e
 * ativação aleatórias — `enabled = false` se e somente se existir regra BLOCKING ativa não
 * satisfeita (da etapa ou da própria transição); o checklist é exatamente o conjunto das regras
 * ativas não satisfeitas; avisos nunca viram motivo; o motor nunca lança e é determinístico.
 */

const RULE_TYPES: readonly RuleType[] = [
  'REQUIRED_DOCUMENT',
  'REQUIRED_FIELD',
  'REQUIRED_APPROVAL',
  'CONDITION',
];

interface RuleShape {
  readonly type: RuleType;
  readonly severity: RuleSeverity;
  readonly active: boolean;
  /** O fato que a regra exige está presente (oráculo da satisfação). */
  readonly satisfied: boolean;
  /** `null` = `STAGE_EXIT`; senão o índice da saída (`TRANSITION`). */
  readonly transition: number | null;
}

interface GraphShape {
  readonly exits: readonly ('FORWARD' | 'COMPLETE')[];
  readonly rules: readonly RuleShape[];
}

const graphArbitrary: fc.Arbitrary<GraphShape> = fc
  .array(fc.constantFrom('FORWARD' as const, 'COMPLETE' as const), { minLength: 1, maxLength: 4 })
  .chain((exits) =>
    fc.record({
      exits: fc.constant(exits),
      rules: fc.array(
        fc.record({
          type: fc.constantFrom(...RULE_TYPES),
          severity: fc.constantFrom('BLOCKING' as const, 'WARNING' as const),
          active: fc.boolean(),
          satisfied: fc.boolean(),
          transition: fc.option(fc.nat({ max: exits.length - 1 }), { nil: null }),
        }),
        { maxLength: 12 },
      ),
    }),
  );

interface Built {
  readonly input: EngineInput;
  /** Mensagem → forma da regra. */
  readonly byMessage: ReadonlyMap<string, RuleShape>;
  /** Chave da transição por índice da saída. */
  readonly exitKeys: readonly string[];
}

/** Monta o snapshot e os fatos: cada regra i lê o seu próprio fato (documento `T{i}`/aprovação `AP{i}`). */
function build(shape: GraphShape, status: ProcessStatus = 'IN_PROGRESS'): Built {
  const builder = new DefinitionBuilder().stage('INICIO', 'START').stage('ATUAL', 'TASK');
  shape.rules.forEach((rule, index) => {
    if (rule.type === 'REQUIRED_APPROVAL') builder.stage(`AP${index}`, 'APPROVAL');
  });
  const exitKeys = shape.exits.map((action, index) => {
    const target = `D${index}`;
    builder.stage(target, action === 'COMPLETE' ? 'END' : 'TASK');
    builder.transition('ATUAL', target, action, { displayOrder: index });
    return `ATUAL_${action}_${target}`;
  });
  builder.transition('INICIO', 'ATUAL', 'FORWARD', { isPrimary: true });

  const documents: RuleDocumentFact[] = [];
  const approvals: StageApprovalFact[] = [];
  const passes: StagePassFact[] = [];
  const byMessage = new Map<string, RuleShape>();
  let sequence = 1;
  const addPass = (key: string, status: StagePassFact['status']) => {
    const processStageId = `pass-${key}`;
    passes.push({
      processStageId,
      workflowStageId: builder.stageId(key),
      sequence: sequence++,
      status,
      departmentId: DEPARTMENTS.planejamento,
      assigneeId: null,
      enteredAt: '2026-10-01T12:00:00.000Z',
      exitedAt: null,
    });
    return processStageId;
  };
  addPass('INICIO', 'COMPLETED');

  shape.rules.forEach((rule, index) => {
    const code = `T${index}`;
    const message = `Regra ${index}`;
    byMessage.set(message, rule);
    if (rule.satisfied && rule.type !== 'REQUIRED_APPROVAL') {
      documents.push({
        documentTypeCode: code,
        status: 'FINALIZED',
        isComplete: true,
        versionNumber: 1,
        approvedAt: null,
      });
    }
    let config: Record<string, unknown>;
    switch (rule.type) {
      case 'REQUIRED_DOCUMENT':
        config = { documentTypeCode: code, minStatus: 'FINAL' };
        break;
      case 'REQUIRED_FIELD':
        config = { field: `documents.${code}.status` };
        break;
      case 'CONDITION':
        config = { expression: { '==': [{ var: `documents.${code}.exists` }, true] } };
        break;
      case 'REQUIRED_APPROVAL': {
        const passId = addPass(`AP${index}`, 'COMPLETED');
        approvals.push({
          processStageId: passId,
          status: rule.satisfied ? 'APPROVED' : 'RETURNED',
        });
        config = { stageKey: `AP${index}` };
        break;
      }
    }
    builder.rule(
      rule.type,
      config,
      rule.transition === null
        ? { stage: 'ATUAL' }
        : { transition: exitKeys[rule.transition] ?? '' },
      { severity: rule.severity, isActive: rule.active, message, displayOrder: index },
    );
  });
  addPass('ATUAL', 'ACTIVE');

  const input: EngineInput = {
    definition: buildWorkflowSnapshot(builder.build()),
    process: engineProcess({ status }),
    facts: {
      context: ruleContext('ATUAL', { documents: documentsSectionOf(documents) }),
      documents,
      passes,
      approvals,
    },
  };
  return { input, byMessage, exitKeys };
}

const blocks = (rule: RuleShape, exit: number) =>
  rule.active &&
  !rule.satisfied &&
  rule.severity === 'BLOCKING' &&
  (rule.transition === null || rule.transition === exit);

describe('Propriedades do motor de execução (US-041)', () => {
  it('enabled = false ⇔ existe regra BLOCKING ativa não satisfeita (custodiante, status editável)', () => {
    fc.assert(
      fc.property(graphArbitrary, (shape) => {
        const { input, exitKeys } = build(shape);
        const advances = availableActions(input, viewer()).filter(
          (entry) => entry.action === 'FORWARD' || entry.action === 'COMPLETE',
        );
        expect(advances.map((entry) => entry.transitionKey).sort()).toEqual([...exitKeys].sort());
        for (const entry of advances) {
          const exit = exitKeys.indexOf(entry.transitionKey ?? '');
          const expected = shape.rules
            .map((rule, index) => ({ rule, message: `Regra ${index}` }))
            .filter(({ rule }) => blocks(rule, exit))
            .map(({ message }) => message);
          expect(entry.enabled).toBe(expected.length === 0);
          expect(entry.reasons.map((reason) => reason.message).sort()).toEqual(expected.sort());
          expect(entry.reasons.every((reason) => reason.code === 'TRANSITION_BLOCKED')).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('checklist = regras ativas não satisfeitas, bloqueantes antes dos avisos; aviso nunca é motivo', () => {
    fc.assert(
      fc.property(graphArbitrary, (shape) => {
        const { input, byMessage } = build(shape);
        const evaluation = evaluateStage(input);
        const checklist = checklistOf(evaluation);
        const expected = shape.rules.filter((rule) => rule.active && !rule.satisfied).length;
        expect(checklist).toHaveLength(expected);
        for (const violation of checklist) {
          const rule = byMessage.get(violation.message);
          expect(rule?.active && !rule.satisfied).toBe(true);
          expect(violation.severity).toBe(rule?.severity);
        }
        const firstWarning = checklist.findIndex((item) => item.severity === 'WARNING');
        if (firstWarning >= 0) {
          expect(checklist.slice(firstWarning).every((item) => item.severity === 'WARNING')).toBe(
            true,
          );
        }
        const warnings = new Set(
          [...byMessage.entries()]
            .filter(([, rule]) => rule.severity === 'WARNING')
            .map(([message]) => message),
        );
        for (const entry of availableActions(input, viewer(), evaluation)) {
          expect(entry.reasons.some((reason) => warnings.has(reason.message))).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('nunca lança e é determinístico para qualquer status, custódia e permissões', () => {
    const viewerArbitrary: fc.Arbitrary<EngineViewer> = fc
      .record({
        custodian: fc.boolean(),
        head: fc.boolean(),
        wide: fc.boolean(),
        permissions: fc.subarray([
          'PROCESS_FORWARD',
          'PROCESS_RETURN',
          'PROCESS_COMPLETE',
          'PROCESS_CLAIM',
          'PROCESS_ASSIGN',
          'PROCESS_CANCEL',
          'PROCESS_SUSPEND',
        ] as const),
      })
      .map(({ custodian, head, wide, permissions }) =>
        viewer({
          departmentIds: custodian ? [DEPARTMENTS.planejamento] : [DEPARTMENTS.compras],
          headOfDepartmentIds: head ? [DEPARTMENTS.planejamento] : [],
          canAssignAnywhere: wide,
          permissions: new Set(permissions),
        }),
      );
    fc.assert(
      fc.property(
        graphArbitrary,
        fc.constantFrom(...PROCESS_STATUSES),
        viewerArbitrary,
        (shape, status, reader) => {
          const { input } = build(shape, status);
          const first = availableActions(input, reader);
          expect(availableActions(input, reader)).toEqual(first);
          expect(checklistOf(evaluateStage(input))).toEqual(checklistOf(evaluateStage(input)));
          for (const entry of first) expect(entry.enabled).toBe(entry.reasons.length === 0);
        },
      ),
      { numRuns: 200 },
    );
  });
});
