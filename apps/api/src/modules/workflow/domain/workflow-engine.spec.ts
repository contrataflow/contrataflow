import type { ActionEntry, ProcessStatus } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  activePassOf,
  availableActions,
  checklistOf,
  evaluateStage,
  evaluateTransition,
  isCustodian,
  notCustodianMessage,
} from './workflow-engine.js';
import type { EngineProcess, EngineViewer } from './workflow-engine.js';
import {
  CREATOR_ID,
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
      reasons: [
        {
          code: 'NOT_PROCESS_CUSTODIAN',
          message: 'Somente quem está com o processo pode encaminhá-lo.',
        },
      ],
    });
    expect(notCustodianMessage('RETURN')).toBe('Somente quem está com o processo pode devolvê-lo.');
    expect(notCustodianMessage('COMPLETE')).toBe(
      'Somente quem está com o processo pode concluí-lo.',
    );
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
      ['DRAFT', { CLAIM: false, ASSIGN: true, SUSPEND: false, CANCEL: true }],
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

    it('US-009 · DISCARD: só rascunho sem número, para o criador com PROCESS_CREATE ou quem tem PROCESS_CANCEL', () => {
      const discard = (process: Partial<EngineProcess>, who: Partial<EngineViewer> = {}) =>
        actionsOf(
          availableActions(
            engineInput(builder, { passes: studies }, { status: 'DRAFT', ...process }),
            viewer(who),
          ),
          'DISCARD',
        );
      // Gestor com PROCESS_CANCEL (não é o criador): descarta o rascunho sem número.
      expect(discard({ numbered: false })).toEqual([
        { action: 'DISCARD', label: 'Descartar rascunho', enabled: true, reasons: [] },
      ]);
      // FA-01: rascunho numerado ou numeração desconhecida → só "Cancelar processo".
      expect(discard({ numbered: true })).toEqual([]);
      expect(discard({})).toEqual([]);
      expect(discard({ numbered: false, status: 'IN_PROGRESS' })).toEqual([]);
      // FA-05: o criador sem PROCESS_CANCEL vê "Descartar rascunho" (e não "Cancelar processo").
      const creatorOnly = { userId: CREATOR_ID, permissions: new Set(['PROCESS_CREATE'] as const) };
      expect(discard({ numbered: false }, creatorOnly)).toHaveLength(1);
      expect(
        actionsOf(
          availableActions(
            engineInput(builder, { passes: studies }, { status: 'DRAFT', numbered: false }),
            viewer(creatorOnly),
          ),
          'CANCEL',
        ),
      ).toEqual([]);
      // Sem PROCESS_CANCEL e sem ser o criador: omitida.
      expect(
        discard({ numbered: false }, { permissions: new Set(['PROCESS_CREATE'] as const) }),
      ).toEqual([]);
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

    it('CLAIM (RN-TRAM-32): etapa APPROVAL desabilita com INVALID_PROCESS_STATUS, mesmo na fila', () => {
      const approval = new DefinitionBuilder()
        .stage('INICIO', 'START')
        .stage('APROVACAO', 'APPROVAL')
        .stage('FIM', 'END')
        .transition('INICIO', 'APROVACAO', 'FORWARD', { isPrimary: true })
        .transition('APROVACAO', 'FIM', 'APPROVE');
      const actions = availableActions(
        engineInput(
          approval,
          {
            passes: [
              pass(approval, 'INICIO', 1),
              pass(approval, 'APROVACAO', 2, { status: 'ACTIVE', exitedAt: null }),
            ],
          },
          { currentDepartmentId: DEPARTMENTS.planejamento },
        ),
        viewer(),
      );
      expect(actionsOf(actions, 'CLAIM')[0]).toMatchObject({
        enabled: false,
        reasons: [
          {
            code: 'INVALID_PROCESS_STATUS',
            message: 'Este processo não pode ser assumido no momento.',
          },
        ],
      });
    });

    it('ASSIGN sem escopo amplo nem chefia da unidade atual = PERMISSION_DENIED', () => {
      const actions = availableActions(
        engineInput(builder, { passes: studies }),
        viewer({ canAssignAnywhere: false, headOfDepartmentIds: [DEPARTMENTS.compras] }),
      );
      expect(actionsOf(actions, 'ASSIGN')[0]?.reasons[0]?.code).toBe('PERMISSION_DENIED');
    });
  });

  describe('EDIT (US-005 · RN-PROC-59 · POL-01): "Editar dados"', () => {
    const edit = (process: Partial<EngineProcess>, who: Partial<EngineViewer> = {}) =>
      actionsOf(
        availableActions(
          engineInput(builder, { passes: studies }, process),
          viewer({ permissions: new Set(['PROCESS_UPDATE']), ...who }),
        ),
        'EDIT',
      );

    it('sem PROCESS_UPDATE: a ação não aparece', () => {
      expect(
        actionsOf(availableActions(engineInput(builder, { passes: studies }), viewer()), 'EDIT'),
      ).toEqual([]);
    });

    it.each(['DRAFT', 'IN_PROGRESS', 'RETURNED'] as const)(
      '%s com custódia: habilitada',
      (status) => {
        expect(edit({ status })).toEqual([
          { action: 'EDIT', label: 'Editar dados', enabled: true, reasons: [] },
        ]);
      },
    );

    it.each([
      ['AWAITING_APPROVAL', 'Não é possível editar enquanto o processo aguarda aprovação.'],
      ['SUSPENDED', 'Não é possível editar com o processo suspenso.'],
      ['COMPLETED', 'Não é possível editar com o processo concluído.'],
    ] as const)('%s: desabilitada com o motivo', (status, message) => {
      expect(edit({ status })[0]?.reasons).toEqual([{ code: 'INVALID_PROCESS_STATUS', message }]);
    });

    it('sem custódia (outro responsável ou fora da unidade da fila): NOT_PROCESS_CUSTODIAN', () => {
      expect(edit({ currentResponsibleId: CREATOR_ID })[0]?.reasons[0]?.code).toBe(
        'NOT_PROCESS_CUSTODIAN',
      );
      expect(edit({}, { departmentIds: [DEPARTMENTS.compras] })[0]?.reasons[0]?.code).toBe(
        'NOT_PROCESS_CUSTODIAN',
      );
      expect(edit({ currentResponsibleId: VIEWER_ID })[0]?.enabled).toBe(true);
    });
  });

  describe('MANAGE_ITEMS (US-006 · RN-PROC-71 · FA-07): "Gerenciar itens"', () => {
    const manage = (process: Partial<EngineProcess>, who: Partial<EngineViewer> = {}) =>
      actionsOf(
        availableActions(
          engineInput(builder, { passes: studies }, process),
          viewer({ permissions: new Set(['PROCESS_UPDATE']), ...who }),
        ),
        'MANAGE_ITEMS',
      );

    it('sem PROCESS_UPDATE (ex.: participante consultor): a ação não aparece — aba em modo leitura', () => {
      expect(
        actionsOf(
          availableActions(engineInput(builder, { passes: studies }), viewer()),
          'MANAGE_ITEMS',
        ),
      ).toEqual([]);
    });

    it('com custódia em status editável: habilitada', () => {
      expect(manage({ status: 'RETURNED' })).toEqual([
        { action: 'MANAGE_ITEMS', label: 'Gerenciar itens', enabled: true, reasons: [] },
      ]);
    });

    it.each([
      ['AWAITING_APPROVAL', 'Itens não podem ser alterados com o processo aguardando aprovação.'],
      ['CANCELED', 'Itens não podem ser alterados com o processo cancelado.'],
    ] as const)('%s: desabilitada com o motivo', (status, message) => {
      expect(manage({ status })[0]?.reasons).toEqual([{ code: 'INVALID_PROCESS_STATUS', message }]);
    });

    it('sem custódia: NOT_PROCESS_CUSTODIAN com a mensagem dos itens', () => {
      expect(manage({ currentResponsibleId: CREATOR_ID })[0]?.reasons).toEqual([
        {
          code: 'NOT_PROCESS_CUSTODIAN',
          message: 'Somente quem está com o processo pode alterar os itens.',
        },
      ]);
    });
  });

  describe('MANAGE_TAGS (US-007 · RN-PROC-87 · FA-04): "Etiquetas"', () => {
    const manage = (process: Partial<EngineProcess>, who: Partial<EngineViewer> = {}) =>
      actionsOf(
        availableActions(
          engineInput(builder, { passes: studies }, process),
          viewer({ permissions: new Set(['PROCESS_UPDATE']), ...who }),
        ),
        'MANAGE_TAGS',
      );

    it('sem PROCESS_UPDATE: a ação não aparece', () => {
      expect(
        actionsOf(
          availableActions(engineInput(builder, { passes: studies }), viewer()),
          'MANAGE_TAGS',
        ),
      ).toEqual([]);
    });

    it('com custódia em status editável: habilitada', () => {
      expect(manage({ status: 'RETURNED' })).toEqual([
        { action: 'MANAGE_TAGS', label: 'Etiquetas', enabled: true, reasons: [] },
      ]);
    });

    it.each([
      [
        'AWAITING_APPROVAL',
        'Etiquetas não podem ser alteradas com o processo aguardando aprovação.',
      ],
      ['CANCELED', 'Etiquetas não podem ser alteradas com o processo cancelado.'],
    ] as const)('%s: desabilitada com o motivo', (status, message) => {
      expect(manage({ status })[0]?.reasons).toEqual([{ code: 'INVALID_PROCESS_STATUS', message }]);
    });

    it('sem custódia: NOT_PROCESS_CUSTODIAN com a mensagem das etiquetas', () => {
      expect(manage({ currentResponsibleId: CREATOR_ID })[0]?.reasons).toEqual([
        {
          code: 'NOT_PROCESS_CUSTODIAN',
          message: 'Somente quem está com o processo pode alterar as etiquetas.',
        },
      ]);
    });
  });

  describe('DUPLICATE (US-011 · RN-PROC-124): "Duplicar processo"', () => {
    const duplicate = (process: Partial<EngineProcess>, permissions: string[]) =>
      actionsOf(
        availableActions(
          engineInput(builder, { passes: studies }, process),
          viewer({ permissions: new Set(permissions) as EngineViewer['permissions'] }),
        ),
        'DUPLICATE',
      );

    it.each([[[]], [['PROCESS_DUPLICATE']], [['PROCESS_CREATE']]])(
      'sem PROCESS_DUPLICATE e PROCESS_CREATE (%j): a ação não aparece',
      (permissions) => {
        expect(duplicate({}, permissions)).toEqual([]);
      },
    );

    it.each(['DRAFT', 'AWAITING_APPROVAL', 'COMPLETED', 'CANCELED'] as const)(
      '%s, mesmo sem custódia: habilitada (a origem não muda)',
      (status) => {
        expect(
          duplicate({ status, currentResponsibleId: CREATOR_ID }, [
            'PROCESS_DUPLICATE',
            'PROCESS_CREATE',
          ]),
        ).toEqual([
          { action: 'DUPLICATE', label: 'Duplicar processo', enabled: true, reasons: [] },
        ]);
      },
    );
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

  describe('evaluateTransition (US-047 · RN-TRAM-04/05): a transição do comando de tramitação', () => {
    const transitionId = (key: string) =>
      builder.transitions.find((transition) => transition.key === key)?.id ?? '';
    const forwardKey = 'ESTUDOS_PRELIMINARES_FORWARD_PESQUISA_PRECOS';

    it('transição da etapa atual: destino, origem e as regras STAGE_EXIT (bloqueante antes do aviso)', () => {
      const input = engineInput(builder, { passes: studies, documents: [etp('DRAFT', false)] });
      const result = evaluateTransition(input, {
        transitionId: transitionId(forwardKey),
        action: 'FORWARD',
      });
      expect(result).toMatchObject({
        transition: { key: forwardKey },
        fromStage: { key: 'ESTUDOS_PRELIMINARES' },
        toStage: { key: 'PESQUISA_PRECOS', type: 'TASK' },
      });
      expect(result?.violations.map((item) => [item.severity, item.message])).toEqual([
        ['BLOCKING', ETP_MESSAGE],
        ['WARNING', RISK_MAP_MESSAGE],
      ]);
    });

    it('de outra etapa, de outra ação ou inexistente → null (TRANSITION_NOT_AVAILABLE)', () => {
      const input = engineInput(builder, { passes: studies, documents: [etp('DRAFT', true)] });
      const unavailable = [
        {
          transitionId: transitionId('ABERTURA_FORWARD_APROVACAO_DFD'),
          action: 'FORWARD' as const,
        },
        {
          transitionId: transitionId('ESTUDOS_PRELIMINARES_RETURN_ABERTURA'),
          action: 'FORWARD' as const,
        },
        { transitionId: transitionId(forwardKey), action: 'COMPLETE' as const },
        { transitionId: '0192c000-0000-7000-8000-00000000dead', action: 'FORWARD' as const },
      ];
      for (const request of unavailable) expect(evaluateTransition(input, request)).toBeNull();
    });

    it('regra TRANSITION de outra saída não conta; processo sem etapa ativa → null', () => {
      const custom = new DefinitionBuilder()
        .stage('A', 'START')
        .stage('B', 'TASK')
        .stage('C', 'TASK')
        .transition('A', 'B', 'FORWARD', { isPrimary: true })
        .transition('A', 'C', 'FORWARD')
        .rule(
          'REQUIRED_FIELD',
          { field: 'process.modalityCode' },
          { transition: 'A_FORWARD_C' },
          { message: 'Informe a modalidade.' },
        );
      const input = engineInput(custom, {
        passes: [pass(custom, 'A', 1, { status: 'ACTIVE', exitedAt: null })],
        context: ruleContext('A', { process: { ...ruleContext('A').process, modalityCode: null } }),
      });
      const id = (key: string) => custom.transitions.find((item) => item.key === key)?.id ?? '';
      expect(
        evaluateTransition(input, { transitionId: id('A_FORWARD_B'), action: 'FORWARD' })
          ?.violations,
      ).toEqual([]);
      expect(
        evaluateTransition(input, {
          transitionId: id('A_FORWARD_C'),
          action: 'FORWARD',
        })?.violations.map((item) => item.message),
      ).toEqual(['Informe a modalidade.']);
      const idle = engineInput(custom, { passes: [pass(custom, 'A', 1)] });
      expect(
        evaluateTransition(idle, { transitionId: id('A_FORWARD_B'), action: 'FORWARD' }),
      ).toBeNull();
    });

    it('PRC-08 expõe o transitionId e a etapa destino nas entradas de avanço', () => {
      const input = engineInput(builder, { passes: studies, documents: [etp('DRAFT', true)] });
      const [forward] = actionsOf(availableActions(input, viewer()), 'FORWARD');
      expect(forward).toMatchObject({
        transitionId: transitionId(forwardKey),
        toStageName: 'Pesquisa de preços',
        toStageType: 'TASK',
      });
    });
  });
});
