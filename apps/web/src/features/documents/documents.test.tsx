// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type {
  DocumentAction,
  DocumentDto,
  DocumentStatus,
  Violation,
} from '@contrataflow/validation';
import type { QueryClient } from '@tanstack/react-query';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import { ID, PROCESS_ID, callsTo, problemResponse } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { DocumentView } from './document-view';
import { ReopenDialog } from './reason-dialog';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, refresh: vi.fn() }),
  usePathname: () => '/processos',
}));

/*
 * US-065 — SCR-105: visualizador do documento com o ciclo de vida (DOC-03/08/09/10/12/13/14).
 * Botões por `meta.allowedActions`, painel de pendências, reconhecimento de avisos, justificativas,
 * exclusão do rascunho e as recusas da API (412, 409, 403, 422, 503).
 */

const DOC = ID(500);
const DOC_URL = `/api/v1/documents/${DOC}`;
const SHORT_REASON = 'curta demais';
const REASON = 'O parecer precisa de ajustes antes da próxima etapa.';

function documentDto(extra: Partial<DocumentDto> = {}): DocumentDto {
  return {
    id: DOC,
    processId: PROCESS_ID,
    documentType: {
      id: ID(501),
      code: 'PARECER',
      name: 'Parecer técnico',
      kind: 'FREE_TEXT',
      systemModule: null,
      requiresApproval: false,
    },
    templateVersionId: null,
    number: 7,
    year: 2026,
    code: 'PARECER 0007/2026',
    title: 'Parecer sobre a aquisição de cimento',
    status: 'DRAFT',
    confidentiality: 'INTERNAL',
    draftContent: { sections: {} },
    draftRevision: 4,
    currentVersionId: ID(502),
    currentVersionNumber: 2,
    approvedVersionId: null,
    pendingApprovalId: null,
    responsibleId: ID(1),
    submittedAt: null,
    submittedById: null,
    finalizedAt: null,
    finalizedById: null,
    approvedAt: null,
    returnedAt: null,
    rejectedAt: null,
    reopenedAt: null,
    reopenedById: null,
    reopenReason: null,
    canceledAt: null,
    canceledById: null,
    cancellationReason: null,
    sourceDocumentId: null,
    createdAt: '2026-10-16T12:00:00.000Z',
    updatedAt: '2026-10-16T12:30:00.000Z',
    createdById: ID(1),
    version: 3,
    ...extra,
  };
}

function violation(extra: Partial<Violation> = {}): Violation {
  return {
    code: 'SECTION_REQUIRED',
    severity: 'BLOCKING',
    message: 'A seção "Justificativa" é obrigatória.',
    ruleId: null,
    sectionKey: 'JUSTIFICATIVA',
    field: null,
    itemId: null,
    params: {},
    ...extra,
  };
}

const BLOCKING = violation();
const WARNING_A = violation({
  code: 'SECTION_EMPTY_OPTIONAL',
  severity: 'WARNING',
  message: 'A seção "Anexos" está vazia.',
  sectionKey: 'ANEXOS',
});
const WARNING_B = violation({
  code: 'HEADER_FIELD_MISSING',
  severity: 'WARNING',
  message: 'O campo "Prazo" não foi preenchido.',
  sectionKey: null,
  field: 'deadline',
});

function documentResponse(
  document: DocumentDto,
  allowedActions: readonly DocumentAction[],
): Response {
  return jsonResponse(
    { data: document, meta: { allowedActions } },
    { headers: { ETag: `"${String(document.version)}"` } },
  );
}

function validationResponse(violations: readonly Violation[]): Response {
  const blocking = violations.filter((item) => item.severity === 'BLOCKING').length;
  return jsonResponse({
    data: {
      documentId: DOC,
      isComplete: blocking === 0,
      draftRevision: 4,
      evaluatedAt: '2026-10-16T12:31:00.000Z',
      summary: { blocking, warnings: violations.length - blocking },
      sections: [],
      violations,
    },
  });
}

