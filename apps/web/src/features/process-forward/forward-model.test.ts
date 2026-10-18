import { PROCESS_FORWARD_MESSAGES } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import {
  DOC_DFD,
  DOC_ETP,
  DOC_RISKS,
  RULE_ETP_FORWARD,
  RULE_RISK_FORWARD,
  T_OUTRA,
  T_PESQUISA,
  approvalEntry,
  checklistRule,
  defaultDocuments,
  documentDto,
  forwardEntry,
  forwardedDto,
  violation,
} from '@test/support/forward-fixtures';
import { ID, stagesDto } from '@test/support/process-fixtures';

import {
  EMPTY_DUE_OVERRIDE,
  addDays,
  buildForwardBody,
  currentStageEnteredAt,
  deadlineMessage,
  defaultDepartment,
  defaultDocumentIds,
  describeForwardError,
  effectiveDocumentIds,
  forwardEntries,
  forwardFieldOf,
  forwardedToast,
  formatDueDate,
  initialTransitionId,
  localToday,
  lockedDocumentIds,
  mergeRules,
  overrideLimit,
  pendingWarnings,
  resolveDocumentId,
  rulesFor,
  rulesOfViolations,
  summaryOf,
  validateForward,
} from './forward-model';
import type { ForwardDraft } from './forward-model';

const STAGE = ID(302);
const COMPRAS = { id: ID(30), name: 'Departamento de Compras' };
const TODAY = '2026-10-05';

const draftOf = (extra: Partial<ForwardDraft> = {}): ForwardDraft => ({
  entry: forwardEntry(),
  department: null,
  assignee: null,
  dueOverride: EMPTY_DUE_OVERRIDE,
  comment: '',
  documentSelection: null,
  documentCount: 0,
  warnings: [],
  acknowledged: [],
  ...extra,
});

type ApiErrorInit = ConstructorParameters<typeof ApiError>[0];

function apiError(
  status: number,
  code: string,
  extra: Partial<Omit<ApiErrorInit, 'status' | 'code'>> = {},
) {
  return new ApiError({ status, code, correlationId: 'c-1', ...extra });
}

describe('escolha da transição (passo 3)', () => {
  const primary = forwardEntry();
  const other = forwardEntry({ transitionId: T_OUTRA, transitionKey: 'OUTRA', primary: false });
  const approval = approvalEntry({ primary: false });

  it('lista só as entradas FORWARD com transitionId, a principal primeiro', () => {
    const entries = forwardEntries([
      other,
      { ...forwardEntry({ action: 'RETURN' }) },
      primary,
      { action: 'EDIT', label: 'Editar', enabled: true, reasons: [] },
      { ...approval, transitionId: undefined },
    ]);
    expect(entries.map((entry) => entry.transitionId)).toEqual([T_PESQUISA, T_OUTRA]);
    expect(forwardEntries(undefined)).toEqual([]);
  });

  it('a principal habilitada vem selecionada; senão a primeira habilitada; senão nenhuma', () => {
    expect(initialTransitionId([other, primary])).toBe(T_PESQUISA);
    expect(initialTransitionId([other, { ...primary, enabled: false }])).toBe(T_OUTRA);
    expect(initialTransitionId([{ ...primary, enabled: false }])).toBeNull();
    expect(initialTransitionId([])).toBeNull();
  });

  it('a transitionKey da ação do painel tem precedência (só se habilitada)', () => {
    expect(initialTransitionId([primary, other], 'OUTRA')).toBe(T_OUTRA);
    expect(initialTransitionId([primary, { ...other, enabled: false }], 'OUTRA')).toBe(T_PESQUISA);
    expect(initialTransitionId([primary, other], 'INEXISTENTE')).toBe(T_PESQUISA);
  });
});

