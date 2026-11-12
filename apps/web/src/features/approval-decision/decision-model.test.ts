import { decideApprovalSchema } from '@contrataflow/validation';
import type { ApprovalDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import {
  DOC_ETP,
  RULE_PARECER,
  RULE_RISCOS,
  T_APROVAR,
  T_DEVOLVER_ABERTURA,
  T_DEVOLVER_ESTUDOS,
  approvalDto,
  approvalMeta,
  decisionOption,
  readOnlyMeta,
  rejectOption,
  returnOption,
  secondReturnOption,
  transitionRule,
} from '@test/support/approval-fixtures';
import { violation } from '@test/support/forward-fixtures';

import {
  activeLinesCount,
  buildDecisionBody,
  canDecide,
  commentRequired,
  decidableLines,
  describeDecisionError,
  groupDecisionOptions,
  isConfirmEnabled,
  isNoticeProblem,
  isOptionAvailable,
  needsRefresh,
  needsTargetChoice,
  optionKey,
  pendingWarnings,
  resolveOption,
  validateDecision,
  violationDocumentId,
  voteIfMatch,
  warningsOf,
  withoutTrailingPeriod,
} from './decision-model';

/* US-052 · SCR-015 — regras puras do painel "Decidir aprovação". */

const REASON = 'Faltou detalhar a justificativa da contratação no ETP';
const WARNING = transitionRule(RULE_RISCOS, 'WARNING', 'O mapa de riscos não foi atualizado.');
const BLOCKING = transitionRule(RULE_PARECER, 'BLOCKING', 'Falta o parecer jurídico.');

const apiError = (
  status: number,
  code: string,
  extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {},
) => new ApiError({ status, code, correlationId: 'c-52', ...extra });

describe('decision-model · opções de decisão (US-052)', () => {
  it('canDecide: só com DECIDE em allowedActions', () => {
    expect(canDecide(approvalMeta())).toBe(true);
    expect(canDecide(readOnlyMeta('NOT_DESIGNATED_APPROVER'))).toBe(false);
  });

  it('groupDecisionOptions: sempre os três grupos (Aprovar, Devolver, Indeferir), na ordem', () => {
    const groups = groupDecisionOptions([rejectOption(), decisionOption(), returnOption()]);
    expect(groups.map((group) => group.decision)).toEqual(['APPROVE', 'RETURN', 'REJECT']);
    expect(groups.every((group) => group.available && group.options.length === 1)).toBe(true);
  });

  it('groupDecisionOptions: decisão sem opção fica indisponível; várias opções ficam no mesmo grupo', () => {
    const groups = groupDecisionOptions([decisionOption(), returnOption(), secondReturnOption()]);
    const reject = groups.find((group) => group.decision === 'REJECT');
    const back = groups.find((group) => group.decision === 'RETURN');
    expect(reject).toMatchObject({ available: false, options: [], blockedMessages: [] });
    expect(back?.options).toHaveLength(2);
    expect(needsTargetChoice(back)).toBe(true);
    expect(needsTargetChoice(groups[0])).toBe(false);
  });

  it('regra BLOCKING desabilita a opção e o grupo mostra a mensagem da regra (V-04)', () => {
    const blocked = decisionOption({ violations: [BLOCKING] });
    expect(isOptionAvailable(blocked)).toBe(false);
    expect(isOptionAvailable(decisionOption({ enabled: false }))).toBe(false);
    expect(isOptionAvailable(decisionOption({ violations: [WARNING] }))).toBe(true);
    const [approve] = groupDecisionOptions([blocked]);
    expect(approve).toMatchObject({
      available: false,
      blockedMessages: ['Falta o parecer jurídico.'],
    });
  });

  it('devolução com duas opções: uma habilitada mantém o grupo disponível', () => {
    const groups = groupDecisionOptions([
      returnOption({ violations: [BLOCKING] }),
      secondReturnOption(),
    ]);
    const back = groups.find((group) => group.decision === 'RETURN');
    expect(back?.available).toBe(true);
    expect(back?.blockedMessages).toEqual([]);
  });

  it('resolveOption: a única opção vale sozinha; com várias, só a escolhida', () => {
    const groups = groupDecisionOptions([returnOption(), secondReturnOption(), decisionOption()]);
    const approve = groups[0];
    const back = groups[1];
    expect(resolveOption(approve, null)?.decision).toBe('APPROVE');
    expect(resolveOption(back, null)).toBeUndefined();
    expect(resolveOption(back, T_DEVOLVER_ABERTURA)?.transitionId).toBe(T_DEVOLVER_ABERTURA);
    expect(resolveOption(back, 'inexistente')).toBeUndefined();
    expect(resolveOption(undefined, null)).toBeUndefined();
  });

  it('optionKey: a transição ou, na avulsa (sem transição), a decisão', () => {
    expect(optionKey(returnOption())).toBe(T_DEVOLVER_ESTUDOS);
    expect(optionKey(decisionOption({ transitionId: null, toStage: null }))).toBe(
      'decision:APPROVE',
    );
  });
});

describe('decision-model · avisos (FA-03 · DEC-016)', () => {
  const withWarning = decisionOption({ violations: [WARNING, BLOCKING] });

  it('warningsOf: só os WARNING não satisfeitos, sem repetir a regra', () => {
    expect(warningsOf(withWarning)).toEqual([
      { ruleId: RULE_RISCOS, message: 'O mapa de riscos não foi atualizado.' },
    ]);
    expect(
      warningsOf(
        decisionOption({
          violations: [WARNING, WARNING, { ...WARNING, ruleId: RULE_PARECER, satisfied: true }],
        }),
      ),
    ).toHaveLength(1);
    expect(warningsOf(undefined)).toEqual([]);
  });

  it('o botão de confirmar só habilita depois de reconhecer todos os avisos', () => {
    expect(pendingWarnings(withWarning, [])).toHaveLength(1);
    expect(isConfirmEnabled(withWarning, [])).toBe(false);
    expect(isConfirmEnabled(withWarning, [RULE_RISCOS])).toBe(true);
    expect(isConfirmEnabled(decisionOption(), [])).toBe(true);
    expect(isConfirmEnabled(undefined, [])).toBe(true);
  });
});

describe('decision-model · validação (RN-TRAM-55)', () => {
  const [approve, back, reject] = groupDecisionOptions([
    decisionOption(),
    returnOption(),
    rejectOption(),
  ]);
  const drafts = {
    approve: { decision: 'APPROVE', group: approve, option: approve?.options[0] },
    back: { decision: 'RETURN', group: back, option: back?.options[0] },
    reject: { decision: 'REJECT', group: reject, option: reject?.options[0] },
  } as const;

  it('V-01: sem decisão', () => {
    expect(
      validateDecision({
        decision: null,
        group: undefined,
        option: undefined,
        comment: '',
        acknowledged: [],
      }),
    ).toEqual({ decision: 'Selecione uma decisão.' });
  });

  it('V-02: devolver e indeferir exigem o motivo; aprovar aceita sem comentário', () => {
    for (const draft of [drafts.back, drafts.reject]) {
      expect(validateDecision({ ...draft, comment: '', acknowledged: [] })).toEqual({
        comment: 'Informe o motivo (mín. 10 caracteres).',
      });
      expect(validateDecision({ ...draft, comment: '   curto  ', acknowledged: [] })).toEqual({
        comment: 'Informe o motivo (mín. 10 caracteres).',
      });
      expect(validateDecision({ ...draft, comment: REASON, acknowledged: [] })).toEqual({});
    }
    expect(validateDecision({ ...drafts.approve, comment: '', acknowledged: [] })).toEqual({});
  });

  it('comentário informado na aprovação também respeita mín. 10 e máx. 5.000', () => {
    expect(validateDecision({ ...drafts.approve, comment: 'ok', acknowledged: [] })).toEqual({
      comment: 'Informe o motivo (mín. 10 caracteres).',
    });
    expect(
      validateDecision({ ...drafts.approve, comment: 'x'.repeat(5001), acknowledged: [] }),
    ).toEqual({ comment: 'O comentário pode ter até 5.000 caracteres.' });
    expect(
      validateDecision({ ...drafts.approve, comment: 'x'.repeat(5000), acknowledged: [] }),
    ).toEqual({});
  });

  it('devolução com várias etapas: exige escolher o destino', () => {
    const [, many] = groupDecisionOptions([returnOption(), secondReturnOption()]);
    expect(
      validateDecision({
        decision: 'RETURN',
        group: many,
        option: resolveOption(many, null),
        comment: REASON,
        acknowledged: [],
      }),
    ).toEqual({ transitionId: 'Escolha a etapa para a qual o processo será devolvido.' });
  });

  it('decisão sem opção ou com opção bloqueada não segue', () => {
    const [none] = groupDecisionOptions([]);
    expect(
      validateDecision({
        decision: 'APPROVE',
        group: none,
        option: undefined,
        comment: '',
        acknowledged: [],
      }),
    ).toEqual({ decision: 'Esta opção de decisão não está disponível para a etapa atual.' });
    const blocked = decisionOption({ violations: [BLOCKING] });
    const [group] = groupDecisionOptions([blocked]);
    expect(
      validateDecision({
        decision: 'APPROVE',
        group,
        option: blocked,
        comment: '',
        acknowledged: [],
      }),
    ).toEqual({ decision: 'Não é possível concluir esta decisão agora.' });
  });

  it('V-03: avisos sem ciência', () => {
    const option = decisionOption({ violations: [WARNING] });
    const [group] = groupDecisionOptions([option]);
    const draft = { decision: 'APPROVE', group, option, comment: '' } as const;
    expect(validateDecision({ ...draft, acknowledged: [] })).toEqual({
      warnings: 'Confirme que está ciente dos avisos para continuar.',
    });
    expect(validateDecision({ ...draft, acknowledged: [RULE_RISCOS] })).toEqual({});
  });

  it('commentRequired acompanha a decisão', () => {
    expect(commentRequired(null)).toBe(false);
    expect(commentRequired('APPROVE')).toBe(false);
    expect(commentRequired('RETURN')).toBe(true);
    expect(commentRequired('REJECT')).toBe(true);
  });
});

describe('decision-model · corpo do APV-03', () => {
  it('aprovar sem comentário: só a decisão e o transitionId da opção', () => {
    const body = buildDecisionBody({
      decision: 'APPROVE',
      option: decisionOption(),
      comment: '   ',
      acknowledged: [],
    });
    expect(body).toEqual({ decision: 'APPROVE', transitionId: decisionOption().transitionId });
    expect(decideApprovalSchema.safeParse(body).success).toBe(true);
  });

  it('devolver: comentário sem espaços nas pontas e o transitionId da etapa escolhida', () => {
    const body = buildDecisionBody({
      decision: 'RETURN',
      option: secondReturnOption(),
      comment: `  ${REASON}  `,
      acknowledged: [],
    });
    expect(body).toEqual({
      decision: 'RETURN',
      comment: REASON,
      transitionId: T_DEVOLVER_ABERTURA,
    });
    expect(decideApprovalSchema.safeParse(body).success).toBe(true);
  });

  it('avisos reconhecidos: só os da opção escolhida, em ordem estável', () => {
    const option = decisionOption({ violations: [WARNING] });
    const body = buildDecisionBody({
      decision: 'APPROVE',
      option,
      comment: '',
      acknowledged: ['regra-de-outra-opcao', RULE_RISCOS],
    });
    expect(body.acknowledgedWarnings).toEqual([RULE_RISCOS]);
    expect(decideApprovalSchema.safeParse(body).success).toBe(true);
  });

  it('avulsa (opção sem transição): não envia transitionId', () => {
    const body = buildDecisionBody({
      decision: 'APPROVE',
      option: decisionOption({ transitionId: null, toStage: null }),
      comment: '',
      acknowledged: [],
    });
    expect(body).toEqual({ decision: 'APPROVE' });
  });

  it('o corpo sem comentário em devolução é recusado pelo mesmo schema da API', () => {
    const body = buildDecisionBody({
      decision: 'RETURN',
      option: returnOption(),
      comment: '',
      acknowledged: [],
    });
    expect(decideApprovalSchema.safeParse(body).success).toBe(false);
  });
});

describe('decision-model · mensagens e links das violações', () => {
  it('withoutTrailingPeriod tira o ponto final para entrar no meio da frase', () => {
    expect(withoutTrailingPeriod('Falta o parecer jurídico.')).toBe('Falta o parecer jurídico');
    expect(withoutTrailingPeriod('Sem ponto ')).toBe('Sem ponto');
  });

  const { documents } = approvalDto();

  it('aponta para o documento coberto citado pela regra (id ou tipo)', () => {
    expect(
      violationDocumentId(
        violation(RULE_PARECER, 'BLOCKING', 'x', { params: { documentId: DOC_ETP } }),
        documents,
      ),
    ).toBe(DOC_ETP);
    expect(
      violationDocumentId(
        violation(RULE_PARECER, 'BLOCKING', 'x', { params: { documentTypeCode: 'ETP' } }),
        documents,
      ),
    ).toBe(DOC_ETP);
  });

  it('sem documento coberto correspondente, não há link', () => {
    expect(violationDocumentId(violation(RULE_PARECER, 'BLOCKING', 'x'), documents)).toBeNull();
    expect(
      violationDocumentId(
        violation(RULE_PARECER, 'BLOCKING', 'x', { params: { documentId: 'outro' } }),
        documents,
      ),
    ).toBeNull();
  });
});

describe('describeDecisionError (tabela "Casos de erro" da US-052)', () => {
  it('422 VALIDATION_ERROR: marca o campo, na ordem da tela, e guarda o resto', () => {
    const found = describeDecisionError(
      apiError(422, 'VALIDATION_ERROR', {
        errors: [
          {
            field: 'comment',
            code: 'TOO_SHORT',
            message: 'Informe o motivo (mín. 10 caracteres).',
          },
          { field: 'comment', code: 'REQUIRED', message: 'Outra' },
          { field: 'acknowledgedWarnings.0', code: 'INVALID_FORMAT', message: 'Aviso inválido.' },
          { field: 'outro', code: 'NOT_ALLOWED', message: 'Campo desconhecido.' },
        ],
      }),
    );
    expect(found).toEqual({
      kind: 'fields',
      messages: {
        comment: 'Informe o motivo (mín. 10 caracteres).',
        warnings: 'Aviso inválido.',
      },
      others: ['Campo desconhecido.'],
    });
  });

  it('422 WARNINGS_NOT_ACKNOWLEDGED e TRANSITION_BLOCKED carregam as violações', () => {
    const violations = [violation(RULE_RISCOS, 'WARNING', 'Mapa desatualizado.')];
    expect(
      describeDecisionError(apiError(422, 'WARNINGS_NOT_ACKNOWLEDGED', { violations })),
    ).toEqual({ kind: 'warnings', violations });
    expect(describeDecisionError(apiError(422, 'TRANSITION_BLOCKED', { violations }))).toEqual({
      kind: 'blocked',
      violations,
    });
  });

  it('422 de domínio: transição indisponível, aprovador não resolvido, chave reutilizada', () => {
    expect(describeDecisionError(apiError(422, 'TRANSITION_NOT_AVAILABLE'))).toEqual({
      kind: 'transitionNotAvailable',
    });
    expect(describeDecisionError(apiError(422, 'APPROVER_UNRESOLVED'))).toEqual({
      kind: 'approverUnresolved',
    });
    expect(describeDecisionError(apiError(422, 'IDEMPOTENCY_KEY_REUSED'))).toEqual({
      kind: 'idempotencyReused',
    });
  });

  it('403: designação, segregação, permissão e vínculo inativo', () => {
    expect(describeDecisionError(apiError(403, 'NOT_DESIGNATED_APPROVER'))).toEqual({
      kind: 'denied',
      reason: 'NOT_DESIGNATED_APPROVER',
    });
    expect(describeDecisionError(apiError(403, 'SELF_APPROVAL_FORBIDDEN'))).toEqual({
      kind: 'denied',
      reason: 'SELF_APPROVAL_FORBIDDEN',
    });
    expect(describeDecisionError(apiError(403, 'PERMISSION_DENIED'))).toEqual({
      kind: 'denied',
      reason: 'PERMISSION_DENIED',
    });
    expect(describeDecisionError(apiError(403, 'MEMBERSHIP_INACTIVE'))).toEqual({
      kind: 'membership',
    });
    expect(describeDecisionError(apiError(403, 'TENANT_SUSPENDED'))).toEqual({
      kind: 'membership',
    });
  });

  it('409, 412 e 428: já decidida, status do processo, versão e pré-condição', () => {
    expect(describeDecisionError(apiError(409, 'APPROVAL_NOT_PENDING'))).toEqual({
      kind: 'notPending',
    });
    expect(describeDecisionError(apiError(409, 'INVALID_PROCESS_STATUS'))).toEqual({
      kind: 'processStatus',
    });
    expect(describeDecisionError(apiError(412, 'VERSION_CONFLICT'))).toEqual({ kind: 'stale' });
    expect(describeDecisionError(apiError(428, 'PRECONDITION_REQUIRED'))).toEqual({
      kind: 'precondition',
    });
  });

  it('404, indisponibilidade e erro inesperado', () => {
    expect(describeDecisionError(apiError(404, 'APPROVAL_NOT_FOUND'))).toEqual({
      kind: 'notFound',
    });
    for (const status of [503, 429, 502, 504]) {
      expect(describeDecisionError(apiError(status, 'DEPENDENCY_UNAVAILABLE'))).toEqual({
        kind: 'unavailable',
      });
    }
    expect(describeDecisionError(apiError(500, 'INTERNAL_ERROR'))).toEqual({
      kind: 'unexpected',
      correlationId: 'c-52',
    });
    expect(describeDecisionError(apiError(422, 'ALGO_NOVO'))).toEqual({
      kind: 'unexpected',
      correlationId: 'c-52',
    });
    expect(describeDecisionError(new Error('rede'))).toEqual({
      kind: 'unexpected',
      correlationId: '—',
    });
  });

  it('isNoticeProblem e needsRefresh separam o aviso da tela do erro do painel', () => {
    for (const code of ['APPROVAL_NOT_PENDING', 'INVALID_PROCESS_STATUS']) {
      expect(isNoticeProblem(describeDecisionError(apiError(409, code)))).toBe(true);
    }
    expect(isNoticeProblem(describeDecisionError(apiError(412, 'VERSION_CONFLICT')))).toBe(true);
    expect(isNoticeProblem(describeDecisionError(apiError(403, 'SELF_APPROVAL_FORBIDDEN')))).toBe(
      true,
    );
    expect(isNoticeProblem(describeDecisionError(apiError(503, 'DEPENDENCY_UNAVAILABLE')))).toBe(
      false,
    );
    expect(isNoticeProblem(describeDecisionError(apiError(422, 'VALIDATION_ERROR')))).toBe(false);
    expect(needsRefresh(describeDecisionError(apiError(422, 'TRANSITION_BLOCKED')))).toBe(true);
    expect(needsRefresh(describeDecisionError(apiError(422, 'WARNINGS_NOT_ACKNOWLEDGED')))).toBe(
      true,
    );
    expect(needsRefresh(describeDecisionError(apiError(422, 'APPROVER_UNRESOLVED')))).toBe(false);
  });
});

describe('US-134 · decisão por linha', () => {
  const LINE_1 = '0192a000-0000-7000-8000-000000001150';
  const LINE_2 = '0192a000-0000-7000-8000-000000001151';
  const base: ApprovalDto['approvers'][number] | undefined = approvalDto().approvers[0];
  if (base === undefined) throw new Error('linha ausente');
  const lines = (versions: readonly number[]) =>
    versions.map((version, index) => ({
      ...base,
      id: index === 0 ? LINE_1 : LINE_2,
      sequence: index + 1,
      version,
    }));

  it('voteIfMatch: versão da aprovação em ANY; da linha escolhida ou de myLine nas demais', () => {
    const meta = { myLine: { id: LINE_1, sequence: 1, status: 'PENDING' as const, etag: '"4"' } };
    expect(
      voteIfMatch({ decisionPolicy: 'ANY', approvers: lines([4]), version: 9 }, meta, null),
    ).toBe('"9"');
    const all = { decisionPolicy: 'ALL' as const, approvers: lines([4, 7]), version: 9 };
    expect(voteIfMatch(all, meta, LINE_2)).toBe('"7"');
    expect(voteIfMatch(all, meta, null)).toBe('"4"');
    expect(voteIfMatch(all, { myLine: null }, null)).toBe('"9"');
  });

  it('decidableLines e activeLinesCount', () => {
    const approval = {
      approvers: [...lines([1, 1]), { ...base, id: 'x', status: 'CANCELED' as const }],
    };
    expect(decidableLines(approval, { decidableLineIds: [LINE_2] }).map((line) => line.id)).toEqual(
      [LINE_2],
    );
    expect(activeLinesCount(approval)).toBe(2);
  });

  it('linha obrigatória quando mais de uma cabe à pessoa; o corpo leva approvalApproverId', () => {
    const option = decisionOption();
    const group = groupDecisionOptions([option])[0];
    const draft = { decision: 'APPROVE' as const, group, option, comment: '', acknowledged: [] };
    expect(validateDecision({ ...draft, lineRequired: true, lineId: null })).toEqual({
      approvalApproverId: 'Escolha em qual linha você vai decidir.',
    });
    expect(validateDecision({ ...draft, lineRequired: true, lineId: LINE_2 })).toEqual({});
    expect(
      buildDecisionBody({
        decision: 'APPROVE',
        option,
        comment: '',
        acknowledged: [],
        approvalApproverId: LINE_2,
      }),
    ).toEqual({ decision: 'APPROVE', transitionId: T_APROVAR, approvalApproverId: LINE_2 });
  });

  it('voto que não encerra não pede ciência de avisos', () => {
    const warning = transitionRule(RULE_RISCOS, 'WARNING', 'O mapa de riscos não foi atualizado.');
    expect(warningsOf(decisionOption({ violations: [warning] }))).toHaveLength(1);
    expect(warningsOf(decisionOption({ violations: [warning], closesApproval: false }))).toEqual(
      [],
    );
  });

  it('erros por linha viram avisos da tela inteira', () => {
    const lineNotPending = describeDecisionError(
      new ApiError({ status: 409, code: 'APPROVAL_LINE_NOT_PENDING', detail: 'x' }),
    );
    expect(lineNotPending).toEqual({ kind: 'lineNotPending' });
    expect(
      describeDecisionError(
        new ApiError({ status: 409, code: 'APPROVER_ALREADY_VOTED', detail: 'x' }),
      ),
    ).toEqual({ kind: 'alreadyVoted' });
    const waiting = describeDecisionError(
      new ApiError({
        status: 403,
        code: 'NOT_DESIGNATED_APPROVER',
        detail: 'x',
        problem: {
          type: 'https://docs.contrataflow.com.br/errors/not-designated-approver',
          title: 'x',
          status: 403,
          detail: 'x',
          instance: '/api/v1/approvals/1/decide',
          code: 'NOT_DESIGNATED_APPROVER',
          correlationId: 'c',
          errors: [],
          violations: [],
          meta: { reason: 'LINE_WAITING' },
        },
      }),
    );
    expect(waiting).toEqual({ kind: 'waiting' });
    for (const kind of ['lineNotPending', 'alreadyVoted', 'waiting'] as const) {
      expect(isNoticeProblem({ kind })).toBe(true);
    }
  });
});