interface DocumentState {
  document: DocumentDto;
  allowed: readonly DocumentAction[];
}

interface Routes {
  readonly state?: DocumentState;
  readonly detail?: () => Response;
  readonly validation?: () => Response;
  /** Resposta dos comandos (`finalize`, `submit`, `reopen`, `cancel`) e do DELETE. */
  readonly command?: (action: string, init?: RequestInit) => Response;
}

/** API simulada do documento: o detalhe devolve o estado corrente, que os comandos podem mudar. */
function mockDocumentApi(routes: Routes = {}) {
  const state = routes.state ?? { document: documentDto(), allowed: ['UPDATE', 'FINALIZE'] };
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === DOC_URL) {
      return Promise.resolve(
        routes.detail ? routes.detail() : documentResponse(state.document, state.allowed),
      );
    }
    if (method === 'GET' && url === `${DOC_URL}/validation`) {
      return Promise.resolve(routes.validation ? routes.validation() : validationResponse([]));
    }
    if (method === 'DELETE' && url === DOC_URL) {
      return Promise.resolve(
        routes.command ? routes.command('delete', init) : new Response(null, { status: 204 }),
      );
    }
    const command = /^\/api\/v1\/documents\/[^/]+\/(finalize|submit|reopen|cancel)$/.exec(url)?.[1];
    if (method === 'POST' && command) {
      return Promise.resolve(
        routes.command
          ? routes.command(command, init)
          : documentResponse(state.document, state.allowed),
      );
    }
    return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, state };
}

function renderView(options: { readonly queryClient?: QueryClient } = {}) {
  return renderWithShell(
    <>
      <DocumentView processId={PROCESS_ID} documentId={DOC} />
      <Toaster label="Notificações" closeLabel="Fechar" />
    </>,
    options,
  );
}

async function openDocument(...args: Parameters<typeof mockDocumentApi>) {
  const api = mockDocumentApi(...args);
  const view = renderView();
  await screen.findByRole('heading', { level: 1, name: 'Parecer sobre a aquisição de cimento' });
  return { ...api, ...view };
}

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

const sentHeaders = (fetchMock: ReturnType<typeof mockDocumentApi>['fetchMock'], url: string) =>
  callsTo(fetchMock, 'POST', url).map((call) => call.headers);