describe('pendências e avisos por transição (passo 8)', () => {
  const entry = forwardEntry();
  const stageExit = checklistRule(RULE_ETP_FORWARD, 'BLOCKING', 'O ETP deve estar completo.');
  const mine = checklistRule(
    RULE_RISK_FORWARD,
    'WARNING',
    'Recomenda-se elaborar o mapa de riscos.',
    {
      scope: 'TRANSITION',
      transitionId: T_PESQUISA,
    },
  );
  const others = checklistRule(ID(613), 'BLOCKING', 'Regra de outra saída.', {
    scope: 'TRANSITION',
    transitionId: T_OUTRA,
  });

  it('STAGE_EXIT vale para todas; TRANSITION só a da transição escolhida', () => {
    expect(rulesFor([mine, others, stageExit], entry).map((rule) => rule.ruleId)).toEqual([
      RULE_ETP_FORWARD,
      RULE_RISK_FORWARD,
    ]);
    expect(rulesFor([mine, others, stageExit], undefined).map((rule) => rule.ruleId)).toEqual([
      RULE_ETP_FORWARD,
    ]);
  });

  it('usa a transitionKey quando a pendência não traz o id e ignora as já satisfeitas', () => {
    const byKey = checklistRule(ID(614), 'WARNING', 'Por chave.', {
      scope: 'TRANSITION',
      transitionKey: 'ESTUDOS_PARA_PESQUISA',
    });
    const satisfied = { ...stageExit, satisfied: true };
    expect(rulesFor([byKey, satisfied], entry).map((rule) => rule.ruleId)).toEqual([ID(614)]);
  });

  it('bloqueantes antes dos avisos, sem repetir a regra', () => {
    const merged = mergeRules(
      rulesFor([mine], entry),
      rulesOfViolations([
        violation(RULE_ETP_FORWARD, 'BLOCKING', 'O ETP deve estar completo.'),
        violation(RULE_RISK_FORWARD, 'WARNING', 'Texto repetido.'),
      ]),
    );
    expect(merged.map((rule) => [rule.ruleId, rule.severity])).toEqual([
      [RULE_ETP_FORWARD, 'BLOCKING'],
      [RULE_RISK_FORWARD, 'WARNING'],
    ]);
    expect(merged[1]?.message).toBe('Recomenda-se elaborar o mapa de riscos.');
  });

  it('as violações do problem+json sem ruleId ficam de fora; o atalho do documento é o mais novo', () => {
    expect(rulesOfViolations([violation('x', 'BLOCKING', 'Sem id', { ruleId: null })])).toEqual([]);
    const rule = rulesOfViolations([
      violation(RULE_ETP_FORWARD, 'BLOCKING', 'ETP', { params: { documentTypeCode: 'ETP' } }),
    ])[0];
    const documents = [
      documentDto(ID(540), 'ETP antigo', 'ETP', 'ETP', { updatedAt: '2026-09-01T00:00:00.000Z' }),
      documentDto(ID(541), 'ETP novo', 'ETP', 'ETP', { updatedAt: '2026-10-01T00:00:00.000Z' }),
      documentDto(ID(542), 'ETP cancelado', 'ETP', 'ETP', {
        status: 'CANCELED',
        updatedAt: '2026-10-04T00:00:00.000Z',
      }),
    ];
    expect(rule && resolveDocumentId(rule, documents)).toBe(ID(541));
    expect(rule && resolveDocumentId(rule, [])).toBeNull();
    expect(
      resolveDocumentId(
        { ruleId: 'x', severity: 'BLOCKING', message: '', documentTypeCode: null },
        documents,
      ),
    ).toBeNull();
  });

  it('avisos que ainda faltam reconhecer', () => {
    const rules = rulesFor([mine], entry);
    expect(pendingWarnings(rules, [])).toHaveLength(1);
    expect(pendingWarnings(rules, [RULE_RISK_FORWARD])).toHaveLength(0);
  });
});

