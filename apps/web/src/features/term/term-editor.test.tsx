// @vitest-environment jsdom
import type {
  TermDetailDto,
  TermDetailMeta,
  TermPriceResearchRefDto,
  TermTemplateSectionDto,
} from '@contrataflow/validation';
import { cleanup, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { editorDraftStore } from '@/lib/drafts/encrypted-drafts';
import { seriousA11yViolations } from '@test/support/axe';
import {
  ID,
  PROCESS_ID,
  bodyOf,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { TENANT_A, jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { TermEditor } from './term-editor';
import {
  canEditTerm,
  draftContentOf,
  localCompleteness,
  objectProblem,
  termNavItems,
  termReadOnlyReason,
} from './term-editor-model';

configure({ asyncUtilTimeout: 8_000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-036 — SCR-012 com a API simulada: navegação lateral com estado, obrigatoriedade e completude
 * recalculada depois do autosave (RN-TR-13), autosave com `If-Match: "s<revision>"` (DOC-05 — o
 * mesmo mecanismo do ETP), "não se aplica" só fora das `REQUIRED` com justificativa ≥ 20 (V-07/V-08),
 * "Dados do TR" (TRM-04: objeto e valor estimado, FA-04/FA-05), modo leitura (FA-06/FA-08) e o
 * conflito de seção (FA-03). Relógio real: o debounce é 1,5 s.
 */

const ANA = '0192a000-0000-7000-8000-0000000000a1';
const BRUNO = '0192a000-0000-7000-8000-0000000000b7';
const TERM_ID = ID(900);
const RESEARCH_ID = ID(701);
const AT = '2026-10-19T17:31:00.000Z';
const SCOPE = { tenantId: TENANT_A.id, userId: ANA, documentId: TERM_ID };
const JUSTIFICATION_30 = 'Serviço prestado remotamente ok';

const section = (
  key: string,
  title: string,
  order: number,
  extra: Partial<TermTemplateSectionDto> = {},
): TermTemplateSectionDto => ({
  key,
  title,
  order,
  requirement: 'REQUIRED',
  helpText: null,
  legalBasis: null,
  minChars: null,
  maxChars: 50_000,
  render: 'TEXT',
  allowNarrative: true,
  ...extra,
});

const META: TermDetailMeta = {
  allowedActions: ['UPDATE', 'FINALIZE'],
  template: {
    versionId: ID(901),
    versionNumber: 1,
    sections: [
      section('OBJECT', 'Definição do objeto', 1, {
        legalBasis: 'Lei 14.133/2021, art. 6º, XXIII, a',
        helpText: 'Descreva a natureza, os quantitativos e o prazo do contrato.',
      }),
      section('DELIVERY', 'Local e condições de entrega ou de execução', 2, {
        requirement: 'REQUIRED_OR_JUSTIFY',
      }),
      section('ESTIMATED_VALUE', 'Estimativa do valor da contratação', 3, {
        render: 'ESTIMATED_VALUE',
      }),
    ],
  },
};

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const emptySection = (revision = 1) => ({
  state: 'EMPTY' as const,
  content: null,
  justification: null,
  revision,
  updatedAt: AT,
  updatedById: ANA,
});

const research = (extra: Partial<TermPriceResearchRefDto> = {}): TermPriceResearchRefDto => ({
  id: RESEARCH_ID,
  code: 'PP 0002/2026',
  status: 'FINALIZED',
  totalEstimatedValue: '98000.00',
  completed: true,
  ...extra,
});

function termDto(extra: Partial<TermDetailDto> = {}): TermDetailDto {
  return {
    id: TERM_ID,
    documentId: TERM_ID,
    processId: PROCESS_ID,
    code: 'TR 0003/2026',
    title: 'Termo de Referência — 0012/2026',
    status: 'DRAFT',
    inApproval: false,
    templateVersion: { id: ID(901), versionNumber: 1 },
    responsibleId: ANA,
    objectDefinition: 'Manutenção predial preventiva dos prédios municipais',
    contractDurationMonths: null,
    executionDeadline: null,
    executionDeadlineType: null,
    deliveryLocation: null,
    paymentTermDays: null,
    productWarrantyMonths: null,
    contractGuaranteePercent: null,
    allowsSubcontracting: null,
    selectionCriterionId: null,
    awardType: null,
    estimatedTotalValue: '98000.00',
    estimatedTotalValueMasked: false,
    estimatedValueSource: 'PRICE_RESEARCH',
    priceResearchId: RESEARCH_ID,
    importedFromEtpId: null,
    importedFromEtpVersionId: null,
    importedAt: null,
    importedById: null,
    documentVersion: 1,
    createdAt: AT,
    updatedAt: AT,
    version: 1,
    draftRevision: 3,
    draftContent: {
      sections: {
        OBJECT: emptySection(1),
        DELIVERY: emptySection(1),
        ESTIMATED_VALUE: emptySection(1),
      },
    },
    completeness: {
      required: 3,
      satisfied: 0,
      percent: 0,
      sections: [
        { key: 'OBJECT', complete: false },
        { key: 'DELIVERY', complete: false },
        { key: 'ESTIMATED_VALUE', complete: false },
      ],
    },
    priceResearch: research(),
    completedPriceResearch: research(),
    etpChangedSinceImport: false,
    ...extra,
  };
}

const saved = (sectionKey: string, revision: number, state = 'FILLED') =>
  jsonResponse(
    {
      data: {
        sectionKey,
        state,
        revision,
        updatedAt: new Date().toISOString(),
        updatedBy: { id: ANA, name: 'Ana Souza' },
        draftRevision: 4,
      },
    },
    { headers: { ETag: `"s${String(revision)}"` } },
  );

interface ApiOptions {
  readonly term?: TermDetailDto;
  readonly meta?: TermDetailMeta;
  readonly putSection?: (call: number, init?: RequestInit) => Response | Promise<Response>;
  readonly patch?: (call: number, init?: RequestInit) => Response | undefined;
}

function mockApi(options: ApiOptions = {}) {
  const base = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
  let current = options.term ?? termDto();
  let sectionCalls = 0;
  let patchCalls = 0;
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === `/api/v1/terms/${TERM_ID}`) {
      return Promise.resolve(
        jsonResponse(
          { data: current, meta: options.meta ?? META },
          { headers: { ETag: `"${String(current.version)}"` } },
        ),
      );
    }
    if (method === 'PATCH' && url === `/api/v1/terms/${TERM_ID}`) {
      patchCalls += 1;
      const custom = options.patch?.(patchCalls, init);
      if (custom !== undefined) return Promise.resolve(custom);
      const body = bodyOf(init) as Partial<TermDetailDto> & { priceResearchId?: string };
      current = {
        ...current,
        ...(body.objectDefinition === undefined ? {} : { objectDefinition: body.objectDefinition }),
        ...(body.estimatedTotalValue === undefined
          ? {}
          : { estimatedTotalValue: body.estimatedTotalValue }),
        ...(body.estimatedValueSource === undefined
          ? {}
          : { estimatedValueSource: body.estimatedValueSource }),
        version: current.version + 1,
      };
      return Promise.resolve(
        jsonResponse(
          { data: current, meta: { allowedActions: ['UPDATE'] } },
          { headers: { ETag: `"${String(current.version)}"` } },
        ),
      );
    }
    if (method === 'PUT' && url.startsWith(`/api/v1/documents/${TERM_ID}/sections/`)) {
      sectionCalls += 1;
      const key = url.split('/').at(-1) ?? '';
      const body = bodyOf(init) as { notApplicable?: boolean };
      return Promise.resolve(
        options.putSection?.(sectionCalls, init) ??
          saved(key, 1 + sectionCalls, body.notApplicable === true ? 'NOT_APPLICABLE' : 'FILLED'),
      );
    }
    return base(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

type FetchMock = ReturnType<typeof mockApi>;
const sectionPuts = (fetchMock: FetchMock) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => init?.method === 'PUT' && requestUrl(input).includes('/sections/'),
  );
const patches = (fetchMock: FetchMock) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => init?.method === 'PATCH' && requestUrl(input) === `/api/v1/terms/${TERM_ID}`,
  );
const headerOf = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers).get(name);
/** A navegação lateral de telas largas (a do menu "Seções" só existe aberta). */
function desktopNav(): HTMLElement {
  const nav = screen.getAllByRole('navigation', { name: 'Seções do TR' }).at(-1);
  if (nav === undefined) throw new Error('navegação ausente');
  return nav;
}
const navButton = (name: RegExp) => within(desktopNav()).getByRole('button', { name });
const completeness = () => screen.getByTestId('term-completeness').textContent;

beforeEach(async () => {
  await editorDraftStore().clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SCR-012 — editar seções do TR (US-036)', () => {
  it('[Sucesso] navegação lateral: ordem, estado, obrigatoriedade, aria-current e completude inicial', async () => {
    mockApi();
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    expect(await screen.findByRole('heading', { name: 'Termo de Referência' })).toBeTruthy();
    expect(completeness()).toBe('0% — 0 de 3 seções exigidas');
    expect(screen.getByRole('progressbar', { name: 'Completude do TR' })).toBeTruthy();
    const first = navButton(/^1\. Definição do objeto, Obrigatória, Vazia$/);
    expect(first.getAttribute('aria-current')).toBe('true');
    const second = navButton(/^2\. Local e condições.*, Obrigatória ou justificada, Vazia$/);
    expect(second.getAttribute('aria-current')).toBeNull();
    // orientação e base legal da seção ativa
    expect(screen.getByText(/Base legal: Lei 14\.133\/2021, art\. 6º, XXIII, a/)).toBeTruthy();
    expect(screen.getByText('Orientação para o preenchimento')).toBeTruthy();
    expect(
      screen.getByText('Descreva a natureza, os quantitativos e o prazo do contrato.'),
    ).toBeTruthy();
    expect(screen.queryByText('Em aprovação')).toBeNull();
  });

  it('[Sucesso] autosave 1,5 s após a pausa com If-Match "s1": "Salvo às HH:mm", ícone e completude aumentam', async () => {
    const fetchMock = mockApi();
    const user = userEvent.setup();
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    const field = await screen.findByLabelText('Texto da seção Definição do objeto');
    await user.type(field, 'Contratação de manutenção predial.');
    expect(screen.getByText('Alterações não salvas')).toBeTruthy();
    expect(sectionPuts(fetchMock)).toHaveLength(0);
    await waitFor(() => {
      expect(sectionPuts(fetchMock)).toHaveLength(1);
    });
    const [input, init] = sectionPuts(fetchMock)[0] ?? [];
    expect(requestUrl(input as RequestInfo)).toBe(`/api/v1/documents/${TERM_ID}/sections/OBJECT`);
    expect(headerOf(init, 'If-Match')).toBe('"s1"');
    expect(bodyOf(init)).toEqual({
      content: doc('Contratação de manutenção predial.'),
      notApplicable: false,
      justification: null,
    });
    expect(await screen.findByText(/^Salvo às \d{2}:\d{2}$/)).toBeTruthy();
    await waitFor(() => {
      expect(completeness()).toBe('33% — 1 de 3 seções exigidas');
    });
    expect(navButton(/Definição do objeto, Obrigatória, Preenchida/)).toBeTruthy();
    expect(await editorDraftStore().loadAll(SCOPE)).toEqual({});
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Validação] seção REQUIRED: o "Não se aplica" não aparece; em REQUIRED_OR_JUSTIFY aparece', async () => {
    mockApi();
    const user = userEvent.setup();
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    await screen.findByLabelText('Texto da seção Definição do objeto');
    expect(screen.queryByRole('button', { name: 'Não se aplica' })).toBeNull();
    await user.click(navButton(/^2\. Local e condições/));
    expect(await screen.findByRole('button', { name: 'Não se aplica' })).toBeTruthy();
    await user.click(navButton(/^3\. Estimativa/));
    expect(await screen.findByLabelText(/^Texto complementar da seção Estimativa/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Não se aplica' })).toBeNull();
  });

  it('[Validação] justificativa curta: "Justifique com pelo menos 20 caracteres." e a seção não é salva', async () => {
    const fetchMock = mockApi();
    const user = userEvent.setup();
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    await user.click(await screen.findByRole('button', { name: /^2\. Local e condições/ }));
    await user.click(screen.getByRole('button', { name: 'Não se aplica' }));
    const justification = screen.getByLabelText('Justificativa *');
    await user.type(justification, 'Serviço remoto');
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Justifique com pelo menos 20 caracteres.',
    );
    expect(document.activeElement).toBe(justification);
    expect(sectionPuts(fetchMock)).toHaveLength(0);
    expect(navButton(/Local e condições.*, Vazia/)).toBeTruthy();
  });

  it('[Sucesso] "Não se aplica" justificado grava NOT_APPLICABLE e a completude considera a seção; "Voltar a preencher" descarta-a', async () => {
    const fetchMock = mockApi();
    const user = userEvent.setup();
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    await user.click(await screen.findByRole('button', { name: /^2\. Local e condições/ }));
    await user.click(screen.getByRole('button', { name: 'Não se aplica' }));
    await user.type(screen.getByLabelText('Justificativa *'), JUSTIFICATION_30);
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => {
      expect(sectionPuts(fetchMock)).toHaveLength(1);
    });
    const [, init] = sectionPuts(fetchMock)[0] ?? [];
    expect(headerOf(init, 'If-Match')).toBe('"s1"');
    expect(bodyOf(init)).toEqual({
      content: null,
      notApplicable: true,
      justification: JUSTIFICATION_30,
    });
    expect(await screen.findByText('Esta seção não se aplica')).toBeTruthy();
    await waitFor(() => {
      expect(completeness()).toBe('33% — 1 de 3 seções exigidas');
    });
    expect(navButton(/Local e condições.*, Não se aplica/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Voltar a preencher' }));
    await waitFor(() => {
      expect(sectionPuts(fetchMock)).toHaveLength(2);
    });
    expect(bodyOf(sectionPuts(fetchMock)[1]?.[1])).toEqual({
      content: null,
      notApplicable: false,
      justification: null,
    });
    await waitFor(() => {
      expect(completeness()).toBe('0% — 0 de 3 seções exigidas');
    });
  });

  it('seção anterior e próxima navegam entre as seções', async () => {
    mockApi();
    const user = userEvent.setup();
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    await screen.findByLabelText('Texto da seção Definição do objeto');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Seção anterior' }).disabled).toBe(
      true,
    );
    await user.click(screen.getByRole('button', { name: 'Próxima seção' }));
    expect(
      await screen.findByLabelText('Texto da seção Local e condições de entrega ou de execução'),
    ).toBeTruthy();
    expect(navButton(/^2\. Local e condições/).getAttribute('aria-current')).toBe('true');
  });
});

describe('SCR-012 — painel "Dados do TR" (TRM-04)', () => {
  it('[Sucesso] valor vinculado à pesquisa: total, origem "Pesquisa de preços PP 0002/2026" e o link', async () => {
    mockApi();
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    expect(await screen.findByTestId('term-estimated-value')).toBeTruthy();
    expect(screen.getByTestId('term-estimated-value').textContent).toMatch(/R\$\s*98\.000,00/);
    expect(screen.getByText(/Pesquisa de preços PP 0002\/2026/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Abrir a pesquisa de preços' }).getAttribute('href'),
    ).toBe(`/processos/${PROCESS_ID}/pesquisa-precos/${RESEARCH_ID}`);
  });

  it('[Permissão] valor mascarado: "Valor sigiloso" no painel e na seção ESTIMATED_VALUE, sem número', async () => {
    mockApi({
      term: termDto({
        estimatedTotalValue: null,
        estimatedTotalValueMasked: true,
        priceResearch: research({ totalEstimatedValue: null }),
        completedPriceResearch: research({ totalEstimatedValue: null }),
      }),
    });
    const user = userEvent.setup();
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    await screen.findByTestId('term-estimated-value');
    expect(screen.getByTestId('term-estimated-value').textContent).toBe('Valor sigiloso');
    expect(screen.queryByText(/R\$/)).toBeNull();
    await user.click(navButton(/^3\. Estimativa/));
    expect(screen.getAllByText('Valor sigiloso')).toHaveLength(2);
  });

  it('FA-04: "Informar manualmente" com pesquisa concluída mostra o aviso; confirmar envia MANUAL com If-Match "1"', async () => {
    const fetchMock = mockApi();
    const user = userEvent.setup();
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    await user.click(await screen.findByRole('button', { name: 'Informar manualmente' }));
    expect(
      screen.getByText(
        'Existe pesquisa de preços concluída (PP 0002/2026). O valor manual tem precedência menor e exige justificativa.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Usar o valor da pesquisa/ })).toBeTruthy();
    await user.type(screen.getByLabelText('Valor estimado (R$)'), '100000.00');
    await user.click(screen.getByRole('button', { name: 'Confirmar valor' }));
    await waitFor(() => {
      expect(patches(fetchMock)).toHaveLength(1);
    });
    const [, init] = patches(fetchMock)[0] ?? [];
    expect(headerOf(init, 'If-Match')).toBe('"1"');
    expect(bodyOf(init)).toEqual({
      estimatedValueSource: 'MANUAL',
      estimatedTotalValue: '100000.00',
    });
    expect(await screen.findByText('Valor estimado atualizado.')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('term-estimated-value').textContent).toMatch(/R\$\s*100\.000,00/);
    });
    expect(screen.getByText(/Informado manualmente/)).toBeTruthy();
  });

  it('FA-04: "Usar o valor da pesquisa" envia priceResearchId da pesquisa concluída', async () => {
    const fetchMock = mockApi({
      term: termDto({
        estimatedValueSource: 'MANUAL',
        estimatedTotalValue: '100000.00',
        priceResearchId: null,
        priceResearch: null,
      }),
    });
    const user = userEvent.setup();
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    await user.click(
      await screen.findByRole('button', {
        name: /^Usar o valor da pesquisa \(R\$\s*98\.000,00\)$/,
      }),
    );
    await waitFor(() => {
      expect(patches(fetchMock)).toHaveLength(1);
    });
    expect(bodyOf(patches(fetchMock)[0]?.[1])).toEqual({ priceResearchId: RESEARCH_ID });
  });

  it('sem pesquisa concluída o valor manual não mostra o aviso; valor inválido não é enviado (V-11)', async () => {
    const fetchMock = mockApi({
      term: termDto({
        estimatedValueSource: null,
        estimatedTotalValue: null,
        priceResearchId: null,
        priceResearch: null,
        completedPriceResearch: null,
      }),
    });
    const user = userEvent.setup();
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    expect(await screen.findByText(/Sem origem definida/)).toBeTruthy();
    expect(screen.getByText('Não informado')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Informar manualmente' }));
    expect(screen.queryByText(/Existe pesquisa de preços concluída/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Usar o valor da pesquisa/ })).toBeNull();
    await user.type(screen.getByLabelText('Valor estimado (R$)'), '10,555');
    await user.click(screen.getByRole('button', { name: 'Confirmar valor' }));
    expect(
      await screen.findByText('Informe um valor válido, com até 2 casas decimais.'),
    ).toBeTruthy();
    expect(patches(fetchMock)).toHaveLength(0);
  });

  it('objeto com menos de 10 caracteres não é enviado (RN-TR-14); objeto válido faz PATCH com If-Match', async () => {
    const fetchMock = mockApi();
    const user = userEvent.setup();
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    const object = await screen.findByLabelText('Objeto (resumo)');
    await user.clear(object);
    await user.type(object, 'Curto');
    await user.click(screen.getByRole('button', { name: 'Salvar objeto' }));
    expect(await screen.findByText('O objeto deve ter entre 10 e 2.000 caracteres.')).toBeTruthy();
    expect(patches(fetchMock)).toHaveLength(0);
    await user.clear(object);
    await user.type(object, 'Manutenção predial e reparos');
    await user.click(screen.getByRole('button', { name: 'Salvar objeto' }));
    await waitFor(() => {
      expect(patches(fetchMock)).toHaveLength(1);
    });
    const [, init] = patches(fetchMock)[0] ?? [];
    expect(headerOf(init, 'If-Match')).toBe('"1"');
    expect(bodyOf(init)).toEqual({ objectDefinition: 'Manutenção predial e reparos' });
    expect(await screen.findByText('Objeto salvo.')).toBeTruthy();
  });

  it('412 VERSION_CONFLICT: "Os dados do TR foram alterados por outra pessoa." e o painel é recarregado', async () => {
    const fetchMock = mockApi({
      patch: (call) => (call === 1 ? problemResponse(412, 'VERSION_CONFLICT') : undefined),
    });
    const user = userEvent.setup();
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    const object = await screen.findByLabelText('Objeto (resumo)');
    await user.clear(object);
    await user.type(object, 'Manutenção predial e reparos');
    const gets = () =>
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          (init?.method ?? 'GET') === 'GET' && requestUrl(input) === `/api/v1/terms/${TERM_ID}`,
      ).length;
    const before = gets();
    await user.click(screen.getByRole('button', { name: 'Salvar objeto' }));
    expect(
      await screen.findByText(/^Os dados do TR foram alterados por outra pessoa\./),
    ).toBeTruthy();
    await waitFor(() => {
      expect(gets()).toBeGreaterThan(before);
    });
    // a edição digitada fica para reaplicar
    expect((object as HTMLTextAreaElement).value).toBe('Manutenção predial e reparos');
  });
});

describe('SCR-012 — modo leitura e estados', () => {
  it('[FA-06] TR concluído: faixa "Documento concluído — para alterar, reabra (US-039).", sem edição', async () => {
    const fetchMock = mockApi({ term: termDto({ status: 'FINALIZED' }) });
    const user = userEvent.setup();
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    expect(
      await screen.findByText('Documento concluído — para alterar, reabra (US-039).'),
    ).toBeTruthy();
    const field = screen.getByLabelText<HTMLTextAreaElement>('Texto da seção Definição do objeto');
    expect(field.readOnly).toBe(true);
    await user.type(field, 'tentativa');
    expect(screen.queryByText('Alterações não salvas')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Informar manualmente' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Salvar objeto' })).toBeNull();
    expect(sectionPuts(fetchMock)).toHaveLength(0);
  });

  it('[FA-08] sem UPDATE: somente leitura com a mensagem de permissão e sem "Não se aplica"', async () => {
    mockApi({ meta: { ...META, allowedActions: [] } });
    const user = userEvent.setup();
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    expect(await screen.findByText('Você não pode editar este TR agora.')).toBeTruthy();
    await user.click(navButton(/^2\. Local e condições/));
    expect(screen.queryByRole('button', { name: 'Não se aplica' })).toBeNull();
    expect(
      screen.getByLabelText<HTMLTextAreaElement>(
        'Texto da seção Local e condições de entrega ou de execução',
      ).readOnly,
    ).toBe(true);
  });

  it('[DEC-018] mostra o selo "Em aprovação" quando o TR está em tramitação de aprovação', async () => {
    mockApi({ term: termDto({ inApproval: true }) });
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    expect((await screen.findByTestId('term-in-approval')).textContent).toBe('Em aprovação');
  });

  it('[Tenant incorreto] TRM-03 404: não abre o editor e oferece nova tentativa', async () => {
    const base = mockApi();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((input, init) =>
        requestUrl(input) === `/api/v1/terms/${TERM_ID}`
          ? Promise.resolve(problemResponse(404, 'NOT_FOUND'))
          : base(input, init),
      ),
    );
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    expect(await screen.findByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Seções do TR' })).toBeNull();
  });
});

describe('SCR-012 — conflito de seção (FA-03)', () => {
  const conflict = () =>
    problemResponse(412, 'SECTION_REVISION_CONFLICT', {
      extension: {
        meta: {
          current: {
            sectionKey: 'OBJECT',
            state: 'FILLED',
            revision: 5,
            content: doc('Texto do Bruno'),
            justification: null,
            updatedAt: AT,
            updatedBy: { id: BRUNO, name: 'Bruno Carvalho' },
          },
        },
      },
    });

  it('412: o diálogo oferece "Ver diferenças", "Manter a minha versão" e "Descartar a minha e recarregar"; manter reenvia com "s5" e overwrittenRevision', async () => {
    const fetchMock = mockApi({
      putSection: (call) => (call === 1 ? conflict() : saved('OBJECT', 6)),
    });
    const user = userEvent.setup();
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    await user.type(
      await screen.findByLabelText('Texto da seção Definição do objeto'),
      'Texto da Carla',
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Alguém salvou esta seção enquanto você editava');
    expect(dialog.textContent).toContain('Alterado por Bruno Carvalho às 14:31.');
    expect(within(dialog).getByRole('button', { name: 'Ver diferenças' })).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: 'Descartar a minha e recarregar' }),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Manter a minha versão' }));
    await waitFor(() => {
      expect(sectionPuts(fetchMock)).toHaveLength(2);
    });
    const [, init] = sectionPuts(fetchMock)[1] ?? [];
    expect(headerOf(init, 'If-Match')).toBe('"s5"');
    expect(bodyOf(init)).toMatchObject({ content: doc('Texto da Carla'), overwrittenRevision: 5 });
  });

  it('412: "Descartar a minha e recarregar" mostra o texto do servidor e conta a seção como preenchida', async () => {
    const fetchMock = mockApi({ putSection: () => conflict() });
    const user = userEvent.setup();
    renderWithShell(<TermEditor processId={PROCESS_ID} termId={TERM_ID} />);
    const field = await screen.findByLabelText<HTMLTextAreaElement>(
      'Texto da seção Definição do objeto',
    );
    await user.type(field, 'Texto da Carla');
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Descartar a minha e recarregar' }),
    );
    await waitFor(() => {
      expect(field.value).toBe('Texto do Bruno');
    });
    expect(sectionPuts(fetchMock)).toHaveLength(1);
    await waitFor(() => {
      expect(completeness()).toBe('33% — 1 de 3 seções exigidas');
    });
  });
});

