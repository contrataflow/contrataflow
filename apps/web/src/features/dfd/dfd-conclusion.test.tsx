// @vitest-environment jsdom
import type * as UiModule from '@contrataflow/ui';
import type {
  ActionEntry,
  ChecklistViolation,
  DocumentDto,
  DocumentValidationDto,
  ForwardedProcessDto,
  Violation,
} from '@contrataflow/validation';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import {
  DFD_ID,
  ID,
  PROCESS_ID,
  bodyOf,
  processDto,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import {
  buildConclusionForwardBody,
  conclusionModeOf,
  conclusionWarnings,
  describeConclusionError,
  inApprovalOf,
} from './dfd-conclusion-model';
import { DfdConclusionStep } from './dfd-conclusion-step';
import type { ConclusionAutosave } from './dfd-conclusion-step';
import { ApiError } from '../../lib/api/api-error';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const ui = vi.hoisted(() => ({ toast: vi.fn(), push: vi.fn() }));
vi.mock('@contrataflow/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof UiModule>()),
  toast: ui.toast,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: ui.push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/processos/${PROCESS_ID}/dfd/${DFD_ID}`,
  useSearchParams: () => new URLSearchParams('passo=conclusao'),
}));

const OPENING = {
  id: ID(302),
  key: 'ABERTURA',
  name: 'Formalização da demanda',
  dueAt: null,
  instructions: null,
  documentTypeCodes: ['DFD'],
};
const TRANSITION = ID(901);
const STAGE = ID(302);
const MARTA = ID(77);
const WARNING_RULE = ID(950);
const APPROVER = 'Helena Prado (titular da Secretaria de Saúde)';

function sendEntry(extra: Partial<ActionEntry> = {}): ActionEntry {
  return {
    action: 'FORWARD',
    transitionId: TRANSITION,
    transitionKey: 'ENVIAR_APROVACAO_DFD',
    toStageKey: 'APROVACAO_DFD',
    toStageName: 'Aprovação da demanda',
    toStageType: 'APPROVAL',
    label: 'Enviar para aprovação da demanda',
    enabled: true,
    primary: true,
    reasons: [],
    dueAtPreview: '2026-10-09T02:59:59.999Z',
    approverPreview: { type: 'DEPARTMENT_HEAD', label: APPROVER, userId: MARTA },
    ...extra,
  };
}

const warning = (code: string, message: string): Violation => ({
  code,
  severity: 'WARNING',
  message,
  ruleId: null,
  sectionKey: null,
  field: null,
  itemId: null,
  params: {},
});

function validationDto(violations: Violation[] = [], draftRevision = 7): DocumentValidationDto {
  const blocking = violations.filter((item) => item.severity === 'BLOCKING').length;
  return {
    documentId: DFD_ID,
    isComplete: blocking === 0,
    draftRevision,
    evaluatedAt: '2026-10-05T17:00:00.000Z',
    summary: { blocking, warnings: violations.length - blocking },
    sections: [],
    violations,
  };
}

function documentDto(extra: Partial<DocumentDto> = {}): DocumentDto {
  return {
    id: DFD_ID,
    processId: PROCESS_ID,
    code: 'DFD 0005/2026',
    title: 'DFD — cimento',
    status: 'DRAFT',
    draftContent: { sections: {} },
    draftRevision: 7,
    currentVersionId: null,
    currentVersionNumber: null,
    approvedVersionId: null,
    pendingApprovalId: null,
    submittedAt: null,
    finalizedAt: null,
    version: 4,
    ...extra,
  } as DocumentDto;
}

interface ApiOptions {
  readonly actions?: ActionEntry[];
  readonly checklist?: ChecklistViolation[];
  readonly validation?: () => DocumentValidationDto;
  readonly forward?: (init?: RequestInit) => Response;
  readonly finalize?: (init?: RequestInit) => Response;
}

function mockApi(options: ApiOptions = {}) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const respond = (response: Response) => Promise.resolve(response);
    if (url === `/api/v1/processes/${PROCESS_ID}/available-actions`) {
      return respond(jsonResponse({ data: options.actions ?? [sendEntry()] }));
    }
    if (url === `/api/v1/processes/${PROCESS_ID}/checklist`) {
      return respond(jsonResponse({ data: { violations: options.checklist ?? [] } }));
    }
    if (url === `/api/v1/documents/${DFD_ID}/validation`) {
      return respond(jsonResponse({ data: options.validation?.() ?? validationDto() }));
    }
    if (method === 'GET' && url === `/api/v1/documents/${DFD_ID}`) {
      return respond(
        jsonResponse({ data: documentDto({ version: 5 }), meta: { allowedActions: [] } }),
      );
    }
    if (method === 'POST' && url === `/api/v1/processes/${PROCESS_ID}/forward`) {
      return respond(
        options.forward?.(init) ??
          jsonResponse({
            data: {
              ...processDto({ status: 'AWAITING_APPROVAL', version: 2 }),
              movement: { id: ID(990), sequence: 2 },
              approval: { id: ID(991), approverLabel: APPROVER },
              numberAssigned: false,
              statusFrom: 'DRAFT',
            } satisfies ForwardedProcessDto,
          }),
      );
    }
    if (method === 'POST' && url === `/api/v1/documents/${DFD_ID}/finalize`) {
      return respond(
        options.finalize?.(init) ??
          jsonResponse({
            data: documentDto({ status: 'FINALIZED', currentVersionNumber: 1 }),
            meta: { allowedActions: [] },
          }),
      );
    }
    return respond(jsonResponse({ data: [] }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const callsTo = (api: ReturnType<typeof mockApi>, method: string, url: string) =>
  api.mock.calls
    .filter(([input, init]) => requestUrl(input) === url && (init?.method ?? 'GET') === method)
    .map(([, init]) => ({ headers: new Headers(init?.headers), body: bodyOf(init) }));

function autosaveOf(status = 'saved'): ConclusionAutosave & { flush: ReturnType<typeof vi.fn> } {
  return { flush: vi.fn(() => Promise.resolve()), snapshot: { status } };
}

function renderStep(
  props: Partial<Parameters<typeof DfdConclusionStep>[0]> = {},
): ReturnType<typeof renderWithShell> {
  return renderWithShell(
    <DfdConclusionStep
      processId={PROCESS_ID}
      documentId={DFD_ID}
      document={documentDto()}
      allowedActions={['UPDATE', 'FINALIZE']}
      process={processDto({ currentStage: { ...OPENING, id: STAGE } })}
      autosave={autosaveOf()}
      retry={{ retries: 0 }}
      {...props}
    />,
  );
}

beforeEach(() => {
  ui.toast.mockClear();
  ui.push.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SCR-007 passo 5 — Concluir e enviar para aprovação (US-016)', () => {
  it('[Sucesso] cartão "Pronto para envio", alerta com "Estou ciente", mensagem e PRC-19 com If-Match, documento e alertas; leva ao painel', async () => {
    const api = mockApi({
      validation: () =>
        validationDto([
          warning('DFD_ATTACHMENTS_PENDING', 'Há 1 anexo em verificação de segurança.'),
        ]),
      checklist: [
        {
          code: 'WORKFLOW_RULE',
          severity: 'WARNING',
          message: 'Recomenda-se anexar a pesquisa do PCA.',
          ruleId: WARNING_RULE,
          sectionKey: null,
          field: null,
          itemId: null,
          params: {},
          name: 'PCA',
          type: 'REQUIRED_DOCUMENT',
          satisfied: false,
          scope: 'STAGE_EXIT',
        },
      ],
    });
    const autosave = autosaveOf();
    const user = userEvent.setup();
    renderStep({ autosave });

    expect(await screen.findByRole('heading', { name: 'Pronto para envio' })).toBeTruthy();
    expect(screen.getByText(`Aprovação da demanda — ${APPROVER}`)).toBeTruthy();
    expect(screen.getByText('até 08/10/2026')).toBeTruthy();
    expect(screen.getByText('DFD 0005/2026 · Rascunho')).toBeTruthy();
    const send = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Concluir e enviar para aprovação',
    });
    // FA-03: cada alerta exige "Estou ciente".
    expect(send.disabled).toBe(true);
    expect(await seriousA11yViolations()).toEqual([]);
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Estou ciente: Há 1 anexo em verificação de segurança.',
      }),
    );
    expect(send.disabled).toBe(true);
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Estou ciente: Recomenda-se anexar a pesquisa do PCA.',
      }),
    );
    expect(send.disabled).toBe(false);
    await user.type(
      screen.getByLabelText('Mensagem ao aprovador (opcional)'),
      'Demanda urgente para reposição de estoque',
    );

    await user.click(send);

    await waitFor(() => {
      expect(ui.push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}`);
    });
    expect(autosave.flush).toHaveBeenCalled();
    const [call] = callsTo(api, 'POST', `/api/v1/processes/${PROCESS_ID}/forward`);
    expect(call?.headers.get('If-Match')).toBe('"1"');
    expect(call?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(call?.body).toEqual({
      transitionId: TRANSITION,
      expectedStageId: STAGE,
      comment: 'Demanda urgente para reposição de estoque',
      acknowledgedWarnings: ['DFD_ATTACHMENTS_PENDING', WARNING_RULE],
      documentIds: [DFD_ID],
    });
    expect(ui.toast).toHaveBeenCalledWith({
      title: `DFD 0005/2026 enviado para aprovação de ${APPROVER}.`,
      tone: 'success',
    });
  });

  it('[Sucesso] FA-01: sem custódia e com FINALIZE, "Finalizar DFD" envia o DOC-10 com a revisão conferida e a versão atual', async () => {
    const api = mockApi({
      actions: [
        sendEntry({
          enabled: false,
          reasons: [
            { code: 'NOT_PROCESS_CUSTODIAN', message: 'Somente quem está com o processo.' },
          ],
        }),
      ],
    });
    const user = userEvent.setup();
    renderStep();

    const finalize = await screen.findByRole('button', { name: 'Finalizar DFD' });
    expect(screen.queryByRole('button', { name: 'Concluir e enviar para aprovação' })).toBeNull();
    expect(screen.queryByLabelText('Mensagem ao aprovador (opcional)')).toBeNull();
    await user.click(finalize);

    await waitFor(() => {
      expect(ui.toast).toHaveBeenCalledWith({
        title: 'DFD finalizado — encaminhe para aprovação.',
        tone: 'success',
      });
    });
    const [call] = callsTo(api, 'POST', `/api/v1/documents/${DFD_ID}/finalize`);
    expect(call?.headers.get('If-Match')).toBe('"5"');
    expect(call?.body).toEqual({ acknowledgedWarnings: [], expectedDraftRevision: 7 });
    expect(ui.push).not.toHaveBeenCalled();
  });

  it('[Validação] FA-02: pendências obrigatórias desabilitam o envio; TRANSITION_BLOCKED recarrega o DOC-08', async () => {
    let blocking = false;
    const api = mockApi({
      validation: () =>
        validationDto(
          blocking
            ? [
                {
                  ...warning('SECTION_REQUIRED', 'Preencha a justificativa.'),
                  severity: 'BLOCKING',
                  sectionKey: 'JUSTIFICATION',
                },
              ]
            : [],
        ),
      forward: () => {
        blocking = true;
        return problemResponse(422, 'TRANSITION_BLOCKED', {
          detail: 'Há pendências obrigatórias.',
        });
      },
    });
    const user = userEvent.setup();
    renderStep();

    // A pendência surge entre a tela e o servidor: o DOC-08 repetido antes do envio ainda passa.
    const send = await screen.findByRole('button', { name: 'Concluir e enviar para aprovação' });
    await user.click(send);

    expect(await screen.findByText('Há 1 pendência obrigatória')).toBeTruthy();
    expect(screen.getByText('Há pendências obrigatórias no DFD.')).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Concluir e enviar para aprovação' })
        .disabled,
    ).toBe(true);
    expect(callsTo(api, 'POST', `/api/v1/processes/${PROCESS_ID}/forward`)).toHaveLength(1);
    expect(ui.push).not.toHaveBeenCalled();
  });

  it('[Validação] FA-10 e V-11: autosave com erro impede concluir; mensagem acima de 5.000 caracteres desabilita o envio', async () => {
    const api = mockApi();
    const user = userEvent.setup();
    renderStep({ autosave: autosaveOf('error') });

    const send = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Concluir e enviar para aprovação',
    });
    await user.click(send);
    expect(
      await screen.findByText(
        'Não foi possível salvar as últimas alterações. Resolva antes de concluir.',
      ),
    ).toBeTruthy();
    expect(callsTo(api, 'POST', `/api/v1/processes/${PROCESS_ID}/forward`)).toEqual([]);

    const field = screen.getByLabelText('Mensagem ao aprovador (opcional)');
    await user.click(field);
    await user.paste('a'.repeat(5001));
    expect(screen.getByText('A mensagem pode ter até 5.000 caracteres.')).toBeTruthy();
    expect(send.disabled).toBe(true);
  });

  it('[Permissão] sem envio nem finalização: os botões não aparecem e a tela diz quem envia', async () => {
    mockApi({
      actions: [
        sendEntry({
          enabled: false,
          reasons: [
            { code: 'NOT_PROCESS_CUSTODIAN', message: 'Somente quem está com o processo.' },
          ],
        }),
      ],
    });
    renderStep({ allowedActions: ['UPDATE'] });

    expect(
      await screen.findByText(
        'O envio para aprovação é feito por quem está com o processo (Ana Souza).',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Concluir e enviar para aprovação' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finalizar DFD' })).toBeNull();
  });

  it('[Concorrência] FA-05: STAGE_CHANGED informa que o processo foi movimentado por outra pessoa', async () => {
    mockApi({
      forward: () =>
        problemResponse(409, 'STAGE_CHANGED', {
          detail: 'O processo foi movimentado por outra pessoa.',
        }),
    });
    const user = userEvent.setup();
    renderStep();

    await user.click(
      await screen.findByRole('button', { name: 'Concluir e enviar para aprovação' }),
    );

    expect(await screen.findByText('O processo foi movimentado por outra pessoa.')).toBeTruthy();
    expect(ui.push).not.toHaveBeenCalled();
  });

  it('Modo leitura depois do envio: faixa "Em aprovação — versão 1 enviada em …" e "Baixar PDF (versão 1)"', async () => {
    mockApi();
    renderStep({
      autosave: null,
      allowedActions: [],
      document: documentDto({
        status: 'IN_REVIEW',
        pendingApprovalId: ID(991),
        currentVersionId: ID(992),
        currentVersionNumber: 1,
        submittedAt: '2026-10-05T17:40:00.000Z',
      }),
    });

    expect(
      await screen.findByText('Em aprovação — versão 1 enviada em 05/10/2026, 14:40'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Baixar PDF \(versão 1\)/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Concluir e enviar para aprovação' })).toBeNull();
  });
});

