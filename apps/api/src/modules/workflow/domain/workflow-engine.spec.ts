import type { ActionEntry, ProcessStatus } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  activePassOf,
  availableActions,
  checklistOf,
  evaluateStage,
  isCustodian,
  NOT_CUSTODIAN_MESSAGE,
} from './workflow-engine.js';
import {
  DEPARTMENTS,
  ETP_MESSAGE,
  RISK_MAP_MESSAGE,
  dec015Workflow,
  engineInput,
  engineProcess,
  etp,
  pass,
  passesUntilStudies,
  ruleContext,
  snapshotOf,
  viewer,
  VIEWER_ID,
} from '../../../../test/support/workflow-engine-fixtures.js';
import { DefinitionBuilder } from '../../../../test/support/workflow-fixtures.js';

/*
 * US-041 — `WorkflowEngine` puro (RN-WF-23..25, 32, 33 · FA-01..05) sobre o workflow padrão da
 * DEC-015: o processo 0012/2026 em ESTUDOS_PRELIMINARES com "ETP completo" (BLOCKING) e
 * "Mapa de riscos" (WARNING).
 */

const actionsOf = (entries: readonly ActionEntry[], action: ActionEntry['action']) =>
  entries.filter((entry) => entry.action === action);

describe('Feature: Motor de execução — ações disponíveis e avaliação de regras (domínio)', () => {
  const builder = dec015Workflow();
  const studies = passesUntilStudies(builder);

  it('[Sucesso] ETP completo → FORWARD habilitado e o aviso "Mapa de riscos" só no checklist', () => {
    const input = engineInput(builder, { passes: studies, documents: [etp('DRAFT', true)] });
    const evaluation = evaluateStage(input);
    const actions = availableActions(input, viewer(), evaluation);

    const [forward] = actionsOf(actions, 'FORWARD');
    expect(forward).toMatchObject({
      action: 'FORWARD',
      transitionKey: 'ESTUDOS_PRELIMINARES_FORWARD_PESQUISA_PRECOS',
      toStageKey: 'PESQUISA_PRECOS',
      label: 'Encaminhar para pesquisa de preços',
      enabled: true,
      primary: true,
      reasons: [],
      requiresComment: false,
      allowDueDateOverride: true,
      departmentResolution: { mode: 'FIXED', departmentId: DEPARTMENTS.compras },
    });
    // RN-WF-25: o aviso nunca desabilita a ação.
    expect(checklistOf(evaluation)).toEqual([
      expect.objectContaining({
        code: 'WORKFLOW_RULE',
        severity: 'WARNING',
        message: RISK_MAP_MESSAGE,
        name: 'Mapa de riscos',
        type: 'REQUIRED_DOCUMENT',
        scope: 'STAGE_EXIT',
        satisfied: false,
        params: { documentTypeCode: 'RISK_MAP', minStatus: 'EXISTS' },
      }),
    ]);
  });

  it('RN-WF-24: ETP incompleto → FORWARD desabilitado com a mensagem da regra; checklist com a bloqueante antes do aviso', () => {
    const input = engineInput(builder, { passes: studies, documents: [etp('DRAFT', false)] });
    const evaluation = evaluateStage(input);
    const [forward] = actionsOf(availableActions(input, viewer(), evaluation), 'FORWARD');
    expect(forward?.enabled).toBe(false);
    expect(forward?.reasons).toEqual([
      { code: 'TRANSITION_BLOCKED', message: ETP_MESSAGE, ruleId: expect.any(String) as unknown },
    ]);
    expect(checklistOf(evaluation).map((item) => [item.severity, item.message])).toEqual([
      ['BLOCKING', ETP_MESSAGE],
      ['WARNING', RISK_MAP_MESSAGE],
    ]);
  });

  it('regra TRANSITION só afeta a própria transição; regra inativa é ignorada', () => {
    const custom = new DefinitionBuilder()
      .stage('INICIO', 'START')
      .stage('A', 'TASK')
      .stage('B', 'TASK')
      .stage('FIM', 'END')
      .transition('INICIO', 'A', 'FORWARD', { isPrimary: true })
      .transition('A', 'B', 'FORWARD', { isPrimary: true, displayOrder: 1 })
      .transition('A', 'FIM', 'COMPLETE', { displayOrder: 0 })
      .rule(
        'REQUIRED_FIELD',
        { field: 'process.modalityCode' },
        { transition: 'A_COMPLETE_FIM' },
        { message: 'Informe a modalidade.' },
      )
      .rule(
        'REQUIRED_DOCUMENT',
        { documentTypeCode: 'TR', minStatus: 'APPROVED' },
        { stage: 'A' },
        { isActive: false },
      );
    const input = engineInput(
      custom,
      {
        passes: [
          pass(custom, 'INICIO', 1),
          pass(custom, 'A', 2, { status: 'ACTIVE', exitedAt: null }),
        ],
        context: ruleContext('A', {
          process: { ...ruleContext('A').process, modalityCode: null },
        }),
      },
      { currentDepartmentId: DEPARTMENTS.planejamento },
    );
    const evaluation = evaluateStage(input);
    const actions = availableActions(input, viewer(), evaluation);
    expect(
      actions.slice(0, 2).map((entry) => [entry.action, entry.toStageKey, entry.enabled]),
    ).toEqual([
      ['FORWARD', 'B', true],
      ['COMPLETE', 'FIM', false],
    ]);
    expect(checklistOf(evaluation)).toEqual([
      expect.objectContaining({
        scope: 'TRANSITION',
        transitionKey: 'A_COMPLETE_FIM',
        field: 'process.modalityCode',
        params: {},
      }),
    ]);
  });

  it('FA-01: etapa END → só ações de ciclo de vida', () => {
    const passes = [
      ...studies.map((item) => ({ ...item, status: 'COMPLETED' as const })),
      pass(builder, 'CONCLUSAO', 9, { status: 'ACTIVE', exitedAt: null }),
    ];
    const input = engineInput(builder, { passes }, { status: 'COMPLETED' });
    const actions = availableActions(input, viewer());
    expect(actions.map((entry) => entry.action)).toEqual(['CLAIM', 'ASSIGN', 'SUSPEND', 'CANCEL']);
    expect(actions.every((entry) => !entry.enabled)).toBe(true);
    expect(checklistOf(evaluateStage(input))).toEqual([]);
  });

  it('FA-02: primeira etapa → sem RETURN', () => {
    const input = engineInput(
      builder,
      { passes: [pass(builder, 'ABERTURA', 1, { status: 'ACTIVE', exitedAt: null })] },
      { status: 'DRAFT' },
    );
    const actions = availableActions(input, viewer());
    expect(actionsOf(actions, 'RETURN')).toEqual([]);
    expect(actionsOf(actions, 'FORWARD')).toHaveLength(1);
  });

  it('RN-WF-23: RETURN só para etapas percorridas e configuradas, uma por etapa distinta', () => {
    // Em TERMO_REFERENCIA, o destino de devolução configurado é PESQUISA_PRECOS (percorrida).
    const passes = [
      pass(builder, 'ABERTURA', 1),
      pass(builder, 'APROVACAO_DFD', 2),
      pass(builder, 'ESTUDOS_PRELIMINARES', 3),
      pass(builder, 'PESQUISA_PRECOS', 4),
      pass(builder, 'TERMO_REFERENCIA', 5, { status: 'RETURNED' }),
      pass(builder, 'PESQUISA_PRECOS', 6, { status: 'RETURNED' }),
      pass(builder, 'TERMO_REFERENCIA', 7, { status: 'ACTIVE', exitedAt: null }),
    ];
    const returns = actionsOf(
      availableActions(engineInput(builder, { passes }), viewer()),
      'RETURN',
    );
    expect(returns).toEqual([
      expect.objectContaining({
        toStageKey: 'PESQUISA_PRECOS',
        enabled: true,
        requiresComment: true,
        reasons: [],
      }),
    ]);

    // Em PESQUISA_PRECOS, sem ter percorrido... só os destinos percorridos aparecem.
    const early = [
      pass(builder, 'ABERTURA', 1),
      pass(builder, 'PESQUISA_PRECOS', 2, { status: 'ACTIVE', exitedAt: null }),
    ];
    expect(
      actionsOf(availableActions(engineInput(builder, { passes: early }), viewer()), 'RETURN').map(
        (entry) => entry.toStageKey,
      ),
    ).toEqual(['ABERTURA']);
  });

  it('FA-04: avisos nunca entram em reasons', () => {
    const input = engineInput(builder, { passes: studies, documents: [etp('FINALIZED', true)] });
    const actions = availableActions(input, viewer());
    expect(actions.flatMap((entry) => entry.reasons).map((reason) => reason.message)).not.toContain(
      RISK_MAP_MESSAGE,
    );
  });

  it('FA-05: quem não é o responsável atual vê as ações desabilitadas com o motivo', () => {
    const input = engineInput(
      builder,
      { passes: studies, documents: [etp('FINALIZED', true)] },
      { currentResponsibleId: 'outra-pessoa' },
    );
    const actions = availableActions(input, viewer());
    const [forward] = actionsOf(actions, 'FORWARD');
    expect(forward).toMatchObject({
      enabled: false,
      reasons: [{ code: 'NOT_PROCESS_CUSTODIAN', message: NOT_CUSTODIAN_MESSAGE }],
    });
    expect(actionsOf(actions, 'CLAIM')[0]).toMatchObject({
      enabled: false,
      reasons: [{ code: 'PROCESS_ALREADY_ASSIGNED', message: 'O processo já tem um responsável.' }],
    });
  });

  it('permissão ausente em todos os escopos omite a ação (permissions.md §9)', () => {
    const input = engineInput(builder, { passes: studies });
    const reader = viewer({ permissions: new Set(), canAssignAnywhere: false });
    expect(availableActions(input, reader)).toEqual([]);
    // Chefia da unidade (titular/substituto) atribui sem PROCESS_ASSIGN.
    const head = viewer({
      permissions: new Set(),
      canAssignAnywhere: false,
      headOfDepartmentIds: [DEPARTMENTS.planejamento],
    });
    expect(availableActions(input, head)).toEqual([
      { action: 'ASSIGN', label: 'Atribuir responsável', enabled: true, reasons: [] },
    ]);
  });

  describe('RN-WF-32: ciclo de vida pelo status (DEC-013) e pela titularidade', () => {
    const lifecycle = (status: ProcessStatus, overrides = {}) =>
      Object.fromEntries(
        availableActions(
          engineInput(
            builder,
            { passes: studies, documents: [etp('FINALIZED', true)] },
            {
              status,
              ...overrides,
            },
          ),
          viewer(),
        )
          .filter((entry) => !['FORWARD', 'RETURN', 'COMPLETE'].includes(entry.action))
          .map((entry) => [entry.action, entry.enabled]),
      );

    it.each([
      ['DRAFT', { CLAIM: true, ASSIGN: true, SUSPEND: false, CANCEL: true }],
      ['IN_PROGRESS', { CLAIM: true, ASSIGN: true, SUSPEND: true, CANCEL: true }],
      ['AWAITING_APPROVAL', { CLAIM: false, ASSIGN: false, SUSPEND: true, CANCEL: true }],
      ['RETURNED', { CLAIM: true, ASSIGN: true, SUSPEND: true, CANCEL: true }],
      ['SUSPENDED', { CLAIM: false, ASSIGN: false, RESUME: true, CANCEL: true }],
      ['CANCELED', { CLAIM: false, ASSIGN: false, SUSPEND: false, CANCEL: false }],
      ['COMPLETED', { CLAIM: false, ASSIGN: false, SUSPEND: false, CANCEL: false }],
      ['PUBLISHED', { CLAIM: false, ASSIGN: false, SUSPEND: false, CANCEL: false }],
    ] as const)('%s → %j', (status, expected) => {
      expect(lifecycle(status)).toEqual(expected);
    });

    it('status inválido explica em pt-BR; avanço em processo suspenso fica desabilitado', () => {
      const input = engineInput(
        builder,
        { passes: studies, documents: [etp('FINALIZED', true)] },
        { status: 'SUSPENDED' },
      );
      const [forward] = actionsOf(availableActions(input, viewer()), 'FORWARD');
      expect(forward?.reasons).toEqual([
        {
          code: 'INVALID_PROCESS_STATUS',
          message: 'Ação indisponível: o processo está suspenso.',
        },
      ]);
    });

    it('CLAIM: já responsável, fora da lotação e processo na fila', () => {
      const own = availableActions(
        engineInput(builder, { passes: studies }, { currentResponsibleId: VIEWER_ID }),
        viewer(),
      );
      expect(actionsOf(own, 'CLAIM')[0]?.reasons).toEqual([
        { code: 'PROCESS_ALREADY_ASSIGNED', message: 'Você já é o responsável pelo processo.' },
      ]);
      const outsider = availableActions(
        engineInput(builder, { passes: studies }),
        viewer({ departmentIds: [DEPARTMENTS.compras] }),
      );
      expect(actionsOf(outsider, 'CLAIM')[0]?.reasons[0]?.code).toBe('NOT_PROCESS_CUSTODIAN');
      expect(actionsOf(outsider, 'FORWARD')[0]?.reasons[0]?.code).toBe('NOT_PROCESS_CUSTODIAN');
    });

    it('ASSIGN sem escopo amplo nem chefia da unidade atual = PERMISSION_DENIED', () => {
      const actions = availableActions(
        engineInput(builder, { passes: studies }),
        viewer({ canAssignAnywhere: false, headOfDepartmentIds: [DEPARTMENTS.compras] }),
      );
      expect(actionsOf(actions, 'ASSIGN')[0]?.reasons[0]?.code).toBe('PERMISSION_DENIED');
    });
  });

  it('ordem: avanços (principal primeiro), devoluções e ciclo de vida', () => {
    const input = engineInput(builder, { passes: studies, documents: [etp('FINALIZED', true)] });
    expect(availableActions(input, viewer()).map((entry) => entry.action)).toEqual([
      'FORWARD',
      'RETURN',
      'CLAIM',
      'ASSIGN',
      'SUSPEND',
      'CANCEL',
    ]);
  });

  it('RN-WF-33: etapa ativa fora da versão fixada → nenhuma ação de avanço nem pendência', () => {
    const input = engineInput(builder, {
      passes: [
        pass(builder, 'ABERTURA', 1, { status: 'ACTIVE', workflowStageId: 'de-outra-versao' }),
      ],
    });
    const evaluation = evaluateStage(input);
    expect(evaluation.stage).toBeNull();
    expect(checklistOf(evaluation)).toEqual([]);
    expect(
      availableActions(input, viewer(), evaluation).filter((entry) =>
        ['FORWARD', 'COMPLETE', 'RETURN'].includes(entry.action),
      ),
    ).toEqual([]);
  });

  it('activePassOf e isCustodian', () => {
    expect(activePassOf([])).toBeNull();
    const passes = [
      pass(builder, 'ABERTURA', 1, { status: 'ACTIVE' }),
      pass(builder, 'APROVACAO_DFD', 2, { status: 'ACTIVE' }),
    ];
    expect(activePassOf(passes)?.sequence).toBe(2);
    expect(isCustodian(engineProcess({ currentResponsibleId: VIEWER_ID }), viewer())).toBe(true);
    expect(isCustodian(engineProcess(), viewer({ departmentIds: [] }))).toBe(false);
  });

  it('CONDITION com documents.<CÓDIGO> sem documento lê o estado "ausente"', () => {
    const custom = new DefinitionBuilder()
      .stage('INICIO', 'START')
      .stage('A', 'TASK')
      .stage('FIM', 'END')
      .transition('INICIO', 'A', 'FORWARD', { isPrimary: true })
      .transition('A', 'FIM', 'COMPLETE')
      .rule(
        'CONDITION',
        { expression: { '==': [{ var: 'documents.TR.exists' }, false] } },
        { stage: 'A' },
      )
      .rule(
        'REQUIRED_FIELD',
        { field: 'documents.TR.status' },
        { stage: 'A' },
        {
          severity: 'WARNING',
        },
      );
    const input = engineInput(custom, {
      passes: [pass(custom, 'A', 1, { status: 'ACTIVE' })],
      context: ruleContext('A'),
    });
    const evaluation = evaluateStage(input);
    expect(evaluation.results.map((result) => result.outcome)).toEqual([
      { satisfied: true },
      { satisfied: false },
    ]);
  });

  describe('desempates e entradas degeneradas', () => {
    it('ordena transições por principal, displayOrder e chave; regras por displayOrder e id', () => {
      const custom = new DefinitionBuilder()
        .stage('INICIO', 'START')
        .stage('A', 'TASK')
        .stage('B', 'TASK')
        .stage('C', 'TASK')
        .stage('FIM', 'END')
        .transition('INICIO', 'A', 'FORWARD', { isPrimary: true })
        .transition('A', 'C', 'FORWARD', { displayOrder: 1 })
        .transition('A', 'B', 'FORWARD', { displayOrder: 1 })
        .transition('A', 'FIM', 'COMPLETE', { displayOrder: 1, isPrimary: true })
        .rule(
          'REQUIRED_DOCUMENT',
          { documentTypeCode: 'TR', minStatus: 'FINAL', minCount: 2 },
          { stage: 'A' },
          { displayOrder: 3 },
        )
        .rule(
          'REQUIRED_DOCUMENT',
          { documentTypeCode: 'ETP', minStatus: 'EXISTS' },
          { stage: 'A' },
          { displayOrder: 3 },
        );
      const input = engineInput(custom, {
        passes: [pass(custom, 'A', 1, { status: 'ACTIVE', exitedAt: null })],
        context: ruleContext('A'),
      });
      const evaluation = evaluateStage(input);
      expect(evaluation.advances.map((transition) => transition.toStageKey)).toEqual([
        'FIM',
        'B',
        'C',
      ]);
      const ids = evaluation.results.map((result) => result.rule.id);
      expect(ids).toEqual([...ids].sort());
      expect(
        checklistOf(evaluation).find((item) => item.params.documentTypeCode === 'TR')?.params,
      ).toEqual({ documentTypeCode: 'TR', minStatus: 'FINAL', minCount: 2 });
    });

    it('processo sem passagem ativa: nada a avaliar, só o ciclo de vida', () => {
      const input = engineInput(builder, { passes: [pass(builder, 'ABERTURA', 1)] });
      const evaluation = evaluateStage(input);
      expect(evaluation).toMatchObject({ currentPass: null, stage: null, results: [] });
      expect(
        availableActions(input, viewer(), evaluation).every((entry) =>
          ['CLAIM', 'ASSIGN', 'SUSPEND', 'CANCEL'].includes(entry.action),
        ),
      ).toBe(true);
    });

    it('REQUIRED_APPROVAL de etapa inexistente na versão e destino ausente do snapshot não lançam', () => {
      const custom = new DefinitionBuilder()
        .stage('INICIO', 'START')
        .stage('A', 'TASK')
        .stage('FIM', 'END')
        .transition('A', 'FIM', 'COMPLETE', { isPrimary: true })
        .rule('REQUIRED_APPROVAL', { stageKey: 'NAO_EXISTE' }, { stage: 'A' });
      const definition = snapshotOf(custom);
      const input = {
        ...engineInput(custom, { passes: [pass(custom, 'A', 1, { status: 'ACTIVE' })] }),
        definition: {
          ...definition,
          stages: definition.stages.filter((stage) => stage.key !== 'FIM'),
        },
      };
      const [complete] = availableActions(input, viewer());
      expect(complete).toMatchObject({ action: 'COMPLETE', enabled: false });
      expect(complete?.departmentResolution).toBeUndefined();
    });
  });
});
