import { describe, expect, it } from 'vitest';

import { decisionTargets, evaluateDecision, evaluateStage } from './workflow-engine.js';
import {
  engineInput,
  pass,
  ruleContext,
} from '../../../../test/support/workflow-engine-fixtures.js';
import { DefinitionBuilder } from '../../../../test/support/workflow-fixtures.js';

/*
 * US-052 — saídas da decisão de aprovação no motor (RN-TRAM-56 · DEC-015/016): `decisionTargets`
 * (as opções do SCR-015) e `evaluateDecision` (o mesmo cálculo usado pelo APV-03): `APPROVE` para
 * qualquer destino, `RETURN`/`REJECT` só para etapas percorridas, uma devolução por etapa e as
 * regras `TRANSITION` da própria saída.
 */

const WARNING = 'O mapa de riscos não foi atualizado desde a última versão.';
const BLOCKING = 'A pesquisa de preços precisa estar concluída.';

function flow(): DefinitionBuilder {
  return new DefinitionBuilder()
    .stage('ABERTURA', 'START', { name: 'Formalização da demanda' })
    .stage('ESTUDOS', 'TASK', { name: 'ETP e mapa de riscos' })
    .stage('TERMO', 'TASK', { name: 'Termo de Referência' })
    .stage('APROVACAO', 'APPROVAL', { name: 'Aprovação da autoridade competente' })
    .stage('CONCLUSAO', 'END', { name: 'Planejamento concluído' })
    .transition('ABERTURA', 'ESTUDOS', 'FORWARD', { isPrimary: true })
    .transition('ESTUDOS', 'TERMO', 'FORWARD', { isPrimary: true })
    .transition('TERMO', 'APROVACAO', 'FORWARD', { isPrimary: true })
    .transition('APROVACAO', 'CONCLUSAO', 'APPROVE', { name: 'Aprovar o planejamento' })
    .transition('APROVACAO', 'TERMO', 'RETURN', { name: 'Devolver ao TR', displayOrder: 2 })
    .transition('APROVACAO', 'ESTUDOS', 'RETURN', { name: 'Devolver ao ETP', displayOrder: 1 })
    .transition('APROVACAO', 'ESTUDOS', 'RETURN', {
      name: 'Devolver ao ETP (duplicada)',
      displayOrder: 3,
    })
    .transition('APROVACAO', 'ABERTURA', 'REJECT', { name: 'Indeferir' });
}

/** ABERTURA, ESTUDOS e TERMO percorridas; APROVACAO ativa. */
function atApproval(builder: DefinitionBuilder, untilTerm = true) {
  return [
    pass(builder, 'ABERTURA', 1),
    pass(builder, 'ESTUDOS', 2),
    ...(untilTerm ? [pass(builder, 'TERMO', 3)] : []),
    pass(builder, 'APROVACAO', 4, { status: 'ACTIVE', exitedAt: null }),
  ];
}

const input = (builder: DefinitionBuilder, passes = atApproval(builder)) =>
  engineInput(builder, { passes, context: ruleContext('APROVACAO') });

