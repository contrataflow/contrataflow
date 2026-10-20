// @vitest-environment jsdom
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DFD_ID,
  ID,
  PROCESS_ID,
  callsTo,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { ElaborateDfdButton } from './elaborate-dfd';

configure({ asyncUtilTimeout: 10_000 });

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/processos/${PROCESS_ID}`,
  useSearchParams: () => new URLSearchParams(),
}));

const DFD_TYPE = ID(601);

const documentTypes = () =>
  jsonResponse({
    data: [
      {
        id: DFD_TYPE,
        code: 'DFD',
        name: 'DFD',
        kind: 'STRUCTURED',
        systemModule: 'DFD',
        isActive: true,
        allowMultiplePerProcess: false,
        sortOrder: 1,
      },
    ],
  });

const panel = (creatable: boolean) => () =>
  jsonResponse({
    data: [],
    meta: {
      currentStage: { key: 'ABERTURA', name: 'Abertura', documentTypeCodes: ['DFD'] },
      creatableTypeIds: creatable ? [DFD_TYPE] : [],
      pendingTypeIds: [DFD_TYPE],
    },
  });

beforeEach(() => {
  push.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('"Elaborar DFD" no painel do processo (US-014 · fluxo principal 1–5)', () => {
  it('sem DFD_CREATE/POL-02 (DOC-01 sem o tipo DFD) a ação não aparece', async () => {
    const api = mockProcessApi({ documentTypes, documents: panel(false) });
    renderWithShell(<ElaborateDfdButton processId={PROCESS_ID} />);
    await waitFor(() => {
      expect(callsTo(api, 'GET', `/api/v1/processes/${PROCESS_ID}/documents`)).toHaveLength(1);
    });
    expect(screen.queryByRole('button', { name: 'Elaborar DFD' })).toBeNull();
  });

  it('cria pelo DFD-02 com Idempotency-Key e leva ao passo Identificação do SCR-007', async () => {
    const api = mockProcessApi({ documentTypes, documents: panel(true) });
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      if (init?.method === 'POST' && requestUrl(input) === `/api/v1/processes/${PROCESS_ID}/dfds`) {
        return Promise.resolve(
          jsonResponse(
            { data: { id: DFD_ID, wizardStep: 'IDENTIFICATION' }, meta: { allowedActions: [] } },
            { status: 201, headers: { Location: `/api/v1/dfds/${DFD_ID}`, ETag: '"1"' } },
          ),
        );
      }
      return api(input, init);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWithShell(<ElaborateDfdButton processId={PROCESS_ID} />);
    await user.click(await screen.findByRole('button', { name: 'Elaborar DFD' }));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        `/processos/${PROCESS_ID}/dfd/${DFD_ID}?passo=identificacao`,
      );
    });
    const [call] = callsTo(fetchMock, 'POST', `/api/v1/processes/${PROCESS_ID}/dfds`);
    expect(call?.body).toEqual({});
    expect(call?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('FA-02: 409 DOCUMENT_ALREADY_EXISTS mostra o código e "Abrir DFD"; falha mostra o correlationId', async () => {
    const api = mockProcessApi({ documentTypes, documents: panel(true) });
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((input, init) => {
        if (
          init?.method === 'POST' &&
          requestUrl(input) === `/api/v1/processes/${PROCESS_ID}/dfds`
        ) {
          attempt += 1;
          return Promise.resolve(
            attempt === 1
              ? problemResponse(409, 'DOCUMENT_ALREADY_EXISTS', {
                  extension: { meta: { existingDfdId: DFD_ID, code: 'DFD 0005/2026' } },
                })
              : problemResponse(503, 'DEPENDENCY_UNAVAILABLE', { correlationId: 'c-dfd-503' }),
          );
        }
        return api(input, init);
      }),
    );
    const user = userEvent.setup();
    renderWithShell(<ElaborateDfdButton processId={PROCESS_ID} />);
    await user.click(await screen.findByRole('button', { name: 'Elaborar DFD' }));
    expect(await screen.findByText('Este processo já possui o DFD 0005/2026.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Abrir DFD' }).getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}/dfd/${DFD_ID}`,
    );
    await user.click(screen.getByRole('button', { name: 'Elaborar DFD' }));
    expect(
      await screen.findByText(
        'Não foi possível criar o DFD agora. Tente novamente em instantes. Código: c-dfd-503',
      ),
    ).toBeTruthy();
  });
});
