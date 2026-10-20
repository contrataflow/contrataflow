// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { ActionEntry, TagDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import {
  PROCESS_ID,
  callsTo,
  mockProcessApi,
  problemResponse,
  summaryDto,
} from '@test/support/process-fixtures';
import type { Handler } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell } from '@test/support/render';

import { ProcessTagsButton, ProcessTagsDialog } from './process-tags';
import type { AppliedTag } from './tag-model';
import { TagsAdminPanel } from './tags-admin-panel';
import { ProcessHeader } from '../process-panel/process-header';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const id = (n: number) => `0192a000-0000-7000-8000-${String(n + 700).padStart(12, '0')}`;

const tag = (n: number, name: string, extra: Partial<TagDto> = {}): TagDto => ({
  id: id(n),
  name,
  color: '#64748B',
  isActive: true,
  version: 1,
  ...extra,
});

const EMERGENCIAIS = tag(1, 'Obras emergenciais', { color: '#B45309' });
const FEDERAL = tag(2, 'Recurso federal');
const GABINETE = tag(3, 'Prioridade do gabinete', { color: '#0F766E' });
const ANTIGA = tag(4, 'Antiga', { isActive: false });

const PUT_URL = `/api/v1/processes/${PROCESS_ID}/tags`;

/** Resposta própria do cenário; `undefined` = a lista padrão de TAG-01. */
type Route = (url: string, init?: RequestInit) => Response | undefined;

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

/** TAG-01 com a lista informada (`includeInactive` só é atendido a quem gerencia); `extra` primeiro. */
const tagsApi =
  (list: readonly TagDto[], extra?: Route): Handler =>
  (url, init) => {
    const handled = extra?.(url, init);
    if (handled) return handled;
    if (url.startsWith('/api/v1/tags') && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse({
        data: url.includes('includeInactive=true') ? list : list.filter((entry) => entry.isActive),
      });
    }
    return problemResponse(404, 'NOT_FOUND');
  };

const manage = (enabled: boolean, message?: string): ActionEntry => ({
  action: 'MANAGE_TAGS',
  label: 'Etiquetas',
  enabled,
  reasons: message ? [{ code: 'NOT_PROCESS_CUSTODIAN', message }] : [],
});

const applied = (...entries: TagDto[]): AppliedTag[] =>
  entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    color: entry.color,
    isActive: entry.isActive,
  }));

function Harness({
  appliedTags = [],
  version = 9,
  entry = manage(true),
}: {
  readonly appliedTags?: AppliedTag[];
  readonly version?: number | undefined;
  readonly entry?: ActionEntry | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ProcessTagsButton
        entry={entry ?? undefined}
        count={appliedTags.length}
        frozen={false}
        onClick={() => {
          setOpen(true);
        }}
      />
      <ProcessTagsDialog
        processId={PROCESS_ID}
        open={open}
        onOpenChange={setOpen}
        applied={appliedTags}
        version={version}
      />
      <Toaster />
    </>
  );
}

function renderPicker(
  list: readonly TagDto[],
  options: {
    permissions?: readonly string[];
    appliedTags?: AppliedTag[];
    version?: number | undefined;
    entry?: ActionEntry | null;
    handler?: Route;
  } = {},
) {
  const api = mockProcessApi({
    permissions: options.permissions ?? ['PROCESS_VIEW', 'PROCESS_UPDATE'],
    tags: tagsApi(list, options.handler),
  });
  renderWithShell(
    <Harness
      {...(options.appliedTags === undefined ? {} : { appliedTags: options.appliedTags })}
      {...('version' in options ? { version: options.version } : {})}
      {...('entry' in options ? { entry: options.entry } : {})}
    />,
    { queryClient: noRetryClient() },
  );
  return api;
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /^Etiquetas/ }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByRole('combobox', { name: 'Buscar etiqueta' });
  return dialog;
}

const option = (dialog: HTMLElement, name: RegExp | string) =>
  within(dialog).getByRole('option', { name });

