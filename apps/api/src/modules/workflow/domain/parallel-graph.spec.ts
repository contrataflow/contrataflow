import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { analyzeParallelStructure, parallelIssues, resolveBranchKeys } from './parallel-graph.js';
import type { ParallelGraph } from './parallel-graph.js';
import { WorkflowDefinitionValidator } from './workflow-definition.validator.js';
import { buildWorkflowSnapshot, workflowSnapshotHash } from './workflow-snapshot.js';
import {
  DefinitionBuilder,
  openReferences,
  parallelWorkflow,
  validFourStageWorkflow,
} from '../../../../test/support/workflow-fixtures.js';

/*
 * US-123 — modelo de etapas paralelas: estrutura de ramos, `branchKey` (RN-WF2-07) e um caso por
 * `reason` de `WF_PARALLEL_INVALID` (RN-WF2-02..06), mais o grafo-limite e a propriedade de
 * determinismo.
 */

const validator = new WorkflowDefinitionValidator();
const validate = (builder: DefinitionBuilder) =>
  validator.validate(builder.build(), openReferences());
const reasons = (builder: DefinitionBuilder) =>
  validate(builder)
    .errors.filter((error) => error.code === 'WF_PARALLEL_INVALID')
    .map((error) => error.reason);
const parallelError = (builder: DefinitionBuilder, reason: string) =>
  validate(builder).errors.find(
    (error) => error.code === 'WF_PARALLEL_INVALID' && error.reason === reason,
  );

describe('estrutura de ramos (US-123 · DEC-194)', () => {
  it('[Sucesso] bloco Jurídico + Controle Interno: válido, sem avisos de split/join', () => {
    const builder = parallelWorkflow();
    const result = validate(builder);
    expect(result).toEqual({ valid: true, errors: [], warnings: [] });

    const structure = analyzeParallelStructure(builder.build());
    expect(structure.issues).toEqual([]);
    expect(structure.blocks).toEqual([
      {
        splitStageKey: 'RAMIFICACAO_ANALISES',
        joinStageKey: 'JUNCAO_ANALISES',
        branches: [
          {
            branchKey: 'CONTROLE_INTERNO',
            entryStageKey: 'CONTROLE_INTERNO',
            stageKeys: ['CONTROLE_INTERNO'],
            exitTransitionKey: 'CONTROLE_INTERNO_FORWARD_JUNCAO_ANALISES',
          },
          {
            branchKey: 'JURIDICO',
            entryStageKey: 'JURIDICO',
            stageKeys: ['JURIDICO'],
            exitTransitionKey: 'JURIDICO_FORWARD_JUNCAO_ANALISES',
          },
        ],
        issues: [],
      },
    ]);
    expect(Object.fromEntries(structure.stageBranch)).toEqual({
      JURIDICO: 'JURIDICO',
      CONTROLE_INTERNO: 'CONTROLE_INTERNO',
    });
  });

  it.each([[3], [5]])('[Sucesso] %i ramos válidos', (count) => {
    const extra = Array.from({ length: count - 2 }, (_, index) => `RAMO_${String(index + 3)}`);
    const builder = parallelWorkflow(new DefinitionBuilder(), [
      'JURIDICO',
      'CONTROLE_INTERNO',
      ...extra,
    ]);
    expect(validate(builder).valid).toBe(true);
    expect(analyzeParallelStructure(builder.build()).blocks[0]?.branches).toHaveLength(count);
  });

  it('[FA-02/FA-03] ramo com TASK → APPROVAL, devolução no ramo e para antes do split', () => {
    const builder = parallelWorkflow()
      .stage('PARECER_APROVACAO', 'APPROVAL')
      .transition('JURIDICO', 'PARECER_APROVACAO', 'FORWARD');
    // Troca a saída do JURIDICO: agora passa pela aprovação antes da junção.
    builder.transitions.splice(
      builder.transitions.findIndex((t) => t.key === 'JURIDICO_FORWARD_JUNCAO_ANALISES'),
      1,
    );
    builder
      .transition('PARECER_APROVACAO', 'JUNCAO_ANALISES', 'APPROVE')
      .transition('PARECER_APROVACAO', 'JURIDICO', 'RETURN')
      .transition('PARECER_APROVACAO', 'JURIDICO', 'REJECT')
      .transition('CONTROLE_INTERNO', 'ESTUDOS_PRELIMINARES', 'RETURN');
    expect(validate(builder)).toMatchObject({ valid: true, errors: [] });
    const keys = resolveBranchKeys(builder.build());
    expect(keys.get(builder.stageId('PARECER_APROVACAO'))).toBe('JURIDICO');
    expect(keys.get(builder.stageId('JURIDICO'))).toBe('JURIDICO');
    expect(keys.get(builder.stageId('CONTROLE_INTERNO'))).toBe('CONTROLE_INTERNO');
    expect(keys.get(builder.stageId('RAMIFICACAO_ANALISES'))).toBeNull();
    expect(keys.get(builder.stageId('JUNCAO_ANALISES'))).toBeNull();
    expect(keys.get(builder.stageId('ESTUDOS_PRELIMINARES'))).toBeNull();
  });

  it('versão sem bloco: estrutura vazia e nenhum branchKey', () => {
    const builder = validFourStageWorkflow();
    const structure = analyzeParallelStructure(builder.build());
    expect(structure).toEqual({ blocks: [], issues: [], stageBranch: new Map() });
  });
});

