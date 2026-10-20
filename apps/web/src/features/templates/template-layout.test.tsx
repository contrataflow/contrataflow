// @vitest-environment jsdom
import { DEFAULT_TEMPLATE_LAYOUT } from '@contrataflow/validation';
import type { LayoutDefinition, TemplateVersionDto } from '@contrataflow/validation';
import { configure, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { TemplateEditorView } from './template-editor';
import { layoutPatch, layoutProblems, toLayoutForm } from './template-layout-model';

/*
 * US-109 · SCR-114, aba "Layout": formulário (faixas e variáveis — V-01..V-04), autosave por TPL-08
 * com `If-Match`, somente leitura sem `TEMPLATE_MANAGE` e a prévia (TPL-09 → *polling* de TPL-12 →
 * download de TPL-13) com "Gerando…", "Pronta" e "Falhou" + "Tentar novamente". axe no formulário
 * e no visualizador.
 */

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/templates',
}));

const NOW = '2026-10-17T12:00:00.000Z';
const TEMPLATE_ID = '0192a109-0000-7000-8000-0000000e0001';
const VERSION_ID = '0192a109-0000-7000-8000-0000000f0001';
const RENDITION_ID = '0192a109-0000-7000-8000-0000000f0002';
const OFICIO = {
  id: '0192a109-0000-7000-8000-0000000d0001',
  code: 'OFICIO',
  name: 'Ofício',
  kind: 'FREE_TEXT',
  systemModule: null,
  defaultConfidentiality: 'INTERNAL',
} as const;

function version(overrides: Partial<TemplateVersionDto> = {}): TemplateVersionDto {
  return {
    id: VERSION_ID,
    templateId: TEMPLATE_ID,
    templateName: 'Ofício padrão',
    versionNumber: 3,
    status: 'DRAFT',
    documentType: OFICIO,
    sections: [],
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
    version: 5,
    ...overrides,
  };
}

function preview(status: string, extra: Record<string, unknown> = {}) {
  return {
    renditionId: RENDITION_ID,
    templateVersionId: VERSION_ID,
    status,
    pageCount: status === 'READY' ? 2 : null,
    sizeBytes: status === 'READY' ? 1024 : null,
    sha256: null,
    errorCode: null,
    errorMessage: null,
    requestedAt: NOW,
    readyAt: status === 'READY' ? NOW : null,
    expiresAt: '2026-10-18T12:00:00.000Z',
    ...extra,
  };
}

type Handler = (url: string, init?: RequestInit) => Response;

function mockApi(
  routes: { patch?: Handler; previewStatus?: () => Record<string, unknown> } = {},
  permissions: readonly string[] = ['TEMPLATE_VIEW', 'TEMPLATE_MANAGE'],
  current: TemplateVersionDto = version(),
) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({ data: { permissions: permissions.map((code) => ({ code, scopes: [] })) } }),
      );
    }
    if (method === 'POST' && url.endsWith('/preview')) {
      return Promise.resolve(
        jsonResponse({ data: { renditionId: RENDITION_ID } }, { status: 202 }),
      );
    }
    if (method === 'GET' && url.endsWith('/download')) {
      return Promise.resolve(
        jsonResponse({ data: { url: 'https://s3.test/previa.pdf', expiresAt: NOW } }),
      );
    }
    if (method === 'GET' && url.includes('/preview/')) {
      return Promise.resolve(
        jsonResponse({ data: (routes.previewStatus ?? (() => preview('READY')))() }),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/template-versions/')) {
      return Promise.resolve(jsonResponse({ data: current }));
    }
    if (method === 'PATCH') {
      return Promise.resolve(
        (routes.patch ?? (() => jsonResponse({ data: version({ version: 6 }) })))(url, init),
      );
    }
    return Promise.resolve(jsonResponse({}, { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const bodyOf = (init?: RequestInit): Record<string, unknown> =>
  JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
const callsTo = (api: ReturnType<typeof mockApi>, method: string, part = '') =>
  api.mock.calls.filter(
    ([input, init]) => (init?.method ?? 'GET') === method && requestUrl(input).includes(part),
  );

async function openLayout() {
  renderWithShell(<TemplateEditorView versionId={VERSION_ID} />);
  await userEvent.click(await screen.findByRole('tab', { name: 'Layout' }));
  return screen.findByLabelText('Margem superior (mm)');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('modelo do layout (US-109)', () => {
  it('valida faixas, variáveis e a altura do logo (V-01..V-04)', () => {
    const form = toLayoutForm(DEFAULT_TEMPLATE_LAYOUT);
    expect(layoutProblems(form)).toEqual([]);
    expect(
      layoutProblems({
        ...form,
        margins: { ...form.margins, top: '5' },
        fontSizePt: '20',
        lineHeight: '2,5',
        footer: 'Assina {{document.assinante}} · {{page}}',
        logoAttachmentId: VERSION_ID,
        logoMaxHeightMm: '25',
      }),
    ).toEqual([
      { field: 'margins.top', message: 'A margem deve estar entre 10 e 40 mm.' },
      { field: 'fontSizePt', message: 'O tamanho da fonte deve estar entre 9 e 14.' },
      { field: 'lineHeight', message: 'A entrelinha deve estar entre 1,0 e 2,0.' },
      { field: 'footer', message: 'A variável {{document.assinante}} não é reconhecida.' },
      {
        field: 'logoMaxHeightMm',
        message: 'A altura do logo deve ser maior que zero e caber na margem superior.',
      },
    ]);
  });

  it('o PATCH leva só o que mudou e remove o logo com null (FA-02)', () => {
    const saved: LayoutDefinition = {
      ...DEFAULT_TEMPLATE_LAYOUT,
      logo: { attachmentId: VERSION_ID, position: 'left', maxHeightMm: 15 },
    };
    const form = toLayoutForm(saved);
    expect(layoutPatch(saved, form)).toEqual({});
    expect(
      layoutPatch(saved, {
        ...form,
        margins: { ...form.margins, left: '25' },
        lineHeight: '1,5',
        header: '{{organization.name}}',
        draftWatermark: false,
        logoAttachmentId: null,
      }),
    ).toEqual({
      marginsMm: { left: 25 },
      lineHeight: 1.5,
      header: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '{{organization.name}}' }] },
        ],
      },
      logo: null,
      draftWatermark: false,
    });
  });
});

