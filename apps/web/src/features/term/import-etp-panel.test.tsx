// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type {
  TermImportPreviewDto,
  TermImportResultDto,
  TermTemplateSectionDto,
} from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { seriousA11yViolations } from '@test/support/axe';
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

import {
  canApplySelection,
  classifyEtpImportError,
  initialSelection,
  itemsToImport,
  needsValueSourceConfirmation,
  toApplyBody,
  toggle,
} from './etp-import-model';
import { ImportEtpPanel } from './import-etp-panel';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/processos/${PROCESS_ID}/tr/${ID(900)}`,
  useSearchParams: () => new URLSearchParams(),
}));

/*
 * US-037 — painel "Importar do ETP" (SCR-012) com a API simulada: prévia com "antes / depois", campos
 * e itens pré-marcados (fluxo principal 2–3), aplicação com `If-Match` e `Idempotency-Key` e o toast
 * (5–8), FA-01 (sem seleção), FA-02 (ETP em elaboração), FA-03 (410 recarrega a prévia), FA-04
 * (sobrescrever especificados), FA-05 (valor sigiloso), RN-TR-22 (confirmação da origem do valor),
 * sem ETP (estado vazio), indisponibilidade e acessibilidade (axe).
 */

const TERM_ID = ID(900);
const URL_PREVIEW = `/api/v1/terms/${TERM_ID}/import-etp/preview`;
const URL_APPLY = `/api/v1/terms/${TERM_ID}/import-etp`;

const SECTIONS: TermTemplateSectionDto[] = [
  ['OBJECT', 'Definição do objeto'],
  ['JUSTIFICATION', 'Justificativa'],
].map(([key = '', title = ''], index) => ({
  key,
  title,
  order: index + 1,
  requirement: 'REQUIRED',
  helpText: null,
  legalBasis: null,
  minChars: null,
  maxChars: 50_000,
  render: 'TEXT',
  allowNarrative: true,
}));

function previewDto(extra: Partial<TermImportPreviewDto> = {}): TermImportPreviewDto {
  return {
    importToken: 'v1.token-1.sig',
    expiresAt: '2026-10-20T15:15:00.000Z',
    etp: {
      id: ID(950),
      code: 'ETP 0001/2026',
      status: 'FINALIZED',
      versionNumber: 2,
      inProgress: false,
    },
    sections: [
      {
        target: 'OBJECT',
        sources: ['RECOMMENDED_SOLUTION'],
        mode: 'REPLACE',
        before: 'Objeto antigo',
        preview: 'Notebooks educacionais',
      },
      {
        target: 'JUSTIFICATION',
        sources: ['NEED_DESCRIPTION'],
        mode: 'APPEND',
        before: '',
        preview: 'Importado do ETP v2 em 20/10/2026\nNecessidade das escolas',
      },
    ],
    fields: [
      {
        target: 'estimatedTotalValue',
        source: 'estimatedTotalValue',
        value: '125000.00',
        valueMasked: false,
        current: null,
      },
    ],
    items: {
      count: 2,
      copyQuantities: true,
      copyCalculationMemoToNotes: false,
      preview: [
        {
          processItemId: ID(961),
          sequence: 1,
          description: 'Notebook',
          etpQuantity: '8.0000',
          trCurrentQuantity: null,
          specified: false,
        },
        {
          processItemId: ID(962),
          sequence: 2,
          description: 'Mouse',
          etpQuantity: '16.0000',
          trCurrentQuantity: '10.0000',
          specified: true,
        },
      ],
    },
    replacesPriceResearchValue: false,
    ...extra,
  };
}

const RESULT = {
  term: {},
  sectionsImported: ['OBJECT', 'JUSTIFICATION'],
  fieldsImported: ['estimatedTotalValue'],
  itemsImported: 1,
  documentVersion: { id: ID(970), versionNumber: 4 },
} as unknown as TermImportResultDto;

const previewing =
  (...responses: (() => Response)[]): Route =>
  (url, init) => {
    if (url !== URL_PREVIEW || init?.method !== 'POST') return undefined;
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return next?.();
  };

const applying =
  (...responses: (() => Response)[]): Route =>
  (url, init) => {
    if (url !== URL_APPLY || init?.method !== 'POST') return undefined;
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return next?.();
  };

const ok = (preview: TermImportPreviewDto) => () => jsonResponse({ data: preview });

function setup(...routes: Route[]) {
  const api = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
  const fetchMock = stubWithRoutes(api, ...routes);
  const onClose = vi.fn();
  const onImported = vi.fn(() => Promise.resolve());
  const onStale = vi.fn(() => Promise.resolve());
  const view = renderWithShell(
    <>
      <Toaster />
      <ImportEtpPanel
        open
        processId={PROCESS_ID}
        termId={TERM_ID}
        version={3}
        sections={SECTIONS}
        onClose={onClose}
        onImported={onImported}
        onStale={onStale}
      />
    </>,
  );
  return { fetchMock, onClose, onImported, onStale, view };
}

const applyButton = () => screen.findByRole('button', { name: 'Aplicar importação' });

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('ImportEtpPanel (US-037 · SCR-012)', () => {
  it('prévia: antes/depois por seção, campos e itens pré-marcados; aplica com If-Match, Idempotency-Key e toast', async () => {
    const user = userEvent.setup();
    const { fetchMock, onImported, onClose } = setup(
      previewing(ok(previewDto())),
      applying(() => jsonResponse({ data: RESULT, meta: { allowedActions: ['UPDATE'] } })),
    );
    const object = await screen.findByRole('checkbox', { name: /Definição do objeto/ });
    expect((object as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Justificativa/ }).checked).toBe(
      true,
    );
    expect(screen.getAllByText('Objeto antigo').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Notebooks educacionais').length).toBeGreaterThan(0);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Valor estimado/ }).checked).toBe(
      true,
    );
    expect(screen.getByText(/R\$\s?125\.000,00/)).toBeTruthy();
    expect(screen.getByText('Origem: ETP 0001/2026, versão 2')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Itens do ETP e quantidades atuais do TR' });
    expect(within(table).getByText('novo')).toBeTruthy();
    expect(within(table).getByText('(já especificado)')).toBeTruthy();
    // FA-04: o especificado só entra com "Sobrescrever".
    expect(screen.getByText('Selecionado: 2 seções e 1 item.')).toBeTruthy();

    await user.click(await applyButton());
    await waitFor(() => {
      expect(onImported).toHaveBeenCalledWith(RESULT);
    });
    expect(onClose).toHaveBeenCalled();
    const [call] = callsTo(fetchMock, 'POST', URL_APPLY);
    expect(call?.headers.get('If-Match')).toBe('"3"');
    expect(call?.headers.get('Idempotency-Key')).toEqual(expect.any(String));
    expect(call?.body).toEqual({
      importToken: 'v1.token-1.sig',
      sections: ['OBJECT', 'JUSTIFICATION'],
      fields: ['estimatedTotalValue'],
      copyItems: true,
    });
    expect(
      await screen.findByText('Importação aplicada: 2 seções e 1 item atualizado'),
    ).toBeTruthy();
  });

  it('FA-01: sem seleção, "Aplicar importação" fica desabilitado com a mensagem', async () => {
    const user = userEvent.setup();
    setup(previewing(ok(previewDto())));
    await user.click(await screen.findByRole('checkbox', { name: /Definição do objeto/ }));
    await user.click(screen.getByRole('checkbox', { name: /Justificativa/ }));
    await user.click(screen.getByRole('checkbox', { name: /Valor estimado/ }));
    await user.click(screen.getByRole('switch', { name: /Copiar os 2 itens/ }));
    expect(((await applyButton()) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Selecione ao menos uma seção, campo ou os itens.')).toBeTruthy();
  });

  it('RN-TR-22: troca da origem PRICE_RESEARCH pede confirmação e envia confirmReplaceValueSource', async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup(
      previewing(ok(previewDto({ replacesPriceResearchValue: true }))),
      applying(() => jsonResponse({ data: RESULT, meta: { allowedActions: [] } })),
    );
    await user.click(await applyButton());
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Substituir o valor da pesquisa de preços?',
    });
    expect(callsTo(fetchMock, 'POST', URL_APPLY)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Substituir e importar' }));
    await waitFor(() => {
      expect(callsTo(fetchMock, 'POST', URL_APPLY)).toHaveLength(1);
    });
    expect(callsTo(fetchMock, 'POST', URL_APPLY)[0]?.body).toMatchObject({
      confirmReplaceValueSource: true,
    });
  });

  it('FA-03: 410 recarrega a prévia sozinha, com o aviso', async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup(
      previewing(ok(previewDto()), ok(previewDto({ importToken: 'v1.token-2.sig' }))),
      applying(() => problemResponse(410, 'IMPORT_PREVIEW_EXPIRED')),
    );
    await user.click(await applyButton());
    expect(
      await screen.findByText('O ETP ou o TR foram alterados. Atualizando a prévia…'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(callsTo(fetchMock, 'POST', URL_PREVIEW)).toHaveLength(2);
    });
    expect(((await applyButton()) as HTMLButtonElement).disabled).toBe(false);
  });

  it('FA-02 e FA-05: aviso de ETP em elaboração; valor sigiloso desmarcado e desabilitado', async () => {
    setup(
      previewing(
        ok(
          previewDto({
            etp: {
              id: ID(950),
              code: null,
              status: 'DRAFT',
              versionNumber: null,
              inProgress: true,
            },
            fields: [
              {
                target: 'estimatedTotalValue',
                source: 'estimatedTotalValue',
                value: null,
                valueMasked: true,
                current: null,
              },
            ],
          }),
        ),
      ),
    );
    expect(
      await screen.findByText('O ETP ainda não foi concluído; os dados podem mudar.'),
    ).toBeTruthy();
    const value = screen.getByRole('checkbox', { name: /Valor estimado/ });
    expect((value as HTMLButtonElement).disabled).toBe(true);
    expect((value as HTMLInputElement).checked).toBe(false);
    expect(screen.getAllByText(/Valor sigiloso/).length).toBeGreaterThan(0);
    expect(screen.getByText('Origem: ETP (rascunho)')).toBeTruthy();
  });

  it('Sem ETP: estado vazio com o atalho para o processo', async () => {
    setup(previewing(() => problemResponse(422, 'ETP_REQUIRED_FOR_IMPORT')));
    expect(await screen.findByText('Este processo não tem um ETP para importar.')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Ir para o processo e criar o ETP' }).getAttribute('href'),
    ).toBe(`/processos/${PROCESS_ID}`);
  });

  it('412: fecha o painel, avisa e recarrega o TR; 503: mantém a seleção com "Tentar novamente"', async () => {
    const user = userEvent.setup();
    const { onStale, onClose } = setup(
      previewing(ok(previewDto())),
      applying(
        () => problemResponse(503, 'DEPENDENCY_UNAVAILABLE'),
        () => problemResponse(412, 'VERSION_CONFLICT'),
      ),
    );
    await user.click(await applyButton());
    expect(
      await screen.findByText('Não foi possível importar agora. Tente novamente em instantes.'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => {
      expect(onStale).toHaveBeenCalled();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('acessibilidade: sem violações sérias no painel', async () => {
    const { view } = setup(previewing(ok(previewDto())));
    await screen.findByRole('checkbox', { name: /Definição do objeto/ });
    expect(await seriousA11yViolations(view.baseElement)).toEqual([]);
  });
});

describe('etp-import-model (US-037)', () => {
  const preview = previewDto();

  it('seleção inicial, V-01, itens e corpo da aplicação', () => {
    const selection = initialSelection(preview);
    expect(selection).toEqual({
      sections: ['OBJECT', 'JUSTIFICATION'],
      fields: ['estimatedTotalValue'],
      copyItems: true,
      overwriteExisting: false,
    });
    expect(canApplySelection(selection)).toBe(true);
    expect(canApplySelection({ ...selection, sections: [], fields: [], copyItems: false })).toBe(
      false,
    );
    expect(itemsToImport(preview, selection)).toBe(1);
    expect(itemsToImport(preview, { ...selection, overwriteExisting: true })).toBe(2);
    expect(itemsToImport(preview, { ...selection, copyItems: false })).toBe(0);
    expect(toApplyBody(preview, { ...selection, overwriteExisting: true }, true)).toEqual({
      importToken: preview.importToken,
      sections: ['OBJECT', 'JUSTIFICATION'],
      fields: ['estimatedTotalValue'],
      copyItems: true,
      overwriteExisting: true,
      confirmReplaceValueSource: true,
    });
    expect(toggle(['A'], 'B', true)).toEqual(['A', 'B']);
    expect(toggle(['A', 'B'], 'A', false)).toEqual(['B']);
  });

  it('confirmação só com o valor marcado sobre a origem PRICE_RESEARCH', () => {
    const linked = previewDto({ replacesPriceResearchValue: true });
    const selection = initialSelection(linked);
    expect(needsValueSourceConfirmation(linked, selection)).toBe(true);
    expect(needsValueSourceConfirmation(linked, { ...selection, fields: [] })).toBe(false);
    expect(needsValueSourceConfirmation(preview, initialSelection(preview))).toBe(false);
  });

  it('classifica as recusas da API', () => {
    const error = (status: number, code: string, errors: ApiError['errors'] = []) =>
      new ApiError({ status, code, errors, correlationId: 'c-1' });
    expect(classifyEtpImportError(error(410, 'IMPORT_PREVIEW_EXPIRED'), 'x').kind).toBe('reload');
    expect(classifyEtpImportError(error(422, 'ETP_REQUIRED_FOR_IMPORT'), 'x').kind).toBe('noEtp');
    expect(classifyEtpImportError(error(412, 'VERSION_CONFLICT'), 'x').kind).toBe('conflict');
    expect(classifyEtpImportError(error(428, 'PRECONDITION_REQUIRED'), 'x').kind).toBe('conflict');
    for (const code of [
      'DOCUMENT_NOT_EDITABLE',
      'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE',
      'PERMISSION_DENIED',
      'NOT_FOUND',
    ]) {
      expect(classifyEtpImportError(error(403, code), 'x').kind).toBe('blocked');
    }
    expect(
      classifyEtpImportError(
        error(422, 'VALIDATION_ERROR', [
          {
            field: 'confirmReplaceValueSource',
            code: 'CONDITIONAL_REQUIRED',
            message: 'Confirme.',
          },
        ]),
        'x',
      ),
    ).toEqual({ kind: 'invalid', message: 'Confirme.', field: 'confirmReplaceValueSource' });
    expect(classifyEtpImportError(error(422, 'IDEMPOTENCY_KEY_REUSED'), 'x').kind).toBe('invalid');
    expect(classifyEtpImportError(error(409, 'IDEMPOTENCY_IN_PROGRESS'), 'x').kind).toBe('retry');
    expect(classifyEtpImportError(error(500, 'INTERNAL_ERROR'), 'Erro')).toEqual({
      kind: 'retry',
      message: 'Erro',
      correlationId: 'c-1',
    });
    expect(classifyEtpImportError(new Error('rede'), 'Erro').kind).toBe('retry');
  });
});
