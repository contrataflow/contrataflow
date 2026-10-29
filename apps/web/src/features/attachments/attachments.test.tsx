// @vitest-environment jsdom
import type { AttachmentDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { AttachmentsSection } from './attachments-section';
import { checkLocalFile, extensionOf, formatFileSize } from './upload-rules';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-068 — `AttachmentUploader`/`AttachmentList`/`DeleteAttachmentDialog` (SCR-105/SCR-006): a API
 * (BFF) e o PUT direto no storage simulados; a sondagem de ATT-04 sem espera real.
 */

const DOCUMENT = '0192a000-0000-7000-8000-0000000000d1';
const ATTACHMENT = '0192a000-0000-7000-8000-0000000000e1';
const UPLOAD_URL = 'https://s3.test/quarantine/tenants/a/uploads/e1?X-Amz-Signature=x';

function attachment(overrides: Partial<AttachmentDto> = {}): AttachmentDto {
  return {
    id: ATTACHMENT,
    processId: '0192a000-0000-7000-8000-0000000000c1',
    targetType: 'DOCUMENT',
    targetId: DOCUMENT,
    fileName: 'comprovante.pdf',
    extension: 'pdf',
    declaredMimeType: 'application/pdf',
    sizeBytes: 2048,
    categoryId: null,
    description: null,
    status: 'PENDING_UPLOAD',
    reasonCode: null,
    sha256: null,
    createdAt: '2026-10-17T12:00:00.000Z',
    uploadedAt: null,
    scannedAt: null,
    uploadedById: '0192a000-0000-7000-8000-0000000000a1',
    version: 1,
    ...overrides,
  };
}

/** XHR simulado: registra o PUT e completa com progresso 50% → 100%. */
class FakeXhr {
  static sent: { method: string; url: string; headers: Record<string, string>; body: unknown }[] =
    [];
  static failNext = false;
  status = 0;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private method = '';
  private url = '';
  private headers: Record<string, string> = {};

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body: unknown) {
    FakeXhr.sent.push({ method: this.method, url: this.url, headers: this.headers, body });
    queueMicrotask(() => {
      if (FakeXhr.failNext) {
        FakeXhr.failNext = false;
        this.onerror?.();
        return;
      }
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 } as ProgressEvent);
      this.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 2 } as ProgressEvent);
      this.status = 200;
      this.onload?.();
    });
  }
}

const deps = {
  sleep: () => Promise.resolve(),
  createRequest: () => new FakeXhr() as unknown as XMLHttpRequest,
};

function mockApi(
  options: {
    permissions?: readonly string[];
    finalStatus?: AttachmentDto['status'];
    reasonCode?: AttachmentDto['reasonCode'];
  } = {},
) {
  let deleted = false;
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      const codes = options.permissions ?? ['ATTACHMENT_UPLOAD', 'PROCESS_VIEW'];
      return Promise.resolve(
        jsonResponse({ data: { permissions: codes.map((code) => ({ code, scopes: [] })) } }),
      );
    }
    if (method === 'POST' && url === '/api/v1/attachments') {
      return Promise.resolve(
        jsonResponse(
          {
            data: attachment(),
            upload: {
              url: UPLOAD_URL,
              method: 'PUT',
              headers: { 'Content-Type': 'application/pdf' },
              expiresAt: '2026-10-17T12:05:00.000Z',
            },
          },
          { status: 201 },
        ),
      );
    }
    if (method === 'POST' && url.endsWith('/confirm')) {
      return Promise.resolve(jsonResponse({ data: { status: 'UPLOADED' } }, { status: 202 }));
    }
    if (method === 'GET' && url === `/api/v1/attachments/${ATTACHMENT}`) {
      return Promise.resolve(
        jsonResponse({
          data: attachment({
            status: options.finalStatus ?? 'AVAILABLE',
            reasonCode: options.reasonCode ?? null,
            version: 4,
          }),
        }),
      );
    }
    if (method === 'DELETE') {
      deleted = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(jsonResponse({ data: null }, { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, wasDeleted: () => deleted };
}

const bodyOf = (init?: RequestInit): unknown =>
  JSON.parse(typeof init?.body === 'string' ? init.body : '{}');

const pdf = () => new File([new Uint8Array(2048)], 'comprovante.pdf', { type: 'application/pdf' });

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXhr.sent = [];
  FakeXhr.failNext = false;
});

