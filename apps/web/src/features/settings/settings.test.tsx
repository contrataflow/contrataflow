// @vitest-environment jsdom
import { renderNumberingMask, SETTING_DEFINITIONS } from '@contrataflow/validation';
import type { SettingsMapDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { messages } from '@/i18n/messages';
import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { SETTINGS_SECTIONS } from './settings-model';
import { SettingsView } from './settings-view';

// A suíte completa roda em paralelo com as demais; o padrão de 1 s é curto para a primeira renderização.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace }),
  usePathname: () => '/admin/configuracoes',
  useSearchParams: () => new URLSearchParams(),
}));

/** SET-01 do tenant provisionado: todas as chaves no padrão, versão 1. */
function catalog(overrides: SettingsMapDto = {}): SettingsMapDto {
  const entries = SETTING_DEFINITIONS.map(
    (definition) => [definition.key, { value: definition.defaultValue, version: 1 }] as const,
  );
  return { ...Object.fromEntries(entries), ...overrides };
}

function problemResponse(
  status: number,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase()}`,
      title: code,
      status,
      detail,
      instance: '/api/v1/settings',
      code,
      correlationId: 'c-test',
      errors: [],
      violations: [],
      ...extra,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** SET-04 simulado: último número 11 em 2026 (processo) e 4 (documentos). */
function previewResponse(_url: string, init?: RequestInit): Response {
  const body = bodyOf(init) as { mask?: string; documentTypeCode?: string };
  const next = body.documentTypeCode === undefined ? 12 : 5;
  const example = renderNumberingMask({
    mask: body.mask ?? '',
    sequence: next,
    year: 2026,
    organization: 'PMSJ',
    typeCode: body.documentTypeCode ?? '',
  });
  return jsonResponse({ data: { example, nextValue: String(next) } });
}

function mockApi(
  routes: { get?: Handler; patch?: Handler; preview?: Handler } = {},
  permissions: readonly string[] = ['SETTINGS_MANAGE'],
) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({
          data: { permissions: permissions.map((code) => ({ code, scopes: [] })) },
        }),
      );
    }
    if (method === 'GET' && url === '/api/v1/settings') {
      return Promise.resolve((routes.get ?? (() => jsonResponse({ data: catalog() })))(url, init));
    }
    if (method === 'POST' && url === '/api/v1/numbering/preview') {
      return Promise.resolve((routes.preview ?? previewResponse)(url, init));
    }
    if (method === 'PATCH' && url === '/api/v1/settings') {
      return Promise.resolve(
        (routes.patch ?? (() => problemResponse(500, 'INTERNAL_ERROR', 'x')))(url, init),
      );
    }
    return Promise.resolve(problemResponse(404, 'NOT_FOUND', 'x'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const bodyOf = (init?: RequestInit): Record<string, unknown> =>
  JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;

const patchCalls = (api: ReturnType<typeof mockApi>) =>
  api.mock.calls.filter(([, init]) => init?.method === 'PATCH');

/** Abre uma seção no `SettingsPage` (botões da navegação à esquerda). */
async function openGroup(name: string) {
  await userEvent.click(await screen.findByRole('button', { name }));
}

/** Escolhe uma opção no `Select` do kit (Radix): abre o gatilho e clica na opção. */
async function choose(trigger: HTMLElement, option: string) {
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  replace.mockClear();
});

describe('textos da SCR-041', () => {
  it('toda chave do registro tem rótulo e descrição (36 caminhos) e toda seção tem nome', () => {
    const fields = messages.settings.fields as unknown as Record<string, unknown>;
    for (const definition of SETTING_DEFINITIONS) {
      let node: unknown = fields;
      for (const part of definition.key.split('.')) {
        node = (node as Record<string, unknown> | undefined)?.[part];
      }
      expect(node, definition.key).toMatchObject({
        label: expect.any(String) as unknown,
        description: expect.any(String) as unknown,
      });
    }
    for (const section of SETTINGS_SECTIONS) {
      expect(
        (messages.settings.sections as Record<string, string>)[section.id],
        section.id,
      ).toBeTruthy();
    }
  });
});

describe('[Sucesso] SCR-041 · Configurações gerais', () => {
  it('lê SET-01, reúne os grupos em seções, mostra versão e passa no axe', async () => {
    const api = mockApi();
    renderWithShell(<SettingsView />);

    expect(await screen.findByRole('heading', { name: 'Configurações gerais' })).toBeTruthy();
    const nav = within(await screen.findByRole('navigation', { name: 'Seções de configurações' }));
    expect(nav.getAllByRole('button').map((item) => item.textContent)).toEqual([
      'Marca',
      'Rótulos',
      'Segurança',
      'Aprovações',
      'Processos e acesso',
      'Prazos',
      'Numeração',
      'Pesquisa de preços',
      'Riscos',
      'Arquivos',
      'Notificações',
      'Inteligência artificial',
    ]);
    expect(nav.getByRole('button', { name: 'Marca' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByLabelText('Cor principal')).toBeTruthy();
    await openGroup('Rótulos');
    expect(nav.getByRole('button', { name: 'Rótulos' }).getAttribute('aria-current')).toBe('true');
    expect(replace).toHaveBeenCalledWith('/admin/configuracoes?secao=labels', { scroll: false });
    const secretariat = screen.getByLabelText<HTMLInputElement>(
      'Nome do nível de unidade requisitante',
    );
    expect(secretariat.value).toBe('Secretaria');
    expect(screen.getAllByText('Versão 1').length).toBeGreaterThan(0);
    expect(api.mock.calls.some(([url]) => requestUrl(url) === '/api/v1/settings')).toBe(true);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('alterar o rótulo e salvar: PATCH só com a chave alterada e sua versão esperada', async () => {
    const api = mockApi({
      patch: () =>
        jsonResponse({ data: { 'labels.secretariat': { value: 'Diretoria', version: 2 } } }),
    });
    renderWithShell(<SettingsView />);

    await openGroup('Rótulos');
    const field = await screen.findByLabelText('Nome do nível de unidade requisitante');
    expect(await screen.findByText('Nenhuma alteração pendente')).toBeTruthy();
    await userEvent.clear(field);
    await userEvent.type(field, 'Diretoria');
    expect(screen.getByText('1 alteração pendente')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(patchCalls(api)).toHaveLength(1);
    });
    expect(bodyOf(patchCalls(api)[0]?.[1])).toEqual({
      values: { 'labels.secretariat': 'Diretoria' },
      expectedVersions: { 'labels.secretariat': 1 },
    });
    expect(await screen.findByText('Nenhuma alteração pendente')).toBeTruthy();
    expect(screen.getAllByText('Versão 2')).toHaveLength(1);
    expect(
      screen.getByLabelText<HTMLInputElement>('Nome do nível de unidade requisitante').value,
    ).toBe('Diretoria');
  });

  it('salva por seção: o lote tudo ou nada leva só as chaves da seção aberta', async () => {
    const api = mockApi({
      patch: () =>
        jsonResponse({
          data: {
            'security.sessionIdleMinutes': { value: 45, version: 2 },
            'security.mfaPolicy': { value: 'ALL', version: 2 },
          },
        }),
    });
    renderWithShell(<SettingsView />);

    // O rascunho de outra seção não atravessa a troca e nunca vai no lote.
    await openGroup('Rótulos');
    const department = await screen.findByLabelText('Nome do nível de setor');
    await userEvent.clear(department);
    await userEvent.type(department, 'Divisão');
    await openGroup('Segurança');
    const idle = await screen.findByLabelText('Inatividade até encerrar a sessão (minutos)');
    await userEvent.clear(idle);
    await userEvent.type(idle, '45');
    await choose(
      screen.getByRole('combobox', { name: 'Verificação em duas etapas' }),
      'Todos os usuários',
    );
    expect(screen.getByText('2 alterações pendentes')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(patchCalls(api)).toHaveLength(1);
    });
    expect(bodyOf(patchCalls(api)[0]?.[1])).toEqual({
      values: {
        'security.sessionIdleMinutes': 45,
        'security.mfaPolicy': 'ALL',
      },
      expectedVersions: {
        'security.sessionIdleMinutes': 1,
        'security.mfaPolicy': 1,
      },
    });
  });

  it('interruptor booleano, extensões e JSON de riscos têm editores próprios', async () => {
    mockApi();
    renderWithShell(<SettingsView />);
    await openGroup('Aprovações');
    const toggle = await screen.findByRole('switch', { name: 'Impedir autoaprovação' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(toggle);
    expect(screen.getByText('1 alteração pendente')).toBeTruthy();

    await openGroup('Arquivos');
    const pdf = screen.getByRole('checkbox', { name: 'pdf' });
    expect(pdf.getAttribute('aria-checked')).toBe('true');
    await openGroup('Riscos');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Escala de riscos (JSON)').value).toContain(
      '"max": 5',
    );
  });
});

describe('[Validação]', () => {
  it('máscara sem {year}: erro inline e "Salvar" desabilitado; aviso de efeito futuro da numeração', async () => {
    const api = mockApi();
    renderWithShell(<SettingsView />);
    await openGroup('Numeração');
    const mask = await screen.findByLabelText('Máscara do número do processo');
    await userEvent.clear(mask);
    await userEvent.type(mask, 'PROC-{{seq:4}');

    expect(
      await screen.findByText(
        'A máscara deve conter {seq:N} e {year}; verifique os marcadores usados.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Salvar' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Efeito a partir do próximo número')).toBeTruthy();
    expect(patchCalls(api)).toHaveLength(0);
  });

  it('escopo por órgão exige {org} na máscara', async () => {
    mockApi();
    renderWithShell(<SettingsView />);
    await openGroup('Numeração');
    await choose(
      await screen.findByRole('combobox', { name: 'Escopo da numeração' }),
      'Uma sequência por órgão/entidade',
    );
    expect(
      await screen.findByText('Com numeração por órgão, a máscara deve incluir {org}.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Salvar' }).hasAttribute('disabled')).toBe(true);
  });

  it('número fora do intervalo e cor sem contraste AA bloqueiam o salvamento', async () => {
    mockApi();
    renderWithShell(<SettingsView />);
    await openGroup('Segurança');
    const idle = await screen.findByLabelText('Inatividade até encerrar a sessão (minutos)');
    await userEvent.clear(idle);
    await userEvent.type(idle, '3');
    expect(
      await screen.findByText('Valor inválido para security.sessionIdleMinutes.'),
    ).toBeTruthy();
    await userEvent.clear(idle);
    await userEvent.type(idle, '30');

    await openGroup('Marca');
    const color = await screen.findByLabelText('Cor principal');
    await userEvent.clear(color);
    await userEvent.type(color, '#FFFF00');
    expect((await screen.findAllByText(/contraste com texto branco/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Salvar' }).hasAttribute('disabled')).toBe(true);
  });

  it('422 da API marca o campo da chave', async () => {
    mockApi({
      patch: () =>
        problemResponse(422, 'VALIDATION_ERROR', 'Dados inválidos', {
          errors: [
            {
              field: 'values.labels.department',
              code: 'INVALID_FORMAT',
              message: 'Valor inválido para labels.department.',
            },
          ],
        }),
    });
    renderWithShell(<SettingsView />);
    await openGroup('Rótulos');
    const field = await screen.findByLabelText('Nome do nível de setor');
    await userEvent.type(field, ' x');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText('Valor inválido para labels.department.')).toBeTruthy();
  });
});

describe('US-105 · numeração com prévia ao vivo (SET-04)', () => {
  const previewCalls = (api: ReturnType<typeof mockApi>) =>
    api.mock.calls.filter(([input]) => requestUrl(input) === '/api/v1/numbering/preview');

  it('máscara válida: "Calculando prévia…" e o exemplo do servidor, anunciados por aria-live', async () => {
    const api = mockApi();
    renderWithShell(<SettingsView />);
    await openGroup('Numeração');
    const mask = await screen.findByLabelText('Máscara do número do processo');
    expect(await screen.findByText('Próximo número: 0012/2026')).toBeTruthy();

    await userEvent.clear(mask);
    await userEvent.type(mask, '{{org}-{{seq:5}/{{year}');
    expect(screen.getAllByText('Calculando prévia…').length).toBeGreaterThan(0);
    const live = await screen.findByText('Próximo número: PMSJ-00012/2026');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(mask.getAttribute('aria-describedby')).toContain(live.parentElement?.id ?? '-');
    // FA-04: a prévia usa a máscara digitada (não a gravada) e o escopo em edição.
    expect(bodyOf(previewCalls(api).at(-1)?.[1])).toEqual({
      mask: '{org}-{seq:5}/{year}',
      scope: 'TENANT',
    });
    expect(patchCalls(api)).toHaveLength(0);
  });

  it('enquanto a máscara é inválida a prévia não avança (nenhuma chamada nova a SET-04)', async () => {
    const api = mockApi();
    renderWithShell(<SettingsView />);
    await openGroup('Numeração');
    const mask = await screen.findByLabelText('Máscara do número do processo');
    await screen.findByText('Próximo número: 0012/2026');
    const calls = previewCalls(api).length;

    await userEvent.clear(mask);
    await userEvent.type(mask, '{{seq:4}');

    expect(
      await screen.findByText(
        'A máscara deve conter {seq:N} e {year}; verifique os marcadores usados.',
      ),
    ).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(previewCalls(api)).toHaveLength(calls);
    expect(screen.queryByText('Próximo número: 0012/2026')).toBeNull();
  });

  it('máscara padrão de documento usa o tipo de exemplo DFD', async () => {
    const api = mockApi();
    renderWithShell(<SettingsView />);
    await openGroup('Numeração');
    expect(await screen.findByText('Próximo número: DFD 0005/2026')).toBeTruthy();
    expect(previewCalls(api).some(([, init]) => bodyOf(init).documentTypeCode === 'DFD')).toBe(
      true,
    );
  });

  it('trocar o escopo mostra o aviso não bloqueante de efeito no próximo exercício', async () => {
    mockApi();
    renderWithShell(<SettingsView />);
    await openGroup('Numeração');
    expect(screen.queryByText('Esta mudança vale a partir do próximo exercício')).toBeNull();
    await choose(
      await screen.findByRole('combobox', { name: 'Escopo da numeração' }),
      'Uma sequência por órgão/entidade',
    );
    expect(await screen.findByText('Esta mudança vale a partir do próximo exercício')).toBeTruthy();
    const mask = screen.getByLabelText('Máscara do número do processo');
    await userEvent.clear(mask);
    await userEvent.type(mask, '{{org}-{{seq:4}/{{year}');
    // O aviso não bloqueia: com {org}, o lote pode ser salvo.
    expect(screen.getByRole('button', { name: 'Salvar' }).hasAttribute('disabled')).toBe(false);
  });

  it('erro do servidor na prévia mostra a mensagem da API', async () => {
    mockApi({
      preview: () =>
        problemResponse(422, 'NUMBERING_MASK_INVALID', 'x', {
          errors: [{ field: 'mask', code: 'INVALID_FORMAT', message: 'Máscara recusada.' }],
        }),
    });
    renderWithShell(<SettingsView />);
    await openGroup('Numeração');
    expect((await screen.findAllByText('Máscara recusada.')).length).toBeGreaterThan(0);
  });

  it('máscara própria de um tipo (numbering.document.<TYPE>.mask) tem rótulo e prévia do tipo', async () => {
    mockApi({
      get: () =>
        jsonResponse({
          data: catalog({
            'numbering.document.OFICIO.mask': { value: 'OF {seq:3}/{year}', version: 1 },
          }),
        }),
    });
    renderWithShell(<SettingsView />);
    await openGroup('Numeração');
    expect(await screen.findByLabelText('Máscara dos documentos do tipo OFICIO')).toBeTruthy();
    expect(await screen.findByText('Próximo número: OF 005/2026')).toBeTruthy();
  });
});

describe('[Concorrência e falhas]', () => {
  it('412 VERSION_CONFLICT: oferece recarregar e descarta os rascunhos', async () => {
    let reads = 0;
    mockApi({
      get: () => {
        reads += 1;
        return jsonResponse({
          data: catalog(reads > 1 ? { 'labels.secretariat': { value: 'Pasta', version: 2 } } : {}),
        });
      },
      patch: () =>
        problemResponse(412, 'VERSION_CONFLICT', 'Versão desatualizada', { currentVersion: 2 }),
    });
    renderWithShell(<SettingsView />);
    await openGroup('Rótulos');
    const field = await screen.findByLabelText('Nome do nível de unidade requisitante');
    await userEvent.clear(field);
    await userEvent.type(field, 'Diretoria');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(
      await screen.findByText('Esta configuração foi alterada por outra pessoa.'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Recarregar valores' }));
    await waitFor(() => {
      expect(
        screen.getByLabelText<HTMLInputElement>('Nome do nível de unidade requisitante').value,
      ).toBe('Pasta');
    });
    expect(screen.queryByText('Esta configuração foi alterada por outra pessoa.')).toBeNull();
  });

  it('503 ao salvar: mantém os valores digitados e informa a indisponibilidade', async () => {
    mockApi({ patch: () => problemResponse(503, 'DEPENDENCY_UNAVAILABLE', 'Indisponível') });
    renderWithShell(<SettingsView />);
    await openGroup('Rótulos');
    const field = await screen.findByLabelText('Nome do nível de setor');
    await userEvent.type(field, ' novo');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(
      await screen.findByText(/Não foi possível salvar agora\. Seus valores continuam na tela/),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Nome do nível de setor').value).toBe(
      'Setor novo',
    );
  });

  it('erro de leitura mostra "Tentar novamente"', async () => {
    mockApi({ get: () => problemResponse(429, 'RATE_LIMITED', 'Muitas tentativas.') });
    renderWithShell(<SettingsView />);
    expect(await screen.findByText('Não foi possível carregar as configurações.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
  });

  it('carregando: skeleton acessível', async () => {
    mockApi({ get: () => new Promise<Response>(() => undefined) });
    renderWithShell(<SettingsView />);
    expect((await screen.findByRole('status')).textContent).toContain(
      'Carregando as configurações',
    );
  });
});

describe('[Permissão]', () => {
  it('sem SETTINGS_MANAGE a API responde 403 e a tela mostra "Acesso negado"', async () => {
    mockApi({ get: () => problemResponse(403, 'PERMISSION_DENIED', 'Negado') }, []);
    renderWithShell(<SettingsView />);
    expect(await screen.findByText('Acesso negado')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
  });

  it('a barra de salvamento só aparece com SETTINGS_MANAGE confirmada por ME-03', async () => {
    mockApi({}, ['PROCESS_VIEW']);
    renderWithShell(<SettingsView />);
    await screen.findByLabelText('Cor principal');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
    });
  });
});
