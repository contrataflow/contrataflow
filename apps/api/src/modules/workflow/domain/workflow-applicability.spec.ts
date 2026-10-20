import { describe, expect, it } from 'vitest';

import {
  compareApplicability,
  evaluateApplicability,
  resolveApplicableWorkflow,
} from './workflow-applicability.js';
import type { ApplicabilityCandidate } from './workflow-applicability.js';
import { defaultIneligibility, markAsDefault, unmarkAsDefault } from './workflow-definition.js';
import type { Workflow } from './workflow-definition.js';

/* US-042 · RN-WF-39..41 — resolução da aplicabilidade e marcação do padrão (domínio puro). */

const T0 = new Date('2026-10-01T12:00:00Z');
const T1 = new Date('2026-10-02T12:00:00Z');
const DIRECT_RULE = { in: [{ var: 'process.modalityCode' }, ['DISPENSA', 'INEXIGIBILIDADE']] };

const candidate = (
  id: string,
  overrides: Partial<ApplicabilityCandidate> = {},
): ApplicabilityCandidate => ({
  id,
  isActive: true,
  isDefault: false,
  applicabilityRule: null,
  applicabilityPriority: 100,
  createdAt: T0,
  currentPublishedVersionId: `v-${id}`,
  ...overrides,
});

describe('evaluateApplicability (RN-WF-39 · DEC-016)', () => {
  it('regra nula casa sempre; JSON Logic sobre RuleContext.process', () => {
    expect(evaluateApplicability(null, {})).toEqual({ matches: true });
    expect(evaluateApplicability(DIRECT_RULE, { modalityCode: 'DISPENSA' })).toEqual({
      matches: true,
    });
    expect(evaluateApplicability(DIRECT_RULE, { modalityCode: 'PREGAO' })).toEqual({
      matches: false,
    });
    // FA-04: modalidade "A definir".
    expect(evaluateApplicability(DIRECT_RULE, { modalityCode: null })).toEqual({ matches: false });
    expect(
      evaluateApplicability(
        { '>=': [{ var: 'process.estimatedValue' }, 1000] },
        { estimatedValue: 1500 },
      ),
    ).toEqual({ matches: true });
  });

  it('fail-closed: caminho fora de process.*, operação proibida e erro de avaliação não casam', () => {
    expect(evaluateApplicability({ var: 'documents.DFD.exists' }, {})).toMatchObject({
      matches: false,
      problem: { kind: 'PATH_UNKNOWN' },
    });
    expect(evaluateApplicability({ log: 'x' }, {})).toMatchObject({
      matches: false,
      problem: { kind: 'OPERATOR_FORBIDDEN' },
    });
    expect(evaluateApplicability({ var: '' }, {})).toMatchObject({ matches: false });
    // `*` sem argumentos passa na whitelist, mas lança no json-logic-js.
    expect(evaluateApplicability({ '*': [] }, {})).toMatchObject({
      matches: false,
      problem: { kind: 'EVALUATION_FAILED' },
    });
  });
});

describe('resolveApplicableWorkflow (RN-WF-39 · FA-03 · FA-04)', () => {
  const standard = candidate('padrao', { isDefault: true });
  const direct = candidate('direta', { applicabilityPriority: 50, applicabilityRule: DIRECT_RULE });

  it('prioridade menor é avaliada primeiro; a direta vence para DISPENSA', () => {
    expect(resolveApplicableWorkflow([standard, direct], { modalityCode: 'DISPENSA' })).toEqual({
      workflow: direct,
      via: 'RULE',
      problems: [],
    });
  });

  it('sem regra que case, vale o primeiro sem regra (o padrão semeado)', () => {
    expect(resolveApplicableWorkflow([standard, direct], { modalityCode: 'PREGAO' })).toMatchObject(
      {
        workflow: standard,
        via: 'UNCONDITIONAL',
      },
    );
  });

  it('empate de prioridade: createdAt crescente, depois o id', () => {
    const older = candidate('b', { createdAt: T0 });
    const newer = candidate('a', { createdAt: T1 });
    expect(resolveApplicableWorkflow([newer, older], {}).workflow?.id).toBe('b');
    const twinA = candidate('a');
    const twinB = candidate('b');
    expect([twinB, twinA].sort(compareApplicability).map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('inativos e sem versão publicada não entram; sem correspondência usa o isDefault', () => {
    const onlyRules = candidate('regra', { applicabilityRule: DIRECT_RULE, isDefault: true });
    const inactive = candidate('inativo', { isActive: false, applicabilityPriority: 1 });
    const draft = candidate('rascunho', {
      currentPublishedVersionId: null,
      applicabilityPriority: 1,
    });
    expect(
      resolveApplicableWorkflow([inactive, draft, onlyRules], { modalityCode: 'PREGAO' }),
    ).toEqual({ workflow: onlyRules, via: 'DEFAULT', problems: [] });
  });

  it('sem nenhum aplicável nem padrão elegível → null (NO_APPLICABLE_WORKFLOW)', () => {
    const inactiveDefault = candidate('padrao', { isDefault: true, isActive: false });
    const direct2 = candidate('direta', { applicabilityRule: DIRECT_RULE });
    expect(resolveApplicableWorkflow([inactiveDefault, direct2], { modalityCode: null })).toEqual({
      workflow: null,
      via: null,
      problems: [],
    });
    expect(resolveApplicableWorkflow([], {})).toMatchObject({ workflow: null });
  });

  it('regra quebrada não casa e volta como problema; a resolução segue para o próximo', () => {
    const broken = candidate('quebrado', {
      applicabilityPriority: 10,
      applicabilityRule: { '*': [] },
    });
    const result = resolveApplicableWorkflow([broken, standard], {});
    expect(result.workflow).toBe(standard);
    expect(result.problems).toEqual([
      {
        workflowId: 'quebrado',
        problem: expect.objectContaining({ kind: 'EVALUATION_FAILED' }) as unknown,
      },
    ]);
  });
});

describe('markAsDefault / unmarkAsDefault (RN-WF-40/41)', () => {
  const workflow: Workflow = {
    id: 'w',
    tenantId: 't',
    key: 'PILOTO_OBRAS',
    name: 'Piloto de obras',
    description: null,
    isActive: true,
    isDefault: false,
    applicabilityRule: null,
    applicabilityPriority: 100,
    currentPublishedVersionId: 'v1',
    createdAt: T0,
    updatedAt: T0,
    createdById: null,
    updatedById: null,
    version: 3,
  };
  const change = { now: T1, userId: 'u' };

  it('marca e desmarca carimbando autor e data', () => {
    expect(markAsDefault(workflow, change)).toMatchObject({
      isDefault: true,
      updatedAt: T1,
      updatedById: 'u',
    });
    expect(unmarkAsDefault({ ...workflow, isDefault: true }, change)).toMatchObject({
      isDefault: false,
      updatedById: 'u',
    });
  });

  it('inativo ou sem versão publicada não pode ser o padrão', () => {
    expect(defaultIneligibility(workflow)).toBeNull();
    expect(defaultIneligibility({ ...workflow, isActive: false })).toBe('INACTIVE');
    expect(defaultIneligibility({ ...workflow, currentPublishedVersionId: null })).toBe(
      'NOT_PUBLISHED',
    );
    expect(() => markAsDefault({ ...workflow, currentPublishedVersionId: null }, change)).toThrow(
      /NOT_PUBLISHED/,
    );
  });
});
