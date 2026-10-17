// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import { commentBodyFromText } from '@contrataflow/validation';
import type { CommentDto, CommentListMetaDto, CommentThreadDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import {
  ID,
  PROCESS_ID,
  callsTo,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { CommentsPanel } from './comments-panel';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
  window.sessionStorage.clear();
});

/* US-071 — SCR-006 aba "Comentários": estados, publicar, responder, editar, moderar e permissões. */

const LIST = `/api/v1/processes/${PROCESS_ID}/comments`;
const CREATED = new Date(Date.now() - 5 * 60_000).toISOString();

const baseMeta: CommentListMetaDto = {
  nextCursor: null,
  hasMore: false,
  canComment: true,
  readOnly: false,
  isBudgetConfidential: false,
};

function comment(sequence: number, extra: Partial<CommentDto> = {}): CommentDto {
  return {
    id: ID(700 + sequence),
    processId: PROCESS_ID,
    targetType: 'PROCESS',
    document: null,
    sectionKey: null,
    parentId: null,
    author: { id: ID(2), name: 'Marcos Vinícius Rocha', departmentName: 'Setor de Planejamento' },
    body: commentBodyFromText(`Comentário número ${String(sequence)}`),
    bodyMasked: false,
    createdAt: CREATED,
    editedAt: null,
    isDeleted: false,
    deletedByModerator: false,
    deletionReason: null,
    canEdit: false,
    editableUntil: null,
    canDelete: false,
    canModerate: false,
    version: 1,
    ...extra,
  };
}

const thread = (base: CommentDto, replies: CommentDto[] = []): CommentThreadDto => ({
  ...base,
  replies,
  replyCount: replies.length,
});

type Route = (url: string, init?: RequestInit) => Response | undefined;

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

function renderPanel(
  threads: readonly CommentThreadDto[],
  options: { meta?: Partial<CommentListMetaDto>; handler?: Route } = {},
) {
  const api = mockProcessApi({
    permissions: ['PROCESS_VIEW'],
    comments: (url, init) => {
      const handled = options.handler?.(url, init);
      if (handled) return handled;
      return jsonResponse({ data: threads, meta: { ...baseMeta, ...options.meta } });
    },
  });
  renderWithShell(
    <>
      <CommentsPanel processId={PROCESS_ID} />
      <Toaster />
    </>,
    { queryClient: noRetryClient() },
  );
  return api;
}

const listCalls = (api: ReturnType<typeof mockProcessApi>) =>
  api.mock.calls.filter(
    ([input, init]) => requestUrl(input).startsWith(LIST) && (init?.method ?? 'GET') === 'GET',
  );