describe('dfd-conclusion-model', () => {
  it('modo: envio quando o PRC-08 oferece a transição (mesmo bloqueada); senão finalizar ou nada', () => {
    const blocked = sendEntry({
      enabled: false,
      reasons: [{ code: 'TRANSITION_BLOCKED', message: 'O DFD deve estar completo.' }],
    });
    expect(conclusionModeOf([blocked], [])).toEqual({ kind: 'SEND', entry: blocked });
    const status = sendEntry({
      enabled: false,
      reasons: [{ code: 'INVALID_PROCESS_STATUS', message: 'Suspenso.' }],
    });
    expect(conclusionModeOf([status], ['FINALIZE'])).toEqual({ kind: 'FINALIZE' });
    expect(conclusionModeOf([], [])).toEqual({ kind: 'NONE' });
    const secondary = sendEntry({ primary: false, transitionId: ID(902) });
    expect(conclusionModeOf([secondary, sendEntry()], [])).toMatchObject({
      entry: { transitionId: TRANSITION },
    });
  });

  it('alertas: os do DFD e os do workflow da transição escolhida, sem repetir; satisfeitos ficam de fora', () => {
    const rule = (ruleId: string, extra: Partial<ChecklistViolation> = {}) =>
      ({
        ...warning('WORKFLOW_RULE', `Regra ${ruleId}`),
        ruleId,
        name: ruleId,
        type: 'CONDITION',
        satisfied: false,
        scope: 'STAGE_EXIT',
        ...extra,
      }) as ChecklistViolation;
    const warnings = conclusionWarnings(
      validationDto([
        warning('DFD_ATTACHMENTS_PENDING', 'Anexo'),
        warning('DFD_ATTACHMENTS_PENDING', 'Anexo'),
      ]),
      [
        rule(ID(1)),
        rule(ID(2), { satisfied: true }),
        rule(ID(3), { transitionId: ID(999) }),
        rule(ID(4), { transitionId: TRANSITION }),
        rule(ID(5), { severity: 'BLOCKING' }),
      ],
      TRANSITION,
    );
    expect(warnings.map((item) => item.key)).toEqual(['DFD_ATTACHMENTS_PENDING', ID(1), ID(4)]);
    expect(conclusionWarnings(undefined, [rule(ID(1))], null)).toEqual([]);
  });

  it('corpo do PRC-19 sem comentário vazio; erros traduzidos com o que recarregar; faixa só com o selo', () => {
    expect(
      buildConclusionForwardBody({
        entry: sendEntry(),
        expectedStageId: STAGE,
        documentId: DFD_ID,
        message: '   ',
        acknowledged: [],
      }),
    ).toEqual({
      transitionId: TRANSITION,
      expectedStageId: STAGE,
      acknowledgedWarnings: [],
      documentIds: [DFD_ID],
    });
    const error = (status: number, code: string) => new ApiError({ status, code });
    expect(describeConclusionError(error(422, 'WARNINGS_NOT_ACKNOWLEDGED'))).toMatchObject({
      key: 'warnings',
      reload: 'validation',
    });
    expect(describeConclusionError(error(412, 'VERSION_CONFLICT')).key).toBe('versionConflict');
    expect(describeConclusionError(error(422, 'APPROVER_UNRESOLVED')).key).toBe(
      'approverUnresolved',
    );
    expect(describeConclusionError(error(403, 'PERMISSION_DENIED')).key).toBe('forbidden');
    expect(describeConclusionError(error(409, 'DOCUMENT_NOT_EDITABLE')).key).toBe('notEditable');
    expect(describeConclusionError(error(409, 'IDEMPOTENCY_IN_PROGRESS')).key).toBe('inProgress');
    expect(describeConclusionError(error(503, 'DEPENDENCY_UNAVAILABLE')).key).toBe('unavailable');
    expect(describeConclusionError(new Error('x')).key).toBe('unexpected');
    expect(inApprovalOf(documentDto())).toBeNull();
    expect(
      inApprovalOf(
        documentDto({ status: 'FINALIZED', pendingApprovalId: ID(5), currentVersionNumber: 1 }),
      ),
    ).toEqual({ versionNumber: 1, sentAt: null });
  });
});