describe('regras locais do seletor (FA-01)', () => {
  it('allowlist, vazio, limite e MIME declarado', () => {
    expect(extensionOf('a.PDF')).toBe('pdf');
    expect(extensionOf('sem')).toBe('');
    expect(checkLocalFile({ name: 'script.exe', size: 10, type: '' })).toEqual({
      ok: false,
      reason: 'TYPE',
    });
    expect(checkLocalFile({ name: 'a.pdf', size: 0, type: 'application/pdf' })).toEqual({
      ok: false,
      reason: 'EMPTY',
    });
    expect(checkLocalFile({ name: 'a.pdf', size: 51 * 1024 * 1024, type: '' })).toEqual({
      ok: false,
      reason: 'SIZE',
    });
    expect(checkLocalFile({ name: 'a.docx', size: 1, type: '' })).toEqual({
      ok: true,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3 MB');
  });
});

describe('AttachmentsSection (US-068)', () => {
  it('[Sucesso] envia um PDF: intenção, PUT direto com os headers assinados, confirmação e AVAILABLE; sem violações de a11y', async () => {
    const { fetchMock } = mockApi();
    const user = userEvent.setup();
    const { container } = renderWithShell(
      <AttachmentsSection
        targetType="DOCUMENT"
        targetId={DOCUMENT}
        action="UPDATE"
        allowedActions={['UPDATE']}
        deps={deps}
      />,
    );
    const button = await screen.findByRole('button', { name: 'Anexar arquivo' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('input de arquivo ausente');
    expect(input.accept).toContain('.pdf');
    expect(button).toBeTruthy();

    await user.upload(input, pdf());

    await screen.findByText('Disponível');
    const intent = fetchMock.mock.calls.find(
      ([url, init]) => requestUrl(url) === '/api/v1/attachments' && init?.method === 'POST',
    );
    expect(bodyOf(intent?.[1])).toEqual({
      targetType: 'DOCUMENT',
      targetId: DOCUMENT,
      fileName: 'comprovante.pdf',
      declaredMimeType: 'application/pdf',
      sizeBytes: 2048,
    });
    expect(new Headers(intent?.[1]?.headers).get('Idempotency-Key')).toBeTruthy();
    expect(FakeXhr.sent).toEqual([
      expect.objectContaining({
        method: 'PUT',
        url: UPLOAD_URL,
        headers: { 'Content-Type': 'application/pdf' },
      }),
    ]);
    expect(
      fetchMock.mock.calls.some(([url]) => requestUrl(url).endsWith(`${ATTACHMENT}/confirm`)),
    ).toBe(true);
    expect(await seriousA11yViolations(container)).toEqual([]);
  });

  it('[Validação] extensão não permitida é bloqueada no seletor, sem chamar a API', async () => {
    const { fetchMock } = mockApi();
    const { container } = renderWithShell(
      <AttachmentsSection targetType="PROCESS" targetId={DOCUMENT} deps={deps} />,
    );
    await screen.findByRole('button', { name: 'Anexar arquivo' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('input de arquivo ausente');
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input, new File(['MZ'], 'script.exe'));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Este tipo de arquivo não é permitido',
    );
    expect(fetchMock.mock.calls.some(([url]) => requestUrl(url) === '/api/v1/attachments')).toBe(
      false,
    );
  });

  it('[Falha de integração] rejeitado pela verificação mostra só o motivo resumido', async () => {
    mockApi({ finalStatus: 'INFECTED', reasonCode: 'INFECTED' });
    const user = userEvent.setup();
    const { container } = renderWithShell(
      <AttachmentsSection targetType="PROCESS" targetId={DOCUMENT} deps={deps} />,
    );
    await screen.findByRole('button', { name: 'Anexar arquivo' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('input de arquivo ausente');
    await user.upload(input, pdf());
    expect(
      await screen.findByText('Arquivo rejeitado pela verificação de segurança.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Ações de/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remover da lista' })).toBeTruthy();
  });

  it('[Falha de rede] PUT falha → "Enviar novamente" gera nova intenção', async () => {
    const { fetchMock } = mockApi();
    FakeXhr.failNext = true;
    const user = userEvent.setup();
    const { container } = renderWithShell(
      <AttachmentsSection targetType="PROCESS" targetId={DOCUMENT} deps={deps} />,
    );
    await screen.findByRole('button', { name: 'Anexar arquivo' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('input de arquivo ausente');
    await user.upload(input, pdf());
    await user.click(await screen.findByRole('button', { name: 'Enviar novamente' }));
    await screen.findByText('Disponível');
    const intents = fetchMock.mock.calls.filter(
      ([url, init]) => requestUrl(url) === '/api/v1/attachments' && init?.method === 'POST',
    );
    expect(intents).toHaveLength(2);
  });

  it('[Sucesso] exclusão exige motivo e envia If-Match com a versão lida', async () => {
    const { fetchMock, wasDeleted } = mockApi();
    const user = userEvent.setup();
    const { container } = renderWithShell(
      <AttachmentsSection targetType="PROCESS" targetId={DOCUMENT} deps={deps} />,
    );
    await screen.findByRole('button', { name: 'Anexar arquivo' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('input de arquivo ausente');
    await user.upload(input, pdf());
    await user.click(await screen.findByRole('button', { name: 'Ações de comprovante.pdf' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Excluir' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Excluir anexo' }));
    expect(within(dialog).getByText('Informe o motivo da exclusão.')).toBeTruthy();
    expect(wasDeleted()).toBe(false);
    await user.type(within(dialog).getByLabelText(/Motivo da exclusão/), 'Enviado por engano');
    await user.click(within(dialog).getByRole('button', { name: 'Excluir anexo' }));
    await screen.findByText('Excluído');
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(new Headers(call?.[1]?.headers).get('If-Match')).toBe('"4"');
    expect(bodyOf(call?.[1])).toEqual({ deletionReason: 'Enviado por engano' });
  });

  it('[Permissão] sem ATTACHMENT_UPLOAD o botão some; alvo não editável desabilita com motivo', async () => {
    mockApi({ permissions: ['PROCESS_VIEW'] });
    renderWithShell(<AttachmentsSection targetType="PROCESS" targetId={DOCUMENT} deps={deps} />);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Anexar arquivo' })).toBeNull();
    });
  });

  it('[Permissão] documento sem UPDATE em allowedActions: botão desabilitado', async () => {
    mockApi();
    renderWithShell(
      <AttachmentsSection
        targetType="DOCUMENT"
        targetId={DOCUMENT}
        action="UPDATE"
        allowedActions={[]}
        deps={deps}
      />,
    );
    const button = await screen.findByRole('button', { name: 'Anexar arquivo' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Não é possível anexar arquivos neste momento.')).toBeTruthy();
  });
});
