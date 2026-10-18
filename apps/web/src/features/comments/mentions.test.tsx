// @vitest-environment jsdom
import { commentBodyFromText } from '@contrataflow/validation';
import type {
  CommentDto,
  CommentListMetaDto,
  CommentThreadDto,
  MentionCandidateDto,
} from '@contrataflow/validation';
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

import { mentionsOfBody, textToCommentBody } from './comment-markup';
import { CommentsPanel } from './comments-panel';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

/*
 * US-072 — "@" no compositor (SCR-006): CMT-05 com debounce, popover navegável só por teclado
 * (listbox/option + aria-activedescendant), nó `mention` no envio, estados vazio (FA-05) e erro,
 * `MentionPill` só para menção válida (RN-CMT-22), destaque do comentário aberto pela notificação
 * e acessibilidade (axe).
 */

const LIST = `/api/v1/processes/${PROCESS_ID}/comments`;
const CANDIDATES = `/api/v1/processes/${PROCESS_ID}/mention-candidates`;
const CLAUDIA = ID(901);
const SETOR = ID(902);
const EVA = ID(903);
const CREATED = new Date(Date.now() - 5 * 60_000).toISOString();

const meta: CommentListMetaDto = {
  nextCursor: null,
  hasMore: false,
  canComment: true,
  readOnly: false,
  isBudgetConfidential: false,
};

const FOUND: MentionCandidateDto[] = [
  { kind: 'USER', id: CLAUDIA, label: 'Cláudia Ramos', secondaryLabel: 'Secretaria de Saúde' },
  { kind: 'DEPARTMENT', id: SETOR, label: 'Setor de Manutenção' },
];

function comment(extra: Partial<CommentDto> = {}): CommentThreadDto {
  return {
    id: ID(800),
    processId: PROCESS_ID,
    targetType: 'PROCESS',
    document: null,
    sectionKey: null,
    parentId: null,
    author: { id: ID(2), name: 'Marcos Vinícius Rocha', departmentName: null },
    body: commentBodyFromText('Comentário'),
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
    mentions: [],
    replies: [],
    replyCount: 0,
    ...extra,
  };
}

type Route = (url: string, init?: RequestInit) => Response | undefined;

function renderPanel(
  options: {
    threads?: readonly CommentThreadDto[];
    candidates?: Route;
    handler?: Route;
    canComment?: boolean;
    highlightedId?: string;
  } = {},
) {
  const api = mockProcessApi({
    permissions: ['PROCESS_VIEW'],
    comments: (url, init) =>
      options.handler?.(url, init) ??
      jsonResponse({
        data: options.threads ?? [],
        meta: { ...meta, canComment: options.canComment ?? true },
      }),
    mentionCandidates: (url, init) =>
      options.candidates?.(url, init) ?? jsonResponse({ data: FOUND }),
  });
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  renderWithShell(
    <CommentsPanel processId={PROCESS_ID} highlightedId={options.highlightedId ?? null} />,
    { queryClient: client },
  );
  return api;
}

const candidateCalls = (api: ReturnType<typeof mockProcessApi>) =>
  api.mock.calls
    .map(([input]) => requestUrl(input))
    .filter((url) => url.startsWith(CANDIDATES))
    .map((url) => new URL(url, 'http://x').searchParams.get('q'));

