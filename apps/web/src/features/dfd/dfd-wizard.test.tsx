// @vitest-environment jsdom
import type {
  DfdDto,
  DfdMeta,
  DocumentItemDto,
  DocumentValidationDto,
  ProcessItemDto,
  Violation,
} from '@contrataflow/validation';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import {
  DFD_ID,
  ID,
  MANUTENCAO,
  PROCESS_ID,
  bodyOf,
  callsTo,
  catalogItem,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { DfdWizard } from './dfd-wizard';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

/** Navegação simulada: `?passo=` é estado observável (`useSearchParams`) e o roteador o altera. */
const nav = vi.hoisted(() => {
  let search = '';
  const listeners = new Set<() => void>();
  const set = (href: string) => {
    search = href.includes('?') ? (href.split('?')[1] ?? '') : '';
    listeners.forEach((listener) => {
      listener();
    });
  };
  return {
    get: () => search,
    set,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    replace: vi.fn((href: string) => {
      set(href);
    }),
  };
});

vi.mock('next/navigation', async () => {
  const React = await import('react');
  return {
    useRouter: () => ({ push: vi.fn(), replace: nav.replace, refresh: vi.fn() }),
    usePathname: () => `/processos/${PROCESS_ID}/dfd/${DFD_ID}`,
    useSearchParams: () => {
      const search = React.useSyncExternalStore(nav.subscribe, nav.get, nav.get);
      return React.useMemo(() => new URLSearchParams(search), [search]);
    },
  };
});

const ANA = '0192a000-0000-7000-8000-0000000000a1';
const UNIT_CX = ID(231);

function dfdDto(extra: Partial<DfdDto> = {}): DfdDto {
  return {
    id: DFD_ID,
    documentId: DFD_ID,
    processId: PROCESS_ID,
    code: 'DFD 0005/2026',
    title: 'DFD — Aquisição de cimento para manutenção de vias',
    status: 'DRAFT',
    templateVersionId: ID(801),
    documentVersion: 1,
    draftRevision: 1,
    requestDate: '2026-10-17',
    requestingDepartmentId: MANUTENCAO.id,
    responsibleId: ANA,
    objectSummary: 'Aquisição de cimento Portland para a manutenção das vias do município.',
    priority: 'MEDIUM',
    expectedDate: null,
    estimatedValue: null,
    estimatedValueMasked: false,
    pcaStatus: 'NOT_APPLICABLE',
    pcaYear: null,
    pcaItemCode: null,
    pcaJustification: null,
    wizardStep: 'IDENTIFICATION',
    completedSteps: [],
    createdAt: '2026-10-17T15:00:00.000Z',
    updatedAt: '2026-10-17T15:00:00.000Z',
    version: 1,
    ...extra,
  };
}

const META: DfdMeta = {
  allowedActions: ['UPDATE', 'FINALIZE', 'DELETE'],
  template: {
    versionId: ID(801),
    versionNumber: 1,
    sections: [
      {
        key: 'JUSTIFICATION',
        title: 'Justificativa da necessidade',
        order: 1,
        requirement: 'REQUIRED',
        helpText: 'Descreva a necessidade da contratação.',
        legalBasis: 'Lei 14.133/2021, art. 12, VII',
        minChars: 50,
        maxChars: 50_000,
      },
      {
        key: 'EXPECTED_RESULTS',
        title: 'Resultados esperados',
        order: 2,
        requirement: 'REQUIRED',
        helpText: null,
        legalBasis: null,
        minChars: null,
        maxChars: 50_000,
      },
      {
        key: 'NOTES',
        title: 'Observações',
        order: 3,
        requirement: 'OPTIONAL',
        helpText: null,
        legalBasis: null,
        minChars: null,
        maxChars: 50_000,
      },
    ],
    fieldConfig: {},
  },
};

function processItem(n: number, description: string, unit = UNIT_CX): ProcessItemDto {
  return {
    id: ID(700 + n),
    processId: PROCESS_ID,
    sequence: n,
    lotNumber: null,
    lotName: null,
    kind: 'GOOD',
    description,
    unitOfMeasure: { id: unit, label: 'Caixa' },
    catalogSystem: null,
    catalogCode: null,
    notes: null,
    referenceQuantity: null,
    referenceQuantitySourceDocumentId: null,
    referenceUnitPrice: null,
    referenceUnitPriceMasked: false,
    referenceUnitPriceSourceDocumentId: null,
    references: [],
    version: 1,
  };
}

const GLOVES = processItem(1, 'Luva de procedimento, tamanho M');
const SYRINGES = processItem(2, 'Seringa descartável 5 ml');

const line = (item: ProcessItemDto, quantity: string): DocumentItemDto => ({
  processItemId: item.id,
  sequence: item.sequence,
  description: item.description,
  unit: { id: UNIT_CX, label: 'Caixa', allowsDecimal: false },
  quantity,
  notes: null,
  sortOrder: 0,
});

const violation = (code: string, location: Partial<Violation>): Violation => ({
  code,
  severity: 'BLOCKING',
  message: `Mensagem ${code}`,
  ruleId: null,
  sectionKey: null,
  field: null,
  itemId: null,
  params: {},
  ...location,
});

function validationDto(violations: Violation[]): DocumentValidationDto {
  const blocking = violations.filter((item) => item.severity === 'BLOCKING').length;
  return {
    documentId: DFD_ID,
    isComplete: blocking === 0,
    draftRevision: 1,
    evaluatedAt: '2026-10-17T15:00:00.000Z',
    summary: { blocking, warnings: violations.length - blocking },
    sections: [],
    violations,
  };
}

interface DfdApiOptions {
  readonly dfd?: DfdDto;
  readonly meta?: DfdMeta;
  readonly items?: () => Response;
  readonly putItems?: (init?: RequestInit) => Response;
  readonly validation?: DocumentValidationDto;
  readonly actions?: readonly { action: string; enabled: boolean }[];
}

/** O `fetch` das leituras do processo (fixtures) + DFD-03, DOC-03/06/07/08 do DFD. */
function mockDfdApi(options: DfdApiOptions = {}) {
  const base = mockProcessApi({
    permissions: ['PROCESS_VIEW', 'ATTACHMENT_UPLOAD'],
    // FA-11: a unidade dos itens não admite decimais.
    catalogs: {
      UNIT_OF_MEASURE: [
        catalogItem(231, 'UNIT_OF_MEASURE', 'CX', 'Caixa', {
          metadata: { abbreviation: 'cx', allowsDecimal: false },
        }),
      ],
    },
    items: () => jsonResponse({ data: [GLOVES, SYRINGES] }, { headers: { ETag: '"3"' } }),
    actions: () =>
      jsonResponse({
        data: (options.actions ?? []).map((entry) => ({
          ...entry,
          label: entry.action,
          reasons: [],
        })),
      }),
  });
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === `/api/v1/dfds/${DFD_ID}`) {
      return Promise.resolve(
        jsonResponse(
          { data: options.dfd ?? dfdDto(), meta: options.meta ?? META },
          { headers: { ETag: '"1"' } },
        ),
      );
    }
    if (method === 'GET' && url === `/api/v1/documents/${DFD_ID}`) {
      return Promise.resolve(
        jsonResponse({
          data: { id: DFD_ID, draftContent: { sections: {} }, version: 1 },
          meta: { allowedActions: ['UPDATE'] },
        }),
      );
    }
    if (url === `/api/v1/documents/${DFD_ID}/items`) {
      if (method === 'PUT') {
        return Promise.resolve(
          options.putItems?.(init) ?? jsonResponse({ data: [] }, { headers: { ETag: '"2"' } }),
        );
      }
      return Promise.resolve(
        options.items?.() ?? jsonResponse({ data: [] }, { headers: { ETag: '"1"' } }),
      );
    }
    if (method === 'GET' && url === `/api/v1/documents/${DFD_ID}/validation`) {
      return Promise.resolve(jsonResponse({ data: options.validation ?? validationDto([]) }));
    }
    if (url.startsWith(`/api/v1/attachments`) || url.includes('/attachments?')) {
      return Promise.resolve(jsonResponse({ data: [], meta: { page: 1, totalItems: 0 } }));
    }
    return base(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  nav.set(`/processos/${PROCESS_ID}/dfd/${DFD_ID}`);
  nav.replace.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SCR-007 — DFD em wizard (US-014)', () => {
  it('abre no passo do wizardStep com o número; "Continuar" valida o passo (V-05) e avança', async () => {
    mockDfdApi();
    const user = userEvent.setup();
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'DFD 0005/2026' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Identificação' })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Número').value).toBe('DFD 0005/2026');
    expect(screen.getByLabelText<HTMLInputElement>('Data *').value).toBe('2026-10-17');
    expect(screen.getByRole('navigation', { name: 'Passos do DFD' })).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);

    const object = screen.getByLabelText('Objeto *');
    await user.clear(object);
    await user.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByText('Informe o objeto.')).toBeTruthy();
    expect(document.activeElement).toBe(object);
    expect(nav.replace).not.toHaveBeenCalled();

    await user.type(object, 'Aquisição de insumos para a UBS Centro');
    await user.click(screen.getByRole('radio', { name: 'Urgente' }));
    expect(
      screen.getByText('Ao ser aprovado, o DFD elevará a prioridade do processo para Urgente.'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Continuar' }));
    await waitFor(() => {
      expect(nav.replace).toHaveBeenCalledWith(
        `/processos/${PROCESS_ID}/dfd/${DFD_ID}?passo=justificativa`,
        { scroll: false },
      );
    });
    expect(await screen.findByRole('heading', { level: 2, name: 'Justificativa' })).toBeTruthy();
    expect(screen.getByLabelText('Justificativa da necessidade *')).toBeTruthy();
    expect(screen.getByText('Base legal: Lei 14.133/2021, art. 12, VII')).toBeTruthy();
    expect(screen.getByText('Descreva a necessidade da contratação.')).toBeTruthy();
  });

  it('Revisão: pendências obrigatórias por passo; "Ir para o campo" abre o Planejamento com foco nos itens; Conclusão "Há 3 pendências obrigatórias"', async () => {
    nav.set(`/processos/${PROCESS_ID}/dfd/${DFD_ID}?passo=revisao`);
    mockDfdApi({
      validation: validationDto([
        violation('SECTION_REQUIRED', {
          sectionKey: 'JUSTIFICATION',
          message: 'Preencha a seção "Justificativa da necessidade".',
        }),
        violation('DFD_ITEMS_REQUIRED', {
          field: 'items',
          message: 'Informe ao menos um item com quantidade.',
        }),
        violation('FIELD_REQUIRED', {
          field: 'expectedDate',
          message: 'Informe a data pretendida para a contratação.',
        }),
        violation('DFD_ATTACHMENTS_PENDING', {
          field: 'attachments',
          severity: 'WARNING',
          message: 'Há 1 anexo em verificação de segurança.',
        }),
      ]),
    });
    const user = userEvent.setup();
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);

    const blocking = await screen.findByRole('list', { name: 'Pendências obrigatórias' });
    expect(within(blocking).getAllByRole('listitem')).toHaveLength(3);
    expect(within(blocking).getByText('Informe ao menos um item com quantidade.')).toBeTruthy();
    const warnings = screen.getByRole('list', { name: 'Alertas' });
    expect(within(warnings).getByText('Há 1 anexo em verificação de segurança.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pré-visualizar PDF' })).toBeTruthy();

    const itemsEntry = within(blocking)
      .getByText('Informe ao menos um item com quantidade.')
      .closest('li') as HTMLElement;
    await user.click(
      within(itemsEntry).getByRole('button', { name: 'Ir para o campo no passo Planejamento' }),
    );
    expect(nav.replace).toHaveBeenCalledWith(
      `/processos/${PROCESS_ID}/dfd/${DFD_ID}?passo=planejamento`,
      { scroll: false },
    );
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('dfd-field-items');
    });

    nav.set(`/processos/${PROCESS_ID}/dfd/${DFD_ID}?passo=conclusao`);
    expect(await screen.findByText('Há 3 pendências obrigatórias')).toBeTruthy();
  });

  it('Planejamento: "2.5" em unidade inteira mostra o erro e não envia; quantidade válida grava pelo DOC-07 com If-Match', async () => {
    nav.set(`/processos/${PROCESS_ID}/dfd/${DFD_ID}?passo=planejamento`);
    const api = mockDfdApi({
      putItems: (init) =>
        jsonResponse(
          {
            data: (bodyOf(init).items as { processItemId: string; quantity: string }[]).map(
              (item) =>
                line(item.processItemId === GLOVES.id ? GLOVES : SYRINGES, `${item.quantity}.0000`),
            ),
          },
          { headers: { ETag: '"2"' } },
        ),
    });
    const user = userEvent.setup();
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);

    await user.click(await screen.findByRole('checkbox', { name: 'Incluir o item 2 neste DFD' }));
    const quantity = screen.getByLabelText('Quantidade do item 2');
    await user.type(quantity, '2.5');
    fireEvent.blur(quantity);
    expect(await screen.findByText('Esta unidade aceita apenas números inteiros.')).toBeTruthy();
    // Inválida no cliente (V-09): nada é enviado.
    expect(callsTo(api, 'PUT', `/api/v1/documents/${DFD_ID}/items`)).toHaveLength(0);
    await user.clear(quantity);
    await user.type(quantity, '5000');
    fireEvent.blur(quantity);
    await waitFor(() => {
      const puts = callsTo(api, 'PUT', `/api/v1/documents/${DFD_ID}/items`);
      expect(puts.at(-1)?.body).toEqual({
        items: [{ processItemId: SYRINGES.id, quantity: '5000' }],
      });
      expect(puts.at(-1)?.headers.get('If-Match')).toBe('"1"');
    });
  });

  it('Concorrência: 412 no DOC-07 recarrega os itens, reaplica a alteração local e preserva a do outro editor', async () => {
    nav.set(`/processos/${PROCESS_ID}/dfd/${DFD_ID}?passo=planejamento`);
    let reads = 0;
    let puts = 0;
    const api = mockDfdApi({
      items: () => {
        reads += 1;
        // Depois do 412: o outro editor já incluiu o item 1 (versão 2 do documento).
        return reads === 1
          ? jsonResponse({ data: [] }, { headers: { ETag: '"1"' } })
          : jsonResponse({ data: [line(GLOVES, '60.0000')] }, { headers: { ETag: '"2"' } });
      },
      putItems: () => {
        puts += 1;
        return puts === 1
          ? problemResponse(412, 'VERSION_CONFLICT')
          : jsonResponse(
              { data: [line(GLOVES, '60.0000'), line(SYRINGES, '5000.0000')] },
              { headers: { ETag: '"3"' } },
            );
      },
    });
    const user = userEvent.setup();
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);

    const quantity = await screen.findByLabelText('Quantidade do item 2');
    await user.click(screen.getByRole('checkbox', { name: 'Incluir o item 2 neste DFD' }));
    await user.type(quantity, '5000');
    fireEvent.blur(quantity);
    await waitFor(() => {
      const calls = callsTo(api, 'PUT', `/api/v1/documents/${DFD_ID}/items`);
      expect(calls.at(-1)?.body).toEqual({
        items: [
          { processItemId: GLOVES.id, quantity: '60' },
          { processItemId: SYRINGES.id, quantity: '5000' },
        ],
      });
      expect(calls.at(-1)?.headers.get('If-Match')).toBe('"2"');
    });
    expect(
      await screen.findByText('Os itens foram alterados por outra pessoa. Atualizamos a lista.'),
    ).toBeTruthy();
  });

  it('FA-03/FA-04: sem MANAGE_ITEMS não há "Adicionar item ao processo"; com ele, aparece', async () => {
    nav.set(`/processos/${PROCESS_ID}/dfd/${DFD_ID}?passo=planejamento`);
    mockDfdApi();
    const { unmount } = renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    expect(
      await screen.findByRole('checkbox', { name: 'Incluir o item 1 neste DFD' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Adicionar item ao processo' })).toBeNull();
    unmount();

    mockDfdApi({ actions: [{ action: 'MANAGE_ITEMS', enabled: true }] });
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    expect(await screen.findByRole('button', { name: 'Adicionar item ao processo' })).toBeTruthy();
  });

  it('FA-05/FA-06: sem UPDATE abre em modo leitura com a faixa de status; estimativa sigilosa aparece como "Valor sigiloso"', async () => {
    nav.set(`/processos/${PROCESS_ID}/dfd/${DFD_ID}?passo=planejamento`);
    mockDfdApi({
      dfd: dfdDto({ status: 'IN_REVIEW', estimatedValueMasked: true }),
      meta: { ...META, allowedActions: [] },
    });
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    const banner = (await screen.findByText('Este DFD está em modo leitura.')).closest('div');
    if (banner === null) throw new Error('faixa ausente');
    expect(within(banner).getByText('Em revisão')).toBeTruthy();
    expect(
      (await screen.findByRole('checkbox', { name: 'Incluir o item 1 neste DFD' })).hasAttribute(
        'disabled',
      ),
    ).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Estimativa preliminar do valor').value).toBe(
      'Valor sigiloso',
    );
  });

  it('DFD inexistente/outro tenant: mensagem "DFD não encontrado."', async () => {
    const base = mockDfdApi();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((input, init) =>
        requestUrl(input) === `/api/v1/dfds/${DFD_ID}`
          ? Promise.resolve(problemResponse(404, 'DFD_NOT_FOUND'))
          : base(input, init),
      ),
    );
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    expect(await screen.findByText('DFD não encontrado.')).toBeTruthy();
  });
});