beforeEach(() => {
  nav.push.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('SCR-105 · cabeçalho do documento', () => {
  it('mostra código, título, tipo, status e a versão corrente (axe sem violações sérias)', async () => {
    await openDocument();
    expect(screen.getByText('PARECER 0007/2026')).toBeTruthy();
    expect(screen.getByText('Rascunho')).toBeTruthy();
    expect(screen.getByText('Tipo: Parecer técnico')).toBeTruthy();
    expect(screen.getByText('Versão 2')).toBeTruthy();
    expect(screen.queryByText('Em aprovação')).toBeNull();
    expect(screen.getByRole('link', { name: 'Voltar ao processo' }).getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}`,
    );
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('com aprovação pendente mostra o selo "Em aprovação" ao lado do status', async () => {
    await openDocument({
      state: {
        document: documentDto({ status: 'FINALIZED', pendingApprovalId: ID(600) }),
        allowed: [],
      },
    });
    expect(screen.getByText('Finalizado')).toBeTruthy();
    expect(screen.getByText('Em aprovação')).toBeTruthy();
  });

  it('sem versão e cancelado: "Nenhuma versão registrada" e o motivo do cancelamento', async () => {
    await openDocument({
      state: {
        document: documentDto({
          status: 'CANCELED',
          currentVersionNumber: null,
          cancellationReason: 'Documento substituído por outro parecer.',
        }),
        allowed: [],
      },
    });
    expect(screen.getByText('Cancelado')).toBeTruthy();
    expect(screen.getByText('Nenhuma versão registrada')).toBeTruthy();
    expect(screen.getByText('Documento substituído por outro parecer.')).toBeTruthy();
  });
});

describe('DocumentActionsBar · botões por meta.allowedActions', () => {
  it('só as ações permitidas viram botão, e UPDATE não gera botão', async () => {
    await openDocument({
      state: { document: documentDto(), allowed: ['UPDATE', 'FINALIZE', 'CANCEL', 'DELETE'] },
    });
    const group = screen.getByRole('group', { name: 'Ações do documento' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Finalizar', 'Cancelar documento', 'Excluir rascunho']);
  });

  it('documento finalizado oferece Reabrir; o rascunho de tipo com aprovação, Submeter', async () => {
    const first = await openDocument({
      state: { document: documentDto({ status: 'FINALIZED' }), allowed: ['REOPEN'] },
    });
    expect(screen.getByRole('button', { name: 'Reabrir' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Finalizar' })).toBeNull();
    first.unmount();

    await openDocument({ state: { document: documentDto(), allowed: ['UPDATE', 'SUBMIT'] } });
    expect(screen.getByRole('button', { name: 'Submeter' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reabrir' })).toBeNull();
  });

  it('sem ações permitidas: avisa que nenhuma ação está disponível', async () => {
    await openDocument({ state: { document: documentDto(), allowed: ['UPDATE'] } });
    expect(screen.getByText('Nenhuma ação disponível para você neste documento.')).toBeTruthy();
    // `UPDATE` sozinho só libera "Salvar versão" (US-066), fora da barra do ciclo de vida.
    expect(screen.queryAllByRole('button').map((button) => button.textContent)).toEqual([
      'Salvar versão',
    ]);
  });

  it('abaixo de 768 px a ação principal fica visível e as demais vão para "Mais ações"', async () => {
    stubMatchMedia(false);
    await openDocument({
      state: { document: documentDto(), allowed: ['FINALIZE', 'CANCEL', 'DELETE'] },
    });
    const user = userEvent.setup();
    expect(screen.getByRole('button', { name: 'Finalizar' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancelar documento' })).toBeNull();

    const more = screen.getByRole('button', { name: 'Mais ações' });
    await user.click(more);
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
      'Cancelar documento',
      'Excluir rascunho',
    ]);

    // A escolha abre o diálogo; ao fechar, o foco volta ao gatilho do menu.
    await user.click(screen.getByRole('menuitem', { name: 'Cancelar documento' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancelar documento' });
    await user.click(within(dialog).getByRole('button', { name: 'Voltar' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(more);
    });
  });
});

describe('CompletenessPanel · finalizar com pendências', () => {
  it('bloqueantes primeiro, foco na primeira pendência e ação desabilitada (axe sem violações sérias)', async () => {
    const { fetchMock } = await openDocument({
      validation: () => validationResponse([WARNING_A, BLOCKING]),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Finalizar' }));

    const panel = await screen.findByRole('region', {
      name: 'Pendências para finalizar o documento',
    });
    const items = within(
      await within(panel).findByRole('list', { name: 'Pendências do documento' }),
    ).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'BloqueanteA seção "Justificativa" é obrigatória.Seção: JUSTIFICATIVA',
      'AvisoA seção "Anexos" está vazia.Seção: ANEXOS',
    ]);
    expect(within(panel).getByText('1 pendência bloqueante e 1 aviso')).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(items[0]);
    });

    const confirm = within(panel).getByRole('button', { name: 'Confirmar finalização' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    const reason = within(panel).getByText('Há pendências que impedem esta ação.');
    expect(confirm.getAttribute('aria-describedby')).toBe(reason.id);
    expect(callsTo(fetchMock, 'POST', `${DOC_URL}/finalize`)).toHaveLength(0);
    expect(await seriousA11yViolations()).toEqual([]);

    // "Fechar" encerra o painel e devolve o foco ao botão que o abriu.
    await user.click(within(panel).getByRole('button', { name: 'Fechar' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Finalizar' }));
    });
    expect(screen.queryByRole('region', { name: /^Pendências para/ })).toBeNull();
  });

  it('referencia o campo do cabeçalho quando a pendência não é de uma seção', async () => {
    await openDocument({ validation: () => validationResponse([WARNING_B]) });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Finalizar' }));
    expect(await screen.findByText('Campo: deadline')).toBeTruthy();
  });

  it('falha ao consultar as pendências: mensagem e "Tentar novamente"', async () => {
    let healthy = false;
    await openDocument({
      validation: () => (healthy ? validationResponse([]) : problemResponse(500, 'INTERNAL_ERROR')),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Finalizar' }));
    expect(await screen.findByText('Não foi possível verificar as pendências agora.')).toBeTruthy();
    healthy = true;
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(
      await screen.findByText(
        'Nenhuma pendência encontrada. O documento está pronto para ser finalizado.',
      ),
    ).toBeTruthy();
  });
});

describe('Finalizar e submeter', () => {
  it.each([
    {
      button: 'Finalizar',
      action: 'finalize',
      confirm: 'Confirmar finalização',
      toast: 'Documento finalizado.',
    },
    {
      button: 'Submeter',
      action: 'submit',
      confirm: 'Confirmar submissão',
      toast: 'Documento submetido.',
    },
  ])(
    '$button sem pendências: confirma, envia com If-Match e Idempotency-Key, avisa e recarrega',
    async ({ button, action, confirm, toast }) => {
      const state: DocumentState = {
        document: documentDto(),
        allowed: ['UPDATE', action === 'finalize' ? 'FINALIZE' : 'SUBMIT'],
      };
      const { fetchMock } = await openDocument({
        state,
        command: () => {
          // Depois do comando o documento está finalizado e só pode ser reaberto.
          state.document = documentDto({
            status: action === 'finalize' ? 'FINALIZED' : 'IN_REVIEW',
            version: 4,
            currentVersionNumber: 3,
          });
          state.allowed = ['REOPEN'];
          return documentResponse(state.document, state.allowed);
        },
      });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: button }));
      expect(await screen.findByText(/Nenhuma pendência encontrada\./)).toBeTruthy();
      await user.click(screen.getByRole('button', { name: confirm }));

      expect(await screen.findByText(toast)).toBeTruthy();
      const [call] = callsTo(fetchMock, 'POST', `${DOC_URL}/${action}`);
      expect(call?.headers.get('If-Match')).toBe('"3"');
      expect(call?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
      expect(call?.body).toEqual({});

      // Resposta aplicada e documento recarregado (DOC-03 duas vezes: carga + refetch).
      await waitFor(() => {
        expect(callsTo(fetchMock, 'GET', DOC_URL)).toHaveLength(2);
      });
      expect(await screen.findByRole('button', { name: 'Reabrir' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: button })).toBeNull();
      expect(screen.queryByRole('region', { name: /^Pendências para/ })).toBeNull();
      expect(screen.getByText('Versão 3')).toBeTruthy();
      // O botão que abriu o fluxo saiu da tela: o foco vai ao título.
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
      });
    },
  );

  it('só avisos: reconhecimento obrigatório e envio de acknowledgedWarnings com os códigos', async () => {
    const { fetchMock } = await openDocument({
      validation: () => validationResponse([WARNING_A, WARNING_B]),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Finalizar' }));
    const panel = await screen.findByRole('region', {
      name: 'Pendências para finalizar o documento',
    });
    await within(panel).findByText('2 avisos');
    await user.click(within(panel).getByRole('button', { name: 'Continuar' }));

    const dialog = await screen.findByRole('dialog', { name: 'Reconhecer os avisos' });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2);
    const checkbox = within(dialog).getByRole('checkbox', { name: 'Reconheço os avisos' });
    await waitFor(() => {
      expect(document.activeElement).toBe(checkbox);
    });
    const confirm = within(dialog).getByRole('button', { name: 'Confirmar finalização' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(await seriousA11yViolations()).toEqual([]);

    await user.click(checkbox);
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await user.click(confirm);

    expect(await screen.findByText('Documento finalizado.')).toBeTruthy();
    const [call] = callsTo(fetchMock, 'POST', `${DOC_URL}/finalize`);
    expect(call?.body).toEqual({
      acknowledgedWarnings: ['SECTION_EMPTY_OPTIONAL', 'HEADER_FIELD_MISSING'],
    });
    expect(call?.headers.get('If-Match')).toBe('"3"');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('cancelar o reconhecimento volta ao painel com o foco em "Continuar"', async () => {
    await openDocument({ validation: () => validationResponse([WARNING_A]) });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Finalizar' }));
    const panel = await screen.findByRole('region', {
      name: 'Pendências para finalizar o documento',
    });
    const next = await within(panel).findByRole('button', { name: 'Continuar' });
    await user.click(next);
    const dialog = await screen.findByRole('dialog', { name: 'Reconhecer os avisos' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(next);
    });
  });

  it('422 DOCUMENT_INCOMPLETE no envio: o painel reabre com as violations do erro', async () => {
    await openDocument({
      // A consulta ainda via o documento completo; a API, no envio, achou uma pendência.
      validation: () => validationResponse([]),
      command: () =>
        problemResponse(422, 'DOCUMENT_INCOMPLETE', {
          detail: 'Há pendências que impedem esta ação.',
          extension: { violations: [BLOCKING] },
        }),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Finalizar' }));
    await user.click(await screen.findByRole('button', { name: 'Confirmar finalização' }));

    const panel = await screen.findByRole('region', {
      name: 'Pendências para finalizar o documento',
    });
    expect(await within(panel).findByText('A seção "Justificativa" é obrigatória.')).toBeTruthy();
    expect(
      within(panel).getByRole<HTMLButtonElement>('button', { name: 'Confirmar finalização' })
        .disabled,
    ).toBe(true);
    expect(within(panel).getByText('Há pendências que impedem esta ação.')).toBeTruthy();
  });

  it('422 WARNINGS_NOT_ACKNOWLEDGED no envio: o painel reabre pedindo o reconhecimento', async () => {
    await openDocument({
      validation: () => validationResponse([]),
      command: () =>
        problemResponse(422, 'WARNINGS_NOT_ACKNOWLEDGED', {
          extension: { violations: [WARNING_A] },
        }),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Finalizar' }));
    await user.click(await screen.findByRole('button', { name: 'Confirmar finalização' }));
    expect(await screen.findByRole('button', { name: 'Continuar' })).toBeTruthy();
    expect(screen.getByText('A seção "Anexos" está vazia.')).toBeTruthy();
  });
});

describe('recusas da API', () => {
  it('412 VERSION_CONFLICT: toast de conflito, painel fechado e documento recarregado', async () => {
    const { fetchMock } = await openDocument({
      command: () => problemResponse(412, 'VERSION_CONFLICT'),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Finalizar' }));
    await user.click(await screen.findByRole('button', { name: 'Confirmar finalização' }));

    expect(
      await screen.findByText(
        'Esta informação foi atualizada por outra pessoa. Recarregue e tente novamente.',
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(callsTo(fetchMock, 'GET', DOC_URL)).toHaveLength(2);
    });
    expect(screen.queryByRole('region', { name: /^Pendências para/ })).toBeNull();
  });

  it('409 INVALID_STATE: toast com o detail e botões novos conforme o meta.allowedActions recarregado', async () => {
    const state: DocumentState = { document: documentDto(), allowed: ['UPDATE', 'FINALIZE'] };
    await openDocument({
      state,
      command: () => {
        // Alguém finalizou antes: o documento recarregado só aceita "Reabrir".
        state.document = documentDto({ status: 'FINALIZED', version: 4 });
        state.allowed = ['REOPEN'];
        return problemResponse(409, 'INVALID_STATE', {
          detail: 'Esta ação não está disponível para o status atual do documento.',
        });
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Finalizar' }));
    await user.click(await screen.findByRole('button', { name: 'Confirmar finalização' }));

    expect(
      await screen.findByText('Esta ação não está disponível para o status atual do documento.'),
    ).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Reabrir' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Finalizar' })).toBeNull();
    expect(screen.getByText('Finalizado')).toBeTruthy();
  });

  it('403 NOT_PROCESS_CUSTODIAN no cancelamento: toast com o detail e o botão some após recarregar', async () => {
    const state: DocumentState = { document: documentDto(), allowed: ['CANCEL'] };
    await openDocument({
      state,
      command: () => {
        state.allowed = [];
        return problemResponse(403, 'NOT_PROCESS_CUSTODIAN', {
          detail: 'Apenas o responsável atual pelo processo pode cancelar este documento.',
        });
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Cancelar documento' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancelar documento' });
    await user.type(within(dialog).getByRole('textbox'), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar cancelamento' }));

    expect(
      await screen.findByText(
        'Apenas o responsável atual pelo processo pode cancelar este documento.',
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Cancelar documento' })).toBeNull();
    });
  });

  it('503: "Tentar novamente" reenvia com a mesma Idempotency-Key', async () => {
    let attempts = 0;
    const { fetchMock } = await openDocument({
      command: () => {
        attempts += 1;
        // As retentativas automáticas (3) também falham; só o "Tentar novamente" manual passa.
        return attempts <= 4
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
          : documentResponse(documentDto({ status: 'FINALIZED', version: 4 }), ['REOPEN']);
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Finalizar' }));
    await user.click(await screen.findByRole('button', { name: 'Confirmar finalização' }));

    expect(
      await screen.findByText('Não foi possível concluir a ação agora.', {}, { timeout: 10_000 }),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Documento finalizado.')).toBeTruthy();

    const keys = sentHeaders(fetchMock, `${DOC_URL}/finalize`).map((headers) =>
      headers.get('Idempotency-Key'),
    );
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(1);
  });
});

describe('ReopenDialog e CancelDialog · justificativa', () => {
  it('Reabrir: foco no campo, erro com menos de 20 caracteres e envio com a justificativa válida', async () => {
    const state: DocumentState = {
      document: documentDto({ status: 'FINALIZED' }),
      allowed: ['REOPEN'],
    };
    const { fetchMock } = await openDocument({
      state,
      command: () => {
        state.document = documentDto({ status: 'DRAFT', version: 4, reopenReason: REASON });
        state.allowed = ['UPDATE', 'FINALIZE'];
        return documentResponse(state.document, state.allowed);
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reabrir' }));

    const dialog = await screen.findByRole('dialog', { name: 'Reabrir documento' });
    const field = within(dialog).getByRole('textbox', { name: 'Justificativa da reabertura' });
    await waitFor(() => {
      expect(document.activeElement).toBe(field);
    });
    expect(within(dialog).getByText('Mínimo de 20 caracteres.')).toBeTruthy();
    expect(within(dialog).getByText('0 de 2.000 caracteres')).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);

    await user.type(field, SHORT_REASON);
    expect(within(dialog).getByText('12 de 2.000 caracteres')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar reabertura' }));
    const error = within(dialog).getByText('Justifique com pelo menos 20 caracteres.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')?.split(' ')).toContain(error.id);
    expect(callsTo(fetchMock, 'POST', `${DOC_URL}/reopen`)).toHaveLength(0);
    expect(document.activeElement).toBe(field);
    expect(await seriousA11yViolations()).toEqual([]);

    await user.clear(field);
    await user.type(field, REASON);
    expect(within(dialog).queryByText('Justifique com pelo menos 20 caracteres.')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar reabertura' }));

    expect(await screen.findByText('Documento reaberto.')).toBeTruthy();
    const [call] = callsTo(fetchMock, 'POST', `${DOC_URL}/reopen`);
    expect(call?.body).toEqual({ reopenReason: REASON });
    expect(call?.headers.get('If-Match')).toBe('"3"');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(await screen.findByRole('button', { name: 'Finalizar' })).toBeTruthy();
    expect(screen.getByText('Rascunho')).toBeTruthy();
  });

  it('fechar sem enviar devolve o foco ao botão "Reabrir"', async () => {
    await openDocument({
      state: { document: documentDto({ status: 'FINALIZED' }), allowed: ['REOPEN'] },
    });
    const user = userEvent.setup();
    const opener = screen.getByRole('button', { name: 'Reabrir' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Reabrir documento' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });

    // Esc também fecha, e o foco volta ao mesmo botão.
    await user.click(opener);
    await screen.findByRole('dialog', { name: 'Reabrir documento' });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it('Cancelar documento: motivo obrigatório e envio de cancellationReason', async () => {
    const state: DocumentState = { document: documentDto(), allowed: ['FINALIZE', 'CANCEL'] };
    const { fetchMock } = await openDocument({
      state,
      command: () => {
        state.document = documentDto({
          status: 'CANCELED',
          version: 4,
          cancellationReason: REASON,
        });
        state.allowed = [];
        return documentResponse(state.document, state.allowed);
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Cancelar documento' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancelar documento' });
    const field = within(dialog).getByRole('textbox', { name: 'Motivo do cancelamento' });

    await user.click(within(dialog).getByRole('button', { name: 'Confirmar cancelamento' }));
    expect(within(dialog).getByText('Justifique com pelo menos 20 caracteres.')).toBeTruthy();
    expect(callsTo(fetchMock, 'POST', `${DOC_URL}/cancel`)).toHaveLength(0);

    await user.type(field, REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar cancelamento' }));
    expect(await screen.findByText('Documento cancelado.')).toBeTruthy();
    const [call] = callsTo(fetchMock, 'POST', `${DOC_URL}/cancel`);
    expect(call?.body).toEqual({ cancellationReason: REASON });
    expect(call?.headers.get('If-Match')).toBe('"3"');
    expect(await screen.findByText('Cancelado')).toBeTruthy();
    expect(screen.getByText('Motivo do cancelamento')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Ações do documento' })).toBeNull();
  });

  it('422 de campo do servidor aparece junto ao campo e o diálogo continua aberto', async () => {
    await openDocument({
      state: { document: documentDto({ status: 'FINALIZED' }), allowed: ['REOPEN'] },
      command: () =>
        problemResponse(422, 'VALIDATION_ERROR', {
          errors: [
            {
              field: 'reopenReason',
              code: 'TOO_SHORT',
              message: 'Justifique com pelo menos 20 caracteres.',
            },
          ],
        }),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reabrir' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reabrir documento' });
    await user.type(within(dialog).getByRole('textbox'), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar reabertura' }));
    expect(
      await within(dialog).findByText('Justifique com pelo menos 20 caracteres.'),
    ).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Reabrir documento' })).toBeTruthy();
  });
});

describe('ReopenDialog isolado', () => {
  it('devolve o foco a quem o abriu, sem depender do DocumentLifecycle', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            Abrir diálogo
          </button>
          <ReopenDialog
            open={open}
            pending={false}
            feedback={null}
            onSubmit={vi.fn()}
            onRetry={vi.fn()}
            onClose={() => {
              setOpen(false);
            }}
          />
        </>
      );
    }
    renderWithShell(<Harness />);
    const user = userEvent.setup();
    const opener = screen.getByRole('button', { name: 'Abrir diálogo' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Reabrir documento' });
    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog).getByRole('textbox'));
    });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });
});

describe('Excluir rascunho', () => {
  it('confirma, envia DELETE com If-Match e volta ao painel do processo, aba Documentos', async () => {
    const { fetchMock } = await openDocument({
      state: { document: documentDto(), allowed: ['UPDATE', 'FINALIZE', 'DELETE'] },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Excluir rascunho' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Excluir rascunho?' });
    expect(
      within(dialog).getByText('O rascunho será excluído e não poderá ser recuperado.'),
    ).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
    expect(callsTo(fetchMock, 'DELETE', DOC_URL)).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Confirmar exclusão' }));
    expect(await screen.findByText('Rascunho excluído.')).toBeTruthy();
    const [call] = callsTo(fetchMock, 'DELETE', DOC_URL);
    expect(call?.headers.get('If-Match')).toBe('"3"');
    expect(nav.push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}?aba=documentos`);
    // O documento excluído não é buscado de novo.
    expect(callsTo(fetchMock, 'GET', DOC_URL)).toHaveLength(1);
  });

  it('"Cancelar" na confirmação não exclui nada', async () => {
    const { fetchMock } = await openDocument({
      state: { document: documentDto(), allowed: ['DELETE'] },
    });
    const user = userEvent.setup();
    const opener = screen.getByRole('button', { name: 'Excluir rascunho' });
    await user.click(opener);
    const dialog = await screen.findByRole('alertdialog', { name: 'Excluir rascunho?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
    expect(callsTo(fetchMock, 'DELETE', DOC_URL)).toHaveLength(0);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('409 INVALID_STATE (já submetido): toast com o detail e o botão some', async () => {
    const state: DocumentState = { document: documentDto(), allowed: ['DELETE'] };
    await openDocument({
      state,
      command: () => {
        state.allowed = ['CANCEL'];
        return problemResponse(409, 'INVALID_STATE', {
          detail: 'Este documento já foi submetido; só pode ser cancelado.',
        });
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Excluir rascunho' }));
    await user.click(await screen.findByRole('button', { name: 'Confirmar exclusão' }));
    expect(
      await screen.findByText('Este documento já foi submetido; só pode ser cancelado.'),
    ).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Cancelar documento' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Excluir rascunho' })).toBeNull();
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe('carregamento do documento', () => {
  it('skeleton anunciado enquanto carrega', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
    );
    renderView();
    expect(await screen.findByText('Carregando o documento…')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('erro: código de correlação copiável e "Tentar novamente" que recarrega', async () => {
    let healthy = false;
    mockDocumentApi({
      detail: () =>
        healthy
          ? documentResponse(documentDto(), ['FINALIZE'])
          : problemResponse(503, 'DEPENDENCY_UNAVAILABLE', { correlationId: 'c-doc-503' }),
    });
    // Sem as retentativas automáticas de consulta (5xx), a falha aparece na hora.
    const queryClient = makeQueryClient();
    queryClient.setDefaultOptions({
      queries: { ...queryClient.getDefaultOptions().queries, retry: false },
    });
    renderView({ queryClient });
    expect(
      await screen.findByRole('heading', { name: 'Não foi possível carregar o documento' }),
    ).toBeTruthy();
    expect(screen.getByText('Código: c-doc-503')).toBeTruthy();
    healthy = true;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Parecer sobre a aquisição de cimento',
      }),
    ).toBeTruthy();
  });

  it('404: mensagem única e link de volta ao processo, sem "Tentar novamente"', async () => {
    mockDocumentApi({ detail: () => problemResponse(404, 'NOT_FOUND') });
    renderView();
    expect(await screen.findByRole('heading', { name: 'Documento não encontrado.' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Voltar ao processo' }).getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}`,
    );
  });
});

const STATUS_LABELS: Record<DocumentStatus, string> = {
  DRAFT: 'Rascunho',
  IN_REVIEW: 'Em revisão',
  RETURNED: 'Devolvido',
  FINALIZED: 'Finalizado',
  APPROVED: 'Aprovado',
  REJECTED: 'Indeferido',
  CANCELED: 'Cancelado',
};

describe('rótulos de status', () => {
  it.each(Object.entries(STATUS_LABELS))('%s aparece como "%s"', async (status, label) => {
    await openDocument({
      state: { document: documentDto({ status: status as DocumentStatus }), allowed: [] },
    });
    expect(screen.getByText(label)).toBeTruthy();
  });
});