describe('padrões do painel', () => {
  it('unidade padrão = a última que executou a etapa de destino (só em CHOSEN_ON_FORWARD)', () => {
    const chosen = forwardEntry({ departmentResolution: { mode: 'CHOSEN_ON_FORWARD' } });
    const stages = stagesDto().map((stage) =>
      stage.key === 'PESQUISA_PRECOS'
        ? {
            ...stage,
            passes: [
              {
                processStageId: ID(801),
                sequence: 2,
                status: 'COMPLETED' as const,
                department: { id: ID(31), name: 'Licitações' },
                assignee: null,
                enteredAt: '2026-09-01T00:00:00.000Z',
                exitedAt: '2026-09-02T00:00:00.000Z',
                dueAt: null,
                dueDateOverridden: false,
                overdueSince: null,
              },
              {
                processStageId: ID(802),
                sequence: 4,
                status: 'COMPLETED' as const,
                department: COMPRAS,
                assignee: null,
                enteredAt: '2026-09-10T00:00:00.000Z',
                exitedAt: '2026-09-11T00:00:00.000Z',
                dueAt: null,
                dueDateOverridden: false,
                overdueSince: null,
              },
            ],
          }
        : stage,
    );
    expect(defaultDepartment(chosen, stages)).toEqual(COMPRAS);
    expect(defaultDepartment(chosen, stagesDto())).toBeNull();
    expect(defaultDepartment(forwardEntry(), stages)).toBeNull();
  });

  it('documentos marcados = criados ou alterados desde a entrada na etapa atual', () => {
    const enteredAt = currentStageEnteredAt(stagesDto());
    expect(enteredAt).toBe('2026-09-20T12:00:00.000Z');
    expect(defaultDocumentIds(defaultDocuments(), enteredAt)).toEqual([DOC_ETP, DOC_RISKS]);
    expect(defaultDocumentIds(defaultDocuments(), null)).toEqual([]);
    expect(currentStageEnteredAt(undefined)).toBeNull();
  });

  it('destino de aprovação trava os documentos não cancelados e a seleção sempre os inclui', () => {
    const documents = [
      ...defaultDocuments(),
      documentDto(ID(560), 'Cancelado', 'X', 'X', { status: 'CANCELED' }),
    ];
    expect(lockedDocumentIds(documents, forwardEntry())).toEqual([]);
    const locked = lockedDocumentIds(documents, approvalEntry());
    expect(locked).toEqual([DOC_ETP, DOC_RISKS, DOC_DFD]);
    expect(effectiveDocumentIds(null, [DOC_ETP], locked)).toEqual(locked);
    expect(effectiveDocumentIds([DOC_RISKS], [DOC_ETP], [])).toEqual([DOC_RISKS]);
  });
});

describe('datas e prazo (passo 5)', () => {
  it('formata o prazo no fuso do tenant e calcula o dia local', () => {
    // 23:59:59 de 20/10 em São Paulo.
    expect(formatDueDate('2026-10-21T02:59:59.000Z', 'America/Sao_Paulo')).toBe('20/10/2026');
    expect(formatDueDate('2026-10-21T02:59:59.000Z', 'UTC')).toBe('21/10/2026');
    expect(localToday(new Date('2026-10-05T02:00:00.000Z'), 'America/Sao_Paulo')).toBe(
      '2026-10-04',
    );
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(overrideLimit('2026-10-05')).toBe('2027-10-05');
  });

  it('"Até DD/MM/AAAA (N dias úteis)" com o SLA da etapa, "Até …" sem SLA, "Sem prazo definido"', () => {
    const stages = stagesDto().map((stage) =>
      stage.key === 'PESQUISA_PRECOS'
        ? { ...stage, slaDays: 10, slaType: 'BUSINESS' as const }
        : stage,
    );
    expect(deadlineMessage(forwardEntry(), stages, 'America/Sao_Paulo')).toEqual({
      key: 'due.untilSla',
      values: { date: '20/10/2026', days: 10, type: 'BUSINESS' },
    });
    const noSla = stages.map((stage) => ({ ...stage, slaDays: null, slaType: null }));
    expect(deadlineMessage(forwardEntry(), noSla, 'America/Sao_Paulo')).toEqual({
      key: 'due.until',
      values: { date: '20/10/2026' },
    });
    expect(
      deadlineMessage(forwardEntry({ dueAtPreview: null }), stages, 'America/Sao_Paulo').key,
    ).toBe('due.none');
    expect(deadlineMessage(undefined, stages, 'America/Sao_Paulo').key).toBe('due.none');
  });
});