describe('term-editor-model', () => {
  const sections = [
    section('A', 'A', 2),
    section('B', 'B', 1, { requirement: 'REQUIRED_OR_JUSTIFY' }),
    section('C', 'C', 3, { requirement: 'OPTIONAL' }),
  ];

  it('canEditTerm / termReadOnlyReason: UPDATE e DRAFT/RETURNED; senão concluído ou sem permissão', () => {
    expect(canEditTerm('DRAFT', ['UPDATE'])).toBe(true);
    expect(canEditTerm('RETURNED', ['UPDATE'])).toBe(true);
    expect(canEditTerm('IN_REVIEW', ['UPDATE'])).toBe(false);
    expect(canEditTerm('DRAFT', [])).toBe(false);
    expect(termReadOnlyReason('DRAFT', ['UPDATE'])).toBeNull();
    expect(termReadOnlyReason('DRAFT', [])).toBe('forbidden');
    for (const status of ['FINALIZED', 'APPROVED', 'IN_REVIEW', 'REJECTED'] as const) {
      expect(termReadOnlyReason(status, ['UPDATE'])).toBe('concluded');
    }
  });

  it('termNavItems: ordena pelo template, junta estado e completude (opcional = indefinida)', () => {
    const items = termNavItems(
      sections,
      { A: 'FILLED' },
      {
        required: 2,
        satisfied: 1,
        percent: 50,
        sections: [
          { key: 'B', complete: false },
          { key: 'A', complete: true },
        ],
      },
    );
    expect(items.map((item) => [item.key, item.state, item.complete])).toEqual([
      ['B', 'EMPTY', false],
      ['A', 'FILLED', true],
      ['C', 'EMPTY', undefined],
    ]);
  });

  it('localCompleteness: preenchida e "não se aplica" justificada contam; REQUIRED "não se aplica" e opcional não', () => {
    const empty = { text: '', notApplicable: false, justification: '' };
    expect(localCompleteness(sections, {}).percent).toBe(0);
    const result = localCompleteness(sections, {
      A: { text: 'Texto', notApplicable: false, justification: '' },
      B: { text: '', notApplicable: true, justification: JUSTIFICATION_30 },
      C: empty,
    });
    expect(result).toMatchObject({ required: 2, satisfied: 2, percent: 100 });
    expect(
      localCompleteness(sections, {
        A: { text: '', notApplicable: true, justification: JUSTIFICATION_30 },
        B: { text: '', notApplicable: true, justification: 'curta' },
      }),
    ).toMatchObject({ satisfied: 0, percent: 0 });
  });

  it('draftContentOf: converte o rascunho gravado em DraftContent', () => {
    const content = draftContentOf({
      A: { text: 'Olá', notApplicable: false, justification: '' },
      B: { text: '', notApplicable: true, justification: `  ${JUSTIFICATION_30} ` },
    });
    expect(content.sections.A).toMatchObject({ state: 'FILLED', content: doc('Olá') });
    expect(content.sections.B).toMatchObject({
      state: 'NOT_APPLICABLE',
      content: null,
      justification: JUSTIFICATION_30,
    });
  });

  it('objectProblem: 10 a 2.000 caracteres', () => {
    expect(objectProblem('curto')).toBe('O objeto deve ter entre 10 e 2.000 caracteres.');
    expect(objectProblem('a'.repeat(10))).toBeNull();
    expect(objectProblem('a'.repeat(2001))).not.toBeNull();
  });
});
