import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';

import { cloneDefinition } from './workflow-clone.js';
import {
  buildWorkflowSnapshot,
  snapshotWithoutIds,
  workflowSnapshotHash,
  workflowSnapshotSchema,
} from './workflow-snapshot.js';
import {
  DefinitionBuilder,
  validFourStageWorkflow,
} from '../../../../test/support/workflow-fixtures.js';

const NEW_VERSION = '0192c000-0000-7000-8000-00000000c0c1';
const NOW = new Date('2026-10-16T09:00:00.000Z');

describe('snapshot canônico e definitionHash (US-040 · RN-WF-20 · DEC-084)', () => {
  it('ordena etapas e transições por chave, resolve chaves das referências e passa no schema', () => {
    const definition = validFourStageWorkflow().build();
    const snapshot = buildWorkflowSnapshot(definition);
    expect(workflowSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.stages.map((stage) => stage.key)).toEqual([
      'ABERTURA',
      'ANALISE',
      'APROVACAO',
      'FIM',
    ]);
    expect(snapshot.initialStageKey).toBe('ABERTURA');
    expect(snapshot.transitions.find((t) => t.key === 'APROVACAO_APPROVE_FIM')).toMatchObject({
      fromStageKey: 'APROVACAO',
      toStageKey: 'FIM',
    });
    expect(snapshot.rules.find((rule) => rule.type === 'REQUIRED_APPROVAL')).toMatchObject({
      scope: 'TRANSITION',
      transitionKey: 'ANALISE_FORWARD_APROVACAO',
      stageKey: null,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/createdAt|updatedAt|"version"/);
  });

  it('hash reprodutível: SHA-256 do JCS do snapshot (inclusive depois de passar pelo jsonb)', () => {
    const snapshot = buildWorkflowSnapshot(validFourStageWorkflow().build());
    const hash = workflowSnapshotHash(snapshot);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(canonicalJson(snapshot))).toBe(hash);
    // O jsonb reordena chaves: o JCS recompõe a mesma forma canônica.
    const reverseKeys = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverseKeys)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, child]) => [key, reverseKeys(child)]),
            )
          : value;
    const reordered = workflowSnapshotSchema.parse(reverseKeys(snapshot));
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(snapshot));
    expect(workflowSnapshotHash(reordered)).toBe(hash);
  });

  it('determinístico: ordem de inserção diferente → mesmo hash', () => {
    const definition = validFourStageWorkflow().build();
    const shuffled = {
      stages: [...definition.stages].reverse(),
      transitions: [...definition.transitions].reverse(),
      rules: [...definition.rules].reverse(),
    };
    expect(workflowSnapshotHash(buildWorkflowSnapshot(shuffled))).toBe(
      workflowSnapshotHash(buildWorkflowSnapshot(definition)),
    );
  });

  it('qualquer mudança de conteúdo muda o hash', () => {
    const definition = validFourStageWorkflow().build();
    const renamed = {
      ...definition,
      stages: definition.stages.map((stage, index) =>
        index === 0 ? { ...stage, name: 'Abertura da demanda' } : stage,
      ),
    };
    expect(workflowSnapshotHash(buildWorkflowSnapshot(renamed))).not.toBe(
      workflowSnapshotHash(buildWorkflowSnapshot(definition)),
    );
  });
});

describe('cloneDefinition (RN-WF-22)', () => {
  it('ids novos, referências remapeadas para a própria versão e snapshot sem ids idêntico', () => {
    const source = validFourStageWorkflow(new DefinitionBuilder()).build();
    let next = 0;
    const clone = cloneDefinition(source, {
      workflowVersionId: NEW_VERSION,
      now: NOW,
      userId: null,
      newId: () => `0192c000-0000-7000-8000-${String((next += 1)).padStart(12, '0')}`,
    });

    expect(clone.stages).toHaveLength(4);
    expect(clone.transitions).toHaveLength(6);
    expect(clone.rules).toHaveLength(3);
    const sourceIds = new Set([
      ...source.stages.map((s) => s.id),
      ...source.transitions.map((t) => t.id),
      ...source.rules.map((r) => r.id),
    ]);
    const cloneIds = [
      ...clone.stages.map((s) => s.id),
      ...clone.transitions.map((t) => t.id),
      ...clone.rules.map((r) => r.id),
    ];
    expect(cloneIds.some((id) => sourceIds.has(id))).toBe(false);

    const stageIds = new Set(clone.stages.map((s) => s.id));
    const transitionIds = new Set(clone.transitions.map((t) => t.id));
    expect(stageIds.has(clone.initialStageId ?? '')).toBe(true);
    for (const transition of clone.transitions) {
      expect(stageIds.has(transition.fromStageId) && stageIds.has(transition.toStageId)).toBe(true);
    }
    for (const rule of clone.rules) {
      expect(rule.stageId === null || stageIds.has(rule.stageId)).toBe(true);
      expect(rule.transitionId === null || transitionIds.has(rule.transitionId)).toBe(true);
    }
    expect(
      [...clone.stages, ...clone.transitions, ...clone.rules].every(
        (row) => row.workflowVersionId === NEW_VERSION && row.version === 1,
      ),
    ).toBe(true);

    const original = buildWorkflowSnapshot(source);
    const copied = buildWorkflowSnapshot(clone);
    expect(workflowSnapshotHash(copied)).not.toBe(workflowSnapshotHash(original));
    expect(snapshotWithoutIds(copied)).toEqual(snapshotWithoutIds(original));
  });

  it('referência fora da versão de origem é erro de programação', () => {
    const source = validFourStageWorkflow().build();
    const broken = {
      ...source,
      transitions: source.transitions
        .slice(0, 1)
        .map((transition) => ({ ...transition, toStageId: NEW_VERSION })),
    };
    expect(() =>
      cloneDefinition(broken, {
        workflowVersionId: NEW_VERSION,
        now: NOW,
        userId: null,
        newId: () => NEW_VERSION,
      }),
    ).toThrow(/fora da versão de origem/);
  });
});