describe('Feature: Decidir aprovação — saídas no motor (domínio)', () => {
  it('opções na ordem APPROVE → RETURN (por exibição, uma por etapa) → REJECT, com o destino', () => {
    const builder = flow();
    const targets = decisionTargets(input(builder));
    expect(
      targets.map((target) => [
        target.transition.action,
        target.transition.name,
        target.toStage.key,
      ]),
    ).toEqual([
      ['APPROVE', 'Aprovar o planejamento', 'CONCLUSAO'],
      ['RETURN', 'Devolver ao ETP', 'ESTUDOS'],
      ['RETURN', 'Devolver ao TR', 'TERMO'],
      ['REJECT', 'Indeferir', 'ABERTURA'],
    ]);
    expect(targets.every((target) => target.violations.length === 0)).toBe(true);
  });

  it('RN-TRAM-56: devolução para etapa nunca percorrida não é opção', () => {
    const builder = flow();
    const targets = decisionTargets(input(builder, atApproval(builder, false)));
    expect(
      targets.filter((target) => target.transition.action === 'RETURN').map((t) => t.toStage.key),
    ).toEqual(['ESTUDOS']);
  });

  it('fora de etapa APPROVAL (ou sem etapa ativa) não há decisão', () => {
    const builder = flow();
    const atTerm = [
      pass(builder, 'ABERTURA', 1),
      pass(builder, 'TERMO', 2, { status: 'ACTIVE', exitedAt: null }),
    ];
    expect(decisionTargets(input(builder, atTerm))).toEqual([]);
    expect(evaluateDecision(input(builder, []), { action: 'APPROVE', transitionId: null })).toEqual(
      { kind: 'UNAVAILABLE' },
    );
  });

  it('APPROVE e REJECT resolvem a única saída sem transitionId', () => {
    const builder = flow();
    const approve = evaluateDecision(input(builder), { action: 'APPROVE', transitionId: null });
    expect(approve).toMatchObject({
      kind: 'RESOLVED',
      evaluation: {
        fromStage: { key: 'APROVACAO' },
        toStage: { key: 'CONCLUSAO', type: 'END' },
        violations: [],
      },
    });
    const reject = evaluateDecision(input(builder), { action: 'REJECT', transitionId: null });
    expect(reject).toMatchObject({
      kind: 'RESOLVED',
      evaluation: { toStage: { key: 'ABERTURA' } },
    });
  });

  it('mais de uma devolução sem transitionId = CHOICE_REQUIRED; com ela, a escolhida', () => {
    const builder = flow();
    const choice = evaluateDecision(input(builder), { action: 'RETURN', transitionId: null });
    expect(choice.kind).toBe('CHOICE_REQUIRED');
    if (choice.kind === 'CHOICE_REQUIRED') expect(choice.targets).toHaveLength(2);

    const toTerm = builder.transitions.find((t) => t.key === 'APROVACAO_RETURN_TERMO')?.id ?? '';
    expect(
      evaluateDecision(input(builder), { action: 'RETURN', transitionId: toTerm }),
    ).toMatchObject({ kind: 'RESOLVED', evaluation: { toStage: { key: 'TERMO' } } });
  });

  it('com só uma devolução possível, RETURN resolve sem transitionId', () => {
    const builder = flow();
    expect(
      evaluateDecision(input(builder, atApproval(builder, false)), {
        action: 'RETURN',
        transitionId: null,
      }),
    ).toMatchObject({ kind: 'RESOLVED', evaluation: { toStage: { key: 'ESTUDOS' } } });
  });

  it('transitionId de outra ação, de outra etapa ou inexistente = UNAVAILABLE', () => {
    const builder = flow();
    const approveId = builder.transitions.find((t) => t.action === 'APPROVE')?.id ?? '';
    const forwardId = builder.transitions.find((t) => t.action === 'FORWARD')?.id ?? '';
    for (const transitionId of [approveId, forwardId, 'inexistente']) {
      expect(evaluateDecision(input(builder), { action: 'RETURN', transitionId })).toEqual({
        kind: 'UNAVAILABLE',
      });
    }
  });

  it('DEC-016: regras TRANSITION da própria saída — bloqueante antes do aviso; as das outras saídas não contam', () => {
    const builder = flow()
      .rule(
        'CONDITION',
        { expression: { '==': [{ var: 'process.status' }, 'CANCELED'] } },
        { transition: 'APROVACAO_APPROVE_CONCLUSAO' },
        { severity: 'WARNING', message: WARNING, displayOrder: 1 },
      )
      .rule(
        'CONDITION',
        { expression: { '==': [{ var: 'process.status' }, 'CANCELED'] } },
        { transition: 'APROVACAO_APPROVE_CONCLUSAO' },
        { severity: 'BLOCKING', message: BLOCKING, displayOrder: 2 },
      )
      .rule(
        'CONDITION',
        { expression: { '==': [{ var: 'process.status' }, 'CANCELED'] } },
        { transition: 'APROVACAO_REJECT_ABERTURA' },
        { severity: 'BLOCKING', message: 'Só da saída de indeferimento.' },
      );
    const decision = evaluateDecision(input(builder), { action: 'APPROVE', transitionId: null });
    expect(decision.kind).toBe('RESOLVED');
    if (decision.kind !== 'RESOLVED') return;
    expect(decision.evaluation.violations.map((v) => [v.severity, v.message])).toEqual([
      ['BLOCKING', BLOCKING],
      ['WARNING', WARNING],
    ]);
    expect(decision.evaluation.violations[0]).toMatchObject({
      code: 'WORKFLOW_RULE',
      scope: 'TRANSITION',
      transitionKey: 'APROVACAO_APPROVE_CONCLUSAO',
    });
    // O mesmo cálculo das opções e da avaliação (UI e backend nunca divergem).
    const evaluation = evaluateStage(input(builder));
    const approve = decisionTargets(input(builder), evaluation)[0];
    expect(approve?.violations).toEqual(decision.evaluation.violations);
  });
});
