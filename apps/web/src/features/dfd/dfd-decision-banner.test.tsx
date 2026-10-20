// @vitest-environment jsdom
import type * as UiModule from '@contrataflow/ui';
import type { DfdDecisionDto, DocumentDto } from '@contrataflow/validation';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { DFD_ID, ID, PROCESS_ID, bodyOf } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { DecisionBanner, visibleDecision } from './dfd-decision-banner';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const ui = vi.hoisted(() => ({ toast: vi.fn(), push: vi.fn() }));
vi.mock('@contrataflow/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof UiModule>()),
  toast: ui.toast,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: ui.push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/processos/${PROCESS_ID}/dfd/${DFD_ID}`,
  useSearchParams: () => new URLSearchParams(),
}));

const REASON = 'Demanda já atendida por contrato vigente';

function documentDto(extra: Partial<DocumentDto> = {}): DocumentDto {
  return {
    id: DFD_ID,
    processId: PROCESS_ID,
    code: 'DFD 0005/2026',
    title: 'DFD — cimento',
    status: 'REJECTED',
    draftContent: { sections: {} },
    draftRevision: 7,
    currentVersionId: ID(992),
    currentVersionNumber: 1,
    approvedVersionId: null,
    pendingApprovalId: null,
    submittedAt: null,
    finalizedAt: null,
    version: 6,
    ...extra,
  } as DocumentDto;
}

function decisionOf(extra: Partial<DfdDecisionDto> = {}): DfdDecisionDto {
  return {
    approvalId: ID(991),
    outcome: 'REJECTED',
    comment: REASON,
    decidedAt: '2026-10-05T17:30:00.000Z',
    decidedBy: { id: ID(77), name: 'Helena Prado' },
    ...extra,
  };
}

function renderBanner(props: Partial<Parameters<typeof DecisionBanner>[0]> = {}) {
  return renderWithShell(
    <DecisionBanner
      decision={decisionOf()}
      document={documentDto()}
      dfdId={DFD_ID}
      allowedActions={['REOPEN']}
      timeZone="America/Sao_Paulo"
      {...props}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('visibleDecision (US-017)', () => {
  it('só enquanto o DFD está no status que a decisão produziu', () => {
    expect(visibleDecision(null, 'REJECTED')).toBeNull();
    expect(visibleDecision(undefined, 'REJECTED')).toBeNull();
    expect(visibleDecision(decisionOf(), 'DRAFT')).toBeNull();
    expect(visibleDecision(decisionOf(), 'REJECTED')).toMatchObject({ outcome: 'REJECTED' });
  });
});

describe('DecisionBanner (US-017 · SCR-007)', () => {
  it('indeferido: título, quem decidiu, o motivo e "Reabrir DFD" para quem tem REOPEN; sem violações de a11y', async () => {
    const { container } = renderBanner();

    expect(screen.getByText('DFD indeferido')).toBeTruthy();
    expect(screen.getByText(/Decisão de Helena Prado em/)).toBeTruthy();
    expect(screen.getByText(REASON)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reabrir DFD' })).toBeTruthy();
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(await seriousA11yViolations(container)).toEqual([]);
  });

  it('aprovado sem motivo e sem REOPEN: só o selo da decisão', () => {
    renderBanner({
      decision: decisionOf({ outcome: 'APPROVED', comment: null }),
      document: documentDto({ status: 'APPROVED' }),
      allowedActions: [],
    });

    expect(screen.getByText('DFD aprovado')).toBeTruthy();
    expect(screen.queryByText('Motivo:')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reabrir DFD' })).toBeNull();
  });

  it('devolvido: orienta o ajuste e o reenvio', () => {
    renderBanner({
      decision: decisionOf({ outcome: 'RETURNED', comment: 'Detalhar a quantidade.' }),
      document: documentDto({ status: 'RETURNED' }),
      allowedActions: ['UPDATE'],
    });

    expect(screen.getByText('DFD devolvido para ajuste')).toBeTruthy();
    expect(screen.getByText('Ajuste o DFD e envie novamente para aprovação.')).toBeTruthy();
  });

  it('sem decisão vigente (reaberto), nada aparece', () => {
    const { container } = renderBanner({ document: documentDto({ status: 'DRAFT' }) });
    expect(container.textContent).toBe('');
  });

  it('"Reabrir DFD" pede a justificativa e chama o DOC-12 com If-Match', async () => {
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if ((init?.method ?? 'GET') === 'POST' && url === `/api/v1/documents/${DFD_ID}/reopen`) {
        return Promise.resolve(
          jsonResponse(
            { data: documentDto({ status: 'DRAFT', version: 7 }), meta: { allowedActions: [] } },
            { headers: { ETag: '"7"' } },
          ),
        );
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderBanner();

    await user.click(screen.getByRole('button', { name: 'Reabrir DFD' }));
    await user.type(
      await screen.findByLabelText(/Justificativa da reabertura/),
      'Ajuste da demanda após o indeferimento do titular.',
    );
    await user.click(screen.getByRole('button', { name: 'Confirmar reabertura' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            requestUrl(input) === `/api/v1/documents/${DFD_ID}/reopen` && init?.method === 'POST',
        ),
      ).toBe(true);
    });
    const [, init] =
      fetchMock.mock.calls.find(
        ([input]) => requestUrl(input) === `/api/v1/documents/${DFD_ID}/reopen`,
      ) ?? [];
    expect(new Headers(init?.headers).get('If-Match')).toBe('"6"');
    expect(bodyOf(init)).toMatchObject({
      reopenReason: 'Ajuste da demanda após o indeferimento do titular.',
    });
    await waitFor(() => {
      expect(ui.toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
    });
  });
});