describe('SCR-006 · aba Comentários (US-071)', () => {
  it('[Estado] vazio: orientação e compositor; [Sucesso] publica com Ctrl+Enter, Idempotency-Key e anúncio', async () => {
    const user = userEvent.setup();
    const created = comment(1);
    const api = renderPanel([], {
      handler: (_url, init) =>
        init?.method === 'POST'
          ? jsonResponse({ data: created }, { status: 201, headers: { ETag: '"1"' } })
          : undefined,
    });
    expect(
      await screen.findByText(
        'Ainda não há comentários. Use este espaço para discutir a instrução do processo.',
      ),
    ).toBeTruthy();
    const field = screen.getByLabelText('Comentário');
    await user.type(field, 'Precisamos rever **as quantidades** do item 2.');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(callsTo(api, 'POST', LIST)).toHaveLength(1);
    });
    const [post] = callsTo(api, 'POST', LIST);
    expect(post?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.body).toEqual({
      targetType: 'PROCESS',
      body: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Precisamos rever ' },
              { type: 'text', text: 'as quantidades', marks: [{ type: 'bold' }] },
              { type: 'text', text: ' do item 2.' },
            ],
          },
        ],
      },
    });
    expect(await screen.findByText('Comentário publicado')).toBeTruthy();
    await waitFor(() => {
      expect((field as HTMLTextAreaElement).value).toBe('');
    });
    await waitFor(() => {
      expect(listCalls(api).length).toBeGreaterThan(1);
    });
  });

  it('[Validação] vazio no front e link javascript: não enviam', async () => {
    const user = userEvent.setup();
    const api = renderPanel([]);
    await screen.findByLabelText('Comentário');
    await user.click(screen.getByRole('button', { name: 'Comentar' }));
    expect(await screen.findByText('Escreva um comentário de até 10.000 caracteres.')).toBeTruthy();
    expect(callsTo(api, 'POST', LIST)).toHaveLength(0);
  });

  it('[Falha de banco] 503: o texto permanece com a mensagem e o correlationId (e no sessionStorage)', async () => {
    const user = userEvent.setup();
    renderPanel([], {
      handler: (_url, init) =>
        init?.method === 'POST'
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE', { correlationId: 'c-503' })
          : undefined,
    });
    const field = await screen.findByLabelText('Comentário');
    await user.type(field, 'Texto que não pode se perder');
    await user.click(screen.getByRole('button', { name: 'Comentar' }));
    expect(
      await screen.findByText('Não foi possível publicar agora. Tente novamente. Código: c-503'),
    ).toBeTruthy();
    expect((field as HTMLTextAreaElement).value).toBe('Texto que não pode se perder');
    const drafts = Array.from({ length: window.sessionStorage.length }, (_, index) =>
      window.sessionStorage.getItem(window.sessionStorage.key(index) ?? ''),
    );
    expect(drafts).toContain('Texto que não pode se perder');
  });

  it('threads: autor, alvo, "(editado)", excluído, moderado com motivo, mascarado e respostas', async () => {
    renderPanel([
      thread(comment(1, { editedAt: CREATED }), [comment(2, { parentId: ID(701) })]),
      thread(comment(3, { isDeleted: true, body: null })),
      thread(
        comment(4, {
          isDeleted: true,
          deletedByModerator: true,
          body: null,
          deletionReason: 'Contém dados pessoais de terceiro.',
        }),
      ),
      thread(
        comment(5, {
          targetType: 'DOCUMENT',
          document: { id: ID(800), code: 'PP 0001/2026', title: 'Pesquisa de preços' },
          body: null,
          bodyMasked: true,
        }),
      ),
    ]);
    const articles = await screen.findAllByRole('article');
    expect(articles).toHaveLength(5);
    expect(articles[0]?.getAttribute('aria-label')).toMatch(
      /^Comentário de Marcos Vinícius Rocha, /,
    );
    expect(screen.getByText('Comentário número 1')).toBeTruthy();
    expect(screen.getAllByText(/há 5 min/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\(editado\)/)).toHaveLength(1);
    expect(screen.getByText('Comentário excluído pelo autor')).toBeTruthy();
    expect(screen.getByText('Comentário removido por moderação')).toBeTruthy();
    expect(screen.getByText('Motivo: Contém dados pessoais de terceiro.')).toBeTruthy();
    expect(
      screen.getByText('Comentário em documento com orçamento sigiloso — conteúdo restrito'),
    ).toBeTruthy();
    expect(screen.getByText(/PP 0001\/2026/)).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Respostas' })).getByText('Comentário número 2'),
    ).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Permissão] sem COMMENT_CREATE: lê sem compositor', async () => {
    renderPanel([thread(comment(1))], { meta: { canComment: false } });
    expect(
      await screen.findByText('Você pode ler os comentários, mas não comentar neste processo.'),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Comentário')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Responder' })).toBeNull();
  });

  it('[FA-05] processo encerrado: somente leitura; [FA-07] aviso de orçamento sigiloso', async () => {
    renderPanel([thread(comment(1))], { meta: { readOnly: true, canComment: false } });
    expect(
      await screen.findByText(
        'Este processo está encerrado; os comentários estão disponíveis apenas para leitura.',
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Comentário')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('[FA-07] processo com orçamento sigiloso: o compositor avisa para não registrar valores', async () => {
    renderPanel([], { meta: { isBudgetConfidential: true } });
    expect(
      await screen.findByText(
        'Não informe valores estimados em comentários: este processo tem orçamento sigiloso.',
      ),
    ).toBeTruthy();
  });

  it('[FA-01] responder: compositor inline envia parentId e o alvo do pai', async () => {
    const user = userEvent.setup();
    const api = renderPanel([thread(comment(1))], {
      handler: (_url, init) =>
        init?.method === 'POST'
          ? jsonResponse({ data: comment(9, { parentId: ID(701) }) }, { status: 201 })
          : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Responder' }));
    const field = screen.getByLabelText('Resposta');
    await user.type(field, 'Concordo.');
    await user.click(screen.getByRole('button', { name: 'Responder' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST', LIST)).toHaveLength(1);
    });
    expect(callsTo(api, 'POST', LIST)[0]?.body).toMatchObject({
      targetType: 'PROCESS',
      parentId: ID(701),
    });
  });

  it('[FA-02] editar pelo menu "Mais" com If-Match; prazo vencido mostra a mensagem e mantém o texto', async () => {
    const user = userEvent.setup();
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    let expired = false;
    const api = renderPanel(
      [thread(comment(1, { canEdit: true, canDelete: true, editableUntil: until, version: 3 }))],
      {
        handler: (_url, init) => {
          if (init?.method !== 'PATCH') return undefined;
          return expired
            ? problemResponse(409, 'COMMENT_EDIT_WINDOW_EXPIRED')
            : jsonResponse({ data: comment(1, { version: 4, editedAt: until }) });
        },
      },
    );
    await user.click(
      await screen.findByRole('button', {
        name: 'Mais ações do comentário de Marcos Vinícius Rocha',
      }),
    );
    await user.click(await screen.findByRole('menuitem', { name: /^Editar \(até / }));
    const field = screen.getByLabelText('Editar comentário');
    expect((field as HTMLTextAreaElement).value).toBe('Comentário número 1');
    await user.clear(field);
    await user.type(field, 'Corrigido');
    expired = true;
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText('O prazo de 15 minutos para editar terminou.')).toBeTruthy();
    expect((field as HTMLTextAreaElement).value).toBe('Corrigido');
    const [patch] = callsTo(api, 'PATCH', `/api/v1/comments/${ID(701)}`);
    expect(patch?.headers.get('If-Match')).toBe('"3"');
    expect(patch?.body).toEqual({ body: commentBodyFromText('Corrigido') });
  });

  it('[FA-04] moderar: motivo obrigatório (mín. 10) e DELETE com reason e If-Match', async () => {
    const user = userEvent.setup();
    const api = renderPanel([thread(comment(1, { canModerate: true, version: 2 }))], {
      handler: (_url, init) =>
        init?.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined,
    });
    await user.click(
      await screen.findByRole('button', {
        name: 'Mais ações do comentário de Marcos Vinícius Rocha',
      }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Remover por moderação' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Motivo da remoção'), 'curto');
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
    expect(
      within(dialog).getByText('Informe o motivo da remoção (mín. 10 caracteres).'),
    ).toBeTruthy();
    expect(callsTo(api, 'DELETE', `/api/v1/comments/${ID(701)}`)).toHaveLength(0);
    await user.type(
      within(dialog).getByLabelText('Motivo da remoção'),
      ' — contém CPF de terceiro',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
    await waitFor(() => {
      expect(callsTo(api, 'DELETE', `/api/v1/comments/${ID(701)}`)).toHaveLength(1);
    });
    const [removal] = callsTo(api, 'DELETE', `/api/v1/comments/${ID(701)}`);
    expect(removal?.headers.get('If-Match')).toBe('"2"');
    expect(removal?.body).toEqual({ reason: 'curto — contém CPF de terceiro' });
    expect(await screen.findByText('Comentário removido')).toBeTruthy();
  });

  it('[FA-03] excluir o próprio: confirmação e DELETE sem corpo', async () => {
    const user = userEvent.setup();
    const api = renderPanel([thread(comment(1, { canDelete: true }))], {
      handler: (_url, init) =>
        init?.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined,
    });
    await user.click(
      await screen.findByRole('button', {
        name: 'Mais ações do comentário de Marcos Vinícius Rocha',
      }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Excluir' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('O comentário será removido para todos. As respostas permanecem.'),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => {
      expect(callsTo(api, 'DELETE', `/api/v1/comments/${ID(701)}`)).toHaveLength(1);
    });
    expect(callsTo(api, 'DELETE', `/api/v1/comments/${ID(701)}`)[0]?.init?.body).toBeFalsy();
  });

  it('[Estado] erro de carga: "Tentar novamente" recarrega', async () => {
    const user = userEvent.setup();
    let fail = true;
    const api = renderPanel([thread(comment(1))], {
      handler: (_url, init) =>
        fail && (init?.method ?? 'GET') === 'GET'
          ? problemResponse(500, 'INTERNAL_ERROR')
          : undefined,
    });
    expect(await screen.findByText('Não foi possível carregar os comentários agora.')).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Comentário número 1')).toBeTruthy();
    expect(listCalls(api).length).toBeGreaterThanOrEqual(2);
  });
});