describe('corpo do PRC-19', () => {
  it('só o essencial: transição, etapa esperada e comentário aparado', () => {
    expect(
      buildForwardBody(draftOf({ comment: '  ETP concluído; seguem os anexos.  ' }), STAGE),
    ).toEqual({
      transitionId: T_PESQUISA,
      expectedStageId: STAGE,
      comment: 'ETP concluído; seguem os anexos.',
    });
    expect(buildForwardBody(draftOf({ comment: '   ' }), STAGE)).toEqual({
      transitionId: T_PESQUISA,
      expectedStageId: STAGE,
    });
  });

  it('toDepartmentId só em CHOSEN_ON_FORWARD; toUserId nunca em destino de aprovação', () => {
    const assignee = { id: ID(61), name: 'Rui' };
    const chosen = forwardEntry({ departmentResolution: { mode: 'CHOSEN_ON_FORWARD' } });
    expect(
      buildForwardBody(draftOf({ entry: chosen, department: COMPRAS, assignee }), STAGE),
    ).toEqual({
      transitionId: T_PESQUISA,
      expectedStageId: STAGE,
      toDepartmentId: COMPRAS.id,
      toUserId: assignee.id,
    });
    // Unidade resolvida pelo workflow: a escolha antiga não é enviada.
    expect(buildForwardBody(draftOf({ department: COMPRAS }), STAGE)).not.toHaveProperty(
      'toDepartmentId',
    );
    expect(
      buildForwardBody(draftOf({ entry: approvalEntry(), assignee }), STAGE),
    ).not.toHaveProperty('toUserId');
  });

  it('dueAt + motivo só com a sobrescrita permitida e ativa', () => {
    const entry = forwardEntry({ allowDueDateOverride: true });
    const dueOverride = { enabled: true, date: '2026-10-30', reason: ' Volume alto de itens ' };
    expect(buildForwardBody(draftOf({ entry, dueOverride }), STAGE)).toEqual({
      transitionId: T_PESQUISA,
      expectedStageId: STAGE,
      dueAt: '2026-10-30',
      dueDateOverrideReason: 'Volume alto de itens',
    });
    expect(buildForwardBody(draftOf({ dueOverride }), STAGE)).not.toHaveProperty('dueAt');
    expect(
      buildForwardBody(draftOf({ entry, dueOverride: { ...dueOverride, enabled: false } }), STAGE),
    ).not.toHaveProperty('dueAt');
  });

  it('documentIds só se o usuário mexeu na lista; avisos = os marcados que ainda valem', () => {
    const warnings = rulesFor(
      [checklistRule(RULE_RISK_FORWARD, 'WARNING', 'Aviso')],
      forwardEntry(),
    );
    const body = buildForwardBody(
      draftOf({
        documentSelection: [DOC_ETP],
        warnings,
        acknowledged: [RULE_RISK_FORWARD, ID(699)],
      }),
      STAGE,
    );
    expect(body).toEqual({
      transitionId: T_PESQUISA,
      expectedStageId: STAGE,
      documentIds: [DOC_ETP],
      acknowledgedWarnings: [RULE_RISK_FORWARD],
    });
    expect(buildForwardBody(draftOf({ documentSelection: [] }), STAGE)).toHaveProperty(
      'documentIds',
      [],
    );
    expect(buildForwardBody(draftOf(), STAGE)).not.toHaveProperty('documentIds');
  });

  it('sem transitionId não há o que enviar', () => {
    expect(() => buildForwardBody(draftOf({ entry: undefined }), STAGE)).toThrow();
  });
});