describe('SCR-114 · aba Layout (US-109)', () => {
  it('[Sucesso] salva fonte e margem com If-Match e insere variável no cabeçalho (axe)', async () => {
    const api = mockApi();
    const top = await openLayout();
    expect(await seriousA11yViolations()).toEqual([]);

    await userEvent.selectOptions(screen.getByLabelText('Fonte'), 'Times New Roman');
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(1);
    });
    const first = callsTo(api, 'PATCH')[0];
    expect(new Headers(first?.[1]?.headers).get('If-Match')).toBe('"5"');
    expect(bodyOf(first?.[1])).toEqual({ layout: { fontFamily: 'Times New Roman' } });

    await userEvent.clear(top);
    await userEvent.type(top, '25');
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Inserir a variável organization.name no campo Cabeçalho',
      }),
    );
    fireEvent.focusOut(screen.getByLabelText('Cabeçalho'), { relatedTarget: document.body });
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(2);
    });
    const second = callsTo(api, 'PATCH')[1];
    expect(new Headers(second?.[1]?.headers).get('If-Match')).toBe('"6"');
    expect(bodyOf(second?.[1])).toMatchObject({
      layout: {
        marginsMm: { top: 25 },
        header: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '{{organization.name}}' }] },
          ],
        },
      },
    });
  });

  it('[Validação] tamanho de fonte fora da faixa: mensagem no campo e nada enviado', async () => {
    const api = mockApi();
    await openLayout();
    const size = screen.getByLabelText('Tamanho da fonte (pt)');
    await userEvent.clear(size);
    await userEvent.type(size, '20');
    fireEvent.focusOut(size, { relatedTarget: document.body });
    expect(await screen.findByText('O tamanho da fonte deve estar entre 9 e 14.')).toBeTruthy();
    expect(size.getAttribute('aria-invalid')).toBe('true');
    expect(callsTo(api, 'PATCH')).toHaveLength(0);
  });

  it('[Concorrência] 412 no salvamento oferece recarregar', async () => {
    mockApi({
      patch: () =>
        new Response(
          JSON.stringify({
            type: 'x',
            title: 'VERSION_CONFLICT',
            status: 412,
            detail: 'x',
            instance: '/x',
            code: 'VERSION_CONFLICT',
            correlationId: 'c',
            errors: [],
            violations: [],
          }),
          { status: 412, headers: { 'Content-Type': 'application/problem+json' } },
        ),
    });
    await openLayout();
    await userEvent.selectOptions(screen.getByLabelText('Orientação'), 'landscape');
    expect(
      await screen.findByText('O layout foi alterado por outra pessoa. Recarregue.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recarregar' })).toBeTruthy();
  });

  it('[Sucesso] gera a prévia: "Gerando…" até pronta, com download (axe no visualizador)', async () => {
    let calls = 0;
    const api = mockApi({
      previewStatus: () => {
        calls += 1;
        return calls === 1 ? preview('PENDING') : preview('READY');
      },
    });
    await openLayout();
    await userEvent.click(screen.getByRole('button', { name: 'Gerar prévia' }));
    expect(await screen.findByText('Prévia pronta.', {}, { timeout: 8000 })).toBeTruthy();
    expect(callsTo(api, 'POST', '/preview')).toHaveLength(1);
    expect(await seriousA11yViolations()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Baixar prévia' })).toBeTruthy();
  });

  it('[Falha de integração] prévia que falhou mostra a mensagem e "Tentar novamente"', async () => {
    const api = mockApi({
      previewStatus: () =>
        preview('FAILED', {
          errorCode: 'DEPENDENCY_UNAVAILABLE',
          errorMessage: 'Não foi possível gerar a prévia agora. Tente novamente.',
        }),
    });
    await openLayout();
    await userEvent.click(screen.getByRole('button', { name: 'Gerar prévia' }));
    expect(
      await screen.findByText('Não foi possível gerar a prévia agora. Tente novamente.'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST', '/preview')).toHaveLength(2);
    });
  });

  it('[Permissão] só TEMPLATE_VIEW: formulário somente leitura e a prévia disponível', async () => {
    const api = mockApi({}, ['TEMPLATE_VIEW'], version({ status: 'PUBLISHED' }));
    await openLayout();
    // `fieldset disabled`: os campos herdam o estado (`:disabled`).
    expect(screen.getByLabelText('Fonte').matches(':disabled')).toBe(true);
    expect(screen.getByLabelText('Margem superior (mm)').matches(':disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: /Inserir a variável/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Gerar prévia' }));
    expect(await screen.findByText('Prévia pronta.')).toBeTruthy();
    expect(callsTo(api, 'PATCH')).toHaveLength(0);
  });
});
