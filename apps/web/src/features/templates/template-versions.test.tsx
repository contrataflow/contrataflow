// @vitest-environment jsdom
import { Toaster } from '@contrataflow/ui';
import { DEFAULT_TEMPLATE_LAYOUT } from '@contrataflow/validation';
import type {
  DocumentTypeDto,
  TemplateDto,
  TemplateVersionDto,
  TemplateVersionHistoryItem,
} from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { DefaultTemplateSelect } from './default-template-select';
import { prePublishProblems, retireBlocked } from './template-versions-model';
import { TemplateVersionsView } from './template-versions-view';

/* US-108 · SCR-033 (aba "Versões") e o `DefaultTemplateSelect` do SCR-108. */

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => '/admin/templates',
}));

const NOW = '2026-10-15T12:00:00.000Z';
const HASH = 'ab12cd34ef56'.padEnd(64, '0');
const OFICIO = {
  id: '0192a000-0000-7000-8000-0000000d0003',
  code: 'OFICIO',
  name: 'Ofício',
  kind: 'FREE_TEXT',
  systemModule: null,
  defaultConfidentiality: 'INTERNAL',
} as const;
const TEMPLATE_ID = '0192a000-0000-7000-8000-0000000e0002';
const V1 = '0192a000-0000-7000-8000-0000000f0011';
const V2 = '0192a000-0000-7000-8000-0000000f0012';

