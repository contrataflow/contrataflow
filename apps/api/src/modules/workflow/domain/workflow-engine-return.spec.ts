import type { ActionEntry } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { availableActions, evaluateReturn, evaluateStage } from './workflow-engine.js';
import {
  dec015Workflow,
  engineInput,
  pass,
  passesUntilStudies,
  viewer,
  VIEWER_ID,
} from '../../../../test/support/workflow-engine-fixtures.js';

/*
 * US-048 — destinos de devolução no motor (RN-TRAM-23/24): as entradas `RETURN` de PRC-08 com a
 * etapa e a última passagem (SCR-104) e `evaluateReturn`, o mesmo cálculo usado pelo PRC-20.
 */

const returnsOf = (entries: readonly ActionEntry[]) =>
  entries.filter((entry) => entry.action === 'RETURN');

describe('Feature: Devolver processo — destinos no motor (domínio)', () => {
  const builder = dec015Workflow();
  const studies = passesUntilStudies(builder);

  it('RETURN traz a etapa de destino (id, nome, tipo) e a saída da última passagem', () => {
    const [entry] = returnsOf(
      availableActions(engineInput(builder, { passes: studies }), viewer()),
    );
    expect(entry).toMatchObject({
      label: 'Devolver para a formalização da demanda',
      toStageKey: 'ABERTURA',
      toStageId: builder.stageId('ABERTURA'),
      toStageName: 'Formalização da demanda',
      toStageType: 'START',
      lastPassedAt: studies[0]?.exitedAt,
      requiresComment: true,
      enabled: true,
      reasons: [],
    });
  });

  it('última passagem = a de maior sequência; sem saída registrada usa a entrada', () => {
    const passes = [
      pass(builder, 'ABERTURA', 1),
      pass(builder, 'APROVACAO_DFD', 2),
      pass(builder, 'ESTUDOS_PRELIMINARES', 3, { status: 'RETURNED' }),
      pass(builder, 'ABERTURA', 4, { exitedAt: null, enteredAt: '2026-10-08T09:00:00.000Z' }),
      pass(builder, 'ESTUDOS_PRELIMINARES', 5, { status: 'ACTIVE', exitedAt: null }),
    ];
    const [entry] = returnsOf(availableActions(engineInput(builder, { passes }), viewer()));
    expect(entry?.lastPassedAt).toBe('2026-10-08T09:00:00.000Z');
  });

  it.each(['DRAFT', 'RETURNED', 'AWAITING_APPROVAL', 'SUSPENDED'] as const)(
    'RN-TRAM-23: status %s → RETURN desabilitado com INVALID_PROCESS_STATUS',
    (status) => {
      const [entry] = returnsOf(
        availableActions(engineInput(builder, { passes: studies }, { status }), viewer()),
      );
      expect(entry).toMatchObject({
        enabled: false,
        reasons: [expect.objectContaining({ code: 'INVALID_PROCESS_STATUS' })],
      });
    },
  );

  it('sem custódia → NOT_PROCESS_CUSTODIAN; sem PROCESS_RETURN → entrada omitida', () => {
    const input = engineInput(builder, { passes: studies }, { currentResponsibleId: 'outra' });
    expect(returnsOf(availableActions(input, viewer()))).toEqual([
      expect.objectContaining({
        enabled: false,
        reasons: [
          {
            code: 'NOT_PROCESS_CUSTODIAN',
            message: 'Somente quem está com o processo pode devolvê-lo.',
          },
        ],
      }),
    ]);
    const custodian = engineInput(
      builder,
      { passes: studies },
      { currentResponsibleId: VIEWER_ID },
    );
    expect(
      returnsOf(availableActions(custodian, viewer({ permissions: new Set(['PROCESS_FORWARD']) }))),
    ).toEqual([]);
  });

  describe('evaluateReturn (RN-TRAM-24)', () => {
    it('etapa percorrida e configurada → transição, etapas de origem/destino e última passagem', () => {
      const input = engineInput(builder, { passes: studies });
      const result = evaluateReturn(input, { targetStageId: builder.stageId('ABERTURA') });
      expect(result).toMatchObject({
        transition: { action: 'RETURN', key: 'ESTUDOS_PRELIMINARES_RETURN_ABERTURA' },
        fromStage: { key: 'ESTUDOS_PRELIMINARES' },
        toStage: { key: 'ABERTURA', type: 'START' },
        lastPass: { sequence: 1, workflowStageId: builder.stageId('ABERTURA') },
      });
    });

    it('percorrida mas sem RETURN configurada, não percorrida, inexistente ou etapa ativa fora da versão → null', () => {
      const input = engineInput(builder, { passes: studies });
      // APROVACAO_DFD foi percorrida, mas ESTUDOS_PRELIMINARES só devolve para ABERTURA.
      expect(evaluateReturn(input, { targetStageId: builder.stageId('APROVACAO_DFD') })).toBeNull();
      // PESQUISA_PRECOS não foi percorrida.
      expect(
        evaluateReturn(input, { targetStageId: builder.stageId('PESQUISA_PRECOS') }),
      ).toBeNull();
      expect(
        evaluateReturn(input, { targetStageId: '0192c000-0000-7000-8000-00000000dead' }),
      ).toBeNull();
      const outside = engineInput(builder, {
        passes: [
          pass(builder, 'ABERTURA', 1),
          pass(builder, 'ESTUDOS_PRELIMINARES', 2, {
            status: 'ACTIVE',
            workflowStageId: 'de-outra-versao',
          }),
        ],
      });
      expect(
        evaluateReturn(
          outside,
          { targetStageId: builder.stageId('ABERTURA') },
          evaluateStage(outside),
        ),
      ).toBeNull();
    });

    it('etapa só ativa (ainda não encerrada) não é destino', () => {
      const input = engineInput(builder, {
        passes: [pass(builder, 'ABERTURA', 1, { status: 'ACTIVE', exitedAt: null })],
      });
      expect(evaluateReturn(input, { targetStageId: builder.stageId('ABERTURA') })).toBeNull();
    });
  });
});