describe('WF_PARALLEL_INVALID — um caso por reason (RN-WF2-02..06)', () => {
  it('SPLIT_BRANCHES_MIN e SPLIT_JOIN_MISSING: um único ramo e nenhuma junção', () => {
    const builder = new DefinitionBuilder()
      .stage('ABERTURA', 'START')
      .stage('ESTUDOS_PRELIMINARES', 'TASK')
      .stage('RAMIFICACAO_ANALISES', 'PARALLEL_SPLIT')
      .stage('JURIDICO', 'TASK')
      .stage('FIM', 'END')
      .transition('ABERTURA', 'ESTUDOS_PRELIMINARES', 'FORWARD')
      .transition('ESTUDOS_PRELIMINARES', 'RAMIFICACAO_ANALISES', 'FORWARD')
      .transition('RAMIFICACAO_ANALISES', 'JURIDICO', 'FORWARD');
    const result = validate(builder);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'WF_PARALLEL_INVALID',
          reason: 'SPLIT_BRANCHES_MIN',
          stageKey: 'RAMIFICACAO_ANALISES',
          message:
            'A ramificação "Etapa RAMIFICACAO_ANALISES" precisa de pelo menos dois ramos. Adicione outro caminho.',
        }),
        expect.objectContaining({
          code: 'WF_PARALLEL_INVALID',
          reason: 'SPLIT_JOIN_MISSING',
          stageKey: 'RAMIFICACAO_ANALISES',
        }),
      ]),
    );
  });

  it('JOIN_NOT_COMMON: cada ramo termina numa junção diferente', () => {
    const builder = parallelWorkflow().stage('JUNCAO_B', 'PARALLEL_JOIN');
    const exit = builder.transitions.findIndex(
      (t) => t.key === 'CONTROLE_INTERNO_FORWARD_JUNCAO_ANALISES',
    );
    builder.transitions.splice(exit, 1);
    builder
      .transition('CONTROLE_INTERNO', 'JUNCAO_B', 'FORWARD')
      .transition('JUNCAO_B', 'AUTORIZACAO_LICITACAO', 'FORWARD');
    expect(parallelError(builder, 'JOIN_NOT_COMMON')).toMatchObject({
      stageKey: 'RAMIFICACAO_ANALISES',
      message:
        'A ramificação "Etapa RAMIFICACAO_ANALISES" precisa terminar em uma única junção comum aos ramos.',
    });
  });

  it('JOIN_WITHOUT_SPLIT: junção solta no tronco', () => {
    const builder = validFourStageWorkflow().stage('JUNCAO_SOLTA', 'PARALLEL_JOIN');
    builder
      .transition('ANALISE', 'JUNCAO_SOLTA', 'FORWARD')
      .transition('JUNCAO_SOLTA', 'APROVACAO', 'FORWARD');
    expect(parallelError(builder, 'JOIN_WITHOUT_SPLIT')).toMatchObject({
      stageKey: 'JUNCAO_SOLTA',
      transitionKey: null,
      message: 'A junção "Etapa JUNCAO_SOLTA" não está ligada a nenhuma ramificação.',
    });
    const structure = analyzeParallelStructure(builder.build());
    expect(structure.blocks).toEqual([]);
    expect(structure.issues.map((issue) => issue.reason)).toEqual(['JOIN_WITHOUT_SPLIT']);
  });

  it('JOIN_WITHOUT_SPLIT: transição do tronco direto para a junção de um bloco', () => {
    const builder = parallelWorkflow().transition(
      'ESTUDOS_PRELIMINARES',
      'JUNCAO_ANALISES',
      'FORWARD',
    );
    expect(parallelError(builder, 'JOIN_WITHOUT_SPLIT')).toMatchObject({
      stageKey: 'JUNCAO_ANALISES',
      transitionKey: 'ESTUDOS_PRELIMINARES_FORWARD_JUNCAO_ANALISES',
    });
  });

  it('NESTED_SPLIT: ramificação dentro de um ramo', () => {
    const builder = parallelWorkflow()
      .stage('RAMIFICACAO_INTERNA', 'PARALLEL_SPLIT')
      .transition('JURIDICO', 'RAMIFICACAO_INTERNA', 'FORWARD');
    expect(parallelError(builder, 'NESTED_SPLIT')).toMatchObject({
      stageKey: 'RAMIFICACAO_INTERNA',
      transitionKey: 'JURIDICO_FORWARD_RAMIFICACAO_INTERNA',
      message: 'Não é possível ramificar dentro de um ramo. Use apenas um nível de ramificação.',
    });
  });

  it('CROSS_BRANCH_TRANSITION: avanço de um ramo para outro', () => {
    const builder = parallelWorkflow().transition('CONTROLE_INTERNO', 'JURIDICO', 'FORWARD');
    expect(parallelError(builder, 'CROSS_BRANCH_TRANSITION')).toMatchObject({
      stageKey: 'CONTROLE_INTERNO',
      transitionKey: 'CONTROLE_INTERNO_FORWARD_JURIDICO',
      message:
        'A transição "FORWARD CONTROLE_INTERNO → JURIDICO" liga dois ramos diferentes. Os ramos só se encontram na junção.',
    });
  });

  it('CROSS_BRANCH_TRANSITION: entrada no ramo por fora da ramificação', () => {
    const builder = parallelWorkflow().transition('ESTUDOS_PRELIMINARES', 'JURIDICO', 'FORWARD');
    expect(parallelError(builder, 'CROSS_BRANCH_TRANSITION')).toMatchObject({
      stageKey: 'ESTUDOS_PRELIMINARES',
      transitionKey: 'ESTUDOS_PRELIMINARES_FORWARD_JURIDICO',
    });
  });

  it('BRANCH_EMPTY: ramificação ligada direto à junção', () => {
    const builder = parallelWorkflow().transition(
      'RAMIFICACAO_ANALISES',
      'JUNCAO_ANALISES',
      'FORWARD',
    );
    expect(parallelError(builder, 'BRANCH_EMPTY')).toMatchObject({
      stageKey: 'RAMIFICACAO_ANALISES',
      transitionKey: 'RAMIFICACAO_ANALISES_FORWARD_JUNCAO_ANALISES',
      message:
        'O ramo "FORWARD RAMIFICACAO_ANALISES → JUNCAO_ANALISES" não tem nenhuma etapa. Adicione uma etapa ou remova o ramo.',
    });
  });

  it('BRANCH_ESCAPES: ramo que conclui o processo sem passar pela junção', () => {
    const builder = parallelWorkflow().transition('CONTROLE_INTERNO', 'FIM', 'COMPLETE');
    expect(parallelError(builder, 'BRANCH_ESCAPES')).toMatchObject({
      stageKey: 'CONTROLE_INTERNO',
      transitionKey: 'CONTROLE_INTERNO_COMPLETE_FIM',
    });
  });

  it('BRANCH_ESCAPES: ramo que avança de volta para antes da ramificação', () => {
    const builder = parallelWorkflow().transition('JURIDICO', 'ESTUDOS_PRELIMINARES', 'FORWARD');
    expect(parallelError(builder, 'BRANCH_ESCAPES')).toMatchObject({
      stageKey: 'JURIDICO',
      transitionKey: 'JURIDICO_FORWARD_ESTUDOS_PRELIMINARES',
    });
  });

  it('JOIN_EXIT_INVALID: junção com duas saídas', () => {
    const builder = parallelWorkflow().transition(
      'JUNCAO_ANALISES',
      'ESTUDOS_PRELIMINARES',
      'FORWARD',
    );
    expect(parallelError(builder, 'JOIN_EXIT_INVALID')).toMatchObject({
      stageKey: 'JUNCAO_ANALISES',
      message: 'A junção "Etapa JUNCAO_ANALISES" precisa de uma única saída para a etapa seguinte.',
    });
  });

  it('JOIN_EXIT_INVALID: junção sem saída', () => {
    const builder = parallelWorkflow();
    builder.transitions.splice(
      builder.transitions.findIndex(
        (t) => t.key === 'JUNCAO_ANALISES_FORWARD_AUTORIZACAO_LICITACAO',
      ),
      1,
    );
    expect(reasons(builder)).toContain('JOIN_EXIT_INVALID');
  });

  it('RETURN_TARGET_INVALID: devolução de fora do bloco para dentro de um ramo e entre ramos', () => {
    const builder = parallelWorkflow()
      .transition('AUTORIZACAO_LICITACAO', 'JURIDICO', 'RETURN')
      .transition('CONTROLE_INTERNO', 'JURIDICO', 'RETURN');
    const errors = validate(builder).errors.filter((e) => e.reason === 'RETURN_TARGET_INVALID');
    expect(errors.map((error) => error.transitionKey)).toEqual([
      'AUTORIZACAO_LICITACAO_RETURN_JURIDICO',
      'CONTROLE_INTERNO_RETURN_JURIDICO',
    ]);
    expect(errors[0]?.message).toBe(
      'A devolução "RETURN AUTORIZACAO_LICITACAO → JURIDICO" não pode entrar no meio de um ramo.',
    );
  });

  it('[Validação] todos os erros de uma vez: split aninhado e transição entre ramos', () => {
    const builder = parallelWorkflow()
      .stage('RAMIFICACAO_INTERNA', 'PARALLEL_SPLIT')
      .transition('JURIDICO', 'RAMIFICACAO_INTERNA', 'FORWARD')
      .transition('CONTROLE_INTERNO', 'JURIDICO', 'FORWARD');
    expect(reasons(builder)).toEqual(
      expect.arrayContaining(['NESTED_SPLIT', 'CROSS_BRANCH_TRANSITION']),
    );
  });

  it('V-12: regra STAGE_EXIT na ramificação é recusada; na junção é aceita (RN-WF2-08)', () => {
    const condition = { expression: { '>': [{ var: 'process.estimatedValue' }, 0] } };
    const onSplit = parallelWorkflow().rule('CONDITION', condition, {
      stage: 'RAMIFICACAO_ANALISES',
    });
    expect(validate(onSplit).errors).toEqual([
      expect.objectContaining({ code: 'WF_RULE_SCOPE_INVALID' }),
    ]);
    const onJoin = parallelWorkflow().rule('CONDITION', condition, { stage: 'JUNCAO_ANALISES' });
    expect(validate(onJoin).valid).toBe(true);
  });
});