describe('validação local (V-01/V-02/V-10/V-14)', () => {
  it('rascunho válido não tem mensagens', () => {
    expect(validateForward(draftOf(), TODAY)).toEqual({});
  });

  it('V-01: sem transição ou com transição indisponível', () => {
    expect(validateForward(draftOf({ entry: undefined }), TODAY).transition).toBe(
      PROCESS_FORWARD_MESSAGES.transitionRequired,
    );
    expect(
      validateForward(draftOf({ entry: forwardEntry({ enabled: false }) }), TODAY).transition,
    ).toBe(PROCESS_FORWARD_MESSAGES.transitionNotAvailable);
  });

  it('V-02: comentário obrigatório (mín. 10) e limite de 5.000', () => {
    const entry = forwardEntry({ requiresComment: true });
    expect(validateForward(draftOf({ entry }), TODAY).comment).toBe(
      'Informe um comentário (mín. 10 caracteres).',
    );
    expect(validateForward(draftOf({ entry, comment: 'curto' }), TODAY).comment).toBe(
      'Informe um comentário (mín. 10 caracteres).',
    );
    expect(validateForward(draftOf({ entry, comment: 'Comentário ok.' }), TODAY).comment).toBe(
      undefined,
    );
    expect(validateForward(draftOf({ comment: 'x'.repeat(5001) }), TODAY).comment).toBe(
      PROCESS_FORWARD_MESSAGES.commentTooLong,
    );
  });

  it('V-10: unidade ausente em CHOSEN_ON_FORWARD', () => {
    const entry = forwardEntry({ departmentResolution: { mode: 'CHOSEN_ON_FORWARD' } });
    expect(validateForward(draftOf({ entry }), TODAY).department).toBe(
      'Escolha a unidade de destino.',
    );
    expect(validateForward(draftOf({ entry, department: COMPRAS }), TODAY).department).toBe(
      undefined,
    );
  });

  it('V-14: data entre hoje e hoje + 365 dias e motivo de 10 a 1.000 caracteres', () => {
    const entry = forwardEntry({ allowDueDateOverride: true });
    const check = (date: string, reason: string) =>
      validateForward(draftOf({ entry, dueOverride: { enabled: true, date, reason } }), TODAY);
    expect(check('', 'Volume alto de itens').dueAt).toBe(
      'Informe uma data entre hoje e 05/10/2027 e o motivo da alteração.',
    );
    expect(check('2026-10-04', 'Volume alto de itens').dueAt).toContain('entre hoje e 05/10/2027');
    expect(check('2027-10-06', 'Volume alto de itens').dueAt).toContain('entre hoje e 05/10/2027');
    expect(check('2026-10-30', 'Volume alto de itens')).toEqual({});
    expect(check('2026-10-30', 'curto').dueReason).toBe(PROCESS_FORWARD_MESSAGES.dueDateReason);
    expect(check('2026-10-30', 'x'.repeat(1001)).dueReason).toBe(
      PROCESS_FORWARD_MESSAGES.dueDateReason,
    );
    // Sem "Alterar prazo" ativo nada é conferido.
    expect(validateForward(draftOf({ entry }), TODAY)).toEqual({});
  });

  it('V-03 e V-09: mais de 50 documentos; aviso sem reconhecimento', () => {
    expect(validateForward(draftOf({ documentCount: 51 }), TODAY).documents).toBe(
      PROCESS_FORWARD_MESSAGES.documents,
    );
    const warnings = rulesFor(
      [checklistRule(RULE_RISK_FORWARD, 'WARNING', 'Aviso')],
      forwardEntry(),
    );
    expect(validateForward(draftOf({ warnings }), TODAY).warnings).toBe(
      PROCESS_FORWARD_MESSAGES.warningsNotAcknowledged,
    );
    expect(
      validateForward(draftOf({ warnings, acknowledged: [RULE_RISK_FORWARD] }), TODAY).warnings,
    ).toBe(undefined);
  });
});

describe('resumo (passo 9) e toast (passo 12)', () => {
  const base = {
    department: null,
    assignee: null,
    dueOverride: EMPTY_DUE_OVERRIDE,
    stages: undefined,
    submitted: [],
    timeZone: 'America/Sao_Paulo',
  } as const;

  it('fila da unidade, com prazo e sem prazo', () => {
    expect(summaryOf({ ...base, entry: forwardEntry() })).toEqual({
      main: {
        key: 'summary.queue',
        values: {
          stage: 'Pesquisa de preços',
          department: 'Departamento de Compras',
          date: '20/10/2026',
        },
      },
      extra: null,
    });
    expect(summaryOf({ ...base, entry: forwardEntry({ dueAtPreview: null }) })?.main.key).toBe(
      'summary.queueNoDue',
    );
  });

  it('atribuição direta e prazo alterado aparecem no resumo', () => {
    const entry = forwardEntry({ allowDueDateOverride: true });
    const summary = summaryOf({
      ...base,
      entry,
      assignee: { id: ID(61), name: 'Rui Almeida' },
      dueOverride: { enabled: true, date: '2026-10-30', reason: 'x' },
    });
    expect(summary?.main).toEqual({
      key: 'summary.assigned',
      values: {
        stage: 'Pesquisa de preços',
        department: 'Departamento de Compras',
        assignee: 'Rui Almeida',
        date: '30/10/2026',
      },
    });
  });

  it('unidade escolhida no encaminhamento: pede a escolha até haver uma', () => {
    const entry = forwardEntry({ departmentResolution: { mode: 'CHOSEN_ON_FORWARD' } });
    expect(summaryOf({ ...base, entry })?.main.key).toBe('summary.pickDepartment');
    expect(summaryOf({ ...base, entry, department: COMPRAS })?.main.values).toMatchObject({
      department: 'Departamento de Compras',
    });
  });

  it('destino de aprovação: aprovador e a versão em que o documento será submetido', () => {
    const dfd = documentDto(DOC_DFD, 'DFD', 'DFD', 'DFD', {
      status: 'RETURNED',
      currentVersionNumber: 1,
    });
    const summary = summaryOf({ ...base, entry: approvalEntry(), submitted: [dfd] });
    expect(summary?.main).toEqual({
      key: 'summary.approval',
      values: { approver: 'Carlos Lima (titular da Secretaria de Obras)' },
    });
    expect(summary?.extra).toEqual({
      key: 'summary.submitOne',
      values: { document: 'DFD', version: 2 },
    });
    const many = summaryOf({
      ...base,
      entry: approvalEntry(),
      submitted: [dfd, documentDto(ID(570), 'Outro', 'X', 'X')],
    });
    expect(many?.extra).toEqual({ key: 'summary.submitMany', values: { count: 2 } });
    // Documento já finalizado/aprovado só ganha o selo "Em aprovação": nada é (re)submetido.
    const finalized = documentDto(ID(571), 'ETP', 'ETP', 'ETP', { status: 'FINALIZED' });
    expect(
      summaryOf({ ...base, entry: approvalEntry(), submitted: [finalized] })?.extra,
    ).toBeNull();
    expect(summaryOf({ ...base, entry: undefined })).toBeNull();
  });

  it('toast: encaminhado, autuado (FA-07) e destino de aprovação', () => {
    expect(forwardedToast(forwardedDto())).toEqual({
      key: 'toast.forwarded',
      values: { stage: 'Pesquisa de preços', department: 'Departamento de Compras' },
    });
    expect(forwardedToast(forwardedDto({ numberAssigned: true }))).toEqual({
      key: 'toast.numbered',
      values: {
        code: '0012/2026',
        stage: 'Pesquisa de preços',
        department: 'Departamento de Compras',
      },
    });
    const approval = { id: ID(960), approverLabel: 'Carlos Lima' };
    expect(forwardedToast(forwardedDto({ approval }))).toEqual({
      key: 'toast.approval',
      values: { approver: 'Carlos Lima' },
    });
    expect(forwardedToast(forwardedDto({ approval, numberAssigned: true })).key).toBe(
      'toast.numberedApproval',
    );
  });
});

