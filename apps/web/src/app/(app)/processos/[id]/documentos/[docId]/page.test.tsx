// @vitest-environment jsdom
import { configure, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ID, PROCESS_ID, callsTo } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import ProcessDocumentPage from './page';

configure({ asyncUtilTimeout: 5000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/processos',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const DOC = ID(500);

describe('/processos/[id]/documentos/[docId] (SCR-105 · US-065)', () => {
  it('busca o documento pelo docId da rota e monta o visualizador com as ações permitidas', async () => {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      if (requestUrl(input) !== `/api/v1/documents/${DOC}`) {
        return Promise.resolve(jsonResponse({}, { status: 404 }));
      }
      return Promise.resolve(
        jsonResponse({
          data: {
            id: DOC,
            processId: PROCESS_ID,
            documentType: {
              id: ID(501),
              code: 'PARECER',
              name: 'Parecer técnico',
              kind: 'FREE_TEXT',
              systemModule: null,
              requiresApproval: false,
            },
            code: null,
            title: 'Parecer de teste',
            status: 'FINALIZED',
            pendingApprovalId: null,
            currentVersionNumber: 1,
            cancellationReason: null,
            version: 5,
            draftContent: { sections: {} },
          },
          meta: { allowedActions: ['REOPEN'] },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithShell(
      await ProcessDocumentPage({ params: Promise.resolve({ id: PROCESS_ID, docId: DOC }) }),
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Parecer de teste' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reabrir' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Processo' }).getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}`,
    );
    expect(callsTo(fetchMock, 'GET', `/api/v1/documents/${DOC}`)).toHaveLength(1);
  });
});
