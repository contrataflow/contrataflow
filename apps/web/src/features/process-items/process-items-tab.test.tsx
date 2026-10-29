// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { ActionEntry, ProcessItemDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import { chooseOption } from '@test/support/kit';
import {
  AQUISICAO,
  CATALOGS,
  ID,
  METRO_CUBICO,
  PROCESS_ID,
  UNIDADE,
  bodyOf,
  callsTo,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell } from '@test/support/render';

import { ProcessItemsTab } from './process-items-tab';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

/** Resposta própria do cenário; `undefined` = a lista padrão. */
type Route = (url: string, init?: RequestInit) => Response | undefined;

const LIST = `/api/v1/processes/${PROCESS_ID}/items`;
const REORDER = `/api/v1/processes/${PROCESS_ID}/items/reorder`;

function item(sequence: number, extra: Partial<ProcessItemDto> = {}): ProcessItemDto {
  return {
    id: ID(900 + sequence),
    processId: PROCESS_ID,
    sequence,
    lotNumber: null,
    lotName: null,
    kind: 'GOOD',
    description: `Item número ${String(sequence)}`,
    unitOfMeasure: { id: UNIDADE.id, label: 'Unidade' },
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
    ...extra,
  };
}

const manage = (enabled: boolean, message?: string): ActionEntry => ({
  action: 'MANAGE_ITEMS',
  label: 'Gerenciar itens',
  enabled,
  reasons: message ? [{ code: 'NOT_PROCESS_CUSTODIAN', message }] : [],
});

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

function renderTab(
  items: readonly ProcessItemDto[],
  options: { action?: ActionEntry; handler?: Route; etag?: string } = {},
) {
  const api = mockProcessApi({
    permissions: ['PROCESS_UPDATE'],
    actions: () => jsonResponse({ data: [options.action ?? manage(true)] }),
    catalogs: {
      ...CATALOGS,
      CONTRACTING_TYPE: [{ ...AQUISICAO, metadata: { itemKinds: ['GOOD'] } }],
      UNIT_OF_MEASURE: [UNIDADE, METRO_CUBICO],
    },
    items: (url, init) => {
      const handled = options.handler?.(url, init);
      if (handled) return handled;
      return jsonResponse({ data: items }, { headers: { ETag: options.etag ?? '"14"' } });
    },
  });
  renderWithShell(
    <>
      <ProcessItemsTab processId={PROCESS_ID} />
      <Toaster />
    </>,
    { queryClient: noRetryClient() },
  );
  return api;
}