describe('erros da API (tabela "Casos de erro")', () => {
  it('mapeia os campos da API para os do painel', () => {
    expect(forwardFieldOf('toDepartmentId')).toBe('department');
    expect(forwardFieldOf('toUserId')).toBe('assignee');
    expect(forwardFieldOf('dueDateOverrideReason')).toBe('dueReason');
    expect(forwardFieldOf('documentIds.2')).toBe('documents');
    expect(forwardFieldOf('documentIds[0]')).toBe('documents');
    expect(forwardFieldOf('acknowledgedWarnings')).toBe('warnings');
    expect(forwardFieldOf('outroCampo')).toBeNull();
  });

  it('concorrência: STAGE_CHANGED, VERSION_CONFLICT e PRECONDITION_REQUIRED', () => {
    expect(describeForwardError(apiError(409, 'STAGE_CHANGED')).kind).toBe('stageChanged');
    expect(describeForwardError(apiError(412, 'VERSION_CONFLICT')).kind).toBe('versionConflict');
    expect(describeForwardError(apiError(428, 'PRECONDITION_REQUIRED')).kind).toBe(
      'versionConflict',
    );
  });

  it('custódia, processo inexistente e status', () => {
    expect(describeForwardError(apiError(403, 'NOT_PROCESS_CUSTODIAN')).kind).toBe('custody');
    expect(describeForwardError(apiError(403, 'PERMISSION_DENIED')).kind).toBe('custody');
    expect(describeForwardError(apiError(404, 'PROCESS_NOT_FOUND')).kind).toBe('notFound');
    expect(describeForwardError(apiError(409, 'INVALID_PROCESS_STATUS'))).toEqual({
      kind: 'status',
      detail: PROCESS_FORWARD_MESSAGES.invalidStatus,
    });
  });

  it('TRANSITION_BLOCKED lista todas as violações (inclusive avisos) e conta as bloqueantes', () => {
    const problem = describeForwardError(
      apiError(422, 'TRANSITION_BLOCKED', {
        violations: [
          violation(RULE_RISK_FORWARD, 'WARNING', 'Aviso'),
          violation(RULE_ETP_FORWARD, 'BLOCKING', 'O ETP deve estar completo.'),
        ],
      }),
    );
    expect(problem).toMatchObject({ kind: 'blocked', count: 1 });
    expect(problem.kind === 'blocked' && problem.rules.map((rule) => rule.ruleId)).toEqual([
      RULE_ETP_FORWARD,
      RULE_RISK_FORWARD,
    ]);
    expect(
      describeForwardError(
        apiError(422, 'WARNINGS_NOT_ACKNOWLEDGED', {
          violations: [violation(RULE_RISK_FORWARD, 'WARNING', 'Aviso')],
        }),
      ),
    ).toMatchObject({ kind: 'warnings' });
  });

  it('erros de campo: DEPARTMENT_REQUIRED, VALIDATION_ERROR e os de uma só causa', () => {
    expect(describeForwardError(apiError(422, 'DEPARTMENT_REQUIRED'))).toEqual({
      kind: 'fields',
      messages: { department: 'Escolha a unidade de destino.' },
      others: [],
    });
    expect(
      describeForwardError(
        apiError(422, 'VALIDATION_ERROR', {
          errors: [
            { field: 'toDepartmentId', code: 'REFERENCE_INACTIVE', message: 'Unidade inativa.' },
            { field: 'toDepartmentId', code: 'REFERENCE_NOT_FOUND', message: 'Repetido.' },
            { field: 'campoDesconhecido', code: 'INVALID_FORMAT', message: 'Outro erro.' },
          ],
        }),
      ),
    ).toEqual({
      kind: 'fields',
      messages: { department: 'Unidade inativa.' },
      others: ['Outro erro.'],
    });
    expect(describeForwardError(apiError(422, 'DUE_DATE_OVERRIDE_NOT_ALLOWED')).kind).toBe(
      'dueNotAllowed',
    );
    expect(describeForwardError(apiError(422, 'ASSIGNEE_NOT_ELIGIBLE')).kind).toBe(
      'assigneeNotEligible',
    );
    expect(describeForwardError(apiError(422, 'TRANSITION_NOT_AVAILABLE')).kind).toBe(
      'transitionNotAvailable',
    );
  });

  it('DOCUMENT_INCOMPLETE agrupa as pendências por documento', () => {
    const problem = describeForwardError(
      apiError(422, 'DOCUMENT_INCOMPLETE', {
        violations: [
          violation('r1', 'BLOCKING', 'Falta o objeto.', {
            ruleId: null,
            params: { documentId: DOC_DFD, documentTitle: 'DFD' },
          }),
          violation('r2', 'BLOCKING', 'Falta a justificativa.', {
            ruleId: null,
            params: { documentId: DOC_DFD, documentTitle: 'DFD' },
          }),
          violation('r3', 'BLOCKING', 'Sem referência.', { ruleId: null }),
        ],
      }),
    );
    expect(problem).toEqual({
      kind: 'documents',
      items: [
        {
          documentId: DOC_DFD,
          title: 'DFD',
          messages: ['Falta o objeto.', 'Falta a justificativa.'],
        },
        { documentId: null, title: null, messages: ['Sem referência.'] },
      ],
    });
  });

  it('APPROVER_UNRESOLVED, idempotência, indisponibilidade e erro inesperado', () => {
    expect(
      describeForwardError(
        apiError(422, 'APPROVER_UNRESOLVED', {
          problem: {
            type: 'https://x.test/e',
            title: 't',
            status: 422,
            detail: 'A Secretaria de Obras não tem titular apto a decidir.',
            instance: '/',
            code: 'APPROVER_UNRESOLVED',
            correlationId: 'c',
            errors: [],
            violations: [],
          },
        }),
      ),
    ).toEqual({
      kind: 'approver',
      detail: 'A Secretaria de Obras não tem titular apto a decidir.',
    });
    expect(describeForwardError(apiError(422, 'APPROVER_UNRESOLVED'))).toEqual({
      kind: 'approver',
      detail: null,
    });
    expect(describeForwardError(apiError(422, 'IDEMPOTENCY_KEY_REUSED')).kind).toBe(
      'idempotencyReused',
    );
    expect(describeForwardError(apiError(409, 'IDEMPOTENCY_IN_PROGRESS')).kind).toBe('inProgress');
    expect(describeForwardError(apiError(503, 'DEPENDENCY_UNAVAILABLE'))).toEqual({
      kind: 'unavailable',
      correlationId: 'c-1',
    });
    expect(describeForwardError(apiError(500, 'INTERNAL_ERROR'))).toEqual({
      kind: 'unexpected',
      correlationId: 'c-1',
    });
    expect(describeForwardError(new Error('rede'))).toEqual({
      kind: 'unexpected',
      correlationId: '—',
    });
  });
});