describe('SCR-006 · menções no compositor (US-072)', () => {
  it('[Sucesso] "@clá" busca CMT-05, setas + Enter escolhem e o envio leva o nó mention', async () => {
    const user = userEvent.setup();
    const api = renderPanel({
      handler: (_url, init) =>
        init?.method === 'POST'
          ? jsonResponse({ data: comment() }, { status: 201, headers: { ETag: '"1"' } })
          : undefined,
    });
    const field = await screen.findByLabelText('Comentário');
    await user.type(field, 'Pode revisar, @clá');
    const listbox = await screen.findByRole('listbox', {
      name: 'Pessoas e unidades para mencionar',
    });
    expect(candidateCalls(api)).toEqual(['clá']);
    const options = within(listbox).getAllByRole('option');
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
    ]);
    expect(field.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
    expect(options[0]?.textContent).toContain('Secretaria de Saúde');

    await user.keyboard('{ArrowDown}');
    expect(field.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
    await user.keyboard('{ArrowUp}{Enter}');
    expect((field as HTMLTextAreaElement).value).toBe('Pode revisar, @Cláudia Ramos ');
    expect(screen.queryByRole('listbox')).toBeNull();

    await user.type(field, 'e @Setor');
    await screen.findByRole('listbox');
    await user.keyboard('{ArrowDown}{Tab}');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(callsTo(api, 'POST', LIST)).toHaveLength(1);
    });
    expect(callsTo(api, 'POST', LIST)[0]?.body).toEqual({
      targetType: 'PROCESS',
      body: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Pode revisar, ' },
              { type: 'mention', attrs: { kind: 'USER', id: CLAUDIA, label: 'Cláudia Ramos' } },
              { type: 'text', text: ' e ' },
              {
                type: 'mention',
                attrs: { kind: 'DEPARTMENT', id: SETOR, label: 'Setor de Manutenção' },
              },
              // O espaço inserido depois da menção escolhida (a digitação continua).
              { type: 'text', text: ' ' },
            ],
          },
        ],
      },
    });
  });

  it('Esc fecha o popover sem cancelar; "@" sem caractere não busca (V-02)', async () => {
    const user = userEvent.setup();
    const api = renderPanel();
    const field = await screen.findByLabelText('Comentário');
    await user.type(field, 'Oi @');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(candidateCalls(api)).toEqual([]);
    await user.type(field, 'c');
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect((field as HTMLTextAreaElement).value).toBe('Oi @c');
  });

  it('FA-05: ninguém encontrado → orientação com o atalho para Participantes', async () => {
    const user = userEvent.setup();
    renderPanel({ candidates: () => jsonResponse({ data: [] }) });
    await user.type(await screen.findByLabelText('Comentário'), '@zé');
    expect(
      await screen.findByText(
        /Ninguém encontrado com esse nome\. Para dar acesso a alguém novo, adicione como participante\./,
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ir para Participantes' }).getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}?aba=participantes`,
    );
  });

  it('[Erro] busca indisponível: aviso discreto e o "@algo" continua como texto', async () => {
    const user = userEvent.setup();
    renderPanel({ candidates: () => problemResponse(503, 'DEPENDENCY_UNAVAILABLE') });
    const field = await screen.findByLabelText('Comentário');
    await user.type(field, '@ana');
    expect(await screen.findByText(/Não foi possível buscar agora/)).toBeTruthy();
    await user.type(field, ' segue');
    expect((field as HTMLTextAreaElement).value).toBe('@ana segue');
  });

  it('[Validação] RICH_TEXT_INVALID de menção: mensagem da story e o texto permanece', async () => {
    const user = userEvent.setup();
    renderPanel({
      handler: (_url, init) =>
        init?.method === 'POST'
          ? problemResponse(422, 'RICH_TEXT_INVALID', {
              detail: 'Não foi possível salvar uma das menções do comentário.',
            })
          : undefined,
    });
    const field = await screen.findByLabelText('Comentário');
    await user.type(field, 'Texto');
    await user.click(screen.getByRole('button', { name: 'Comentar' }));
    expect(
      await screen.findByText('Não foi possível salvar uma das menções do comentário.'),
    ).toBeTruthy();
    expect((field as HTMLTextAreaElement).value).toBe('Texto');
  });

  it('[Permissão] sem COMMENT_CREATE não há compositor (o "@" não é oferecido)', async () => {
    renderPanel({ canComment: false });
    expect(
      await screen.findByText('Você pode ler os comentários, mas não comentar neste processo.'),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Comentário')).toBeNull();
  });

  it('RN-CMT-22: só a menção válida vira MentionPill; a descartada fica como texto simples', async () => {
    const body = textToCommentBody('Oi @Cláudia Ramos e @Eva Prado', [
      { kind: 'USER', id: CLAUDIA, label: 'Cláudia Ramos' },
      { kind: 'USER', id: EVA, label: 'Eva Prado' },
    ]);
    renderPanel({
      threads: [comment({ body, mentions: [{ id: ID(990), kind: 'USER', targetId: CLAUDIA }] })],
    });
    const article = await screen.findByRole('article');
    expect(within(article).getByText('Pessoa:')).toBeTruthy();
    expect(within(article).getByText('Cláudia Ramos')).toBeTruthy();
    expect(within(article).getByText('@Eva Prado')).toBeTruthy();
    expect(within(article).queryAllByText('Pessoa:')).toHaveLength(1);
  });

  it('passo 6: o comentário aberto pela notificação fica destacado e focado', async () => {
    renderPanel({ threads: [comment()], highlightedId: ID(800) });
    const article = await screen.findByRole('article');
    await waitFor(() => {
      expect(document.activeElement).toBe(article);
    });
    expect(article.getAttribute('aria-current')).toBe('true');
  });

  it('[A11y] popover aberto sem violações sérias (axe)', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(await screen.findByLabelText('Comentário'), '@cl');
    await screen.findByRole('listbox');
    expect(await seriousA11yViolations(document.body)).toEqual([]);
  });
});

describe('comment-markup (US-072)', () => {
  it('"@Rótulo" só vira menção com fronteira de palavra; edição recupera as menções do corpo', () => {
    const mentions = [{ kind: 'USER' as const, id: CLAUDIA, label: 'Ana' }];
    const body = textToCommentBody('@Ana e @Anabela', mentions);
    expect(body).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { kind: 'USER', id: CLAUDIA, label: 'Ana' } },
            { type: 'text', text: ' e @Anabela' },
          ],
        },
      ],
    });
    expect(mentionsOfBody(body)).toEqual(mentions);
  });
});
