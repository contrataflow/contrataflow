// @vitest-environment jsdom
import type {
  DocumentItemDto,
  EtpDetailDto,
  EtpDetailMeta,
  PriceResearchSummaryDto,
} from '@contrataflow/validation';
import { cleanup, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { seriousA11yViolations } from '@test/support/axe';
import {
  ID,
  PROCESS_ID,
  bodyOf,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import {
  estimateConflictRows,
  estimateDraftsOf,
  estimateFieldErrorsOf,
  estimateItemsBody,
  estimateProblemOf,
  estimateRowProblems,
  estimatesDirty,
  estimateValueBody,
  estimateValueFormOf,
  estimateValueStatus,
  memoFits,
  quantityDecimal,
  quantityText,
} from './etp-estimates-model';
import { EtpEstimatesSection } from './etp-estimates-section';

configure({ asyncUtilTimeout: 8_000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-022 — seção "Estimativas" da SCR-008 com a API simulada: quantidade e memória de cálculo por
 * item (DOC-06/07 com `If-Match` da versão do documento, "Salvo às HH:mm"), V-01 na tela, 412 com
 * "Ver diferenças"/"Recarregar" (Concorrência), 503 mantendo o digitado (Falha de banco), o painel
 * "Valor estimado" (ETP-04: vincular à pesquisa — somente leitura com "Ver pesquisa de preços" —,
 * valor manual, V-04), FA-03/04/05, modo somente leitura (Permissão) e axe.
 */

const ETP_ID = ID(900);
const RESEARCH_ID = ID(930);
const AT = '2026-10-19T17:31:00.000Z';
const MEMO = 'Consumo médio mensal (50) × 10 meses de obra';

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function item(n: number, quantity: string, extra: Partial<DocumentItemDto> = {}): DocumentItemDto {
  return {
    processItemId: ID(950 + n),
    sequence: n,
    description: n === 1 ? 'Cimento CP-II (saco 50kg)' : 'Areia média (m³)',
    unit: { id: ID(960 + n), label: n === 1 ? 'Saco' : 'm³', allowsDecimal: n !== 1 },
    quantity,
    notes: null,
    sortOrder: n - 1,
    calculationMemo: null,
    specification: null,
    acceptanceCriteria: null,
    ...extra,
  };
}

function etpDto(extra: Partial<EtpDetailDto> = {}): EtpDetailDto {
  return {
    id: ETP_ID,
    documentId: ETP_ID,
    processId: PROCESS_ID,
    code: 'ETP 0007/2026',
    title: 'Estudo Técnico Preliminar — 0012/2026',
    status: 'DRAFT',
    conclusion: 'PENDING',
    importedFromDfdVersionId: null,
    responsibleId: null,
    templateVersionId: ID(901),
    documentVersion: 3,
    itemsCount: 2,
    createdAt: AT,
    updatedAt: AT,
    version: 1,
    recommendedAlternativeId: null,
    parcelingDecision: null,
    estimatedValueSource: null,
    estimatedTotalValue: null,
    estimatedTotalValueMasked: false,
    priceResearchId: null,
    draftRevision: 0,
    draftContent: { sections: {} },
    ...extra,
  };
}

const META: EtpDetailMeta = { allowedActions: ['UPDATE'], template: null };

const research: PriceResearchSummaryDto = {
  id: RESEARCH_ID,
  documentId: RESEARCH_ID,
  code: 'PP 0003/2026',
  title: 'Pesquisa de preços',
  status: 'FINALIZED',
  referenceDate: '2026-10-01',
  itemsCount: 2,
  itemsWithAlertsCount: 0,
  version: 2,
};

interface ApiState {
  items: DocumentItemDto[];
  documentVersion: number;
  etp: EtpDetailDto;
  putItems?: (init?: RequestInit) => Response | undefined;
  patchEtp?: (init?: RequestInit) => Response | undefined;
}

function mockApi(initial: Partial<ApiState> = {}) {
  const state: ApiState = {
    items: initial.items ?? [item(1, '400.0000'), item(2, '12.5000')],
    documentVersion: initial.documentVersion ?? 3,
    etp: initial.etp ?? etpDto(),
    ...(initial.putItems ? { putItems: initial.putItems } : {}),
    ...(initial.patchEtp ? { patchEtp: initial.patchEtp } : {}),
  };
  const base = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url === `/api/v1/documents/${ETP_ID}/items`) {
      if (method === 'PUT') {
        const custom = state.putItems?.(init);
        if (custom) return Promise.resolve(custom);
        const body = bodyOf(init) as {
          items: { processItemId: string; quantity: string; calculationMemo?: unknown }[];
        };
        state.items = state.items.map((row) => {
          const line = body.items.find(
            (candidate) => candidate.processItemId === row.processItemId,
          );
          if (line === undefined) return row;
          const [whole = '0', fraction = ''] = line.quantity.split('.');
          return {
            ...row,
            quantity: `${whole}.${fraction.padEnd(4, '0')}`,
            calculationMemo:
              line.calculationMemo === undefined
                ? row.calculationMemo
                : (line.calculationMemo as DocumentItemDto['calculationMemo']),
          };
        });
        state.documentVersion += 1;
      }
      return Promise.resolve(
        jsonResponse(
          { data: state.items },
          { headers: { ETag: `"${String(state.documentVersion)}"` } },
        ),
      );
    }
    if (url === `/api/v1/etps/${ETP_ID}`) {
      if (method === 'PATCH') {
        const custom = state.patchEtp?.(init);
        if (custom) return Promise.resolve(custom);
        const body = bodyOf(init) as Partial<EtpDetailDto>;
        state.etp = {
          ...state.etp,
          ...(body.estimatedValueSource === 'PRICE_RESEARCH'
            ? {
                estimatedValueSource: 'PRICE_RESEARCH',
                priceResearchId: body.priceResearchId ?? null,
                estimatedTotalValue: '125000.00',
              }
            : {
                estimatedValueSource: 'MANUAL',
                priceResearchId: null,
                estimatedTotalValue: body.estimatedTotalValue ?? null,
              }),
          version: state.etp.version + 1,
        };
      }
      return Promise.resolve(jsonResponse({ data: state.etp, meta: META }));
    }
    if (method === 'GET' && url === `/api/v1/processes/${PROCESS_ID}/price-research`) {
      return Promise.resolve(jsonResponse({ data: [research] }));
    }
    return base(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, state };
}

const callsOf = (fetchMock: ReturnType<typeof mockApi>['fetchMock'], method: string, url: string) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => requestUrl(input) === url && (init?.method ?? 'GET') === method,
  );

/** A linha `index` da lista de itens. */
function rowOf(list: HTMLElement, index: number): HTMLElement {
  const row = within(list).getAllByRole('listitem')[index];
  if (row === undefined) throw new Error(`linha ${String(index)} ausente`);
  return row;
}

function renderSection(editable = true) {
  return renderWithShell(
    <EtpEstimatesSection
      processId={PROCESS_ID}
      documentId={ETP_ID}
      editable={editable}
      readOnlyItems={<p>Quadro somente leitura</p>}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Seção "Estimativas" do ETP (US-022 · SCR-008)', () => {
  it('[Sucesso] informar quantidade e memória de cálculo: PUT com If-Match, memória em rich text e "Salvo às"', async () => {
    const { fetchMock } = mockApi();
    const user = userEvent.setup();
    renderSection();
    const list = await screen.findByRole('list', { name: 'Itens do ETP' });
    const quantity = within(rowOf(list, 0)).getByLabelText<HTMLInputElement>('Quantidade');
    expect(quantity.value).toBe('400');
    await user.clear(quantity);
    await user.type(quantity, '500');
    await user.type(within(rowOf(list, 0)).getByLabelText('Memória de cálculo'), MEMO);
    expect(screen.getByText('Alterações não salvas')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Salvar itens' }));
    expect(await screen.findByText(/^Salvo às \d{2}:\d{2}$/)).toBeTruthy();
    const [call] = callsOf(fetchMock, 'PUT', `/api/v1/documents/${ETP_ID}/items`);
    expect(new Headers(call?.[1]?.headers).get('If-Match')).toBe('"3"');
    expect(bodyOf(call?.[1])).toEqual({
      items: [
        {
          processItemId: ID(951),
          quantity: '500',
          sortOrder: 0,
          calculationMemo: doc(MEMO),
        },
        { processItemId: ID(952), quantity: '12,5'.replace(',', '.'), sortOrder: 1 },
      ],
    });
  });

  it('[Sucesso] vincular à pesquisa de preços concluída: valor R$ 125.000,00 somente leitura, com "Ver pesquisa de preços"', async () => {
    const { fetchMock } = mockApi();
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('radio', { name: 'Vincular à pesquisa de preços' }));
    const select = await screen.findByLabelText<HTMLSelectElement>('Pesquisa de preços');
    await waitFor(() => {
      expect(select.value).toBe(RESEARCH_ID);
    });
    await user.click(screen.getByRole('button', { name: 'Salvar valor' }));
    expect(await screen.findByText('R$ 125.000,00')).toBeTruthy();
    expect(screen.getByText('Calculado pela pesquisa de preços — somente leitura.')).toBeTruthy();
    expect(screen.getByText(/^Salvo às \d{2}:\d{2}$/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ver pesquisa de preços' }).getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}/pesquisa-precos/${RESEARCH_ID}`,
    );
    const [call] = callsOf(fetchMock, 'PATCH', `/api/v1/etps/${ETP_ID}`);
    expect(new Headers(call?.[1]?.headers).get('If-Match')).toBe('"1"');
    expect(bodyOf(call?.[1])).toEqual({
      estimatedValueSource: 'PRICE_RESEARCH',
      priceResearchId: RESEARCH_ID,
    });
  });

  it('[Sucesso] FA-02: da pesquisa para o manual, o último valor é o ponto de partida', async () => {
    const { fetchMock } = mockApi({
      etp: etpDto({
        estimatedValueSource: 'PRICE_RESEARCH',
        priceResearchId: RESEARCH_ID,
        estimatedTotalValue: '125000.00',
      }),
    });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('radio', { name: 'Valor manual' }));
    const money = screen.getByLabelText<HTMLInputElement>('Valor estimado total');
    expect(money.value).toBe('125.000,00');
    await user.clear(money);
    await user.type(money, '98000,5');
    await user.click(screen.getByRole('button', { name: 'Salvar valor' }));
    await waitFor(() => {
      expect(callsOf(fetchMock, 'PATCH', `/api/v1/etps/${ETP_ID}`)).toHaveLength(1);
    });
    expect(bodyOf(callsOf(fetchMock, 'PATCH', `/api/v1/etps/${ETP_ID}`)[0]?.[1])).toEqual({
      estimatedValueSource: 'MANUAL',
      estimatedTotalValue: '98000.50',
    });
  });

  it('[Validação] quantidade zerada: "Informe uma quantidade maior que zero." sem chamar a API', async () => {
    const { fetchMock } = mockApi();
    const user = userEvent.setup();
    renderSection();
    const list = await screen.findByRole('list', { name: 'Itens do ETP' });
    const second = rowOf(list, 1);
    const quantity = within(second).getByLabelText<HTMLInputElement>('Quantidade');
    await user.clear(quantity);
    await user.type(quantity, '0');
    await user.click(screen.getByRole('button', { name: 'Salvar itens' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Informe uma quantidade maior que zero.',
    );
    expect(quantity.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(quantity);
    expect(callsOf(fetchMock, 'PUT', `/api/v1/documents/${ETP_ID}/items`)).toHaveLength(0);
  });

  it('[Validação] valor sem origem: "Escolha como o valor estimado será definido."', async () => {
    const { fetchMock } = mockApi();
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Salvar valor' }));
    expect(await screen.findByText('Escolha como o valor estimado será definido.')).toBeTruthy();
    expect(callsOf(fetchMock, 'PATCH', `/api/v1/etps/${ETP_ID}`)).toHaveLength(0);
  });

  it('[Permissão] sem edição: quadro somente leitura, valor sem formulário; FA-05 valor sigiloso', async () => {
    mockApi({ etp: etpDto({ estimatedTotalValueMasked: true, estimatedValueSource: 'MANUAL' }) });
    renderSection(false);
    expect(await screen.findByText('Quadro somente leitura')).toBeTruthy();
    expect(await screen.findByText('Valor sigiloso')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Salvar valor' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Salvar itens' })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('[Concorrência] 412 ao salvar os itens: "Ver diferenças" mostra a versão salva e "Recarregar" adota-a', async () => {
    let server: DocumentItemDto[] = [];
    const api = mockApi({
      putItems: () => {
        server = [item(1, '450.0000'), item(2, '12.5000')];
        api.state.items = server;
        api.state.documentVersion = 4;
        return problemResponse(412, 'VERSION_CONFLICT', { extension: { currentVersion: 4 } });
      },
    });
    const user = userEvent.setup();
    renderSection();
    const list = await screen.findByRole('list', { name: 'Itens do ETP' });
    const quantity = within(rowOf(list, 0)).getByLabelText<HTMLInputElement>('Quantidade');
    await user.clear(quantity);
    await user.type(quantity, '500');
    await user.click(screen.getByRole('button', { name: 'Salvar itens' }));
    expect(await screen.findByText('Os dados foram alterados por outra pessoa.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Ver diferenças' }));
    const diff = await screen.findByRole('table', { name: 'Ver diferenças' });
    expect(within(diff).getByText('500')).toBeTruthy();
    expect(within(diff).getByText('450')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Recarregar' }));
    await waitFor(() => {
      expect(
        within(
          screen.getByRole('list', { name: 'Itens do ETP' }),
        ).getAllByLabelText<HTMLInputElement>('Quantidade')[0]?.value,
      ).toBe('450');
    });
  });

  it('[Falha de banco] 503 ao salvar: mensagem e os dados digitados ficam', async () => {
    mockApi({ putItems: () => problemResponse(503, 'DEPENDENCY_UNAVAILABLE') });
    const user = userEvent.setup();
    renderSection();
    const list = await screen.findByRole('list', { name: 'Itens do ETP' });
    const quantity = within(rowOf(list, 0)).getByLabelText<HTMLInputElement>('Quantidade');
    await user.clear(quantity);
    await user.type(quantity, '500');
    await user.click(screen.getByRole('button', { name: 'Salvar itens' }));
    expect(
      await screen.findByText('Não foi possível salvar agora. Tente novamente em instantes.'),
    ).toBeTruthy();
    expect(quantity.value).toBe('500');
  });

  it('FA-03/FA-04: "Aguardando cálculo da pesquisa de preços" e "Valor desatualizado — escolha a origem novamente"', async () => {
    mockApi({
      etp: etpDto({ estimatedValueSource: 'PRICE_RESEARCH', priceResearchId: RESEARCH_ID }),
    });
    renderSection();
    expect(await screen.findByText('Aguardando cálculo da pesquisa de preços')).toBeTruthy();
    cleanup();
    mockApi({ etp: etpDto({ estimatedTotalValue: '130000.00' }) });
    renderSection();
    expect(
      await screen.findByText('Valor desatualizado — escolha a origem novamente'),
    ).toBeTruthy();
    expect(screen.getByText('R$ 130.000,00')).toBeTruthy();
  });

  it('acessibilidade: sem violações sérias do axe na seção editável', async () => {
    mockApi();
    const { container } = renderSection();
    await screen.findByRole('list', { name: 'Itens do ETP' });
    await screen.findByRole('button', { name: 'Salvar valor' });
    expect(await seriousA11yViolations(container)).toEqual([]);
  });
});

describe('etp-estimates-model (US-022)', () => {
  const items = [item(1, '400.0000'), item(2, '12.5000', { calculationMemo: doc('memória') })];

  it('quantidade: exibição brasileira e decimal da API', () => {
    expect(quantityText('500.0000')).toBe('500');
    expect(quantityText('12.5000')).toBe('12,5');
    expect(quantityDecimal('1.234,5')).toBe('1234.5');
    expect(quantityDecimal(' 7 ')).toBe('7');
  });

  it('rascunho, alteração, V-01/V-02 e corpo do DOC-07 (memória só quando muda)', () => {
    const drafts = estimateDraftsOf(items);
    expect(drafts[ID(952)]).toEqual({ quantity: '12,5', memo: 'memória' });
    expect(estimatesDirty(items, drafts)).toBe(false);
    const changed = { ...drafts, [ID(951)]: { quantity: '1,5', memo: '' } };
    expect(estimatesDirty(items, changed)).toBe(true);
    expect(estimateRowProblems(items, changed)).toEqual({
      [ID(951)]: 'Esta unidade aceita apenas números inteiros.',
    });
    expect(
      estimateItemsBody(items, { ...drafts, [ID(952)]: { quantity: '13', memo: '' } }),
    ).toEqual([
      { processItemId: ID(951), quantity: '400', sortOrder: 0 },
      { processItemId: ID(952), quantity: '13', sortOrder: 1, calculationMemo: null },
    ]);
    expect(estimateConflictRows(items, drafts, [item(1, '450.0000')])).toEqual([
      { sequence: 1, mine: '400', server: '450' },
      { sequence: 2, mine: '12,5', server: '—' },
    ]);
  });

  it('FA-06: a memória cabe em 1 MB', () => {
    expect(memoFits('curta')).toBe(true);
    expect(memoFits('x'.repeat(1024 * 1024))).toBe(false);
  });

  it('valor estimado: V-04/V-05, corpo do ETP-04 e situação exibida', () => {
    const form = estimateValueFormOf(etpDto(), RESEARCH_ID);
    expect(form).toEqual({ source: null, money: '', priceResearchId: RESEARCH_ID });
    expect(estimateValueBody(form)).toMatchObject({ ok: false, field: 'source' });
    expect(estimateValueBody({ ...form, source: 'MANUAL' })).toMatchObject({
      ok: false,
      field: 'money',
    });
    expect(estimateValueBody({ ...form, source: 'MANUAL', money: '1,234' })).toMatchObject({
      ok: false,
      message: 'Informe um valor válido, com até 2 casas decimais.',
    });
    expect(
      estimateValueBody({ ...form, source: 'PRICE_RESEARCH', priceResearchId: '' }),
    ).toMatchObject({ ok: false, field: 'priceResearchId' });
    expect(estimateValueStatus(etpDto())).toEqual({ kind: 'undefined' });
    expect(
      estimateValueStatus(etpDto({ estimatedValueSource: 'MANUAL', estimatedTotalValue: '1.00' })),
    ).toEqual({ kind: 'manual', value: '1.00' });
  });

  it('erros da API → mensagens e campos', () => {
    expect(estimateProblemOf(new Error('x'))).toEqual({ kind: 'unexpected', correlationId: '—' });
    expect(estimateProblemOf(new ApiError({ status: 412, code: 'VERSION_CONFLICT' }))).toEqual({
      kind: 'conflict',
    });
    expect(estimateProblemOf(new ApiError({ status: 403, code: 'PERMISSION_DENIED' }))).toEqual({
      kind: 'message',
      key: 'forbidden',
    });
    expect(estimateProblemOf(new ApiError({ status: 409, code: 'DOCUMENT_NOT_EDITABLE' }))).toEqual(
      { kind: 'message', key: 'notEditable' },
    );
    expect(estimateProblemOf(new ApiError({ status: 413, code: 'PAYLOAD_TOO_LARGE' }))).toEqual({
      kind: 'message',
      key: 'memoInvalid',
    });
    expect(
      estimateProblemOf(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c1' })),
    ).toEqual({ kind: 'unexpected', correlationId: 'c1' });
    const invalid = new ApiError({
      status: 422,
      code: 'VALIDATION_ERROR',
      errors: [
        {
          field: 'items[1].quantity',
          code: 'OUT_OF_RANGE',
          message: 'Informe uma quantidade maior que zero.',
        },
      ],
    });
    expect(estimateProblemOf(invalid)).toEqual({ kind: 'message', key: 'formErrors' });
    expect(estimateFieldErrorsOf(items, invalid)).toEqual({
      [ID(952)]: 'Informe uma quantidade maior que zero.',
    });
  });
});