describe('grafo-limite e propriedades', () => {
  it('versão de 50 etapas com 5 ramos é válida', () => {
    const branches = ['RAMO_A', 'RAMO_B', 'RAMO_C', 'RAMO_D', 'RAMO_E'];
    const builder = parallelWorkflow(new DefinitionBuilder(), branches);
    // 6 do tronco + 5 entradas = 11; mais 39 etapas encadeadas nos ramos = 50.
    let added = 0;
    for (let index = 0; added < 39; index += 1) {
      const branch = branches[index % branches.length] ?? '';
      const exit = builder.transitions.findIndex(
        (t) => t.toStageId === builder.stageId('JUNCAO_ANALISES') && t.key.startsWith(branch),
      );
      const last = builder.transitions[exit];
      if (!last) throw new Error('saída do ramo ausente');
      const key = `${branch}_${String(index)}`;
      builder.stage(key, 'TASK');
      builder.transitions.splice(exit, 1);
      const from = builder.stages.find((stage) => stage.id === last.fromStageId)?.key ?? '';
      builder
        .transition(from, key, 'FORWARD')
        .transition(key, 'JUNCAO_ANALISES', 'FORWARD', { key: `${branch}_EXIT_${String(index)}` });
      added += 1;
    }
    expect(builder.stages).toHaveLength(50);
    const result = validate(builder);
    expect(result).toMatchObject({ valid: true, errors: [] });
    const structure = analyzeParallelStructure(builder.build());
    expect(structure.blocks[0]?.branches.map((branch) => branch.stageKeys.length)).toEqual([
      9, 9, 9, 9, 8,
    ]);
  });

  /** Grafo aleatório de até 15 etapas e 40 transições com todos os tipos e ações. */
  const graphArbitrary = fc
    .record({
      types: fc.array(
        fc.constantFrom(
          'START' as const,
          'TASK' as const,
          'APPROVAL' as const,
          'END' as const,
          'PARALLEL_SPLIT' as const,
          'PARALLEL_JOIN' as const,
        ),
        { minLength: 1, maxLength: 15 },
      ),
      edges: fc.array(
        fc.tuple(
          fc.nat(),
          fc.nat(),
          fc.constantFrom(
            'FORWARD' as const,
            'APPROVE' as const,
            'COMPLETE' as const,
            'RETURN' as const,
            'REJECT' as const,
          ),
        ),
        { maxLength: 40 },
      ),
    })
    .map(({ types, edges }): ParallelGraph => {
      const stages = types.map((type, index) => ({
        id: `s${String(index)}`,
        key: `S${String(index).padStart(2, '0')}`,
        name: `Etapa ${String(index)}`,
        type,
      }));
      const transitions = edges.map(([from, to, action], index) => ({
        key: `T${String(index).padStart(2, '0')}`,
        name: `Transição ${String(index)}`,
        fromStageId: `s${String(from % stages.length)}`,
        toStageId: `s${String(to % stages.length)}`,
        action,
      }));
      return { stages, transitions };
    });

  it('determinística e independente da ordem de entrada; nunca lança', () => {
    fc.assert(
      fc.property(graphArbitrary, (graph) => {
        const first = analyzeParallelStructure(graph);
        const shuffled = analyzeParallelStructure({
          stages: [...graph.stages].reverse(),
          transitions: [...graph.transitions].reverse(),
        });
        expect(shuffled.blocks).toEqual(first.blocks);
        expect(shuffled.issues).toEqual(first.issues);
        expect(shuffled.stageBranch).toEqual(first.stageBranch);
        // Só TASK/APPROVAL pertencem a ramos; cada etapa tem no máximo um ramo.
        const typeOf = new Map(graph.stages.map((stage) => [stage.key, stage.type]));
        for (const key of first.stageBranch.keys()) {
          expect(['TASK', 'APPROVAL']).toContain(typeOf.get(key));
        }
        // Grafo sem split nem join não tem problema de paralelismo.
        const usesParallel = graph.stages.some(
          (stage) => stage.type === 'PARALLEL_SPLIT' || stage.type === 'PARALLEL_JOIN',
        );
        if (!usesParallel) expect(parallelIssues(first)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});

describe('definitionHash (DEC-084) com branchKey', () => {
  it('regressão do MVP 1: versão sem bloco tem o mesmo snapshot com branchKey nulo ou ausente', () => {
    const definition = validFourStageWorkflow().build();
    const withNulls = {
      ...definition,
      stages: definition.stages.map((stage) => ({ ...stage, branchKey: null })),
    };
    const snapshot = buildWorkflowSnapshot(definition);
    expect(buildWorkflowSnapshot(withNulls)).toEqual(snapshot);
    expect(workflowSnapshotHash(buildWorkflowSnapshot(withNulls))).toBe(
      workflowSnapshotHash(snapshot),
    );
    expect(snapshot.stages.some((stage) => 'branchKey' in stage)).toBe(false);
  });

  it('o branchKey entra no snapshot e no hash das etapas de ramo', () => {
    const definition = parallelWorkflow().build();
    const keys = resolveBranchKeys(definition);
    const stages = definition.stages.map((stage) => ({
      ...stage,
      branchKey: keys.get(stage.id) ?? null,
    }));
    const snapshot = buildWorkflowSnapshot({ ...definition, stages });
    expect(snapshot.stages.find((stage) => stage.key === 'JURIDICO')?.branchKey).toBe('JURIDICO');
    expect(
      snapshot.stages.find((stage) => stage.key === 'RAMIFICACAO_ANALISES'),
    ).not.toHaveProperty('branchKey');
    expect(workflowSnapshotHash(snapshot)).not.toBe(
      workflowSnapshotHash(buildWorkflowSnapshot(definition)),
    );
  });
});
