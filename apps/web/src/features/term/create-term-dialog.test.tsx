// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { TermDto, TermListMeta, TermSummaryDto } from '@contrataflow/validation';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { chooseOption, optionLabels } from '@test/support/kit';
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

import { CreateTermButton, CreateTermDialog } from './create-term-dialog';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/processos/${PROCESS_ID}`,
  useSearchParams: () => new URLSearchParams(),
}));

/*
 * US-036 — diálogo "Criar Termo de Referência" (SCR-006): TRM-01 (modelos publicados e título
 * padrão), TRM-02 com Idempotency-Key, FA-01 (outro modelo / sem modelo), FA-02 (TR existente) e os
 * erros de etapa, custódia e status.
 */

const URL_TERMS = `/api/v1/processes/${PROCESS_ID}/terms`;
const TERM_ID = ID(819);
const TERM_TYPE = ID(808);
const DEFAULT_TITLE = 'Termo de Referência — Manutenção predial preventiva';

const TEMPLATES: TermListMeta['templates'] = [
  {
    id: ID(830),
    name: 'TR — Serviços contínuos',
    isDefault: false,
    versionId: ID(831),
    versionNumber: 2,
  },
  { id: ID(832), name: 'TR — Padrão', isDefault: true, versionId: ID(833), versionNumber: 1 },
];

function termDto(extra: Partial<TermDto> = {}): TermDto {
  return {
    id: TERM_ID,
    documentId: TERM_ID,
    processId: PROCESS_ID,
    code: 'TR 0003/2026',
    title: DEFAULT_TITLE,
    status: 'DRAFT',
    inApproval: false,
    templateVersion: { id: ID(833), versionNumber: 1 },
    responsibleId: ID(1),
    objectDefinition: 'Manutenção predial preventiva dos prédios',
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
    priceResearchId: ID(701),
    importedFromEtpId: null,
    importedFromEtpVersionId: null,
    importedAt: null,
    importedById: null,
    documentVersion: 1,
    createdAt: '2026-10-19T15:00:00.000Z',
    updatedAt: '2026-10-19T15:00:00.000Z',
    version: 1,
    ...extra,
  };
}

const list =
  (templates: TermListMeta['templates'], items: TermSummaryDto[] = []): Route =>
  (url, init) =>
    url === URL_TERMS && (init?.method ?? 'GET') === 'GET'
      ? jsonResponse({ data: items, meta: { templates, defaultTitle: DEFAULT_TITLE } })
      : undefined;

const created: Route = (url, init) =>
  url === URL_TERMS && init?.method === 'POST'
    ? jsonResponse(
        { data: termDto(), meta: { allowedActions: ['UPDATE'] } },
        { status: 201, headers: { Location: `/api/v1/terms/${TERM_ID}`, ETag: '"1"' } },
      )
    : undefined;

const failing =
  (response: () => Response): Route =>
  (url, init) =>
    url === URL_TERMS && init?.method === 'POST' ? response() : undefined;

function setup(...routes: Route[]) {
  const api = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
  const fetchMock = stubWithRoutes(api, ...routes);
  const onOpenChange = vi.fn();
  renderWithShell(
    <>
      <Toaster />
      <CreateTermDialog processId={PROCESS_ID} open onOpenChange={onOpenChange} />
    </>,
  );
  return { fetchMock, onOpenChange };
}

const submitButton = () => screen.getByRole('button', { name: 'Criar TR' });
const templateSelect = () => screen.findByRole('combobox', { name: 'Modelo' });
const titleInput = () => screen.findByRole<HTMLInputElement>('textbox', { name: /Título/ });

beforeEach(() => {
  push.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('CreateTermDialog (US-036 · fluxo principal 2–5)', () => {
  it('pré-seleciona o modelo padrão e preenche o título com "Termo de Referência — {processo}"', async () => {
    setup(list(TEMPLATES));
    const select = await templateSelect();
    expect(select.textContent).toBe('TR — Padrão (padrão)');
    expect(await optionLabels(userEvent.setup(), 'Modelo')).toEqual([
      'TR — Serviços contínuos',
      'TR — Padrão (padrão)',
    ]);
    expect((await titleInput()).value).toBe(DEFAULT_TITLE);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('cria com o modelo padrão: envia templateId e title com Idempotency-Key, avisa e navega para a SCR-012', async () => {
    const user = userEvent.setup();
    const { fetchMock, onOpenChange } = setup(list(TEMPLATES), created);
    await templateSelect();
    await user.click(submitButton());
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}/tr/${TERM_ID}`);
    });
    const [call] = callsTo(fetchMock, 'POST', URL_TERMS);
    expect(call?.body).toEqual({ templateId: ID(832), title: DEFAULT_TITLE });
    expect(call?.headers.get('Idempotency-Key')).toEqual(expect.any(String));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(await screen.findByText('TR 0003/2026 criado.')).toBeTruthy();
  });

  it('FA-01: escolher outro modelo e editar o título', async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup(list(TEMPLATES), created);
    await templateSelect();
    await chooseOption(user, 'Modelo', 'TR — Serviços contínuos');
    const title = await titleInput();
    await user.clear(title);
    await user.type(title, 'TR da manutenção das escolas');
    await user.click(submitButton());
    await waitFor(() => {
      expect(callsTo(fetchMock, 'POST', URL_TERMS)).toHaveLength(1);
    });
    expect(callsTo(fetchMock, 'POST', URL_TERMS)[0]?.body).toEqual({
      templateId: ID(830),
      title: 'TR da manutenção das escolas',
    });
  });

  it('FA-01: sem modelo publicado o envio fica desabilitado com a orientação ao administrador', async () => {
    setup(list([]));
    expect(
      await screen.findByText('Não há modelo de TR publicado. Fale com o administrador do órgão.'),
    ).toBeTruthy();
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('V-01: título curto não é enviado e mostra a mensagem do campo', async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup(list(TEMPLATES), created);
    const title = await titleInput();
    await user.clear(title);
    await user.type(title, 'TR');
    await user.click(submitButton());
    expect(await screen.findByText('O título deve ter entre 5 e 250 caracteres.')).toBeTruthy();
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(callsTo(fetchMock, 'POST', URL_TERMS)).toHaveLength(0);
  });

  it('V-02: 422 em templateId marca o campo Modelo', async () => {
    const user = userEvent.setup();
    setup(
      list(TEMPLATES),
      failing(() =>
        problemResponse(422, 'VALIDATION_ERROR', {
          errors: [{ field: 'templateId', code: 'REFERENCE_NOT_FOUND', message: 'x' }],
        }),
      ),
    );
    await templateSelect();
    await user.click(submitButton());
    expect(await screen.findByText('Selecione um modelo de TR válido.')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('FA-02: 409 DOCUMENT_ALREADY_EXISTS oferece "Abrir TR existente" e bloqueia novo envio', async () => {
    const user = userEvent.setup();
    setup(
      list(TEMPLATES),
      failing(() =>
        problemResponse(409, 'DOCUMENT_ALREADY_EXISTS', {
          extension: { meta: { existingTermId: TERM_ID } },
        }),
      ),
    );
    await templateSelect();
    await user.click(submitButton());
    expect(await screen.findByText('Este processo já tem um Termo de Referência.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Abrir TR existente' }).getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}/tr/${TERM_ID}`,
    );
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    [
      422,
      'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE',
      'O Termo de Referência não pode ser elaborado nesta etapa.',
    ],
    [403, 'NOT_PROCESS_CUSTODIAN', 'Somente quem está com o processo pode criar o TR.'],
    [403, 'PERMISSION_DENIED', 'Você não pode criar ou editar o TR deste processo agora.'],
    [409, 'INVALID_PROCESS_STATUS', 'O processo não permite alterações no status atual.'],
    [
      422,
      'IDEMPOTENCY_KEY_REUSED',
      'Esta solicitação já foi enviada com outros dados. Recarregue a página.',
    ],
    [
      503,
      'DEPENDENCY_UNAVAILABLE',
      'Não foi possível criar o TR agora. Tente novamente em instantes.',
    ],
    [500, 'INTERNAL_ERROR', 'Ocorreu um erro inesperado. Código: c-test.'],
  ])('erro %s %s mostra a mensagem da US-036', async (status, code, message) => {
    const user = userEvent.setup();
    setup(
      list(TEMPLATES),
      failing(() => problemResponse(status, code)),
    );
    await templateSelect();
    await user.click(submitButton());
    expect(await screen.findByText(message)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('o reenvio depois de uma falha usa a mesma Idempotency-Key', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const flaky: Route = (url, init) => {
      if (url !== URL_TERMS || init?.method !== 'POST') return undefined;
      calls += 1;
      return calls === 1
        ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
        : jsonResponse({ data: termDto(), meta: { allowedActions: [] } }, { status: 201 });
    };
    const { fetchMock } = setup(list(TEMPLATES), flaky);
    await templateSelect();
    await user.click(submitButton());
    await screen.findByText('Não foi possível criar o TR agora. Tente novamente em instantes.');
    await user.click(submitButton());
    await waitFor(() => {
      expect(push).toHaveBeenCalled();
    });
    const keys = callsTo(fetchMock, 'POST', URL_TERMS).map((call) =>
      call.headers.get('Idempotency-Key'),
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});

describe('CreateTermButton (DOC-01 + TRM-01)', () => {
  const documentTypes = () =>
    jsonResponse({
      data: [
        {
          id: TERM_TYPE,
          code: 'TR',
          name: 'Termo de Referência',
          kind: 'STRUCTURED',
          systemModule: 'TERM_OF_REFERENCE',
          isActive: true,
          allowMultiplePerProcess: false,
          sortOrder: 3,
        },
      ],
    });
  const panel = (creatable: boolean) => () =>
    jsonResponse({
      data: [],
      meta: {
        currentStage: null,
        creatableTypeIds: creatable ? [TERM_TYPE] : [],
        pendingTypeIds: [TERM_TYPE],
      },
    });

  it('sem permissão (DOC-01 sem o tipo) o botão "Criar Termo de Referência" não aparece', async () => {
    const api = mockProcessApi({ documentTypes, documents: panel(false) });
    const fetchMock = stubWithRoutes(api, list(TEMPLATES));
    renderWithShell(<CreateTermButton processId={PROCESS_ID} />);
    await waitFor(() => {
      expect(callsTo(fetchMock, 'GET', URL_TERMS)).toHaveLength(1);
    });
    expect(screen.queryByRole('button', { name: 'Criar Termo de Referência' })).toBeNull();
  });

  it('com o tipo liberado abre o diálogo', async () => {
    const user = userEvent.setup();
    const api = mockProcessApi({ documentTypes, documents: panel(true) });
    stubWithRoutes(api, list(TEMPLATES));
    renderWithShell(<CreateTermButton processId={PROCESS_ID} />);
    await user.click(await screen.findByRole('button', { name: 'Criar Termo de Referência' }));
    expect(await screen.findByRole('dialog', { name: 'Criar Termo de Referência' })).toBeTruthy();
  });

  it('FA-02: com TR ativo vira o link "Abrir TR 0003/2026"', async () => {
    const api = mockProcessApi({ documentTypes, documents: panel(false) });
    stubWithRoutes(
      api,
      list(TEMPLATES, [
        {
          id: TERM_ID,
          documentId: TERM_ID,
          code: 'TR 0003/2026',
          status: 'DRAFT',
          title: DEFAULT_TITLE,
          version: 1,
        },
      ]),
    );
    renderWithShell(<CreateTermButton processId={PROCESS_ID} />);
    const link = await screen.findByRole('link', { name: 'Abrir TR 0003/2026' });
    expect(link.getAttribute('href')).toBe(`/processos/${PROCESS_ID}/tr/${TERM_ID}`);
    expect(screen.queryByRole('button', { name: 'Criar Termo de Referência' })).toBeNull();
  });
});