function template(overrides: Partial<TemplateDto> = {}): TemplateDto {
  return {
    id: TEMPLATE_ID,
    name: 'Ofício padrão',
    description: null,
    documentTypeId: OFICIO.id,
    documentType: OFICIO,
    isActive: true,
    isSystem: false,
    isDefault: false,
    draftVersion: {
      id: V2,
      versionNumber: 2,
      status: 'DRAFT',
      sectionCount: 2,
      updatedAt: NOW,
      publishedAt: null,
    },
    currentPublishedVersion: {
      id: V1,
      versionNumber: 1,
      status: 'PUBLISHED',
      sectionCount: 2,
      updatedAt: NOW,
      publishedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
    version: 2,
    ...overrides,
  };
}

function item(overrides: Partial<TemplateVersionHistoryItem> = {}): TemplateVersionHistoryItem {
  return {
    id: V1,
    templateId: TEMPLATE_ID,
    versionNumber: 1,
    status: 'PUBLISHED',
    sectionCount: 2,
    changeNotes: null,
    isCurrent: true,
    publishedAt: NOW,
    retiredAt: null,
    contentHash: HASH,
    createdAt: NOW,
    updatedAt: NOW,
    version: 3,
    ...overrides,
  };
}

const draftItem = () =>
  item({
    id: V2,
    versionNumber: 2,
    status: 'DRAFT',
    isCurrent: false,
    publishedAt: null,
    contentHash: null,
    changeNotes: 'Inclui a conclusão',
    version: 2,
  });

function draftVersion(overrides: Partial<TemplateVersionDto> = {}): TemplateVersionDto {
  return {
    id: V2,
    templateId: TEMPLATE_ID,
    templateName: 'Ofício padrão',
    versionNumber: 2,
    status: 'DRAFT',
    documentType: OFICIO,
    sections: [
      {
        key: 'OBJETO',
        title: 'Objeto',
        order: 1,
        requirement: 'REQUIRED',
        maxChars: 50_000,
        render: 'TEXT',
        allowNarrative: true,
      },
    ],
    fieldConfig: {},
    importMappings: null,
    layout: DEFAULT_TEMPLATE_LAYOUT,
    changeNotes: null,
    importSources: null,
    publishedAt: null,
    retiredAt: null,
    contentHash: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 2,
    ...overrides,
  };
}

function firstSection(): TemplateVersionDto['sections'][number] {
  const [first] = draftVersion().sections;
  if (!first) throw new Error('rascunho sem seção');
  return first;
}

function problem(
  status: number,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {},
) {
  return new Response(
    JSON.stringify({
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase()}`,
      title: code,
      status,
      detail,
      instance: '/api/v1/x',
      code,
      correlationId: 'c-test',
      errors: [],
      violations: [],
      ...extra,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

type Handler = (url: string, init?: RequestInit) => Response;

function mockApi(
  routes: {
    template?: Handler;
    history?: Handler;
    version?: Handler;
    publish?: Handler;
    retire?: Handler;
    create?: Handler;
    setDefault?: Handler;
  } = {},
  permissions: readonly string[] = ['TEMPLATE_VIEW', 'TEMPLATE_MANAGE', 'TEMPLATE_PUBLISH'],
) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const pick = (handler: Handler | undefined, fallback: Handler) =>
      Promise.resolve((handler ?? fallback)(url, init));
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({ data: { permissions: permissions.map((code) => ({ code, scopes: [] })) } }),
      );
    }
    if (method === 'GET' && url.startsWith(`/api/v1/templates/${TEMPLATE_ID}/versions`)) {
      return pick(routes.history, () =>
        jsonResponse({ data: [draftItem(), item()], meta: { page: 1, totalItems: 2 } }),
      );
    }
    if (method === 'GET' && url.startsWith(`/api/v1/templates/${TEMPLATE_ID}`)) {
      return pick(routes.template, () => jsonResponse({ data: template() }));
    }
    if (method === 'GET' && url.startsWith('/api/v1/template-versions/')) {
      return pick(routes.version, () => jsonResponse({ data: draftVersion() }));
    }
    if (url.endsWith('/publish')) return pick(routes.publish, () => problem(500, 'X', 'x'));
    if (url.endsWith('/retire')) return pick(routes.retire, () => problem(500, 'X', 'x'));
    if (method === 'POST' && url.endsWith('/versions')) {
      return pick(routes.create, () => problem(500, 'X', 'x'));
    }
    if (method === 'PUT') return pick(routes.setDefault, () => problem(500, 'X', 'x'));
    return Promise.resolve(problem(404, 'NOT_FOUND', 'x'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const headerOf = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers).get(name);
const callTo = (api: ReturnType<typeof mockApi>, suffix: string) =>
  api.mock.calls.find(([input]) => requestUrl(input).endsWith(suffix));

function WithToaster({ children }: { readonly children: ReactNode }) {
  return (
    <>
      {children}
      <Toaster />
    </>
  );
}

/** Abre o menu ⋯ da linha da versão (`Ações da versão N`). */
async function openVersionMenu(
  number: number,
  user: Pick<ReturnType<typeof userEvent.setup>, 'click'> = userEvent,
) {
  await user.click(
    await screen.findByRole('button', { name: `Ações da versão ${String(number)}` }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

describe('template-versions-model', () => {
  it('prePublishProblems usa a validação do editor e aponta a seção', () => {
    expect(prePublishProblems(draftVersion())).toEqual([]);
    const invalid = draftVersion({
      sections: [{ ...firstSection(), key: 'objeto', helpText: '{{nao.existe}}' }],
    });
    expect(prePublishProblems(invalid).map((p) => p.sectionKey)).toEqual(['objeto', 'objeto']);
  });

  it('retireBlocked: só a corrente sem outra publicada de um template padrão', () => {
    const current = item();
    expect(retireBlocked(current, [current], true)).toBe(true);
    expect(retireBlocked(current, [current], false)).toBe(false);
    expect(retireBlocked(current, [current, item({ id: V2, isCurrent: false })], true)).toBe(false);
    expect(retireBlocked(item({ isCurrent: false }), [current], true)).toBe(false);
  });
});

describe('SCR-033 · aba Versões (US-108)', () => {
  it('[Sucesso] histórico com situação, corrente, hash resumido e notas; ações por linha (axe)', async () => {
    mockApi();
    renderWithShell(
      <WithToaster>
        <TemplateVersionsView templateId={TEMPLATE_ID} />
      </WithToaster>,
    );
    const v2Row = (await screen.findByRole('rowheader', { name: 'v2' })).closest('tr');
    const v1Row = screen.getByRole('rowheader', { name: 'v1' }).closest('tr');
    if (!v2Row || !v1Row) throw new Error('linhas ausentes');
    expect(within(v2Row).getByText('Rascunho')).toBeTruthy();
    expect(within(v2Row).getByText('Inclui a conclusão')).toBeTruthy();
    expect(within(v1Row).getByText('Corrente')).toBeTruthy();
    expect(within(v1Row).getByText('ab12cd34ef56')).toBeTruthy();
    // Com rascunho, "Iniciar nova versão" não aparece (RN-TPL-13).
    expect(screen.queryByRole('button', { name: 'Iniciar nova versão' })).toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);

    await userEvent.click(within(v2Row).getByRole('button', { name: 'Ações da versão 2' }));
    expect(await screen.findByRole('menuitem', { name: 'Publicar versão' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Editar' }).getAttribute('href')).toBe(
      `/admin/templates/${TEMPLATE_ID}/versoes/${V2}`,
    );
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(v1Row).getByRole('button', { name: 'Ações da versão 1' }));
    expect(await screen.findByRole('menuitem', { name: 'Aposentar' })).toBeTruthy();
  });

  it('[Sucesso] publicar: confere o rascunho, envia If-Match e Idempotency-Key e mostra o hash no toast', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      publish: () =>
        jsonResponse({
          data: draftVersion({ status: 'PUBLISHED', contentHash: HASH, version: 3 }),
        }),
    });
    renderWithShell(
      <WithToaster>
        <TemplateVersionsView templateId={TEMPLATE_ID} />
      </WithToaster>,
    );
    await openVersionMenu(2, user);
    await user.click(await screen.findByRole('menuitem', { name: 'Publicar versão' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publicar a versão 2?' });
    const confirm = within(dialog).getByRole('button', { name: 'Publicar' });
    await waitFor(() => {
      expect(confirm.hasAttribute('disabled')).toBe(false);
    });
    expect(document.activeElement).toBe(confirm);
    expect(await seriousA11yViolations()).toEqual([]);
    await user.click(confirm);

    expect(await screen.findByText('Versão 2 publicada (hash ab12cd34ef56).')).toBeTruthy();
    const [, init] = callTo(api, `/template-versions/${V2}/publish`) ?? [];
    expect(init?.method).toBe('POST');
    expect(headerOf(init, 'If-Match')).toBe('"2"');
    expect(headerOf(init, 'Idempotency-Key')).toBeTruthy();
  });

  it('[Validação] pendências locais desabilitam "Publicar" e são listadas; 422 lista as violações por seção', async () => {
    const user = userEvent.setup();
    mockApi({
      version: () =>
        jsonResponse({
          data: draftVersion({
            sections: [{ ...firstSection(), helpText: 'Veja {{nao.existe}}' }],
          }),
        }),
    });
    renderWithShell(
      <WithToaster>
        <TemplateVersionsView templateId={TEMPLATE_ID} />
      </WithToaster>,
    );
    await openVersionMenu(2, user);
    await user.click(await screen.findByRole('menuitem', { name: 'Publicar versão' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText('O template tem pendências que impedem a publicação.'),
    ).toBeTruthy();
    expect(within(dialog).getByText(/OBJETO/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Publicar' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('[Validação] 422 TEMPLATE_INVALID do servidor: violações listadas e nada publicado', async () => {
    const user = userEvent.setup();
    mockApi({
      publish: () =>
        problem(422, 'TEMPLATE_INVALID', 'O template tem um problema de conteúdo.', {
          violations: [
            {
              code: 'TEMPLATE_IMPORT_TARGET_UNKNOWN',
              severity: 'BLOCKING',
              message: 'O mapeamento referencia uma seção que não existe.',
              ruleId: null,
              sectionKey: 'OBJETO',
              field: null,
              itemId: null,
              params: {},
            },
          ],
        }),
    });
    renderWithShell(
      <WithToaster>
        <TemplateVersionsView templateId={TEMPLATE_ID} />
      </WithToaster>,
    );
    await openVersionMenu(2, user);
    await user.click(await screen.findByRole('menuitem', { name: 'Publicar versão' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Publicar' });
    await waitFor(() => {
      expect(confirm.hasAttribute('disabled')).toBe(false);
    });
    await user.click(confirm);
    expect(
      await within(dialog).findByText('O mapeamento referencia uma seção que não existe.'),
    ).toBeTruthy();
  });

  it('[Validação] FA-03: única publicada de um template padrão → "Aposentar" desabilitado com explicação', async () => {
    mockApi({
      template: () => jsonResponse({ data: template({ isDefault: true, draftVersion: null }) }),
      history: () => jsonResponse({ data: [item()], meta: { page: 1, totalItems: 1 } }),
    });
    renderWithShell(
      <WithToaster>
        <TemplateVersionsView templateId={TEMPLATE_ID} />
      </WithToaster>,
    );
    await openVersionMenu(1);
    const retire = await screen.findByRole('menuitem', { name: 'Aposentar' });
    expect(retire.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/publique outra versão/)).toBeTruthy();
    expect(screen.getByText('Padrão do tipo')).toBeTruthy();
  });

  it('[Sucesso] aposentar: If-Match da versão; 409 TEMPLATE_IN_USE mostra a mensagem da API', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      retire: () =>
        problem(
          409,
          'TEMPLATE_IN_USE',
          'Publique outra versão antes de aposentar esta, pois ela é a padrão de "Ofício".',
        ),
    });
    renderWithShell(
      <WithToaster>
        <TemplateVersionsView templateId={TEMPLATE_ID} />
      </WithToaster>,
    );
    await openVersionMenu(1, user);
    await user.click(await screen.findByRole('menuitem', { name: 'Aposentar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aposentar a versão 1?' });
    await user.click(within(dialog).getByRole('button', { name: 'Aposentar' }));
    expect(
      await within(dialog).findByText(
        'Publique outra versão antes de aposentar esta, pois ela é a padrão de "Ofício".',
      ),
    ).toBeTruthy();
    const [, init] = callTo(api, `/template-versions/${V1}/retire`) ?? [];
    expect(headerOf(init, 'If-Match')).toBe('"3"');
  });

  it('[Sucesso] iniciar nova versão abre o rascunho no editor; [Concorrência] 409 TEMPLATE_DRAFT_EXISTS avisa', async () => {
    const user = userEvent.setup();
    let calls = 0;
    mockApi({
      template: () => jsonResponse({ data: template({ draftVersion: null }) }),
      history: () => jsonResponse({ data: [item()], meta: { page: 1, totalItems: 1 } }),
      create: () => {
        calls += 1;
        return calls === 1
          ? jsonResponse(
              { data: draftVersion({ id: V2, versionNumber: 2, version: 1 }) },
              { status: 201 },
            )
          : problem(409, 'TEMPLATE_DRAFT_EXISTS', 'Já existe um rascunho.', {
              meta: { draftVersionId: V2 },
            });
      },
    });
    renderWithShell(
      <WithToaster>
        <TemplateVersionsView templateId={TEMPLATE_ID} />
      </WithToaster>,
    );
    await user.click(await screen.findByRole('button', { name: 'Iniciar nova versão' }));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/admin/templates/${TEMPLATE_ID}/versoes/${V2}`);
    });
    await user.click(await screen.findByRole('button', { name: 'Iniciar nova versão' }));
    expect(
      await screen.findByText('Já existe um rascunho em edição para este template.'),
    ).toBeTruthy();
  });

  it('[Permissão] FA-05: só TEMPLATE_VIEW navega no histórico sem botões de ação', async () => {
    mockApi({}, ['TEMPLATE_VIEW']);
    renderWithShell(
      <WithToaster>
        <TemplateVersionsView templateId={TEMPLATE_ID} />
      </WithToaster>,
    );
    expect(await screen.findByRole('rowheader', { name: 'v2' })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Publicar|Aposentar|Iniciar nova versão/ }),
    ).toBeNull();
    await openVersionMenu(1);
    expect(await screen.findByRole('menuitem', { name: 'Ver' })).toBeTruthy();
  });
});

