// @vitest-environment jsdom
import { richTextFromPlainText } from '@contrataflow/validation';
import type { DocumentItemDto, TermDetailDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { seriousA11yViolations } from '@test/support/axe';
import { processItem, stubWithRoutes } from '@test/support/price-research-fixtures';
import type { Route } from '@test/support/price-research-fixtures';
import {
  ID,
  PROCESS_ID,
  bodyOf,
  callsTo,
  catalogItem,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { conditionsBody, conditionsFormOf } from './term-conditions-model';
import { TermConditionsPanel } from './term-conditions-panel';
import {
  includedIds,
  moveItem,
  termItemFieldErrorsOf,
  termItemProblems,
  termItemsBody,
  termItemsDirty,
  termItemsStateOf,
} from './term-items-model';
import { TermItemsPanel } from './term-items-panel';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-038 — painéis "Itens" e "Condições contratuais" da SCR-012 com a API simulada: inclusão com
 * quantidade, especificação e critérios (DOC-07 com `If-Match` do documento), reordenação por
 * teclado, V-01 no front, 412/503 e modo leitura; condições com só os campos alterados (TRM-04),
 * FA-04 (prazo sem tipo bloqueia o salvamento), V-08 (garantia > 10%), FA-05 (catálogo de critério
 * indisponível sem bloquear os demais campos), 412 com "Ver versão atual" e acessibilidade (axe).
 */

const TERM_ID = ID(800);
const URL_ITEMS = `/api/v1/documents/${TERM_ID}/items`;
const URL_TERM = `/api/v1/terms/${TERM_ID}`;
const MENOR_PRECO = catalogItem(820, 'JUDGMENT_CRITERION', 'MENOR_PRECO', 'Menor preço');
const MAIOR_DESCONTO = catalogItem(821, 'JUDGMENT_CRITERION', 'MAIOR_DESCONTO', 'Maior desconto');

const CEMENT = processItem(1, '120.0000', { description: 'Cimento CP-II' });
const SAND = processItem(2, null, { description: 'Areia média' });

afterEach(() => {
  vi.unstubAllGlobals();
});

function line(n: 1 | 2, quantity: string, extra: Partial<DocumentItemDto> = {}): DocumentItemDto {
  const item = n === 1 ? CEMENT : SAND;
  return {
    processItemId: item.id,
    sequence: item.sequence,
    description: item.description,
    unit: { id: item.unitOfMeasure.id, label: 'Unidade', allowsDecimal: true },
    quantity,
    notes: null,
    sortOrder: n - 1,
    calculationMemo: null,
    specification: null,
    acceptanceCriteria: null,
    ...extra,
  };
}

function termDto(extra: Partial<TermDetailDto> = {}): TermDetailDto {
  return {
    id: TERM_ID,
    documentId: TERM_ID,
    processId: PROCESS_ID,
    code: 'TR 0003/2026',
    title: 'Termo de Referência',
    status: 'DRAFT',
    inApproval: false,
    templateVersion: null,
    responsibleId: null,
    objectDefinition: 'Aquisição de materiais de construção',
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
    estimatedTotalValue: null,
    estimatedTotalValueMasked: false,
    estimatedValueSource: null,
    priceResearchId: null,
    importedFromEtpId: null,
    importedFromEtpVersionId: null,
    importedAt: null,
    importedById: null,
    documentVersion: 4,
    createdAt: '2026-10-20T12:00:00.000Z',
    updatedAt: '2026-10-20T12:00:00.000Z',
    version: 2,
    draftRevision: 0,
    draftContent: { sections: {} },
    completeness: { required: 0, satisfied: 0, percent: 0, sections: [] },
    priceResearch: null,
    completedPriceResearch: null,
    etpChangedSinceImport: false,
    ...extra,
  };
}

/** PRC-13 + DOC-06 + DOC-07 padrão (o PUT ecoa o corpo com a versão + 1). */
function itemsRoutes(options: { saved?: DocumentItemDto[]; put?: Route } = {}): Route {
  let current = options.saved ?? [];
  let version = 4;
  return (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === `/api/v1/processes/${PROCESS_ID}/items`) {
      return jsonResponse({ data: [CEMENT, SAND] }, { headers: { ETag: '"7"' } });
    }
    if (method === 'GET' && url === URL_ITEMS) {
      return jsonResponse({ data: current }, { headers: { ETag: `"${String(version)}"` } });
    }
    if (method === 'PUT' && url === URL_ITEMS) {
      const custom = options.put?.(url, init);
      if (custom !== undefined) return custom;
      const body = bodyOf(init) as {
        items: { processItemId: string; quantity: string; sortOrder: number }[];
      };
      current = body.items.map((item) =>
        line(item.processItemId === CEMENT.id ? 1 : 2, `${item.quantity}.0000`, {
          sortOrder: item.sortOrder,
        }),
      );
      version += 1;
      return jsonResponse({ data: current }, { headers: { ETag: `"${String(version)}"` } });
    }
    return undefined;
  };
}

function renderItems(options: { editable?: boolean; routes?: Route[] } = {}) {
  const api = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
  const fetchMock = stubWithRoutes(api, ...(options.routes ?? [itemsRoutes()]));
  const view = renderWithShell(
    <TermItemsPanel
      processId={PROCESS_ID}
      term={{ id: TERM_ID, documentId: TERM_ID }}
      editable={options.editable ?? true}
    />,
  );
  return { ...view, fetchMock };
}

const puts = (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) =>
  fetchMock.mock.calls
    .filter(([input, init]) => requestUrl(input) === URL_ITEMS && init?.method === 'PUT')
    .map(([, init]) => ({
      body: bodyOf(init) as { items: Record<string, unknown>[] },
      ifMatch: new Headers(init?.headers).get('If-Match'),
    }));

async function openPanel(name: RegExp) {
  await userEvent.click(screen.getByRole('button', { name }));
}

/** O rascunho da linha (os testes partem de linhas que existem). */
function draftIn(state: ReturnType<typeof termItemsStateOf>, id: string) {
  const draft = state.drafts[id];
  if (draft === undefined) throw new Error('linha ausente');
  return draft;
}

describe('Modelo do painel "Itens" (RN-TR-25/26)', () => {
  it('incluídas primeiro na ordem do TR; as demais pelo nº, com a quantidade de referência', () => {
    const state = termItemsStateOf([CEMENT, SAND], [line(2, '50.0000', { sortOrder: 0 })]);
    expect(state.order).toEqual([SAND.id, CEMENT.id]);
    expect(state.drafts[CEMENT.id]).toMatchObject({ included: false, quantity: '120' });
    expect(state.drafts[SAND.id]).toMatchObject({ included: true, quantity: '50' });
    expect(includedIds(state)).toEqual([SAND.id]);
  });

  it('corpo do DOC-07: só as incluídas, sortOrder pela posição e textos só quando mudam', () => {
    const saved = [line(1, '100.0000', { specification: richTextFromPlainText('Saco 50 kg') })];
    const initial = termItemsStateOf([CEMENT, SAND], saved);
    expect(termItemsBody(initial, saved)).toEqual([
      { processItemId: CEMENT.id, quantity: '100', sortOrder: 0 },
    ]);
    const edited = {
      order: moveItem(initial.order, SAND.id, -1),
      drafts: {
        ...initial.drafts,
        [CEMENT.id]: { ...draftIn(initial, CEMENT.id), specification: '' },
        [SAND.id]: {
          ...draftIn(initial, SAND.id),
          included: true,
          quantity: '2,5',
          acceptanceCriteria: 'Laudo',
          notes: ' obs ',
        },
      },
    };
    expect(termItemsDirty(edited, [CEMENT, SAND], saved)).toBe(true);
    expect(termItemsBody(edited, saved)).toEqual([
      {
        processItemId: SAND.id,
        quantity: '2.5',
        notes: 'obs',
        sortOrder: 0,
        acceptanceCriteria: richTextFromPlainText('Laudo'),
      },
      { processItemId: CEMENT.id, quantity: '100', sortOrder: 1, specification: null },
    ]);
  });

  it('V-01 no front e erros do 422 mapeados para a n-ésima incluída', () => {
    const state = termItemsStateOf([CEMENT, SAND], [line(1, '1.0000'), line(2, '1.0000')]);
    const zero = {
      ...state,
      drafts: { ...state.drafts, [SAND.id]: { ...draftIn(state, SAND.id), quantity: '0' } },
    };
    expect(termItemProblems(zero, [])).toEqual({
      [SAND.id]: 'Informe uma quantidade maior que zero.',
    });
    const error = new ApiError({
      status: 422,
      code: 'VALIDATION_ERROR',
      errors: [
        {
          field: 'items[1].processItemId',
          code: 'DUPLICATE_IN_LIST',
          message: 'Este item já está na lista.',
        },
      ],
    });
    expect(termItemFieldErrorsOf(state, error)).toEqual({
      [SAND.id]: 'Este item já está na lista.',
    });
    expect(moveItem([CEMENT.id], CEMENT.id, -1)).toEqual([CEMENT.id]);
  });
});

describe('Modelo do painel "Condições contratuais" (RN-TR-28..32)', () => {
  it('corpo só com os campos alterados; percentual em forma canônica', () => {
    const term = termDto({ contractGuaranteePercent: '5', awardType: 'GLOBAL' });
    const form = {
      ...conditionsFormOf(term),
      contractGuaranteePercent: '05,00',
      awardType: 'BY_ITEM' as const,
    };
    expect(conditionsFormOf(term).contractGuaranteePercent).toBe('5');
    expect(conditionsBody(form, term)).toEqual({ ok: true, body: { awardType: 'BY_ITEM' } });
    expect(
      conditionsBody({ ...form, contractGuaranteePercent: '2,5', deliveryLocation: '  ' }, term),
    ).toEqual({ ok: true, body: { awardType: 'BY_ITEM', contractGuaranteePercent: '2.5' } });
  });

  it('V-05..V-08: faixas e o par prazo × tipo de contagem', () => {
    const form = conditionsFormOf(termDto());
    expect(conditionsBody({ ...form, executionDeadline: '30' }, termDto())).toEqual({
      ok: false,
      errors: { executionDeadlineType: 'Informe o tipo de contagem do prazo.' },
    });
    expect(conditionsBody({ ...form, executionDeadlineType: 'BUSINESS' }, termDto())).toEqual({
      ok: false,
      errors: { executionDeadline: 'Informe o prazo de execução/entrega.' },
    });
    expect(
      conditionsBody(
        {
          ...form,
          contractDurationMonths: '121',
          paymentTermDays: '0',
          productWarrantyMonths: '1.5',
          contractGuaranteePercent: '15',
        },
        termDto(),
      ),
    ).toEqual({
      ok: false,
      errors: {
        contractDurationMonths: 'A vigência deve estar entre 1 e 120 meses.',
        paymentTermDays: 'O prazo de pagamento deve estar entre 1 e 90 dias.',
        productWarrantyMonths: 'A garantia do objeto deve estar entre 0 e 120 meses.',
        contractGuaranteePercent: 'A garantia contratual não pode superar 10% (arts. 96–98).',
      },
    });
  });
});

describe('Painel "Itens" (US-038 · SCR-012)', () => {
  it('[Sucesso] incluir os itens com quantidade e especificação envia o DOC-07 com If-Match', async () => {
    const { fetchMock } = renderItems();
    await openPanel(/^Itens/);
    const cement = await screen.findByTestId('term-item-1');
    await userEvent.click(within(cement).getByRole('checkbox'));
    expect(within(cement).getByLabelText<HTMLInputElement>('Quantidade').value).toBe('120');
    await userEvent.clear(within(cement).getByLabelText('Quantidade'));
    await userEvent.type(within(cement).getByLabelText('Quantidade'), '100');
    await userEvent.type(within(cement).getByLabelText('Especificação'), 'Saco de 50 kg');
    const sand = screen.getByTestId('term-item-2');
    await userEvent.click(within(sand).getByRole('checkbox'));
    await userEvent.type(within(sand).getByLabelText('Quantidade'), '50');
    await userEvent.click(screen.getByRole('button', { name: 'Mover o item 2 para cima' }));
    await userEvent.click(screen.getByRole('button', { name: 'Salvar itens' }));

    await waitFor(() => {
      expect(puts(fetchMock)).toHaveLength(1);
    });
    const [put] = puts(fetchMock);
    expect(put?.ifMatch).toBe('"4"');
    expect(put?.body.items).toEqual([
      { processItemId: SAND.id, quantity: '50', sortOrder: 0 },
      {
        processItemId: CEMENT.id,
        quantity: '100',
        sortOrder: 1,
        specification: richTextFromPlainText('Saco de 50 kg'),
      },
    ]);
    expect(await screen.findByText(/^Salvo às/)).toBeTruthy();
    expect(screen.getByText('2 itens no TR')).toBeTruthy();
  });

  it('[Validação] quantidade zero é barrada no front com a mensagem na linha', async () => {
    const { fetchMock } = renderItems({ routes: [itemsRoutes({ saved: [line(1, '1.0000')] })] });
    await openPanel(/^Itens/);
    const cement = await screen.findByTestId('term-item-1');
    await userEvent.clear(within(cement).getByLabelText('Quantidade'));
    await userEvent.type(within(cement).getByLabelText('Quantidade'), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar itens' }));
    expect((await within(cement).findByRole('alert')).textContent).toContain(
      'Informe uma quantidade maior que zero.',
    );
    expect(puts(fetchMock)).toHaveLength(0);
  });

  it('[Concorrência] 412 oferece recarregar; [Falha de banco] 503 mantém os dados preenchidos', async () => {
    let calls = 0;
    const conflict: Route = () => {
      calls += 1;
      return calls === 1
        ? problemResponse(412, 'VERSION_CONFLICT')
        : problemResponse(503, 'DEPENDENCY_UNAVAILABLE');
    };
    renderItems({ routes: [itemsRoutes({ saved: [line(1, '1.0000')], put: conflict })] });
    await openPanel(/^Itens/);
    const cement = await screen.findByTestId('term-item-1');
    await userEvent.clear(within(cement).getByLabelText('Quantidade'));
    await userEvent.type(within(cement).getByLabelText('Quantidade'), '9');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar itens' }));
    expect(
      await screen.findByText('O TR foi alterado por outra pessoa. Recarregue para continuar.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recarregar os itens' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Salvar itens' }));
    expect(
      await screen.findByText('Não foi possível salvar agora. Tente novamente em instantes.'),
    ).toBeTruthy();
    expect(within(cement).getByLabelText<HTMLInputElement>('Quantidade').value).toBe('9');
  });

  it('[Permissão] sem edição: somente leitura, sem "Salvar itens"', async () => {
    renderItems({ editable: false, routes: [itemsRoutes({ saved: [line(1, '1.0000')] })] });
    await openPanel(/^Itens/);
    const cement = await screen.findByTestId('term-item-1');
    expect(within(cement).getByRole<HTMLInputElement>('checkbox').disabled).toBe(true);
    expect(within(cement).getByLabelText<HTMLInputElement>('Quantidade').readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Salvar itens' })).toBeNull();
    expect(screen.getByText('Os itens do TR estão em modo leitura.')).toBeTruthy();
  });

  it('estado vazio e acessibilidade (axe) com o painel aberto', async () => {
    const empty: Route = (url) =>
      url === `/api/v1/processes/${PROCESS_ID}/items` ? jsonResponse({ data: [] }) : undefined;
    const view = renderItems({ routes: [empty, itemsRoutes()] });
    await openPanel(/^Itens/);
    expect(
      await screen.findByText(
        'Nenhum item cadastrado no processo — adicione em Itens do processo.',
      ),
    ).toBeTruthy();
    view.unmount();

    const { container } = renderItems({ routes: [itemsRoutes({ saved: [line(1, '1.0000')] })] });
    await openPanel(/^Itens/);
    await screen.findByTestId('term-item-1');
    expect(await seriousA11yViolations(container)).toEqual([]);
  });
});

describe('Painel "Condições contratuais" (US-038 · SCR-012)', () => {
  const catalogState = { down: false };
  afterEach(() => {
    catalogState.down = false;
  });

  function renderConditions(
    options: { term?: TermDetailDto; editable?: boolean; patch?: Route } = {},
  ) {
    const api = mockProcessApi({
      permissions: ['PROCESS_VIEW'],
      catalogs: {
        JUDGMENT_CRITERION: () =>
          catalogState.down
            ? problemResponse(500, 'INTERNAL_ERROR')
            : jsonResponse({ data: [MENOR_PRECO, MAIOR_DESCONTO], meta: { page: 1 } }),
      },
    });
    const term = options.term ?? termDto();
    const patchRoute: Route = (url, init) => {
      if (url !== URL_TERM || init?.method !== 'PATCH') return undefined;
      const custom = options.patch?.(url, init);
      if (custom !== undefined) return custom;
      const body = bodyOf(init) as Partial<TermDetailDto>;
      return jsonResponse(
        {
          data: { ...term, ...body, version: term.version + 1 },
          meta: { allowedActions: ['UPDATE'] },
        },
        { headers: { ETag: `"${String(term.version + 1)}"` } },
      );
    };
    const fetchMock = stubWithRoutes(api, patchRoute);
    const view = renderWithShell(
      <TermConditionsPanel term={term} editable={options.editable ?? true} />,
    );
    return { ...view, api: fetchMock };
  }

  it('[Sucesso] definir as condições envia só os campos informados com If-Match', async () => {
    const { api } = renderConditions();
    await openPanel(/^Condições contratuais/);
    await userEvent.type(screen.getByLabelText('Vigência do contrato (meses)'), '12');
    await userEvent.type(screen.getByLabelText('Prazo de execução/entrega'), '30');
    await userEvent.click(screen.getByLabelText('Dias corridos'));
    await userEvent.type(screen.getByLabelText('Prazo de pagamento (dias)'), '30');
    await userEvent.type(screen.getByLabelText('Garantia contratual (%)'), '5');
    await userEvent.selectOptions(
      await screen.findByLabelText('Critério de julgamento'),
      'Menor preço',
    );
    await userEvent.selectOptions(screen.getByLabelText('Tipo de adjudicação'), 'Por item');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar condições' }));

    await waitFor(() => {
      expect(callsTo(api, 'PATCH', URL_TERM)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'PATCH', URL_TERM);
    expect(call?.headers.get('If-Match')).toBe('"2"');
    expect(call?.body).toEqual({
      contractDurationMonths: 12,
      executionDeadline: 30,
      executionDeadlineType: 'CALENDAR',
      paymentTermDays: 30,
      contractGuaranteePercent: '5',
      selectionCriterionId: MENOR_PRECO.id,
      awardType: 'BY_ITEM',
    });
    expect(await screen.findByText(/^Salvo às/)).toBeTruthy();
  });

  it('[Validação] FA-04: prazo sem tipo de contagem bloqueia o salvamento; V-08: garantia acima de 10%', async () => {
    const { api } = renderConditions();
    await openPanel(/^Condições contratuais/);
    await userEvent.type(screen.getByLabelText('Prazo de execução/entrega'), '30');
    await userEvent.type(screen.getByLabelText('Garantia contratual (%)'), '15');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar condições' }));
    expect(await screen.findByText('Informe o tipo de contagem do prazo.')).toBeTruthy();
    expect(
      screen.getByText('A garantia contratual não pode superar 10% (arts. 96–98).'),
    ).toBeTruthy();
    expect(callsTo(api, 'PATCH', URL_TERM)).toHaveLength(0);
  });

  it('[Validação] 422 da API marca o campo devolvido', async () => {
    renderConditions({
      patch: () =>
        problemResponse(422, 'VALIDATION_ERROR', {
          errors: [
            {
              field: 'selectionCriterionId',
              code: 'REFERENCE_INACTIVE',
              message: 'Selecione um critério de julgamento válido.',
            },
          ],
        }),
    });
    await openPanel(/^Condições contratuais/);
    await userEvent.selectOptions(
      await screen.findByLabelText('Critério de julgamento'),
      'Maior desconto',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Salvar condições' }));
    expect(await screen.findByText('Selecione um critério de julgamento válido.')).toBeTruthy();
  });

  it('[Concorrência] 412 VERSION_CONFLICT oferece "Ver versão atual"', async () => {
    renderConditions({ patch: () => problemResponse(412, 'VERSION_CONFLICT') });
    await openPanel(/^Condições contratuais/);
    await userEvent.type(screen.getByLabelText('Vigência do contrato (meses)'), '6');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar condições' }));
    expect(
      await screen.findByText('O TR foi alterado por outra pessoa. Recarregue para continuar.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ver versão atual' })).toBeTruthy();
  });

  it('[Falha de integração] catálogo indisponível: mensagem com "Tentar novamente" e os demais campos salváveis', async () => {
    catalogState.down = true;
    const { api } = renderConditions();
    await openPanel(/^Condições contratuais/);
    expect(await screen.findByText('Não foi possível carregar as opções.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Prazo de pagamento (dias)'), '15');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar condições' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH', URL_TERM)).toHaveLength(1);
    });
    expect(callsTo(api, 'PATCH', URL_TERM)[0]?.body).toEqual({ paymentTermDays: 15 });
    catalogState.down = false;
    await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('option', { name: 'Menor preço' })).toBeTruthy();
  });

  it('[Permissão] sem edição: somente leitura, sem "Salvar condições"; axe sem violações sérias', async () => {
    const { container } = renderConditions({
      editable: false,
      term: termDto({ contractDurationMonths: 12, awardType: 'GLOBAL' }),
    });
    await openPanel(/^Condições contratuais/);
    expect(screen.getByLabelText<HTMLInputElement>('Vigência do contrato (meses)').readOnly).toBe(
      true,
    );
    expect(screen.getByLabelText<HTMLInputElement>('Tipo de adjudicação').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Salvar condições' })).toBeNull();
    await screen.findByRole('option', { name: 'Menor preço' });
    expect(await seriousA11yViolations(container)).toEqual([]);
  });
});
