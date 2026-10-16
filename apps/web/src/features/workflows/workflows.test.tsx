// @vitest-environment jsdom
import { Toaster } from '@contrataflow/ui';
import type { WorkflowDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { WorkflowsView } from './workflows-view';
import { describeApplicability } from './workflows.api';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/workflows',
}));

const DIRECT_RULE = { in: [{ var: 'process.modalityCode' }, ['DISPENSA', 'INEXIGIBILIDADE']] };

function workflow(overrides: Partial<WorkflowDto>): WorkflowDto {
  return {
    id: '0192a000-0000-7000-8000-000000000001',
    key: 'DEFAULT_PREPARATORY',
    name: 'Fase preparatória — Lei 14.133/2021',
    description: null,
    isActive: true,
    isDefault: false,
    applicabilityRule: null,
    applicabilityPriority: 100,
    currentPublishedVersion: {
      id: '0192a000-0000-7000-8000-0000000000a1',
      versionNumber: 1,
      publishedAt: '2026-10-15T12:00:00.000Z',
    },
    draftVersion: null,
    version: 2,
    ...overrides,
  };
}

const DIRECT = workflow({
  id: '0192a000-0000-7000-8000-000000000002',
  key: 'DIRECT_CONTRACTING_ART72',
  name: 'Contratação direta — Lei 14.133/2021, art. 72',
  applicabilityRule: DIRECT_RULE,
  applicabilityPriority: 50,
  version: 3,
});
const STANDARD = workflow({ isDefault: true });
const PILOTO = workflow({
  id: '0192a000-0000-7000-8000-000000000003',
  key: 'PILOTO_OBRAS',
  name: 'Piloto de obras',
  currentPublishedVersion: null,
  draftVersion: { id: '0192a000-0000-7000-8000-0000000000c1', versionNumber: 1 },
});

