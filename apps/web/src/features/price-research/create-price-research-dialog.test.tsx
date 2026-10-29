// @vitest-environment jsdom
import { localDateOf } from '@contrataflow/types';
import { Toaster, clearToasts, formatDisplayDate, fromIsoDate } from '@contrataflow/ui';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import {
  PRICE_TYPE,
  RESEARCH_ID,
  priceResearchDto,
  priceResearchMeta,
  processItem,
  stubWithRoutes,
} from '@test/support/price-research-fixtures';
import type { Route } from '@test/support/price-research-fixtures';
import {
  ID,
  PROCESS_ID,
  callsTo,
  catalogItem,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell } from '@test/support/render';

import {
  CreatePriceResearchButton,
  CreatePriceResearchDialog,
} from './create-price-research-dialog';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/processos/${PROCESS_ID}`,
  useSearchParams: () => new URLSearchParams(),
}));

const POST = `/api/v1/processes/${PROCESS_ID}/price-research`;
const TODAY = localDateOf(new Date(), 'America/Sao_Paulo');
const TOMORROW = localDateOf(new Date(Date.now() + 36 * 3_600_000), 'America/Sao_Paulo');

/** Unidade inteira (UN): 1,5 não é aceito. */
const UNIDADE_INTEIRA = catalogItem(231, 'UNIT_OF_MEASURE', 'UN', 'Unidade', {
  metadata: { allowsDecimal: false },
});

const PROCESS_ITEMS = [
  processItem(1, '10.0000'),
  processItem(2, null, { description: 'Item sem quantidade' }),
  processItem(3, '3.0000'),
];

const itemsRoute =
  (items = PROCESS_ITEMS): Route =>
  (url, init) =>
    url === `/api/v1/processes/${PROCESS_ID}/items` && (init?.method ?? 'GET') === 'GET'
      ? jsonResponse({ data: items }, { headers: { ETag: '"4"' } })
      : undefined;

const created =
  (extra: Partial<ReturnType<typeof priceResearchDto>> = {}): Route =>
  (url, init) =>
    url === POST && init?.method === 'POST'
      ? jsonResponse(
          { data: priceResearchDto(extra), meta: priceResearchMeta() },
          {
            status: 201,
            headers: { Location: `/api/v1/price-research/${RESEARCH_ID}`, ETag: '"1"' },
          },
        )
      : undefined;

const failing =
  (response: () => Response): Route =>
  (url, init) =>
    url === POST && init?.method === 'POST' ? response() : undefined;

function setup(...routes: Route[]) {
  const api = mockProcessApi({
    permissions: ['PROCESS_VIEW'],
    catalogs: { UNIT_OF_MEASURE: [UNIDADE_INTEIRA] },
  });
  const fetchMock = stubWithRoutes(api, ...routes, itemsRoute());
  const onOpenChange = vi.fn();
  const view = renderWithShell(
    <>
      <Toaster />
      <CreatePriceResearchDialog processId={PROCESS_ID} open onOpenChange={onOpenChange} />
    </>,
  );
  return { fetchMock, onOpenChange, ...view };
}

const quantityField = (n: number) =>
  screen.findByLabelText<HTMLInputElement>(`Quantidade do item ${String(n)}`);
const submitButton = () => screen.getByRole('button', { name: 'Criar pesquisa' });

beforeEach(() => {
  push.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('CreatePriceResearchDialog (US-024 · fluxo principal 2–7)', () => {
  it('lista os itens do processo todos marcados, com a quantidade de referência e o título sugerido', async () => {
    setup();
    const table = await screen.findByRole('table', {
      name: 'Itens do processo que farão parte da pesquisa de preços',
    });
    for (const n of [1, 2, 3]) {
      const checkbox = within(table).getByRole('checkbox', {
        name: `Incluir o item ${String(n)} na pesquisa`,
      });
      expect(checkbox.getAttribute('aria-checked')).toBe('true');
    }
    expect((await quantityField(1)).value).toBe('10');
    expect((await quantityField(3)).value).toBe('3');
    expect(screen.getByLabelText<HTMLInputElement>(/Título/).value).toBe(
      'Pesquisa de preços — 0012/2026',
    );
    expect(screen.getByRole('button', { name: /Data-base/ }).textContent).toContain(
      formatDisplayDate(fromIsoDate(TODAY) ?? new Date()),
    );
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('FA-03: item sem quantidade de referência destaca "Informe a quantidade" e bloqueia o envio até preencher', async () => {
    const user = userEvent.setup();
    setup();
    await quantityField(2);
    expect(await screen.findByText('Informe a quantidade')).toBeTruthy();
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
    await user.type(await quantityField(2), '7');
    await waitFor(() => {
      expect((submitButton() as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByText('Informe a quantidade')).toBeNull();
  });

  it('V-04: quantidade fracionária em unidade inteira e zero são recusadas na linha', async () => {
    const user = userEvent.setup();
    setup();
    const field = await quantityField(1);
    await user.clear(field);
    await user.type(field, '1,5');
    expect(await screen.findByText('Esta unidade aceita apenas números inteiros.')).toBeTruthy();
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
    await user.clear(field);
    await user.type(field, '0');
    expect(
      await screen.findByText('Informe uma quantidade maior que zero (até 4 casas decimais).'),
    ).toBeTruthy();
  });

  it('V-05: dias depois de hoje ficam desabilitados no calendário da data-base', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('button', { name: /Data-base/ }));
    const calendar = await screen.findByRole('dialog', { name: /^Escolher/ });
    const cells = within(calendar)
      .getAllByRole('gridcell')
      .filter((cell) => !cell.hasAttribute('data-outside'));
    const today = Number(TODAY.slice(8));
    const todayCell = cells.find((cell) => cell.textContent === String(today));
    expect(todayCell?.querySelector('button')?.disabled).toBe(false);
    if (TOMORROW.slice(0, 7) === TODAY.slice(0, 7)) {
      const tomorrowCell = cells.find((cell) => cell.textContent === String(today + 1));
      expect(tomorrowCell?.querySelector('button')?.disabled).toBe(true);
    }
  });

  it('V-06: título curto bloqueia o envio; sem nenhum item marcado também', async () => {
    const user = userEvent.setup();
    setup();
    const title = await screen.findByLabelText(/Título/);
    await user.clear(title);
    await user.type(title, 'Abc');
    expect(await screen.findByText('O título deve ter entre 5 e 250 caracteres.')).toBeTruthy();
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
    await user.clear(title);
    await user.type(title, 'Pesquisa do cimento');
    await user.click(screen.getByRole('checkbox', { name: 'Selecionar todos os itens' }));
    expect(await screen.findByText('0 de 3 itens selecionados')).toBeTruthy();
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('cria pelo PRS-02 com Idempotency-Key, sem os itens desmarcados, e leva à SCR-009', async () => {
    const user = userEvent.setup();
    const { fetchMock, onOpenChange } = setup(created());
    await user.click(await screen.findByRole('checkbox', { name: 'Incluir o item 3 na pesquisa' }));
    await user.type(await quantityField(2), '7');
    await waitFor(() => {
      expect((submitButton() as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(submitButton());
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}/pesquisa-precos/${RESEARCH_ID}`);
    });
    const [call] = callsTo(fetchMock, 'POST', POST);
    expect(call?.body).toEqual({
      title: 'Pesquisa de preços — 0012/2026',
      referenceDate: TODAY,
      items: [
        { processItemId: ID(901), quantity: '10' },
        { processItemId: ID(902), quantity: '7' },
      ],
    });
    expect(call?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText('Pesquisa de preços PP 0001/2026 criada')).toBeTruthy();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('FA-02: processo sem itens mostra a orientação e o link "Ir para Itens"', async () => {
    setup(itemsRoute([]));
    expect(
      await screen.findByText('Cadastre os itens da contratação antes de criar a pesquisa.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ir para Itens' }).getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}?aba=itens`,
    );
    expect(screen.queryByRole('button', { name: 'Criar pesquisa' })).toBeNull();
  });

  it('FA-01: 409 DOCUMENT_ALREADY_EXISTS oferece "Abrir pesquisa existente"', async () => {
    const user = userEvent.setup();
    setup(
      failing(() =>
        problemResponse(409, 'DOCUMENT_ALREADY_EXISTS', {
          extension: { meta: { existingId: RESEARCH_ID } },
        }),
      ),
      itemsRoute([processItem(1, '10.0000')]),
    );
    await user.click(await screen.findByRole('button', { name: 'Criar pesquisa' }));
    expect(await screen.findByText('Este processo já tem uma pesquisa de preços.')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Abrir pesquisa existente' }).getAttribute('href'),
    ).toBe(`/processos/${PROCESS_ID}/pesquisa-precos/${RESEARCH_ID}`);
  });

  it('422 VALIDATION_ERROR marca a linha de items[i].quantity e mantém o botão bloqueado até corrigir', async () => {
    const user = userEvent.setup();
    setup(
      failing(() =>
        problemResponse(422, 'VALIDATION_ERROR', {
          errors: [
            {
              field: 'items[1].quantity',
              code: 'OUT_OF_RANGE',
              message: 'Quantidade recusada pelo servidor.',
            },
          ],
        }),
      ),
    );
    await user.type(await quantityField(2), '7');
    await user.click(submitButton());
    expect(await screen.findByText('Revise os campos destacados.')).toBeTruthy();
    const field = await quantityField(2);
    expect(await screen.findByText('Quantidade recusada pelo servidor.')).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
    await user.type(field, '1');
    await waitFor(() => {
      expect((submitButton() as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('422 BUSINESS_RULE_VIOLATION PRICE_ITEMS_REQUIRED troca o formulário pela orientação', async () => {
    const user = userEvent.setup();
    setup(
      failing(
        () =>
          new Response(
            JSON.stringify({
              type: 'https://docs.contrataflow.com.br/errors/business-rule-violation',
              title: 'BUSINESS_RULE_VIOLATION',
              status: 422,
              detail: 'x',
              instance: POST,
              code: 'BUSINESS_RULE_VIOLATION',
              correlationId: 'c-1',
              errors: [],
              violations: [
                {
                  code: 'PRICE_ITEMS_REQUIRED',
                  severity: 'BLOCKING',
                  message: 'x',
                  ruleId: null,
                  sectionKey: null,
                  field: null,
                  itemId: null,
                  params: {},
                },
              ],
            }),
            { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
          ),
      ),
      itemsRoute([processItem(1, '10.0000')]),
    );
    await user.click(await screen.findByRole('button', { name: 'Criar pesquisa' }));
    expect(
      await screen.findByText('Cadastre os itens da contratação antes de criar a pesquisa.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ir para Itens' })).toBeTruthy();
  });

  it('503 mantém o diálogo e mostra o correlationId', async () => {
    const user = userEvent.setup();
    setup(
      failing(() => problemResponse(503, 'DEPENDENCY_UNAVAILABLE', { correlationId: 'c-503' })),
      itemsRoute([processItem(1, '10.0000')]),
    );
    await user.click(await screen.findByRole('button', { name: 'Criar pesquisa' }));
    expect(
      await screen.findByText(
        'Não foi possível criar a pesquisa agora. Tente novamente. Código: c-503',
      ),
    ).toBeTruthy();
    expect(submitButton()).toBeTruthy();
  });
});

describe('CreatePriceResearchButton (DOC-01 + PRS-01)', () => {
  const documentTypes = () =>
    jsonResponse({
      data: [
        {
          id: PRICE_TYPE,
          code: 'PRICE_RESEARCH',
          name: 'Pesquisa de preços',
          kind: 'STRUCTURED',
          systemModule: 'PRICE_RESEARCH',
          isActive: true,
          allowMultiplePerProcess: false,
          sortOrder: 4,
        },
      ],
    });
  const panel = (creatable: boolean) => () =>
    jsonResponse({
      data: [],
      meta: {
        currentStage: null,
        creatableTypeIds: creatable ? [PRICE_TYPE] : [],
        pendingTypeIds: [PRICE_TYPE],
      },
    });
  const summaries: Route = (url) =>
    url === POST
      ? jsonResponse({
          data: [
            {
              id: RESEARCH_ID,
              documentId: RESEARCH_ID,
              code: 'PP 0001/2026',
              title: 'Pesquisa',
              status: 'DRAFT',
              referenceDate: '2026-10-16',
              itemsCount: 3,
              itemsWithAlertsCount: 3,
              version: 1,
            },
          ],
        })
      : undefined;
  const none: Route = (url) => (url === POST ? jsonResponse({ data: [] }) : undefined);

  it('sem permissão (DOC-01 sem o tipo) o botão não aparece', async () => {
    const api = mockProcessApi({ documentTypes, documents: panel(false) });
    const fetchMock = stubWithRoutes(api, none);
    renderWithShell(<CreatePriceResearchButton processId={PROCESS_ID} />);
    await waitFor(() => {
      expect(callsTo(fetchMock, 'GET', POST)).toHaveLength(1);
    });
    expect(screen.queryByRole('button', { name: 'Criar pesquisa de preços' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Abrir pesquisa/ })).toBeNull();
  });

  it('com o tipo liberado mostra "Criar pesquisa de preços" e abre o diálogo', async () => {
    const user = userEvent.setup();
    const api = mockProcessApi({ documentTypes, documents: panel(true) });
    stubWithRoutes(api, none, itemsRoute());
    renderWithShell(<CreatePriceResearchButton processId={PROCESS_ID} />);
    await user.click(await screen.findByRole('button', { name: 'Criar pesquisa de preços' }));
    expect(await screen.findByRole('dialog', { name: 'Criar pesquisa de preços' })).toBeTruthy();
  });

  it('FA-01: com pesquisa ativa vira o link "Abrir pesquisa {código}"', async () => {
    const api = mockProcessApi({ documentTypes, documents: panel(false) });
    stubWithRoutes(api, summaries);
    renderWithShell(<CreatePriceResearchButton processId={PROCESS_ID} />);
    const link = await screen.findByRole('link', { name: 'Abrir pesquisa PP 0001/2026' });
    expect(link.getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}/pesquisa-precos/${RESEARCH_ID}`,
    );
    expect(screen.queryByRole('button', { name: 'Criar pesquisa de preços' })).toBeNull();
  });
});
