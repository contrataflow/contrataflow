import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { cloneDefinition } from './workflow-clone.js';
import { WorkflowDefinitionValidator } from './workflow-definition.validator.js';
import {
  buildWorkflowSnapshot,
  snapshotWithoutIds,
  workflowSnapshotHash,
} from './workflow-snapshot.js';
import { DefinitionBuilder, openReferences } from '../../../../test/support/workflow-fixtures.js';

/*
 * Property-based (US-040 · Testes necessários): grafos válidos gerados — cadeia START → … → END
 * com aprovações, devoluções e indeferimentos aleatórios — são sempre aceitos; mutações dirigidas
 * são sempre rejeitadas com o código esperado; o clone só difere pelos ids.
 */

const validator = new WorkflowDefinitionValidator();

interface Shape {
  /** Tipo de cada etapa intermediária. */
  readonly middle: readonly ('TASK' | 'APPROVAL')[];
  /** Sementes para escolher o destino das devoluções/indeferimentos. */
  readonly picks: readonly number[];
  /** Etapas de tarefa que também devolvem. */
  readonly taskReturns: readonly boolean[];
}

const shapeArbitrary: fc.Arbitrary<Shape> = fc.integer({ min: 1, max: 12 }).chain((size) =>
  fc.record({
    middle: fc.array(fc.constantFrom('TASK' as const, 'APPROVAL' as const), {
      minLength: size,
      maxLength: size,
    }),
    picks: fc.array(fc.nat(), { minLength: 2 * size, maxLength: 2 * size }),
    taskReturns: fc.array(fc.boolean(), { minLength: size, maxLength: size }),
  }),
);

/** Monta o grafo válido descrito pela forma. */
function buildValid(shape: Shape): DefinitionBuilder {
  const builder = new DefinitionBuilder().stage('INICIO', 'START');
  const keys = ['INICIO'];
  const types: string[] = ['START'];
  shape.middle.forEach((type, index) => {
    const key = `E${index}`;
    builder.stage(key, type);
    keys.push(key);
    types.push(type);
  });
  builder.stage('FIM', 'END');
  keys.push('FIM');
  types.push('END');

  // Destinos válidos de devolução: START/TASK anteriores à etapa i.
  const earlier = (index: number, seed: number) => {
    const candidates = keys.slice(0, index).filter((_key, at) => types[at] !== 'APPROVAL');
    return candidates[seed % candidates.length] ?? 'INICIO';
  };

  for (let index = 0; index < keys.length - 1; index += 1) {
    const from = keys[index] ?? '';
    const to = keys[index + 1] ?? '';
    const type = types[index];
    const toEnd = index + 1 === keys.length - 1;
    if (type === 'APPROVAL') {
      builder.transition(from, to, 'APPROVE');
      builder.transition(from, earlier(index, shape.picks[2 * (index - 1)] ?? 0), 'RETURN');
      builder.transition(from, earlier(index, shape.picks[2 * (index - 1) + 1] ?? 0), 'REJECT');
    } else {
      builder.transition(from, to, toEnd ? 'COMPLETE' : 'FORWARD', { isPrimary: true });
      if (type === 'TASK' && shape.taskReturns[index - 1]) {
        builder.transition(from, earlier(index, shape.picks[2 * (index - 1)] ?? 0), 'RETURN');
      }
    }
  }
  return builder;
}

const codesOf = (builder: DefinitionBuilder) =>
  validator.validate(builder.build(), openReferences()).errors.map((error) => error.code);

describe('WorkflowDefinitionValidator — property-based', () => {
  it('todo grafo válido gerado é aceito', () => {
    fc.assert(
      fc.property(shapeArbitrary, (shape) => {
        expect(codesOf(buildValid(shape))).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it('remover a REJECT de uma aprovação → WF_APPROVAL_TRANSITIONS', () => {
    fc.assert(
      fc.property(
        shapeArbitrary.filter((shape) => shape.middle.includes('APPROVAL')),
        (shape) => {
          const builder = buildValid(shape);
          const index = builder.transitions.findIndex((t) => t.action === 'REJECT');
          builder.transitions.splice(index, 1);
          expect(codesOf(builder)).toContain('WF_APPROVAL_TRANSITIONS');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('desconectar uma etapa (sem avanço que chegue nela) → WF_STAGE_UNREACHABLE', () => {
    fc.assert(
      fc.property(shapeArbitrary, fc.nat(), (shape, seed) => {
        const builder = buildValid(shape);
        const target = builder.stages[1 + (seed % shape.middle.length)];
        const incoming = (t: { toStageId: string; action: string }) =>
          t.toStageId === target?.id && ['FORWARD', 'APPROVE', 'COMPLETE'].includes(t.action);
        builder.transitions.splice(
          0,
          builder.transitions.length,
          ...builder.transitions.filter((t) => !incoming(t)),
        );
        const errors = validator.validate(builder.build(), openReferences()).errors;
        expect(errors).toContainEqual(
          expect.objectContaining({ code: 'WF_STAGE_UNREACHABLE', stageKey: target?.key }),
        );
      }),
      { numRuns: 100 },
    );
  });

  it('ciclo sem saída para END → WF_END_UNREACHABLE', () => {
    fc.assert(
      fc.property(shapeArbitrary, (shape) => {
        const builder = buildValid(shape)
          .stage('CICLO_A', 'TASK')
          .stage('CICLO_B', 'TASK')
          .transition('INICIO', 'CICLO_A', 'FORWARD')
          .transition('CICLO_A', 'CICLO_B', 'FORWARD')
          .transition('CICLO_B', 'CICLO_A', 'FORWARD');
        expect(codesOf(builder)).toContain('WF_END_UNREACHABLE');
      }),
      { numRuns: 100 },
    );
  });

  it('hash(clone(v)) difere de hash(v) só pelos ids', () => {
    fc.assert(
      fc.property(shapeArbitrary, (shape) => {
        const source = buildValid(shape).build();
        let next = 0;
        const clone = cloneDefinition(source, {
          workflowVersionId: '0192c000-0000-7000-8000-0000000c1000',
          now: new Date('2026-10-16T00:00:00Z'),
          userId: null,
          newId: () => `0192c000-0000-7000-8fff-${String((next += 1)).padStart(12, '0')}`,
        });
        const original = buildWorkflowSnapshot(source);
        const copied = buildWorkflowSnapshot(clone);
        expect(snapshotWithoutIds(copied)).toEqual(snapshotWithoutIds(original));
        expect(workflowSnapshotHash(copied)).not.toBe(workflowSnapshotHash(original));
      }),
      { numRuns: 100 },
    );
  });
});
