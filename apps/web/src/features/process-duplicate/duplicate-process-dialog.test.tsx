// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { ProcessDocumentDto } from '@contrataflow/validation';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import {
  ID,
  MANUTENCAO,
  OBRAS,
  PROCESS_ID,
  PROJETOS,
  bodyOf,
  mockProcessApi,
  problemResponse,
  processDto,
} from '@test/support/process-fixtures';
import type { ProcessApiOptions } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { DuplicateProcessDialog } from './duplicate-process-dialog';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const nav = { push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => nav,
  usePathname: () => `/processos/${PROCESS_ID}`,
}));

beforeEach(() => {
  nav.push.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const POST_URL = `/api/v1/processes/${PROCESS_ID}/duplicate`;

const valueOf = (element: HTMLElement) => (element as HTMLInputElement).value;
const disabledOf = (element: HTMLElement) => (element as HTMLButtonElement).disabled;

function documentOf(
  n: number,
  kind: 'STRUCTURED' | 'FREE_TEXT',
  code: string,
  title: string,
): ProcessDocumentDto {
  return {
    id: ID(n),
    processId: PROCESS_ID,
    documentType: {
      id: ID(n + 50),
      code,
      name: code,
      kind,
      systemModule: null,
      requiresApproval: true,
    },
    templateVersionId: null,
    number: 5,
    year: 2026,
    code: `${code} 0005/2026`,
    title,
    status: 'APPROVED',
    confidentiality: 'INTERNAL',
    draftRevision: 1,
    currentVersionId: null,
    currentVersionNumber: null,
    approvedVersionId: null,
    pendingApprovalId: null,
    responsibleId: ID(1),
    responsibleName: 'Ana Souza',
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
    updatedAt: '2026-10-17T13:30:00.000Z',
    createdById: ID(1),
    version: 1,
    summary: null,
    meta: { allowedActions: [] },
  };
}

const documentsResponse = (items: ProcessDocumentDto[]) => () =>
  jsonResponse({
    data: items,
    meta: { currentStage: null, creatableTypeIds: [], pendingTypeIds: [] },
  });

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

function renderDialog(options: ProcessApiOptions = {}) {
  const api = mockProcessApi({
    permissions: ['PROCESS_CREATE', 'PROCESS_DUPLICATE'],
    documents: documentsResponse([
      documentOf(501, 'STRUCTURED', 'DFD', 'DFD — cimento'),
      documentOf(502, 'FREE_TEXT', 'DESPACHO', 'Despacho de encaminhamento'),
    ]),
    ...options,
  });
  const onOpenChange = vi.fn();
  renderWithShell(
    <>
      <DuplicateProcessDialog processId={PROCESS_ID} open onOpenChange={onOpenChange} />
      <Toaster />
    </>,
    { queryClient: noRetryClient() },
  );
  return { api, onOpenChange };
}

const posts = (api: ReturnType<typeof mockProcessApi>) =>
  api.mock.calls.filter(
    ([input, init]) => requestUrl(input) === POST_URL && init?.method === 'POST',
  );

describe('SCR-113 · Diálogo "Duplicar processo" (US-011)', () => {
  it('[Sucesso] pré-preenche, copia documentos e navega para o novo processo com o toast', async () => {
    const user = userEvent.setup();
    const { api, onOpenChange } = renderDialog();

    const title = await screen.findByLabelText(/^Título/);
    expect(valueOf(title)).toBe('Aquisição de cimento para manutenção de vias');
    await waitFor(() => {
      expect(document.activeElement).toBe(title);
    });
    await waitFor(() => {
      expect(valueOf(screen.getByLabelText(/^Setor solicitante/))).toBe(MANUTENCAO.id);
    });
    expect(valueOf(screen.getByLabelText(/^Secretaria solicitante/))).toBe(OBRAS.id);

    const copyDocuments = screen.getByRole('switch', { name: /Copiar documentos estruturados/ });
    await waitFor(() => {
      expect(disabledOf(copyDocuments)).toBe(false);
    });
    expect(copyDocuments.getAttribute('aria-checked')).toBe('false');
    await user.click(copyDocuments);
    expect(copyDocuments.getAttribute('aria-checked')).toBe('true');
    // Só o estruturado entra na lista; o despacho nunca é copiado.
    const list = screen.getByRole('list', { name: 'Documentos que serão copiados' });
    expect(list.textContent).toContain('DFD 0005/2026 — DFD — cimento');
    expect(list.textContent).not.toContain('Despacho');

    await user.clear(title);
    await user.type(title, 'Aquisição de cimento 2027');
    await user.click(screen.getByRole('button', { name: 'Duplicar' }));

    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    const [[, init]] = posts(api) as [[unknown, RequestInit]];
    expect(new Headers(init.headers).get('Idempotency-Key')).toBeTruthy();
    expect(bodyOf(init)).toEqual({
      title: 'Aquisição de cimento 2027',
      object: 'Aquisição de cimento Portland para a manutenção das vias do município.',
      requestingSecretariatId: OBRAS.id,
      requestingDepartmentId: MANUTENCAO.id,
      copyDocuments: true,
      copyAttachments: false,
    });
    expect(await screen.findByText('Processo 0045/2026 criado a partir de 0012/2026')).toBeTruthy();
    expect(nav.push).toHaveBeenCalledWith(`/processos/${ID(410)}`);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('FA-03: sem documento estruturado o interruptor fica desabilitado com a dica', async () => {
    renderDialog({
      documents: documentsResponse([
        documentOf(502, 'FREE_TEXT', 'DESPACHO', 'Despacho de encaminhamento'),
      ]),
    });
    expect(await screen.findByText('Nenhum documento estruturado para copiar')).toBeTruthy();
    expect(disabledOf(screen.getByRole('switch', { name: /Copiar documentos estruturados/ }))).toBe(
      true,
    );
    expect(disabledOf(screen.getByRole('switch', { name: 'Copiar anexos' }))).toBe(false);
  });

  it('FA-05: o seletor de setor só mostra as unidades cobertas pelo PROCESS_CREATE', async () => {
    renderDialog({ scopes: [{ type: 'OWN_DEPARTMENTS', includeSubtree: false }] });
    const sector = await screen.findByLabelText(/^Setor solicitante/);
    await waitFor(() => {
      expect(valueOf(sector)).toBe(MANUTENCAO.id);
    });
    const options = Array.from(sector.querySelectorAll('option')).map((option) => option.value);
    expect(options).toContain(MANUTENCAO.id);
    expect(options).not.toContain(PROJETOS.id);
  });

  it('[Validação] título curto não chega à API; referência inativa da origem pede ajuste (FA-01)', async () => {
    const user = userEvent.setup();
    const { api } = renderDialog({
      duplicate: () =>
        problemResponse(422, 'VALIDATION_ERROR', {
          errors: [
            {
              field: 'modalityId',
              code: 'REFERENCE_INACTIVE',
              message: 'Selecione uma modalidade válida.',
            },
          ],
        }),
    });
    const title = await screen.findByLabelText(/^Título/);
    await user.clear(title);
    await user.type(title, 'Obra');
    await user.click(screen.getByRole('button', { name: 'Duplicar' }));
    expect(await screen.findByText('O título deve ter entre 5 e 200 caracteres.')).toBeTruthy();
    expect(posts(api)).toHaveLength(0);

    await user.clear(title);
    await user.type(title, 'Aquisição de cimento 2027');
    await user.click(screen.getByRole('button', { name: 'Duplicar' }));
    expect(
      await screen.findByText('Há dados copiados da origem que precisam de ajuste:'),
    ).toBeTruthy();
    expect(screen.getByText('Selecione uma modalidade válida.')).toBeTruthy();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('[Permissão] 403 no setor do novo processo mostra o motivo e sugere outro setor', async () => {
    const user = userEvent.setup();
    renderDialog({
      duplicate: () =>
        problemResponse(403, 'PERMISSION_DENIED', {
          detail: 'Você não pode abrir processos para este setor.',
        }),
    });
    await screen.findByLabelText(/^Título/);
    await user.click(screen.getByRole('button', { name: 'Duplicar' }));
    expect(await screen.findByText('Você não pode abrir processos para este setor.')).toBeTruthy();
    expect(
      screen.getByText('Escolha outro setor solicitante ou peça acesso ao administrador.'),
    ).toBeTruthy();
  });

  it('[Falha de banco] 503 oferece "Tentar novamente" com a mesma chave de idempotência', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { api } = renderDialog({
      duplicate: () => {
        calls += 1;
        return calls === 1
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
          : jsonResponse({ data: processDto({ id: ID(411), code: '0046/2026' }) }, { status: 201 });
      },
    });
    await screen.findByLabelText(/^Título/);
    await user.click(screen.getByRole('button', { name: 'Duplicar' }));
    const retry = await screen.findByRole('button', { name: 'Tentar novamente' });
    await user.click(retry);
    await waitFor(() => {
      expect(nav.push).toHaveBeenCalledWith(`/processos/${ID(411)}`);
    });
    const keys = posts(api).map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'));
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys).size).toBe(1);
  });

  it('[Acessibilidade] sem violações sérias do axe', async () => {
    renderDialog();
    await screen.findByLabelText(/^Título/);
    await waitFor(() => {
      expect(
        disabledOf(screen.getByRole('switch', { name: /Copiar documentos estruturados/ })),
      ).toBe(false);
    });
    expect(await seriousA11yViolations()).toEqual([]);
  });
});