describe('SCR-006 · aba "Itens" (US-006)', () => {
  it('[Sucesso] lista agrupada por lote e inclusão com Idempotency-Key, sem o ETag do processo', async () => {
    const user = userEvent.setup();
    const created = item(3, { description: 'Areia média' });
    const api = renderTab(
      [
        item(1, { lotNumber: 1, lotName: 'Materiais de construção' }),
        item(2, { lotNumber: 1, lotName: 'Materiais de construção' }),
      ],
      {
        handler: (url, init) =>
          init?.method === 'POST' && url === LIST
            ? jsonResponse({ data: created }, { status: 201, headers: { ETag: '"1"' } })
            : undefined,
      },
    );
    expect(await screen.findByText('Lote 1 — Materiais de construção')).toBeTruthy();
    expect(screen.getByText('2 itens')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Adicionar item' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Descrição/), 'Areia média');
    // Natureza padrão = primeira de `itemKinds` do tipo (Bem).
    expect(within(dialog).getByRole('combobox', { name: /^Natureza/ }).textContent).toBe('Bem');
    await within(dialog).findByRole('combobox', { name: /^Unidade de medida/ });
    await chooseOption(user, /^Unidade de medida/, METRO_CUBICO.label, dialog);
    await user.type(within(dialog).getByLabelText(/^Lote \(número\)/), '1');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar item' }));

    await waitFor(() => {
      expect(callsTo(api, 'POST', LIST)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'POST', LIST);
    expect(call?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(call?.headers.get('If-Match')).toBeNull();
    expect(call?.body).toEqual({
      description: 'Areia média',
      kind: 'GOOD',
      unitOfMeasureId: METRO_CUBICO.id,
      lotNumber: 1,
    });
    expect(await screen.findByText('Item adicionado')).toBeTruthy();
  });

  it('[Validação] código CATMAT com letras e natureza incomum: erros antes de enviar', async () => {
    const user = userEvent.setup();
    const api = renderTab([]);
    expect(
      await screen.findByText('Nenhum item ainda. Adicione os itens que serão contratados.'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Adicionar item' }));
    const dialog = await screen.findByRole('dialog');
    await chooseOption(user, /^Natureza/, 'Obra', dialog);
    expect(
      within(dialog).getByText('Natureza incomum para o tipo de contratação Aquisição de bens.'),
    ).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/^Descrição/), 'Cimento');
    await within(dialog).findByRole('combobox', { name: /^Unidade de medida/ });
    await chooseOption(user, /^Unidade de medida/, UNIDADE.label, dialog);
    await chooseOption(user, /^Sistema de catálogo/, 'CATMAT', dialog);
    await user.type(within(dialog).getByLabelText(/^Código CATMAT/), 'AB12');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar item' }));
    expect(
      await within(dialog).findByText('O código CATMAT/CATSER deve conter apenas números.'),
    ).toBeTruthy();
    expect(callsTo(api, 'POST', LIST)).toEqual([]);
  });

  it('[Permissão] modo leitura com o motivo; preço sigiloso mascarado e quantidade visível', async () => {
    renderTab(
      [
        item(1, {
          referenceQuantity: '120.0000',
          referenceQuantitySourceDocumentId: ID(501),
          referenceUnitPrice: null,
          referenceUnitPriceMasked: true,
        }),
      ],
      { action: manage(false, 'Somente quem está com o processo pode alterar os itens.') },
    );
    expect(
      await screen.findByText('Somente quem está com o processo pode alterar os itens.'),
    ).toBeTruthy();
    expect(screen.getByText('Sigiloso')).toBeTruthy();
    expect(screen.getByText('120')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Adicionar item' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Sucesso] lacunas: "Renumerar" envia a ordem atual com If-Match = ETag da lista', async () => {
    const user = userEvent.setup();
    const one = item(1);
    const three = item(3);
    const api = renderTab([one, three], {
      handler: (url, init) =>
        init?.method === 'POST' && url === REORDER
          ? jsonResponse({ data: [one, { ...three, sequence: 2 }] }, { headers: { ETag: '"15"' } })
          : undefined,
    });
    expect(await screen.findByText('Os itens têm numeração com lacunas (1, 3).')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Renumerar' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST', REORDER)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'POST', REORDER);
    expect(call?.headers.get('If-Match')).toBe('"14"');
    expect(call?.body).toEqual({ itemIds: [one.id, three.id] });
    expect(await screen.findByText('Ordem dos itens salva')).toBeTruthy();
  });

  it('[Acessibilidade] "Mover para baixo" anuncia a posição e "Salvar ordem" envia a nova ordem; 412 recarrega', async () => {
    const user = userEvent.setup();
    const one = item(1);
    const two = item(2);
    const api = renderTab([one, two], {
      handler: (url, init) =>
        init?.method === 'POST' && url === REORDER
          ? problemResponse(412, 'VERSION_CONFLICT', { extension: { currentVersion: 15 } })
          : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Mover para baixo — 1' }));
    expect(screen.getByText('Item 1 movido para a posição 2')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Salvar ordem' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST', REORDER)).toHaveLength(1);
    });
    expect(callsTo(api, 'POST', REORDER)[0]?.body).toEqual({ itemIds: [two.id, one.id] });
    expect(await screen.findByText('A lista de itens foi alterada por outra pessoa.')).toBeTruthy();
    // A lista é recarregada (FA-08).
    await waitFor(() => {
      expect(callsTo(api, 'GET', LIST).length).toBeGreaterThan(1);
    });
  });

  it('[Duplicidade] exclusão de item em uso: diálogo com os documentos e o aviso de reabertura', async () => {
    const user = userEvent.setup();
    const used = item(1);
    const references = [
      {
        documentId: ID(501),
        code: 'DFD 0005/2026',
        typeCode: 'DFD',
        status: 'DRAFT',
        editable: true,
      },
      {
        documentId: ID(502),
        code: 'PP 0002/2026',
        typeCode: 'PRICE_RESEARCH',
        status: 'APPROVED',
        editable: false,
      },
    ];
    const api = renderTab([used], {
      handler: (_url, init) =>
        init?.method === 'DELETE'
          ? problemResponse(409, 'ITEM_IN_USE', { extension: { meta: { references } } })
          : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Excluir' }));
    const confirm = await screen.findByRole('dialog');
    await user.click(within(confirm).getByRole('button', { name: 'Excluir' }));
    const DELETE = `/api/v1/process-items/${used.id}`;
    await waitFor(() => {
      expect(callsTo(api, 'DELETE', DELETE)).toHaveLength(1);
    });
    expect(callsTo(api, 'DELETE', DELETE)[0]?.headers.get('If-Match')).toBe('"1"');
    expect(await screen.findByText('Item em uso')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'DFD 0005/2026 (Rascunho)' })).toBeTruthy();
    expect(
      screen.getByText('O PP 0002/2026 está aprovado; é preciso reabri-lo antes.'),
    ).toBeTruthy();
  });

  it('[Validação] edição de item em uso: unidade travada e confirmação para documento concluído', async () => {
    const user = userEvent.setup();
    const used = item(1, {
      references: [
        {
          documentId: ID(503),
          code: 'ETP 0003/2026',
          typeCode: 'ETP',
          status: 'APPROVED',
          editable: false,
        },
      ],
    });
    const PATCH = `/api/v1/process-items/${used.id}`;
    const api = renderTab([used], {
      handler: (_url, init) =>
        init?.method === 'PATCH'
          ? jsonResponse({ data: { ...used, description: 'Cimento CP-IV', version: 2 } })
          : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Editar' }));
    const dialog = await screen.findByRole('dialog');
    const unit = within(dialog).getByLabelText(/^Unidade de medida/);
    expect(unit.getAttribute('aria-readonly')).toBe('true');
    expect(
      within(dialog).getByText(
        'A unidade não pode ser alterada porque o item já tem quantidades em documentos.',
      ),
    ).toBeTruthy();
    const description = within(dialog).getByLabelText(/^Descrição/);
    await user.clear(description);
    await user.type(description, 'Cimento CP-IV');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar item' }));
    expect(
      await screen.findByText(
        'Os documentos ETP 0003/2026 (Aprovado) manterão a descrição anterior nas versões já geradas.',
      ),
    ).toBeTruthy();
    expect(callsTo(api, 'PATCH', PATCH)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH', PATCH)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'PATCH', PATCH);
    expect(call?.headers.get('If-Match')).toBe('"1"');
    expect(bodyOf(call?.init)).toEqual({ description: 'Cimento CP-IV' });
  });
});
