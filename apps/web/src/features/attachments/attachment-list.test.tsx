// @vitest-environment jsdom
import type { AttachmentDto } from '@contrataflow/validation';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, problem, renderWithShell, requestUrl } from '@test/support/render';

import { AttachmentList } from './attachment-list';
import { AttachmentsSection } from './attachments-section';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-069 — `AttachmentList`/`AttachmentViewer` (SCR-006/SCR-105): ATT-01 (lista), ATT-05 (download
 * por URL assinada, pedida a cada clique) e a prévia inline de imagem; a API (BFF) simulada.
 */

const PROCESS = '0192a000-0000-7000-8000-0000000000c1';
const DOCUMENT = '0192a000-0000-7000-8000-0000000000d1';
const SIGNED_URL = 'https://s3.test/documents/tenants/a/parecer.pdf?X-Amz-Signature=x';

function attachment(overrides: Partial<AttachmentDto> = {}): AttachmentDto {
  return {
    id: '0192a000-0000-7000-8000-0000000000e1',
    processId: PROCESS,
    targetType: 'DOCUMENT',
    targetId: DOCUMENT,
    fileName: 'parecer.pdf',
    extension: 'pdf',
    declaredMimeType: 'application/pdf',
    sizeBytes: 2048,
    categoryId: null,
    description: null,
    status: 'AVAILABLE',
    reasonCode: null,
    sha256: 'a'.repeat(64),
    createdAt: '2026-10-17T12:00:00.000Z',
    uploadedAt: '2026-10-17T12:00:05.000Z',
    scannedAt: '2026-10-17T12:00:09.000Z',
    uploadedById: '0192a000-0000-7000-8000-0000000000a1',
    version: 4,
    ...overrides,
  };
}

const PDF = attachment();
const IMAGE = attachment({
  id: '0192a000-0000-7000-8000-0000000000e2',
  fileName: 'foto.png',
  extension: 'png',
  declaredMimeType: 'image/png',
});
const SHEET = attachment({
  id: '0192a000-0000-7000-8000-0000000000e3',
  fileName: 'planilha.xlsx',
  extension: 'xlsx',
  declaredMimeType: 'application/vnd.ms-excel',
});
const SCANNING = attachment({
  id: '0192a000-0000-7000-8000-0000000000e4',
  fileName: 'em-verificacao.pdf',
  status: 'SCANNING',
  sha256: null,
});