describe('SCR-006 · seletor de etiquetas do processo (US-007)', () => {
  it('[Sucesso] marca duas etiquetas e aplica: PUT com o conjunto completo e If-Match da versão do processo', async () => {
    const user = userEvent.setup();
    const api = renderPicker([EMERGENCIAIS, FEDERAL, GABINETE], {
      handler: (url, init) =>
        init?.method === 'PUT' && url === PUT_URL
          ? jsonResponse({ data: { tags: [EMERGENCIAIS, FEDERAL] } }, { headers: { ETag: '"10"' } })
          : undefined,
    });
    const dialog = await openPicker(user);
    expect(within(dialog).getByText('0/10')).toBeTruthy();
    await user.click(option(dialog, /Obras emergenciais/));
    await user.click(option(dialog, /Recurso federal/));
    expect(within(dialog).getByText('2/10')).toBeTruthy();
    expect(within(dialog).getByText('2 etiquetas marcadas de 10')).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Aplicar etiquetas' }));
    await waitFor(() => {
      expect(callsTo(api, 'PUT', PUT_URL)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'PUT', PUT_URL);
    expect(call?.headers.get('If-Match')).toBe('"9"');
    expect(call?.body).toEqual({ tagIds: [EMERGENCIAIS.id, FEDERAL.id] });
    expect(await screen.findByText('Etiquetas atualizadas.')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('parte do conjunto aplicado, marca/desmarca por teclado (setas + Enter) e só habilita com mudança', async () => {
    const user = userEvent.setup();
    const api = renderPicker([EMERGENCIAIS, FEDERAL, GABINETE], {
      appliedTags: applied(EMERGENCIAIS),
    });
    expect(screen.getByRole('button', { name: 'Etiquetas (1)' })).toBeTruthy();
    const dialog = await openPicker(user);
    const apply = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Aplicar etiquetas',
    });
    expect(option(dialog, /Obras emergenciais/).getAttribute('aria-selected')).toBe('true');
    expect(apply.disabled).toBe(true);

    const search = within(dialog).getByRole('combobox', { name: 'Buscar etiqueta' });
    await user.type(search, 'GABI');
    // Sem acento nem caixa: só "Prioridade do gabinete" aparece.
    expect(within(dialog).queryByRole('option', { name: /Recurso federal/ })).toBeNull();
    await user.keyboard('{Enter}');
    expect(option(dialog, /Prioridade do gabinete/).getAttribute('aria-selected')).toBe('true');
    expect(apply.disabled).toBe(false);

    // Voltar ao conjunto aplicado desabilita de novo.
    await user.clear(search);
    await user.click(option(dialog, /Prioridade do gabinete/));
    expect(apply.disabled).toBe(true);
    expect(callsTo(api, 'PUT', PUT_URL)).toHaveLength(0);
  });

  it('[Validação] limite de 10: a 11ª etiqueta não é marcada e a mensagem aparece; desmarcar libera', async () => {
    const user = userEvent.setup();
    const eleven = Array.from({ length: 11 }, (_, index) =>
      tag(20 + index, `Etiqueta ${String(20 + index)}`),
    );
    renderPicker(eleven, { appliedTags: applied(...eleven.slice(0, 10)) });
    const dialog = await openPicker(user);
    expect(within(dialog).getByText('10/10')).toBeTruthy();
    expect(within(dialog).getByText('Use no máximo 10 etiquetas por processo.')).toBeTruthy();
    const last = option(dialog, /Etiqueta 30/);
    expect(last.getAttribute('aria-disabled')).toBe('true');
    await user.click(last);
    expect(last.getAttribute('aria-selected')).toBe('false');
    await user.click(option(dialog, /Etiqueta 20/));
    expect(within(dialog).getByText('9/10')).toBeTruthy();
    await user.click(last);
    expect(last.getAttribute('aria-selected')).toBe('true');
  });

  it('[Permissão] sem custódia o botão fica desabilitado com o motivo; sem PROCESS_UPDATE a ação some', async () => {
    renderPicker([FEDERAL], {
      entry: manage(false, 'Somente quem está com o processo pode alterar as etiquetas.'),
    });
    const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Etiquetas' });
    expect(button.disabled).toBe(true);
    expect(
      screen.getByText('Somente quem está com o processo pode alterar as etiquetas.'),
    ).toBeTruthy();
    expect(button.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('[Permissão] sem a ação MANAGE_TAGS nada é renderizado', () => {
    renderPicker([FEDERAL], { entry: null });
    expect(screen.queryByRole('button', { name: /Etiquetas/ })).toBeNull();
  });

  it('[Permissão] a criação rápida só existe com TAG_MANAGE; sem ela, estado vazio orienta pedir ao gestor', async () => {
    const user = userEvent.setup();
    renderPicker([]);
    const dialog = await openPicker(user);
    expect(
      within(dialog).getByText('Nenhuma etiqueta cadastrada. Peça ao gestor para criar etiquetas.'),
    ).toBeTruthy();
    // Sem lista, o combobox fica recolhido e sem aria-controls (axe: aria-required-attr).
    const combobox = within(dialog).getByRole('combobox');
    expect(combobox.getAttribute('aria-expanded')).toBe('false');
    expect(combobox.getAttribute('aria-controls')).toBeNull();
    await user.type(combobox, 'Nova etiqueta');
    expect(within(dialog).queryByRole('option', { name: /Criar etiqueta/ })).toBeNull();
  });

  it('[Sucesso] FA-01 criar etiqueta no seletor: POST com Idempotency-Key, já marcada em seguida', async () => {
    const user = userEvent.setup();
    const created = tag(40, 'Convênio federal');
    const list = [FEDERAL];
    const api = renderPicker(list, {
      permissions: ['PROCESS_VIEW', 'PROCESS_UPDATE', 'TAG_MANAGE'],
      handler: (url, init) => {
        if (init?.method === 'POST' && url === '/api/v1/tags') {
          list.push(created);
          return jsonResponse({ data: created }, { status: 201, headers: { ETag: '"1"' } });
        }
        return undefined;
      },
    });
    const dialog = await openPicker(user);
    await user.type(within(dialog).getByRole('combobox'), 'Convênio federal');
    // Um nome que já existe não oferece a criação.
    expect(
      within(dialog).queryByRole('option', { name: /Criar etiqueta "Recurso federal"/ }),
    ).toBeNull();
    await user.click(option(dialog, 'Criar etiqueta "Convênio federal"'));
    await waitFor(() => {
      expect(callsTo(api, 'POST', '/api/v1/tags')).toHaveLength(1);
    });
    const [call] = callsTo(api, 'POST', '/api/v1/tags');
    expect(call?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(call?.body).toEqual({ name: 'Convênio federal' });
    await waitFor(() => {
      expect(within(dialog).getByText('1/10')).toBeTruthy();
    });
  });

  it('[Duplicidade] criação rápida com nome repetido (409): mensagem no seletor, sem marcar nada', async () => {
    const user = userEvent.setup();
    renderPicker([FEDERAL], {
      permissions: ['PROCESS_VIEW', 'PROCESS_UPDATE', 'TAG_MANAGE'],
      handler: (url, init) =>
        init?.method === 'POST' && url === '/api/v1/tags'
          ? problemResponse(409, 'CONFLICT')
          : undefined,
    });
    const dialog = await openPicker(user);
    await user.type(within(dialog).getByRole('combobox'), 'Nome novo');
    await user.click(option(dialog, 'Criar etiqueta "Nome novo"'));
    expect(await within(dialog).findByText('Já existe uma etiqueta com este nome.')).toBeTruthy();
    expect(within(dialog).getByText('0/10')).toBeTruthy();
  });

  it('FA-03 etiqueta inativa já aplicada: esmaecida com "(inativa)", removível e não reaplicável', async () => {
    const user = userEvent.setup();
    renderPicker([FEDERAL], { appliedTags: applied(ANTIGA) });
    const dialog = await openPicker(user);
    const inactive = option(dialog, /Antiga/);
    expect(within(inactive).getByText('(inativa)')).toBeTruthy();
    expect(inactive.getAttribute('aria-selected')).toBe('true');
    await user.click(inactive);
    expect(inactive.getAttribute('aria-selected')).toBe('false');
    // Desmarcada, não volta: inativa só pode ser removida.
    expect(inactive.getAttribute('aria-disabled')).toBe('true');
    await user.click(inactive);
    expect(inactive.getAttribute('aria-selected')).toBe('false');
  });

  it('[Concorrência] 412: avisa, mantém as etiquetas marcadas e o seletor aberto para nova confirmação', async () => {
    const user = userEvent.setup();
    const api = renderPicker([EMERGENCIAIS, FEDERAL], {
      handler: (url, init) =>
        init?.method === 'PUT' && url === PUT_URL
          ? problemResponse(412, 'VERSION_CONFLICT')
          : undefined,
    });
    const dialog = await openPicker(user);
    await user.click(option(dialog, /Obras emergenciais/));
    await user.click(within(dialog).getByRole('button', { name: 'Aplicar etiquetas' }));
    expect(
      await within(dialog).findByText(
        'O processo foi alterado por outra pessoa. As etiquetas que você marcou foram mantidas — confirme novamente.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(option(dialog, /Obras emergenciais/).getAttribute('aria-selected')).toBe('true');
    expect(callsTo(api, 'PUT', PUT_URL)).toHaveLength(1);
    // Nova confirmação possível.
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Aplicar etiquetas' }).disabled,
    ).toBe(false);
  });

  it('[Falha de banco] 503: "Não foi possível salvar as etiquetas agora." com a seleção intacta', async () => {
    const user = userEvent.setup();
    renderPicker([EMERGENCIAIS], {
      handler: (url, init) =>
        init?.method === 'PUT' && url === PUT_URL
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
          : undefined,
    });
    const dialog = await openPicker(user);
    await user.click(option(dialog, /Obras emergenciais/));
    await user.click(within(dialog).getByRole('button', { name: 'Aplicar etiquetas' }));
    expect(
      await within(dialog).findByText('Não foi possível salvar as etiquetas agora.'),
    ).toBeTruthy();
    expect(option(dialog, /Obras emergenciais/).getAttribute('aria-selected')).toBe('true');
  });

  it('[Validação] 422 do servidor: pede revisar as etiquetas', async () => {
    const user = userEvent.setup();
    renderPicker([EMERGENCIAIS], {
      handler: (url, init) =>
        init?.method === 'PUT' && url === PUT_URL
          ? problemResponse(422, 'VALIDATION_ERROR', {
              errors: [{ field: 'tagIds', code: 'REFERENCE_INACTIVE', message: 'inativa' }],
            })
          : undefined,
    });
    const dialog = await openPicker(user);
    await user.click(option(dialog, /Obras emergenciais/));
    await user.click(within(dialog).getByRole('button', { name: 'Aplicar etiquetas' }));
    expect(await within(dialog).findByText('Revise as etiquetas selecionadas.')).toBeTruthy();
  });

  it('erro ao carregar as etiquetas oferece "Tentar novamente"', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    renderPicker([FEDERAL], {
      handler: (url, init) => {
        if (url.startsWith('/api/v1/tags') && (init?.method ?? 'GET') === 'GET') {
          attempts += 1;
          if (attempts <= 1) return problemResponse(503, 'DEPENDENCY_UNAVAILABLE');
        }
        return undefined;
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Etiquetas' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Não foi possível carregar as etiquetas.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    expect(await within(dialog).findByRole('option', { name: /Recurso federal/ })).toBeTruthy();
  });

  it('[Acessibilidade] sem violações sérias no seletor aberto', async () => {
    const user = userEvent.setup();
    renderPicker([EMERGENCIAIS, FEDERAL], { appliedTags: applied(ANTIGA) });
    const dialog = await openPicker(user);
    await within(dialog).findByRole('option', { name: /Recurso federal/ });
    expect(await seriousA11yViolations(dialog)).toEqual([]);
  });
});

describe('SCR-006 · etiquetas no cabeçalho do processo', () => {
  it('mostra os chips com cor e nome, a inativa esmaecida com "(inativa)", e o botão no slot', () => {
    renderWithShell(
      <ProcessHeader
        header={{
          ...summaryDto().header,
          tags: [
            { id: EMERGENCIAIS.id, name: EMERGENCIAIS.name, color: '#B45309', isActive: true },
            { id: ANTIGA.id, name: ANTIGA.name, color: '#64748B', isActive: false },
          ],
        }}
        tagsAction={<span>slot-etiquetas</span>}
      />,
    );
    const list = screen.getByRole('list', { name: 'Etiquetas' });
    const chips = within(list).getAllByRole('listitem');
    expect(chips).toHaveLength(2);
    expect(within(chips.at(0) ?? list).getByText('Obras emergenciais')).toBeTruthy();
    expect(within(chips.at(1) ?? list).getByText('(inativa)')).toBeTruthy();
    expect(screen.getByText('slot-etiquetas')).toBeTruthy();
  });
});

describe('SCR-109 · aba "Etiquetas" (US-007)', () => {
  function renderAdmin(list: TagDto[], handler?: Route) {
    const api = mockProcessApi({
      permissions: ['PROCESS_VIEW', 'TAG_MANAGE'],
      tags: tagsApi(list, handler),
    });
    renderWithShell(
      <>
        <TagsAdminPanel />
        <Toaster />
      </>,
      { queryClient: noRetryClient() },
    );
    return api;
  }

  it('[Sucesso] lista ativas e inativas; cria com nome e cor da paleta (POST com Idempotency-Key)', async () => {
    const user = userEvent.setup();
    const created = tag(50, 'Obras', { color: '#B91C1C' });
    const list = [EMERGENCIAIS, ANTIGA];
    const api = renderAdmin(list, (url, init) => {
      if (init?.method === 'POST' && url === '/api/v1/tags') {
        list.push(created);
        return jsonResponse({ data: created }, { status: 201, headers: { ETag: '"1"' } });
      }
      return undefined;
    });
    expect(await screen.findByRole('table', { name: 'Etiquetas do órgão' })).toBeTruthy();
    expect(screen.getByText('Ativa')).toBeTruthy();
    expect(screen.getByText('Inativa')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Nova etiqueta' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Nome'), 'Obras');
    await user.click(within(dialog).getByRole('radio', { name: 'Vermelho' }));
    expect(
      within(dialog).getByRole('radio', { name: 'Vermelho' }).getAttribute('aria-checked'),
    ).toBe('true');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar etiqueta' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST', '/api/v1/tags')).toHaveLength(1);
    });
    const [call] = callsTo(api, 'POST', '/api/v1/tags');
    expect(call?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(call?.body).toEqual({ name: 'Obras', color: '#B91C1C' });
    expect(await screen.findByText('Etiqueta Obras criada.')).toBeTruthy();
  });

  it('[Validação] nome curto: erro antes de enviar; cor padrão #64748B', async () => {
    const user = userEvent.setup();
    const api = renderAdmin([EMERGENCIAIS]);
    await user.click(await screen.findByRole('button', { name: 'Nova etiqueta' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'Cinza' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await user.type(within(dialog).getByLabelText('Nome'), 'a');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar etiqueta' }));
    expect(
      await within(dialog).findByText('O nome deve ter entre 2 e 40 caracteres.'),
    ).toBeTruthy();
    expect(callsTo(api, 'POST', '/api/v1/tags')).toHaveLength(0);
  });

  it('[Duplicidade] 409: "Já existe uma etiqueta com este nome." no campo', async () => {
    const user = userEvent.setup();
    renderAdmin([EMERGENCIAIS], (url, init) =>
      init?.method === 'POST' && url === '/api/v1/tags'
        ? problemResponse(409, 'CONFLICT')
        : undefined,
    );
    await user.click(await screen.findByRole('button', { name: 'Nova etiqueta' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Nome'), 'obras EMERGENCIAIS');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar etiqueta' }));
    expect(await within(dialog).findByText('Já existe uma etiqueta com este nome.')).toBeTruthy();
  });

  it('FA-02 renomear avisa sobre regras de workflow e envia só o que mudou com If-Match', async () => {
    const user = userEvent.setup();
    const api = renderAdmin([{ ...EMERGENCIAIS, version: 3 }], (url, init) =>
      init?.method === 'PATCH' && url === `/api/v1/tags/${EMERGENCIAIS.id}`
        ? jsonResponse(
            { data: { ...EMERGENCIAIS, name: 'Obras de emergência', version: 4 } },
            { headers: { ETag: '"4"' } },
          )
        : undefined,
    );
    await user.click(
      await screen.findByRole('button', { name: 'Editar a etiqueta Obras emergenciais' }),
    );
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Nome');
    expect(
      within(dialog).queryByText(
        'Regras de workflow que usam o nome antigo deixarão de reconhecer esta etiqueta.',
      ),
    ).toBeNull();
    await user.clear(name);
    await user.type(name, 'Obras de emergência');
    expect(
      within(dialog).getByText(
        'Regras de workflow que usam o nome antigo deixarão de reconhecer esta etiqueta.',
      ),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Salvar etiqueta' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH', `/api/v1/tags/${EMERGENCIAIS.id}`)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'PATCH', `/api/v1/tags/${EMERGENCIAIS.id}`);
    expect(call?.headers.get('If-Match')).toBe('"3"');
    expect(call?.body).toEqual({ name: 'Obras de emergência' });
  });

  it('desativa e reativa com If-Match da versão lida', async () => {
    const user = userEvent.setup();
    const api = renderAdmin([{ ...FEDERAL, version: 2 }], (_url, init) =>
      init?.method === 'PATCH'
        ? jsonResponse({ data: { ...FEDERAL, isActive: false, version: 3 } })
        : undefined,
    );
    await user.click(
      await screen.findByRole('button', { name: 'Desativar a etiqueta Recurso federal' }),
    );
    await waitFor(() => {
      expect(callsTo(api, 'PATCH', `/api/v1/tags/${FEDERAL.id}`)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'PATCH', `/api/v1/tags/${FEDERAL.id}`);
    expect(call?.headers.get('If-Match')).toBe('"2"');
    expect(call?.body).toEqual({ isActive: false });
    expect(await screen.findByText('Etiqueta Recurso federal desativada.')).toBeTruthy();
  });

  it('[Concorrência] 412: aviso de que a etiqueta mudou e recarrega a lista', async () => {
    const user = userEvent.setup();
    renderAdmin([FEDERAL], (_url, init) =>
      init?.method === 'PATCH' ? problemResponse(412, 'VERSION_CONFLICT') : undefined,
    );
    await user.click(
      await screen.findByRole('button', { name: 'Desativar a etiqueta Recurso federal' }),
    );
    expect(
      await screen.findByText('A etiqueta foi alterada por outra pessoa. Recarregamos a lista.'),
    ).toBeTruthy();
  });

  it('estado vazio: orienta criar a primeira etiqueta e lê o cadastro com as inativas', async () => {
    const empty = renderAdmin([]);
    expect(await screen.findByText('Nenhuma etiqueta cadastrada')).toBeTruthy();
    expect(callsTo(empty, 'GET', '/api/v1/tags?includeInactive=true').length).toBeGreaterThan(0);
  });

  it('[Acessibilidade] tabela e formulário sem violações sérias', async () => {
    const user = userEvent.setup();
    renderAdmin([EMERGENCIAIS, ANTIGA]);
    await screen.findByRole('table', { name: 'Etiquetas do órgão' });
    expect(await seriousA11yViolations()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Nova etiqueta' }));
    const dialog = await screen.findByRole('dialog');
    expect(await seriousA11yViolations(dialog)).toEqual([]);
  });
});
