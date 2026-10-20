// @vitest-environment jsdom
import type { AttachmentDto, DocumentDto, DocumentVersionDto } from '@contrataflow/validation';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, problem, renderWithShell, requestUrl } from '@test/support/render';

import { UploadedDocumentFile } from './uploaded-document-file';
import { CreateDocumentDialog } from '../process-documents/create-document-dialog';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => '/processos',
}));

/*
 * US-064 — documento externo na SCR-105 (`UploadedDocumentFile`) e o `CreateDocumentDialog` do
 * painel: a API (BFF) e o PUT direto no storage simulados; a sondagem de ATT-04 sem espera real.
 * Envio → varredura → DOC-19 com `If-Match`/`Idempotency-Key`, rejeição (FA-01), sem prévia
 * (FA-02), reenvio com a mesma chave (FA-05), permissão, axe sem violações sérias.
 */

const ID = (n: number) => `0192a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PROCESS_ID = ID(600);
const DOC = ID(601);
const VERSION = ID(602);
const ATTACHMENT = ID(603);
const UPLOAD_URL = 'https://s3.test/quarantine/tenants/a/uploads/x?X-Amz-Signature=x';
const DOWNLOAD_URL = 'https://s3.test/documents/tenants/a/documents/x?X-Amz-Signature=y';

function documentDto(extra: Partial<DocumentDto> = {}): DocumentDto {
  return {
    id: DOC,
    processId: PROCESS_ID,
    documentType: {
      id: ID(610),
      code: 'DOCUMENTO_EXTERNO',
      name: 'Documento externo',
      kind: 'UPLOADED',
      systemModule: null,
      requiresApproval: false,
    },
    templateVersionId: null,
    number: null,
    year: null,
    code: null,
    title: 'Parecer jurídico sobre a minuta',
    status: 'DRAFT',
    confidentiality: 'INTERNAL',
    draftContent: { sections: {} },
    draftRevision: 1,
    currentVersionId: null,
    currentVersionNumber: null,
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
    createdAt: '2026-10-17T12:00:00.000Z',
    updatedAt: '2026-10-17T12:00:00.000Z',
    createdById: ID(1),
    version: 1,
    ...extra,
  };
}

function attachment(overrides: Partial<AttachmentDto> = {}): AttachmentDto {
  return {
    id: ATTACHMENT,
    processId: PROCESS_ID,
    targetType: 'DOCUMENT',
    targetId: DOC,
    fileName: 'parecer.pdf',
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
    uploadedById: ID(1),
    version: 1,
    ...overrides,
  };
}

function versionDto(overrides: Partial<DocumentVersionDto> = {}): DocumentVersionDto {
  return {
    id: VERSION,
    documentId: DOC,
    processId: PROCESS_ID,
    versionNumber: 1,
    reason: 'UPLOAD',
    statusAtCreation: 'DRAFT',
    contentHash: 'ab'.repeat(32),
    attachmentId: ATTACHMENT,
    templateVersionId: null,
    changeSummary: null,
    createdById: ID(1),
    createdByName: 'Lúcia Matos',
    createdAt: '2026-10-17T12:30:00.000Z',
    kind: 'UPLOADED',
    content: null,
    ...overrides,
  };
}

/** XHR simulado: registra o PUT e completa com progresso 50% → 100%. */
class FakeXhr {
  static sent: { method: string; url: string }[] = [];
  status = 0;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private method = '';
  private url = '';

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader() {
    // Os cabeçalhos assinados não importam aqui (US-068 cobre).
  }

  send() {
    FakeXhr.sent.push({ method: this.method, url: this.url });
    queueMicrotask(() => {
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
  fetchBytes: () => Promise.resolve(new Blob(['png'], { type: 'image/png' })),
};

const bodyOf = (init?: RequestInit): unknown =>
  JSON.parse(typeof init?.body === 'string' ? init.body : '{}');

const pdf = () => new File([new Uint8Array(2048)], 'parecer.pdf', { type: 'application/pdf' });

function mockApi(
  options: {
    permissions?: readonly string[];
    confirmStatus?: AttachmentDto['status'];
    finalStatus?: AttachmentDto['status'];
    current?: Partial<AttachmentDto>;
    uploadVersion?: () => Response;
  } = {},
) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      const codes = options.permissions ?? ['ATTACHMENT_UPLOAD', 'PROCESS_VIEW', 'DOCUMENT_UPDATE'];
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
      return Promise.resolve(
        jsonResponse({ data: { status: options.confirmStatus ?? 'UPLOADED' } }, { status: 202 }),
      );
    }
    if (method === 'GET' && url === `/api/v1/attachments/${ATTACHMENT}`) {
      return Promise.resolve(
        jsonResponse({
          data: attachment({
            status: options.finalStatus ?? 'AVAILABLE',
            sha256: 'ab'.repeat(32),
            ...options.current,
          }),
        }),
      );
    }
    if (method === 'GET' && url === `/api/v1/attachments/${ATTACHMENT}/download`) {
      return Promise.resolve(
        jsonResponse({ data: { url: DOWNLOAD_URL, expiresAt: '2026-10-17T12:35:00.000Z' } }),
      );
    }
    if (method === 'GET' && url === `/api/v1/document-versions/${VERSION}`) {
      return Promise.resolve(jsonResponse({ data: versionDto() }));
    }
    if (method === 'POST' && url === `/api/v1/documents/${DOC}/upload-version`) {
      return Promise.resolve(
        options.uploadVersion?.() ?? jsonResponse({ data: versionDto() }, { status: 201 }),
      );
    }
    if (method === 'POST' && url === `/api/v1/processes/${PROCESS_ID}/documents`) {
      return Promise.resolve(
        jsonResponse(
          { data: documentDto(), meta: { allowedActions: ['UPDATE'] } },
          { status: 201 },
        ),
      );
    }
    return Promise.resolve(jsonResponse({ data: null }, { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const callsTo = (fetchMock: ReturnType<typeof mockApi>, path: string, method = 'POST') =>
  fetchMock.mock.calls.filter(
    ([url, init]) => requestUrl(url) === path && (init?.method ?? 'GET') === method,
  );

describe('US-064 — documento externo na SCR-105', () => {
  beforeEach(() => {
    FakeXhr.sent = [];
    push.mockReset();
    // jsdom não implementa URLs `blob:`.
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('[Sucesso] rascunho sem arquivo: enviar PDF → varredura → DOC-19 com If-Match e Idempotency-Key', async () => {
    const fetchMock = mockApi();
    const { container } = renderWithShell(
      <UploadedDocumentFile
        document={documentDto()}
        meta={{ allowedActions: ['UPDATE', 'DELETE'] }}
        deps={deps}
      />,
    );
    expect(screen.getByText(/Rascunho sem arquivo/)).toBeTruthy();
    await screen.findByRole('button', { name: 'Enviar arquivo' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('input de arquivo ausente');
    await userEvent.setup().upload(input, pdf());

    await screen.findByText('Versão 1 enviada.');
    expect(bodyOf(callsTo(fetchMock, '/api/v1/attachments')[0]?.[1])).toMatchObject({
      targetType: 'DOCUMENT',
      targetId: DOC,
      fileName: 'parecer.pdf',
    });
    expect(FakeXhr.sent).toEqual([{ method: 'PUT', url: UPLOAD_URL }]);
    const [register] = callsTo(fetchMock, `/api/v1/documents/${DOC}/upload-version`);
    expect(bodyOf(register?.[1])).toEqual({ attachmentId: ATTACHMENT });
    const headers = new Headers(register?.[1]?.headers);
    expect(headers.get('If-Match')).toBe('"1"');
    expect(headers.get('Idempotency-Key')).toBeTruthy();
    expect(await seriousA11yViolations(container)).toEqual([]);
  });

  it('[Sucesso] versão corrente em imagem: VersionBadge e prévia inline pela URL assinada (ATT-05)', async () => {
    const fetchMock = mockApi({ current: { fileName: 'foto.png', extension: 'png' } });
    const { container } = renderWithShell(
      <UploadedDocumentFile
        document={documentDto({ currentVersionId: VERSION, currentVersionNumber: 1, version: 2 })}
        meta={{ allowedActions: ['UPDATE'] }}
        deps={deps}
      />,
    );
    const image = await screen.findByRole('img', { name: 'Prévia de foto.png' });
    expect(image.getAttribute('src')).toBe('blob:preview');
    expect(screen.getByText(/v1 · enviado por Lúcia Matos em/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enviar nova versão' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Baixar arquivo' })).toBeTruthy();
    expect(callsTo(fetchMock, `/api/v1/attachments/${ATTACHMENT}/download`, 'GET')).toHaveLength(1);
    expect(await seriousA11yViolations(container)).toEqual([]);
  });

  it('FA-02: PDF e DOCX sem prévia na tela — "Baixar arquivo" sempre visível (ATT-05 no clique)', async () => {
    mockApi({ current: { fileName: 'planilha.xlsx', extension: 'xlsx' } });
    const navigate = vi.fn();
    renderWithShell(
      <UploadedDocumentFile
        document={documentDto({ currentVersionId: VERSION, currentVersionNumber: 1, version: 2 })}
        meta={{ allowedActions: ['UPDATE'] }}
        deps={deps}
        navigate={navigate}
      />,
    );
    await screen.findByText(/Sem prévia disponível para este tipo de arquivo/);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Baixar arquivo' }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(DOWNLOAD_URL);
    });
  });

  it('FA-01: arquivo rejeitado pela varredura → mensagem, "Escolher outro arquivo" e nenhum DOC-19', async () => {
    const fetchMock = mockApi({ finalStatus: 'INFECTED', current: { reasonCode: 'INFECTED' } });
    const { container } = renderWithShell(
      <UploadedDocumentFile
        document={documentDto()}
        meta={{ allowedActions: ['UPDATE'] }}
        deps={deps}
      />,
    );
    await screen.findByRole('button', { name: 'Enviar arquivo' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('input de arquivo ausente');
    await userEvent.setup().upload(input, pdf());
    await screen.findByText('Não foi possível usar este arquivo. Verifique e tente novamente.');
    expect(screen.getByRole('button', { name: 'Escolher outro arquivo' })).toBeTruthy();
    expect(callsTo(fetchMock, `/api/v1/documents/${DOC}/upload-version`)).toHaveLength(0);
  });

  it('[Validação] extensão não permitida bloqueada no seletor, sem chamar a API', async () => {
    const fetchMock = mockApi();
    const { container } = renderWithShell(
      <UploadedDocumentFile
        document={documentDto()}
        meta={{ allowedActions: ['UPDATE'] }}
        deps={deps}
      />,
    );
    await screen.findByRole('button', { name: 'Enviar arquivo' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('input de arquivo ausente');
    await userEvent.setup({ applyAccept: false }).upload(input, new File(['MZ'], 'script.exe'));
    await screen.findByText(/Este tipo de arquivo não é permitido/);
    expect(callsTo(fetchMock, '/api/v1/attachments')).toHaveLength(0);
  });

  it('FA-05: DOC-19 indisponível (503) → "Tentar novamente" reenvia com a MESMA chave, sem novo upload', async () => {
    let fail = true;
    const fetchMock = mockApi({
      uploadVersion: () => {
        if (fail) {
          fail = false;
          return problem(503, 'DEPENDENCY_UNAVAILABLE');
        }
        return jsonResponse({ data: versionDto() }, { status: 201 });
      },
    });
    const { container } = renderWithShell(
      <UploadedDocumentFile
        document={documentDto()}
        meta={{ allowedActions: ['UPDATE'] }}
        deps={deps}
      />,
    );
    await screen.findByRole('button', { name: 'Enviar arquivo' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('input de arquivo ausente');
    const user = userEvent.setup();
    await user.upload(input, pdf());
    await screen.findByText(/Não foi possível concluir o envio agora/);
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await screen.findByText('Versão 1 enviada.');

    const registers = callsTo(fetchMock, `/api/v1/documents/${DOC}/upload-version`);
    expect(registers.length).toBeGreaterThanOrEqual(2);
    const keys = new Set(
      registers.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key')),
    );
    expect(keys.size).toBe(1);
    expect(callsTo(fetchMock, '/api/v1/attachments')).toHaveLength(1);
    expect(FakeXhr.sent).toHaveLength(1);
  });

  it('[Permissão] sem ATTACHMENT_UPLOAD o botão "Enviar arquivo" não aparece', async () => {
    mockApi({ permissions: ['PROCESS_VIEW', 'DOCUMENT_CREATE'] });
    renderWithShell(
      <UploadedDocumentFile
        document={documentDto()}
        meta={{ allowedActions: ['UPDATE'] }}
        deps={deps}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Enviar arquivo' })).toBeNull();
    });
    expect(screen.getByText(/Rascunho sem arquivo/)).toBeTruthy();
  });

  it('V-08: documento fora de edição (sem UPDATE) → envio desabilitado com o motivo', async () => {
    mockApi();
    renderWithShell(
      <UploadedDocumentFile
        document={documentDto({ status: 'FINALIZED' })}
        meta={{ allowedActions: ['REOPEN'] }}
        deps={deps}
      />,
    );
    const button = await screen.findByRole('button', { name: 'Enviar arquivo' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Este documento não pode receber uma nova versão agora.')).toBeTruthy();
  });
});

describe('US-064 — CreateDocumentDialog', () => {
  const type = {
    id: ID(610),
    code: 'DOCUMENTO_EXTERNO',
    name: 'Documento externo',
    kind: 'UPLOADED' as const,
    systemModule: null,
    singular: false,
    sortOrder: 110,
  };

  beforeEach(() => {
    push.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('V-01: título curto → mensagem no campo, sem chamar a API; válido → DOC-02 e SCR-105', async () => {
    const fetchMock = mockApi();
    renderWithShell(<CreateDocumentDialog processId={PROCESS_ID} type={type} onClose={vi.fn()} />);
    const user = userEvent.setup();
    const field = await screen.findByLabelText('Título');
    await user.type(field, 'abc');
    await user.click(screen.getByRole('button', { name: 'Criar e enviar arquivo' }));
    expect(await screen.findByText(/O título deve ter entre 5 e 250 caracteres/)).toBeTruthy();
    expect(callsTo(fetchMock, `/api/v1/processes/${PROCESS_ID}/documents`)).toHaveLength(0);

    await user.clear(field);
    await user.type(field, 'Parecer jurídico sobre a minuta');
    await user.click(screen.getByRole('button', { name: 'Criar e enviar arquivo' }));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}/documentos/${DOC}`);
    });
    const [created] = callsTo(fetchMock, `/api/v1/processes/${PROCESS_ID}/documents`);
    expect(bodyOf(created?.[1])).toEqual({
      documentTypeId: type.id,
      title: 'Parecer jurídico sobre a minuta',
    });
    expect(new Headers(created?.[1]?.headers).get('Idempotency-Key')).toBeTruthy();
  });

  it('[Permissão] 403 da API aparece no diálogo, sem navegar', async () => {
    const fetchMock = vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        requestUrl(input).startsWith('/api/v1/me/permissions')
          ? jsonResponse({ data: { permissions: [] } })
          : problem(403, 'PERMISSION_DENIED'),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderWithShell(<CreateDocumentDialog processId={PROCESS_ID} type={type} onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Título'), 'Parecer jurídico sobre a minuta');
    await user.click(screen.getByRole('button', { name: 'Criar e enviar arquivo' }));
    await screen.findByText('PERMISSION_DENIED');
    expect(push).not.toHaveBeenCalled();
  });
});