describe('SCR-033 · biblioteca padrão semeada (US-110)', () => {
  const seeded = () =>
    template({
      name: 'Ofício — Modelo padrão',
      isSystem: true,
      isDefault: true,
      draftVersion: null,
    });

  it('[Sucesso] template semeado mostra o selo em texto e aceita "Iniciar nova versão" (RN-TPL-32)', async () => {
    mockApi({
      template: () => jsonResponse({ data: seeded() }),
      history: () => jsonResponse({ data: [item()], meta: { page: 1, totalItems: 1 } }),
    });
    renderWithShell(
      <WithToaster>
        <TemplateVersionsView templateId={TEMPLATE_ID} />
      </WithToaster>,
    );
    expect(await screen.findByText('Modelo padrão da plataforma')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Iniciar nova versão' })).toBeTruthy();
  });

  it('[Permissão] só TEMPLATE_VIEW: selo visível e sem o botão de nova versão', async () => {
    mockApi(
      {
        template: () => jsonResponse({ data: seeded() }),
        history: () => jsonResponse({ data: [item()], meta: { page: 1, totalItems: 1 } }),
      },
      ['TEMPLATE_VIEW'],
    );
    renderWithShell(
      <WithToaster>
        <TemplateVersionsView templateId={TEMPLATE_ID} />
      </WithToaster>,
    );
    expect(await screen.findByText('Modelo padrão da plataforma')).toBeTruthy();
    expect(await screen.findByRole('rowheader', { name: 'v1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Iniciar nova versão' })).toBeNull();
  });
});

describe('DefaultTemplateSelect (SCR-108 · DTY-04)', () => {
  const type = {
    id: OFICIO.id,
    code: 'OFICIO',
    name: 'Ofício',
    kind: 'FREE_TEXT',
    defaultTemplate: null,
    version: 4,
  } as unknown as DocumentTypeDto;
  const unpublished = template({
    id: '0192a000-0000-7000-8000-0000000e0003',
    name: 'Ofício rascunho',
    currentPublishedVersion: null,
  });

  it('opções do tipo: publicadas selecionáveis, sem publicação desabilitadas; troca envia PUT com If-Match', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      setDefault: () =>
        jsonResponse({
          data: {
            ...type,
            defaultTemplate: { id: TEMPLATE_ID, name: 'Ofício padrão', versionNumber: 1 },
          },
        }),
    });
    renderWithShell(
      <WithToaster>
        <DefaultTemplateSelect type={type} templates={[template(), unpublished]} />
      </WithToaster>,
    );
    await user.click(screen.getByRole('combobox', { name: 'Template padrão de Ofício' }));
    expect(
      (
        await screen.findByRole('option', { name: 'Ofício rascunho (sem versão publicada)' })
      ).getAttribute('aria-disabled'),
    ).toBe('true');
    await user.click(screen.getByRole('option', { name: /^Ofício padrão/ }));

    expect(
      await screen.findByText('Template padrão de "Ofício" definido: Ofício padrão.'),
    ).toBeTruthy();
    const [, init] = callTo(api, `/document-types/${OFICIO.id}/default-template`) ?? [];
    expect(init?.method).toBe('PUT');
    expect(headerOf(init, 'If-Match')).toBe('"4"');
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '{}')).toEqual({
      templateId: TEMPLATE_ID,
    });
  });

  it('erro da API (412) aparece junto ao campo', async () => {
    const user = userEvent.setup();
    mockApi({ setDefault: () => problem(412, 'VERSION_CONFLICT', 'Alterado.') });
    renderWithShell(
      <WithToaster>
        <DefaultTemplateSelect type={type} templates={[template()]} />
      </WithToaster>,
    );
    await user.click(screen.getByRole('combobox', { name: 'Template padrão de Ofício' }));
    await user.click(await screen.findByRole('option', { name: /^Ofício padrão/ }));
    expect(
      await screen.findByText(
        'O tipo foi alterado por outra pessoa. A lista foi recarregada; tente novamente.',
      ),
    ).toBeTruthy();
  });
});
