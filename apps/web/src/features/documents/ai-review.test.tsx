// @vitest-environment jsdom
import type { DocumentDto, DocumentMeta, DraftSection } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { ID, PROCESS_ID, bodyOf, problemResponse } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl, shellSession } from '@test/support/render';

import { AiReviewPanel } from './ai-review';
import { aiSectionAnchor, aiSectionsOf, sectionLabelOf, toConfirmMarksOf } from './ai-review-model';
import { ViolationList } from './violation-list';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/processos',
}));

/*
 * US-122 — marcas de IA e revisão humana na SCR-105 (DOC-27): badge "Gerado por IA · revisão
 * pendente" com a contagem, chips "[a confirmar: …]" focáveis, "Marcar seção como revisada" com a
 * revisão lida, "Revisar todas" com a confirmação "Li e revisei as N seções" (`confirmAll`), ações
 * ocultas sem permissão de edição, conflito 412, 503 com "Tentar novamente" e axe.
 */

const DOC = ID(900);
const G1 = ID(901);
const API = '/api/v1';
const ME = shellSession().user.id;

const ai = (reviewedAt: string | null = null, reviewedById: string | null = null) => ({
  generationId: G1,
  appliedAt: '2026-10-16T12:00:00.000Z',
  appliedById: ME,
  reviewedAt,
  reviewedById,
});

function section(extra: Partial<DraftSection> & { marks?: string[] } = {}): DraftSection {
  const { marks = [], ...rest } = extra;
  return {
    state: 'FILLED',
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Entrega em ' },
            ...marks.map((label) => ({
              type: 'toConfirm',
              attrs: { label, category: 'DEADLINE', origin: 'AI' },
            })),
          ],
        },
      ],
    },
    justification: null,
    revision: 4,
    updatedAt: '2026-10-16T12:00:00.000Z',
    updatedById: ME,
    ...rest,
  };
}

function documentDto(sections: Record<string, DraftSection>): DocumentDto {
  return {
    id: DOC,
    processId: PROCESS_ID,
    documentType: {
      id: ID(902),
      code: 'DFD',
      name: 'Documento de Formalização da Demanda',
      kind: 'STRUCTURED',
      systemModule: 'DFD',
      requiresApproval: false,
    },
    templateVersionId: null,
    number: 5,
    year: 2026,
    code: 'DFD 0005/2026',
    title: 'DFD da aquisição de cadeiras',
    status: 'DRAFT',
    confidentiality: 'INTERNAL',
    draftContent: { sections },
    draftRevision: 7,
    currentVersionId: null,
    currentVersionNumber: null,
    approvedVersionId: null,
    pendingApprovalId: null,
    responsibleId: ME,
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
    createdAt: '2026-10-16T12:00:00.000Z',
    updatedAt: '2026-10-16T12:30:00.000Z',
    createdById: ME,
    version: 3,
  };
}

const EDITABLE: DocumentMeta = { allowedActions: ['UPDATE', 'FINALIZE'] };

function mockReview(response: () => Response = () => okReview(['JUSTIFICATION'])) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    if ((init?.method ?? 'GET') === 'POST' && url === `${API}/documents/${DOC}/ai-review`) {
      return Promise.resolve(response());
    }
    return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function okReview(keys: string[]): Response {
  return jsonResponse({
    data: { document: documentDto({}), reviewedSectionKeys: keys },
  });
}

const reviewBodies = (fetchMock: ReturnType<typeof mockReview>) =>
  fetchMock.mock.calls
    .filter(([input]) => requestUrl(input).endsWith('/ai-review'))
    .map(([, init]) => bodyOf(init));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('modelo das marcas de IA (RN-AI-55/57)', () => {
  it('lista só seções preenchidas com IA ou marcações, em ordem, com as pendências', () => {
    const sections = aiSectionsOf(
      documentDto({
        ZETA: section({ marks: ['prazo'] }),
        JUSTIFICATION: section({ ai: ai() }),
        MANUAL: section(),
        EMPTY: section({ state: 'EMPTY', ai: ai() }),
        REVIEWED: section({ ai: ai('2026-10-17T10:00:00.000Z', ME) }),
      }),
    );
    expect(
      sections.map((item) => `${item.key}:${String(item.pending)}:${String(item.marks.length)}`),
    ).toEqual(['JUSTIFICATION:true:0', 'REVIEWED:false:0', 'ZETA:false:1']);
    expect(toConfirmMarksOf(null)).toEqual([]);
    expect(sectionLabelOf('EXPECTED_RESULTS')).toBe('Expected results');
    expect(aiSectionAnchor('EXPECTED_RESULTS')).toBe('secao-ia-expected-results');
  });
});

