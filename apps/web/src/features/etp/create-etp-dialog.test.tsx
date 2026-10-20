// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { EtpDto, ImportableDfdDto } from '@contrataflow/validation';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { stubWithRoutes } from '@test/support/price-research-fixtures';
import type { Route } from '@test/support/price-research-fixtures';
import {
  ID,
  PROCESS_ID,
  callsTo,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell } from '@test/support/render';

import { CreateEtpButton, CreateEtpDialog } from './create-etp-dialog';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/processos/${PROCESS_ID}`,
  useSearchParams: () => new URLSearchParams(),
}));

const URL_ETPS = `/api/v1/processes/${PROCESS_ID}/etps`;
const ETP_ID = ID(819);
const ETP_TYPE = ID(808);

const DFD: ImportableDfdDto = {
  documentId: ID(807),
  code: 'DFD 0005/2026',
  status: 'FINALIZED',
  versionId: ID(806),
  versionNumber: 1,
  objectSummary: 'Manutenção predial preventiva dos prédios',
  itemsCount: 2,
  pcaStatus: 'PLANNED',
};

function etpDto(extra: Partial<EtpDto> = {}): EtpDto {
  return {
    id: ETP_ID,
    documentId: ETP_ID,
    processId: PROCESS_ID,
    code: 'ETP 0001/2026',
    title: 'Estudo Técnico Preliminar — 0012/2026',
    status: 'DRAFT',
    conclusion: 'PENDING',
    importedFromDfdVersionId: DFD.versionId,
    responsibleId: ID(1),
    templateVersionId: ID(805),
    documentVersion: 1,
    itemsCount: 2,
    createdAt: '2026-10-18T15:00:00.000Z',
    updatedAt: '2026-10-18T15:00:00.000Z',
    version: 1,
    ...extra,
  };
}

const list =
  (importableDfd: ImportableDfdDto | null, items: unknown[] = []): Route =>
  (url, init) =>
    url === URL_ETPS && (init?.method ?? 'GET') === 'GET'
      ? jsonResponse({ data: items, meta: { importableDfd } })
      : undefined;

const created: Route = (url, init) =>
  url === URL_ETPS && init?.method === 'POST'
    ? jsonResponse(
        { data: etpDto(), meta: { allowedActions: ['UPDATE'] } },
        { status: 201, headers: { Location: `/api/v1/etps/${ETP_ID}`, ETag: '"1"' } },
      )
    : undefined;

const failing =
  (response: () => Response): Route =>
  (url, init) =>
    url === URL_ETPS && init?.method === 'POST' ? response() : undefined;

function setup(...routes: Route[]) {
  const api = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
  const fetchMock = stubWithRoutes(api, ...routes);
  const onOpenChange = vi.fn();
  renderWithShell(
    <>
      <Toaster />
      <CreateEtpDialog processId={PROCESS_ID} open onOpenChange={onOpenChange} />
    </>,
  );
  return { fetchMock, onOpenChange };
}

const submitButton = () => screen.getByRole('button', { name: 'Criar ETP' });
const importBox = () =>
  screen.findByRole<HTMLInputElement>('checkbox', { name: 'Importar dados do DFD' });

beforeEach(() => {
  push.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('CreateEtpDialog (US-019 · fluxo principal 2–7)', () => {
  it('mostra o cartão "Importar dados do DFD 0005/2026?" pré-marcado, com objeto, itens e PCA', async () => {
    setup(list(DFD));
    expect(
      await screen.findByRole('heading', { name: 'Importar dados do DFD 0005/2026?' }),
    ).toBeTruthy();
    expect((await importBox()).checked).toBe(true);
    expect(screen.getByText('Manutenção predial preventiva dos prédios')).toBeTruthy();
    expect(screen.getByText('2 itens')).toBeTruthy();
    expect(screen.getByText('Previsto no PCA')).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('cria importando: envia importFromDfd true com Idempotency-Key, avisa e navega para a SCR-008', async () => {
    const user = userEvent.setup();
    const { fetchMock, onOpenChange } = setup(list(DFD), created);
    await importBox();
    await user.click(submitButton());
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}/etp/${ETP_ID}`);
    });
    const [call] = callsTo(fetchMock, 'POST', URL_ETPS);
    expect(call?.body).toEqual({ importFromDfd: true });
    expect(call?.headers.get('Idempotency-Key')).toEqual(expect.any(String));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(await screen.findByText('ETP 0001/2026 criado.')).toBeTruthy();
  });

  it('FA-01: desmarcar a importação cria o ETP em branco', async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup(list(DFD), created);
    await user.click(await importBox());
    await user.click(submitButton());
    await waitFor(() => {
      expect(callsTo(fetchMock, 'POST', URL_ETPS)).toHaveLength(1);
    });
    expect(callsTo(fetchMock, 'POST', URL_ETPS)[0]?.body).toEqual({ importFromDfd: false });
  });

  it('FA-02: sem DFD elegível o cartão fica oculto e o ETP é criado sem importação', async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup(list(null), created);
    expect(await screen.findByText(/Não há DFD finalizado neste processo/)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    await user.click(submitButton());
    await waitFor(() => {
      expect(callsTo(fetchMock, 'POST', URL_ETPS)[0]?.body).toEqual({ importFromDfd: false });
    });
  });

  it('V-04: 422 NOT_ALLOWED em importFromDfd desmarca e oculta a importação', async () => {
    const user = userEvent.setup();
    setup(
      list(DFD),
      failing(() =>
        problemResponse(422, 'VALIDATION_ERROR', {
          errors: [
            {
              field: 'importFromDfd',
              code: 'NOT_ALLOWED',
              message: 'Não há um DFD finalizado neste processo para importar.',
            },
          ],
        }),
      ),
    );
    await importBox();
    await user.click(submitButton());
    expect(
      await screen.findByText('Não há um DFD finalizado neste processo para importar.'),
    ).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('FA-03: 409 DOCUMENT_ALREADY_EXISTS oferece "Abrir ETP" e bloqueia novo envio', async () => {
    const user = userEvent.setup();
    setup(
      list(DFD),
      failing(() =>
        problemResponse(409, 'DOCUMENT_ALREADY_EXISTS', {
          extension: { meta: { existingEtpId: ETP_ID } },
        }),
      ),
    );
    await importBox();
    await user.click(submitButton());
    expect(
      await screen.findByText('Este processo já tem um ETP. Abra o estudo existente.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Abrir ETP' }).getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}/etp/${ETP_ID}`,
    );
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    [403, 'PERMISSION_DENIED', 'Você não pode criar o ETP neste processo.'],
    [
      409,
      'DOCUMENT_NOT_EDITABLE',
      'O processo não está em um status que permita criar documentos.',
    ],
    [422, 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE', 'Este documento não é permitido na etapa atual.'],
    [
      422,
      'IDEMPOTENCY_KEY_REUSED',
      'Esta solicitação já foi enviada com outros dados. Recarregue a página.',
    ],
    [
      503,
      'DEPENDENCY_UNAVAILABLE',
      'Não foi possível criar o ETP agora. Tente novamente em instantes.',
    ],
    [500, 'INTERNAL_ERROR', 'Ocorreu um erro inesperado. Código: c-test.'],
  ])('erro %s %s mostra a mensagem da US-019', async (status, code, message) => {
    const user = userEvent.setup();
    setup(
      list(DFD),
      failing(() => problemResponse(status, code)),
    );
    await importBox();
    await user.click(submitButton());
    expect(await screen.findByText(message)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('FA-04: o reenvio depois de uma falha usa a mesma Idempotency-Key', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const flaky: Route = (url, init) => {
      if (url !== URL_ETPS || init?.method !== 'POST') return undefined;
      calls += 1;
      return calls === 1
        ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
        : jsonResponse({ data: etpDto(), meta: { allowedActions: [] } }, { status: 201 });
    };
    const { fetchMock } = setup(list(DFD), flaky);
    await importBox();
    await user.click(submitButton());
    await screen.findByText('Não foi possível criar o ETP agora. Tente novamente em instantes.');
    await user.click(submitButton());
    await waitFor(() => {
      expect(push).toHaveBeenCalled();
    });
    const keys = callsTo(fetchMock, 'POST', URL_ETPS).map((call) =>
      call.headers.get('Idempotency-Key'),
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});

describe('CreateEtpButton (DOC-01 + ETP-01)', () => {
  const documentTypes = () =>
    jsonResponse({
      data: [
        {
          id: ETP_TYPE,
          code: 'ETP',
          name: 'Estudo Técnico Preliminar',
          kind: 'STRUCTURED',
          systemModule: 'ETP',
          isActive: true,
          allowMultiplePerProcess: false,
          sortOrder: 2,
        },
      ],
    });
  const panel = (creatable: boolean) => () =>
    jsonResponse({
      data: [],
      meta: {
        currentStage: null,
        creatableTypeIds: creatable ? [ETP_TYPE] : [],
        pendingTypeIds: [ETP_TYPE],
      },
    });

  it('sem permissão (DOC-01 sem o tipo) o botão "Criar ETP" não aparece', async () => {
    const api = mockProcessApi({ documentTypes, documents: panel(false) });
    const fetchMock = stubWithRoutes(api, list(null));
    renderWithShell(<CreateEtpButton processId={PROCESS_ID} />);
    await waitFor(() => {
      expect(callsTo(fetchMock, 'GET', URL_ETPS)).toHaveLength(1);
    });
    expect(screen.queryByRole('button', { name: 'Criar ETP' })).toBeNull();
  });

  it('com o tipo liberado abre o diálogo', async () => {
    const user = userEvent.setup();
    const api = mockProcessApi({ documentTypes, documents: panel(true) });
    stubWithRoutes(api, list(DFD));
    renderWithShell(<CreateEtpButton processId={PROCESS_ID} />);
    await user.click(await screen.findByRole('button', { name: 'Criar ETP' }));
    expect(
      await screen.findByRole('dialog', { name: 'Criar Estudo Técnico Preliminar' }),
    ).toBeTruthy();
  });

  it('FA-03: com ETP ativo vira o link "Abrir ETP 0001/2026"', async () => {
    const api = mockProcessApi({ documentTypes, documents: panel(false) });
    stubWithRoutes(
      api,
      list(DFD, [
        {
          id: ETP_ID,
          documentId: ETP_ID,
          code: 'ETP 0001/2026',
          status: 'DRAFT',
          conclusion: 'PENDING',
          version: 1,
        },
      ]),
    );
    renderWithShell(<CreateEtpButton processId={PROCESS_ID} />);
    const link = await screen.findByRole('link', { name: 'Abrir ETP 0001/2026' });
    expect(link.getAttribute('href')).toBe(`/processos/${PROCESS_ID}/etp/${ETP_ID}`);
    expect(screen.queryByRole('button', { name: 'Criar ETP' })).toBeNull();
  });
});