function mockApi(
  items: readonly AttachmentDto[],
  download: (id: string) => Response = () =>
    jsonResponse({ data: { url: SIGNED_URL, expiresAt: '2026-10-17T12:05:00.000Z' } }),
) {
  const downloads: string[] = [];
  const fetchMock = vi.fn<typeof fetch>((input) => {
    const url = requestUrl(input);
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({ data: { permissions: [{ code: 'PROCESS_VIEW', scopes: [] }] } }),
      );
    }
    if (url.startsWith(`/api/v1/processes/${PROCESS}/attachments`)) {
      return Promise.resolve(
        jsonResponse({
          data: items,
          meta: { page: 1, pageSize: 100, totalItems: items.length, totalPages: 1 },
        }),
      );
    }
    const match = /^\/api\/v1\/attachments\/([^/]+)\/download$/.exec(url);
    if (match?.[1]) {
      downloads.push(match[1]);
      return Promise.resolve(download(match[1]));
    }
    return Promise.resolve(jsonResponse({ data: null }, { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, downloads };
}

/** Abre o menu ⋯ da linha do arquivo (Radix: o gatilho abre por clique). */
async function openMenu(user: ReturnType<typeof userEvent.setup>, fileName: string) {
  await user.click(await screen.findByRole('button', { name: `Ações de ${fileName}` }));
}

const renderList = (
  props: Partial<React.ComponentProps<typeof AttachmentList>> = {},
  navigate = vi.fn<(url: string) => void>(),
) => ({
  navigate,
  ...renderWithShell(
    <AttachmentList
      processId={PROCESS}
      targetType="DOCUMENT"
      targetId={DOCUMENT}
      navigate={navigate}
      {...props}
    />,
  ),
});

beforeEach(() => {
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AttachmentList (US-069)', () => {
  it('[Sucesso] lista o alvo pelo ATT-01 e baixa pelo ATT-05, com nova URL a cada clique (FA-02); sem violações de a11y', async () => {
    const { fetchMock, downloads } = mockApi([PDF]);
    const user = userEvent.setup();
    const { navigate, container } = renderList();

    const row = await screen.findByRole('listitem', { name: 'parecer.pdf (2 KB)' });
    expect(row).toBeTruthy();
    const listCall = fetchMock.mock.calls.find(([url]) =>
      requestUrl(url).startsWith(`/api/v1/processes/${PROCESS}/attachments`),
    );
    expect(requestUrl(listCall?.[0] ?? '')).toContain(`targetType=DOCUMENT&targetId=${DOCUMENT}`);

    await openMenu(user, 'parecer.pdf');
    await user.click(screen.getByRole('menuitem', { name: 'Baixar parecer.pdf' }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(SIGNED_URL);
    });
    await openMenu(user, 'parecer.pdf');
    await user.click(screen.getByRole('menuitem', { name: 'Baixar parecer.pdf' }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledTimes(2);
    });
    expect(downloads).toEqual([PDF.id, PDF.id]);
    expect(await seriousA11yViolations(container)).toEqual([]);
  });

  it('[Validação] anexo em verificação: sem download ativo e a mensagem de espera (FA-01)', async () => {
    const { downloads } = mockApi([SCANNING]);
    const user = userEvent.setup();
    renderList();
    expect(
      await screen.findByText('Arquivo em verificação. Tente novamente em instantes.'),
    ).toBeTruthy();
    expect(
      screen.getByRole('progressbar', { name: 'Verificando segurança do arquivo…' }),
    ).toBeTruthy();
    await openMenu(user, 'em-verificacao.pdf');
    const item = screen.getByRole('menuitem', { name: 'Baixar em-verificacao.pdf' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('menuitem', { name: /Visualizar/ })).toBeNull();
    expect(downloads).toEqual([]);
  });

  it('[Validação] formato sem prévia só oferece o download; PDF avisa que a prévia ainda não existe (FA-01)', async () => {
    mockApi([SHEET, PDF]);
    const user = userEvent.setup();
    renderList();
    await screen.findByRole('listitem', { name: 'planilha.xlsx (2 KB)' });
    expect(screen.getByText('Sem prévia disponível — baixar arquivo.')).toBeTruthy();
    await openMenu(user, 'planilha.xlsx');
    expect(screen.queryByRole('menuitem', { name: 'Visualizar planilha.xlsx' })).toBeNull();
    await user.keyboard('{Escape}');

    await openMenu(user, 'parecer.pdf');
    await user.click(screen.getByRole('menuitem', { name: 'Visualizar parecer.pdf' }));
    expect(await screen.findByText(/A prévia de PDF na tela chega/)).toBeTruthy();
  });

  it('[Sucesso] prévia inline de imagem: bytes por fetch da URL assinada, sem navegar', async () => {
    const { downloads } = mockApi([IMAGE]);
    const fetchBytes = vi.fn(() => Promise.resolve(new Blob(['png'], { type: 'image/png' })));
    const user = userEvent.setup();
    const { navigate } = renderList({ fetchBytes });
    await openMenu(user, 'foto.png');
    await user.click(await screen.findByRole('menuitem', { name: 'Visualizar foto.png' }));
    const image = await screen.findByRole('img', { name: 'Prévia de foto.png' });
    expect(image.getAttribute('src')).toBe('blob:preview');
    expect(fetchBytes).toHaveBeenCalledWith(SIGNED_URL);
    expect(downloads).toEqual([IMAGE.id]);
    expect(navigate).not.toHaveBeenCalled();
    await openMenu(user, 'foto.png');
    await user.click(screen.getByRole('menuitem', { name: 'Fechar a prévia de foto.png' }));
    expect(screen.queryByRole('img', { name: 'Prévia de foto.png' })).toBeNull();
  });

  it('[Concorrência] anexo que saiu de AVAILABLE depois da listagem: 409 com a mensagem e lista renovada', async () => {
    const { fetchMock } = mockApi([PDF], () => problem(409, 'ATTACHMENT_NOT_AVAILABLE'));
    const user = userEvent.setup();
    const { navigate } = renderList();
    await openMenu(user, 'parecer.pdf');
    await user.click(await screen.findByRole('menuitem', { name: 'Baixar parecer.pdf' }));
    expect(
      await screen.findByText('Arquivo em verificação. Tente novamente em instantes.'),
    ).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    await waitFor(() => {
      const listings = fetchMock.mock.calls.filter(([url]) =>
        requestUrl(url).startsWith(`/api/v1/processes/${PROCESS}/attachments`),
      );
      expect(listings.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('[Permissão] POL-09: 403 mostra a negação, sem código de suporte nem navegação', async () => {
    mockApi([PDF], () => problem(403, 'PERMISSION_DENIED'));
    const user = userEvent.setup();
    const { navigate } = renderList();
    await openMenu(user, 'parecer.pdf');
    await user.click(await screen.findByRole('menuitem', { name: 'Baixar parecer.pdf' }));
    expect(
      await screen.findByText('Você não tem permissão para baixar este arquivo.'),
    ).toBeTruthy();
    expect(screen.queryByText(/Código de suporte/)).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('[Falha de integração] 503: mensagem, correlationId e nova tentativa pelo mesmo botão', async () => {
    let healthy = false;
    const { downloads } = mockApi([PDF], () =>
      healthy
        ? jsonResponse({ data: { url: SIGNED_URL, expiresAt: '2026-10-17T12:05:00.000Z' } })
        : problem(503, 'DEPENDENCY_UNAVAILABLE', 'corr-503'),
    );
    const user = userEvent.setup();
    const { navigate } = renderList();
    await openMenu(user, 'parecer.pdf');
    await user.click(await screen.findByRole('menuitem', { name: 'Baixar parecer.pdf' }));
    expect(
      await screen.findByText(
        'Não foi possível baixar o arquivo agora. Tente novamente em instantes.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Código de suporte: corr-503')).toBeTruthy();
    healthy = true;
    await openMenu(user, 'parecer.pdf');
    await user.click(screen.getByRole('menuitem', { name: 'Baixar parecer.pdf' }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(SIGNED_URL);
    });
    expect(downloads).toHaveLength(2);
  });

  it('[Vazio] sem anexos: "Nenhum anexo"; com envio da sessão não repete o estado vazio', async () => {
    mockApi([]);
    const first = renderList();
    expect(await screen.findByText('Nenhum anexo')).toBeTruthy();
    first.unmount();
    renderList({ sessionCount: 1 });
    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull();
    });
    expect(screen.queryByText('Nenhum anexo')).toBeNull();
  });

  it('[Falha] erro ao listar: alerta com "Recarregar anexos"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => Promise.resolve(problem(503, 'DEPENDENCY_UNAVAILABLE'))),
    );
    renderList();
    expect(await screen.findByText('Não foi possível carregar os anexos agora.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recarregar anexos' })).toBeTruthy();
  });

  it('a seção do alvo mostra os anexos já enviados quando recebe o processo', async () => {
    mockApi([PDF]);
    renderWithShell(
      <AttachmentsSection targetType="DOCUMENT" targetId={DOCUMENT} processId={PROCESS} />,
    );
    expect(await screen.findByRole('listitem', { name: 'parecer.pdf (2 KB)' })).toBeTruthy();
    expect(screen.queryByText(/chega em breve/)).toBeNull();
  });
});