describe('AiReviewPanel (US-122 · DOC-27)', () => {
  it('mostra badge pendente com a contagem e os chips focáveis; marcar a seção envia a revisão lida (axe)', async () => {
    const fetchMock = mockReview();
    const { container } = renderWithShell(
      <AiReviewPanel
        document={documentDto({ JUSTIFICATION: section({ ai: ai(), marks: ['prazo'] }) })}
        meta={EDITABLE}
      />,
    );
    const item = screen.getByRole('heading', { name: 'Justification' }).closest('li');
    if (!item) throw new Error('sem seção');
    expect(within(item).getByText('Gerado por IA · revisão pendente')).toBeTruthy();
    expect(within(item).getByText('· 1 pendência')).toBeTruthy();
    const chip = within(item).getByRole('note', { name: 'Pendência a confirmar: prazo' });
    expect(chip.textContent).toBe('[a confirmar: prazo]');
    expect(chip.getAttribute('tabindex')).toBe('0');
    expect(item.id).toBe('secao-ia-justification');
    expect(await seriousA11yViolations(container)).toEqual([]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Marcar seção como revisada' }));
    await waitFor(() => {
      expect(reviewBodies(fetchMock)).toEqual([
        { sectionKeys: ['JUSTIFICATION'], expectedRevisions: { JUSTIFICATION: 4 } },
      ]);
    });
    expect(await screen.findByText('Seção Justification marcada como revisada.')).toBeTruthy();
    // Só uma seção pendente: sem "Revisar todas".
    expect(screen.queryByRole('button', { name: /Revisar todas/ })).toBeNull();
  });

  it('"Revisar todas": confirmação obrigatória e DOC-27 com confirmAll e as revisões de cada seção', async () => {
    const fetchMock = mockReview(() => okReview(['EXPECTED_RESULTS', 'JUSTIFICATION']));
    renderWithShell(
      <AiReviewPanel
        document={documentDto({
          JUSTIFICATION: section({ ai: ai() }),
          EXPECTED_RESULTS: section({ ai: ai(), revision: 2 }),
        })}
        meta={EDITABLE}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Revisar todas (2)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revisar todas as seções' });
    const confirm = within(dialog).getByRole('button', {
      name: 'Marcar as 2 seções como revisadas',
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(dialog).getByRole('checkbox', { name: 'Li e revisei as 2 seções' }));
    expect(await seriousA11yViolations(dialog)).toEqual([]);
    await user.click(confirm);
    await waitFor(() => {
      expect(reviewBodies(fetchMock)).toEqual([
        {
          sectionKeys: ['EXPECTED_RESULTS', 'JUSTIFICATION'],
          expectedRevisions: { EXPECTED_RESULTS: 2, JUSTIFICATION: 4 },
          confirmAll: true,
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(await screen.findByText('2 seções marcadas como revisadas.')).toBeTruthy();
  });

  it('sem permissão de edição (sem UPDATE): badge e chips à vista, sem ações de revisão', () => {
    mockReview();
    renderWithShell(
      <AiReviewPanel
        document={documentDto({
          JUSTIFICATION: section({ ai: ai(), marks: ['valor'] }),
          EXPECTED_RESULTS: section({ ai: ai() }),
        })}
        meta={{ allowedActions: [] }}
      />,
    );
    expect(screen.getAllByText('Gerado por IA · revisão pendente')).toHaveLength(2);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('seção revisada por mim mostra "revisada por você"; sem IA nem marcações o painel some', () => {
    mockReview();
    const { unmount } = renderWithShell(
      <AiReviewPanel
        document={documentDto({
          JUSTIFICATION: section({ ai: ai('2026-10-17T10:00:00.000Z', ME) }),
        })}
        meta={EDITABLE}
      />,
    );
    expect(screen.getByText(/Gerado por IA · revisada por você em/)).toBeTruthy();
    expect(
      screen.getByText('Todo o conteúdo gerado por IA foi revisado e não há itens [a confirmar].'),
    ).toBeTruthy();
    unmount();
    renderWithShell(
      <AiReviewPanel document={documentDto({ MANUAL: section() })} meta={EDITABLE} />,
    );
    expect(screen.queryByRole('heading', { name: 'Conteúdo gerado por IA' })).toBeNull();
  });

  it('412 (seção alterada) avisa para ler a versão atual; 503 oferece "Tentar novamente"', async () => {
    let calls = 0;
    const fetchMock = mockReview(() => {
      calls += 1;
      if (calls === 1) return problemResponse(412, 'VERSION_CONFLICT');
      if (calls === 2) return problemResponse(503, 'DEPENDENCY_UNAVAILABLE');
      return okReview(['JUSTIFICATION']);
    });
    renderWithShell(
      <AiReviewPanel
        document={documentDto({ JUSTIFICATION: section({ ai: ai() }) })}
        meta={EDITABLE}
      />,
    );
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: 'Marcar seção como revisada' });
    await user.click(button);
    expect(
      await screen.findByText('A seção foi alterada. Leia a versão atual antes de revisar.'),
    ).toBeTruthy();
    await user.click(button);
    expect(
      await screen.findByText(
        'Não foi possível registrar a revisão agora. Tente novamente em instantes.',
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => {
      expect(reviewBodies(fetchMock)).toHaveLength(3);
    });
  });
});

describe('painel de validação: link para a seção (DOC-08)', () => {
  it('violações de IA levam o link para a seção; as demais não', () => {
    renderWithShell(
      <ViolationList
        label="Pendências"
        violations={[
          {
            code: 'SECTION_PLACEHOLDER_PENDING',
            severity: 'BLOCKING',
            message: 'Resolva os 2 itens [a confirmar] da seção "Resultados".',
            ruleId: null,
            sectionKey: 'EXPECTED_RESULTS',
            field: null,
            itemId: null,
            params: { count: 2 },
          },
          {
            code: 'SECTION_REQUIRED',
            severity: 'BLOCKING',
            message: 'Preencha a seção "Objeto".',
            ruleId: null,
            sectionKey: 'OBJETO',
            field: null,
            itemId: null,
            params: {},
          },
        ]}
      />,
    );
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('#secao-ia-expected-results');
    expect(links[0]?.textContent).toBe('Ir para a seção EXPECTED_RESULTS');
  });
});