function problemResponse(status: number, code: string): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase()}`,
      title: code,
      status,
      detail: code,
      instance: '/api/v1/workflows',
      code,
      correlationId: 'c-test',
      errors: [],
      violations: [],
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function mockApi(
  routes: { list?: Handler; setDefault?: Handler } = {},
  permissions: readonly string[] = ['WORKFLOW_VIEW', 'WORKFLOW_MANAGE', 'WORKFLOW_PUBLISH'],
) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({ data: { permissions: permissions.map((code) => ({ code, scopes: [] })) } }),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/workflows')) {
      return Promise.resolve(
        (routes.list ?? (() => jsonResponse({ data: [DIRECT, STANDARD, PILOTO] })))(url, init),
      );
    }
    if (method === 'POST' && url.endsWith('/set-default')) {
      return Promise.resolve(
        (routes.setDefault ?? (() => problemResponse(500, 'INTERNAL_ERROR')))(url, init),
      );
    }
    return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function WithToaster({ children }: { readonly children: ReactNode }) {
  return (
    <>
      {children}
      <Toaster />
    </>
  );
}

const card = (name: RegExp) => {
  const item = screen.getAllByRole('listitem').find((li) => name.test(li.textContent));
  if (!item) throw new Error(`cartão ${String(name)} ausente`);
  return item;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('describeApplicability', () => {
  it('nula, modalidades semeadas e regra personalizada', () => {
    expect(describeApplicability(null)).toEqual({ kind: 'ANY' });
    expect(describeApplicability(DIRECT_RULE)).toEqual({
      kind: 'MODALITIES',
      codes: ['DISPENSA', 'INEXIGIBILIDADE'],
    });
    expect(describeApplicability({ '>': [{ var: 'process.estimatedValue' }, 1] })).toEqual({
      kind: 'CUSTOM',
    });
    expect(describeApplicability({ in: [{ var: 'process.originCode' }, ['PCA']] })).toEqual({
      kind: 'CUSTOM',
    });
  });
});

describe('SCR-034 · lista de workflows com o padrão (US-042)', () => {
  it('[Sucesso] lista com o selo "Padrão" (ícone + texto), aplicabilidade e versão; sem violações de a11y', async () => {
    mockApi();
    renderWithShell(<WorkflowsView />);

    await screen.findByText('Contratação direta — Lei 14.133/2021, art. 72');
    const standard = card(/Fase preparatória/);
    expect(within(standard).getByText('Padrão')).toBeTruthy();
    expect(within(standard).getByText('Qualquer processo')).toBeTruthy();
    expect(within(standard).getByText('v1')).toBeTruthy();
    expect(within(standard).queryByRole('button', { name: /Tornar/ })).toBeNull();
    const direct = card(/Contratação direta/);
    expect(within(direct).getByText('Modalidade: DISPENSA, INEXIGIBILIDADE')).toBeTruthy();
    expect(within(direct).getByText('Prioridade 50')).toBeTruthy();
    expect(within(direct).queryByText('Padrão')).toBeNull();
    expect(
      await within(direct).findByRole('button', {
        name: 'Tornar Contratação direta — Lei 14.133/2021, art. 72 o workflow padrão',
      }),
    ).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Validação] FA-02: workflow sem versão publicada tem "Tornar padrão" desabilitado com o motivo', async () => {
    mockApi();
    renderWithShell(<WorkflowsView />);
    await screen.findByText('Piloto de obras');
    const piloto = card(/Piloto de obras/);
    const button = await within(piloto).findByRole('button', { name: /Tornar Piloto de obras/ });
    expect(button.hasAttribute('disabled')).toBe(true);
    const reason = button.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(reason)?.textContent).toBe(
      'Publique uma versão e ative o workflow antes de torná-lo padrão.',
    );
    expect(within(piloto).getByText('Nenhuma versão publicada')).toBeTruthy();
  });

  it('[Permissão] sem WORKFLOW_PUBLISH a ação fica oculta', async () => {
    mockApi({}, ['WORKFLOW_VIEW']);
    renderWithShell(<WorkflowsView />);
    await screen.findByText('Piloto de obras');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Tornar/ })).toBeNull();
    });
  });

  it('[Sucesso] tornar padrão: confirma, envia WF-05 com If-Match e mostra o toast', async () => {
    let listed = [DIRECT, STANDARD, PILOTO];
    const api = mockApi({
      list: () => jsonResponse({ data: listed }),
      setDefault: () => {
        listed = [
          { ...DIRECT, isDefault: true, version: 4 },
          { ...STANDARD, isDefault: false, version: 3 },
          PILOTO,
        ];
        return jsonResponse({ data: listed[0] }, { headers: { ETag: '"4"' } });
      },
    });
    const user = userEvent.setup();
    renderWithShell(
      <WithToaster>
        <WorkflowsView />
      </WithToaster>,
    );

    await user.click(await screen.findByRole('button', { name: /Tornar Contratação direta/ }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Hoje o padrão é "Fase preparatória — Lei 14.133/2021".'),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Tornar padrão' }));

    expect(
      await screen.findByText(
        'Workflow Contratação direta — Lei 14.133/2021, art. 72 agora é o padrão.',
      ),
    ).toBeTruthy();
    const call = api.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(requestUrl(call?.[0] ?? '')).toBe(`/api/v1/workflows/${DIRECT.id}/set-default`);
    expect(new Headers(call?.[1]?.headers).get('If-Match')).toBe('"3"');
    await waitFor(() => {
      expect(within(card(/Contratação direta/)).queryByText('Padrão')).toBeTruthy();
    });
    expect(within(card(/Fase preparatória/)).queryByText('Padrão')).toBeNull();
  });

  it('[Concorrência] 412 mostra "alterado por outra pessoa" e recarrega a lista', async () => {
    const api = mockApi({ setDefault: () => problemResponse(412, 'VERSION_CONFLICT') });
    const user = userEvent.setup();
    renderWithShell(<WorkflowsView />);
    await user.click(await screen.findByRole('button', { name: /Tornar Contratação direta/ }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Tornar padrão' }),
    );
    expect(
      await screen.findByText('Este workflow foi alterado por outra pessoa. Atualize a página.'),
    ).toBeTruthy();
    await waitFor(() => {
      const lists = api.mock.calls.filter(
        ([input, init]) =>
          (init?.method ?? 'GET') === 'GET' && requestUrl(input).startsWith('/api/v1/workflows'),
      );
      expect(lists.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('[Falha de banco] 503 orienta tentar de novo; 403 e 422 têm mensagens próprias', async () => {
    const statuses: [number, string, string][] = [
      [
        503,
        'DEPENDENCY_UNAVAILABLE',
        'Não foi possível concluir agora. Tente novamente em instantes.',
      ],
      [403, 'PERMISSION_DENIED', 'Você não tem permissão para alterar o workflow padrão.'],
      [
        422,
        'BUSINESS_RULE_VIOLATION',
        'Publique uma versão e ative o workflow antes de torná-lo padrão.',
      ],
    ];
    for (const [status, code, message] of statuses) {
      mockApi({ setDefault: () => problemResponse(status, code) });
      const user = userEvent.setup();
      const view = renderWithShell(<WorkflowsView />);
      await user.click(await screen.findByRole('button', { name: /Tornar Contratação direta/ }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Tornar padrão' }));
      expect(await within(dialog).findByText(message)).toBeTruthy();
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('carregando, vazio e 403', async () => {
    mockApi({ list: () => new Promise<Response>(() => undefined) });
    const loading = renderWithShell(<WorkflowsView />);
    expect((await screen.findByRole('status')).textContent).toContain('Carregando os workflows');
    loading.unmount();

    mockApi({ list: () => jsonResponse({ data: [] }) });
    const empty = renderWithShell(<WorkflowsView />);
    expect(await screen.findByText('Nenhum workflow cadastrado ainda.')).toBeTruthy();
    empty.unmount();

    mockApi({ list: () => problemResponse(403, 'PERMISSION_DENIED') });
    renderWithShell(<WorkflowsView />);
    expect(
      await screen.findByText('Você não tem permissão para consultar os workflows.'),
    ).toBeTruthy();
  });
});
