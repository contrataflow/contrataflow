// @vitest-environment jsdom
import type {
  DocumentValidationDto,
  EtpDetailDto,
  EtpDetailMeta,
  EtpTemplateSectionDto,
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

import { EtpEditor } from './etp-editor';
import { canEditEtp, sectionDraftOf, sectionSaveBody } from './etp-editor-model';

configure({ asyncUtilTimeout: 8_000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-020 — SCR-008 com a API simulada: navegação lateral com o estado de cada seção (RN-ETP-13),
 * autosave com `If-Match: "s<revision>"` e "Salvo às HH:mm" (RN-ETP-10), "não se aplica" com
 * justificativa ≥ 20 caracteres (RN-ETP-11 · V-04), quadro somente leitura dos itens (RN-ETP-12),
 * modo leitura sem UPDATE (FA-05), conflito (FA-01) e a contingência local nas falhas de banco e
 * de rede (FA-04). Relógio real: o debounce é 1,5 s.
 */

const ANA = '0192a000-0000-7000-8000-0000000000a1';
const BRUNO = '0192a000-0000-7000-8000-0000000000b7';
const ETP_ID = ID(900);
const AT = '2026-10-18T17:31:00.000Z';
const SCOPE = { tenantId: TENANT_A.id, userId: ANA, documentId: ETP_ID };
const JUSTIFICATION_30 = 'Solução única no mercado atual';

const section = (
  key: string,
  title: string,
  order: number,
  extra: Partial<EtpTemplateSectionDto> = {},
): EtpTemplateSectionDto => ({
  key,
  title,
  order,
  requirement: 'REQUIRED_OR_JUSTIFY',
  helpText: null,
  legalBasis: null,
  minChars: null,
  maxChars: 50_000,
  render: 'TEXT',
  allowNarrative: true,
  ...extra,
});

const META: EtpDetailMeta = {
  allowedActions: ['UPDATE', 'FINALIZE'],
  template: {
    versionId: ID(901),
    versionNumber: 1,
    sections: [
      section('NEED_DESCRIPTION', 'Descrição da necessidade', 1, {
        requirement: 'REQUIRED',
        legalBasis: 'Lei 14.133/2021, art. 18, §1º, I',
      }),
      section('MARKET_SURVEY', 'Levantamento de mercado', 2),
      section('ESTIMATES', 'Estimativas das quantidades e do valor', 3),
    ],
  },
};

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const emptySection = (revision = 0) => ({
  state: 'EMPTY' as const,
  content: null,
  justification: null,
  revision,
  updatedAt: AT,
  updatedById: ANA,
});

function etpDto(extra: Partial<EtpDetailDto> = {}): EtpDetailDto {
  return {
    id: ETP_ID,
    documentId: ETP_ID,
    processId: PROCESS_ID,
    code: 'ETP 0003/2026',
    title: 'Estudo Técnico Preliminar — 0012/2026',
    status: 'DRAFT',
    conclusion: 'PENDING',
    importedFromDfdVersionId: null,
    responsibleId: ANA,
    templateVersionId: ID(901),
    documentVersion: 1,
    itemsCount: 1,
    createdAt: AT,
    updatedAt: AT,
    version: 1,
    recommendedAlternativeId: null,
    parcelingDecision: null,
    estimatedValueSource: null,
    estimatedTotalValue: null,
    estimatedTotalValueMasked: false,
    priceResearchId: null,
    draftRevision: 3,
    draftContent: {
      sections: {
        NEED_DESCRIPTION: emptySection(0),
        MARKET_SURVEY: emptySection(1),
        ESTIMATES: emptySection(1),
      },
    },
    ...extra,
  };
}

function validationDto(): DocumentValidationDto {
  return {
    documentId: ETP_ID,
    isComplete: false,
    draftRevision: 3,
    evaluatedAt: AT,
    summary: { blocking: 1, warnings: 0 },
    sections: [],
    violations: [
      {
        code: 'SECTION_REQUIRED',
        severity: 'BLOCKING',
        message: 'Preencha a seção "Descrição da necessidade".',
        ruleId: null,
        sectionKey: 'NEED_DESCRIPTION',
        field: null,
        itemId: null,
        params: {},
      },
    ],
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
  readonly etp?: EtpDetailDto;
  readonly meta?: EtpDetailMeta;
  readonly putSection?: (call: number, init?: RequestInit) => Response | Promise<Response>;
}

function mockApi(options: ApiOptions = {}) {
  const base = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
  let sectionCalls = 0;
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === `/api/v1/etps/${ETP_ID}`) {
      return Promise.resolve(
        jsonResponse(
          { data: options.etp ?? etpDto(), meta: options.meta ?? META },
          { headers: { ETag: '"1"' } },
        ),
      );
    }
    if (method === 'PUT' && url.startsWith(`/api/v1/documents/${ETP_ID}/sections/`)) {
      sectionCalls += 1;
      const key = url.split('/').at(-1) ?? '';
      const body = bodyOf(init) as { notApplicable?: boolean };
      return Promise.resolve(
        options.putSection?.(sectionCalls, init) ??
          saved(key, 1 + sectionCalls, body.notApplicable === true ? 'NOT_APPLICABLE' : 'FILLED'),
      );
    }
    if (method === 'GET' && url === `/api/v1/documents/${ETP_ID}/validation`) {
      return Promise.resolve(jsonResponse({ data: validationDto() }));
    }
    if (method === 'GET' && url === `/api/v1/documents/${ETP_ID}/items`) {
      return Promise.resolve(
        jsonResponse(
          {
            data: [
              {
                processItemId: ID(950),
                sequence: 1,
                description: 'Tinta acrílica 18 L',
                unit: { id: ID(951), label: 'Unidade', allowsDecimal: false },
                quantity: '10.0000',
                notes: null,
                sortOrder: 0,
              },
            ],
          },
          { headers: { ETag: '"1"' } },
        ),
      );
    }
    return base(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const sectionPuts = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => init?.method === 'PUT' && requestUrl(input).includes('/sections/'),
  );
const ifMatchOf = (init: RequestInit | undefined) => new Headers(init?.headers).get('If-Match');
/** A navegação lateral de telas largas (a do menu "Seções" só existe aberta). */
function desktopNav(): HTMLElement {
  const nav = screen.getAllByRole('navigation', { name: 'Seções do ETP' }).at(-1);
  if (nav === undefined) throw new Error('navegação ausente');
  return nav;
}
const navButton = (name: RegExp) => within(desktopNav()).getByRole('button', { name });

beforeEach(async () => {
  await editorDraftStore().clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SCR-008 — editar seções do ETP (US-020)', () => {
  it('[Sucesso] autosave 1,5 s após a pausa com If-Match "s0": seção FILLED, "Salvo às HH:mm" e o ícone da navegação', async () => {
    const fetchMock = mockApi();
    const user = userEvent.setup();
    renderWithShell(<EtpEditor processId={PROCESS_ID} etpId={ETP_ID} />);
    expect(
      await screen.findByText('0 de 3 seções resolvidas · 1 seção com pendência'),
    ).toBeTruthy();
    expect(navButton(/Descrição da necessidade, Vazia, Com pendência/)).toBeTruthy();
    expect(screen.getByText('Preencha a seção "Descrição da necessidade".')).toBeTruthy();
    const field = screen.getByLabelText('Texto da seção Descrição da necessidade');
    await user.type(field, 'As escolas precisam de manutenção.');
    expect(screen.getByText('Alterações não salvas')).toBeTruthy();
    expect(sectionPuts(fetchMock)).toHaveLength(0);
    await waitFor(() => {
      expect(sectionPuts(fetchMock)).toHaveLength(1);
    });
    const [input, init] = sectionPuts(fetchMock)[0] ?? [];
    expect(requestUrl(input as RequestInfo)).toBe(
      `/api/v1/documents/${ETP_ID}/sections/NEED_DESCRIPTION`,
    );
    expect(ifMatchOf(init)).toBe('"s0"');
    expect(bodyOf(init)).toEqual({
      content: doc('As escolas precisam de manutenção.'),
      notApplicable: false,
      justification: null,
    });
    expect(await screen.findByText(/^Salvo às \d{2}:\d{2}$/)).toBeTruthy();
    expect(navButton(/Descrição da necessidade, Preenchida/)).toBeTruthy();
    expect(await editorDraftStore().loadAll(SCOPE)).toEqual({});
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Sucesso] "Não se aplica" com justificativa de 30 caracteres grava NOT_APPLICABLE e mostra só a justificativa; "Voltar a preencher" descarta-a', async () => {
    const fetchMock = mockApi();
    const user = userEvent.setup();
    renderWithShell(<EtpEditor processId={PROCESS_ID} etpId={ETP_ID} />);
    await user.click(await screen.findByRole('button', { name: /^2\. Levantamento de mercado/ }));
    await user.click(screen.getByRole('button', { name: 'Não se aplica' }));
    await user.type(screen.getByLabelText('Justificativa *'), JUSTIFICATION_30);
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => {
      expect(sectionPuts(fetchMock)).toHaveLength(1);
    });
    const [, init] = sectionPuts(fetchMock)[0] ?? [];
    expect(ifMatchOf(init)).toBe('"s1"');
    expect(bodyOf(init)).toEqual({
      content: null,
      notApplicable: true,
      justification: JUSTIFICATION_30,
    });
    expect(await screen.findByText('Esta seção não se aplica')).toBeTruthy();
    expect(screen.getByText(JUSTIFICATION_30)).toBeTruthy();
    expect(screen.queryByLabelText('Texto da seção Levantamento de mercado')).toBeNull();
    await waitFor(() => {
      expect(navButton(/Levantamento de mercado, Não se aplica/)).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: 'Voltar a preencher' }));
    await waitFor(() => {
      expect(sectionPuts(fetchMock)).toHaveLength(2);
    });
    expect(bodyOf(sectionPuts(fetchMock)[1]?.[1])).toEqual({
      content: null,
      notApplicable: false,
      justification: null,
    });
    expect(await screen.findByLabelText('Texto da seção Levantamento de mercado')).toBeTruthy();
  });

  it('[Validação] justificativa de 10 caracteres: "Explique por que esta seção não se aplica (mín. 20 caracteres)." e nada é enviado', async () => {
    const fetchMock = mockApi();
    const user = userEvent.setup();
    renderWithShell(<EtpEditor processId={PROCESS_ID} etpId={ETP_ID} />);
    await user.click(await screen.findByRole('button', { name: /^2\. Levantamento de mercado/ }));
    await user.click(screen.getByRole('button', { name: 'Não se aplica' }));
    const justification = screen.getByLabelText('Justificativa *');
    await user.type(justification, '0123456789');
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Explique por que esta seção não se aplica (mín. 20 caracteres).',
    );
    expect(document.activeElement).toBe(justification);
    expect(justification.getAttribute('aria-invalid')).toBe('true');
    expect(sectionPuts(fetchMock)).toHaveLength(0);
    expect(navButton(/Levantamento de mercado, Vazia/)).toBeTruthy();
  });

  it('[Sucesso] seção estruturada: os itens do ETP (DOC-06) em quadro somente leitura, com o texto complementar editável', async () => {
    mockApi();
    const user = userEvent.setup();
    renderWithShell(<EtpEditor processId={PROCESS_ID} etpId={ETP_ID} />);
    await user.click(await screen.findByRole('button', { name: /^3\. Estimativas/ }));
    const table = await screen.findByRole('table', { name: 'Itens do ETP (somente leitura)' });
    expect(within(table).getByText('Tinta acrílica 18 L')).toBeTruthy();
    expect(within(table).getByText('10')).toBeTruthy();
    expect(
      screen.getByLabelText('Texto complementar da seção Estimativas das quantidades e do valor'),
    ).toBeTruthy();
  });

  it('[Permissão] sem UPDATE (SOMENTE_LEITURA): todas as seções em modo leitura, sem "Não se aplica" nem gravação', async () => {
    const fetchMock = mockApi({ meta: { ...META, allowedActions: [] } });
    const user = userEvent.setup();
    renderWithShell(<EtpEditor processId={PROCESS_ID} etpId={ETP_ID} />);
    expect(await screen.findByText('Você não pode editar este ETP.')).toBeTruthy();
    const field = screen.getByLabelText<HTMLTextAreaElement>(
      'Texto da seção Descrição da necessidade',
    );
    expect(field.readOnly).toBe(true);
    await user.type(field, 'tentativa');
    expect(screen.queryByRole('button', { name: 'Não se aplica' })).toBeNull();
    expect(screen.queryByText('Alterações não salvas')).toBeNull();
    expect(sectionPuts(fetchMock)).toHaveLength(0);
  });

  it('[Permissão] FA-05: ETP em revisão abre somente leitura com "Este ETP não pode ser editado no status atual."', async () => {
    mockApi({ etp: etpDto({ status: 'IN_REVIEW' }) });
    renderWithShell(<EtpEditor processId={PROCESS_ID} etpId={ETP_ID} />);
    expect(await screen.findByText('Este ETP não pode ser editado no status atual.')).toBeTruthy();
  });

  it('[Concorrência] 412: diálogo "Alguém salvou esta seção…"; "Manter a minha versão" reenvia com "s5" e overwrittenRevision', async () => {
    const fetchMock = mockApi({
      putSection: (call) =>
        call === 1
          ? problemResponse(412, 'SECTION_REVISION_CONFLICT', {
              extension: {
                meta: {
                  current: {
                    sectionKey: 'NEED_DESCRIPTION',
                    state: 'FILLED',
                    revision: 5,
                    content: doc('Texto do Bruno'),
                    justification: null,
                    updatedAt: AT,
                    updatedBy: { id: BRUNO, name: 'Bruno Carvalho' },
                  },
                },
              },
            })
          : saved('NEED_DESCRIPTION', 6),
    });
    const user = userEvent.setup();
    renderWithShell(<EtpEditor processId={PROCESS_ID} etpId={ETP_ID} />);
    await user.type(
      await screen.findByLabelText('Texto da seção Descrição da necessidade'),
      'Texto da Carla',
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Alguém salvou esta seção enquanto você editava');
    expect(dialog.textContent).toContain('Alterado por Bruno Carvalho às 14:31.');
    await user.click(screen.getByRole('button', { name: 'Manter a minha versão' }));
    await waitFor(() => {
      expect(sectionPuts(fetchMock)).toHaveLength(2);
    });
    const [, init] = sectionPuts(fetchMock)[1] ?? [];
    expect(ifMatchOf(init)).toBe('"s5"');
    expect(bodyOf(init)).toMatchObject({ content: doc('Texto da Carla'), overwrittenRevision: 5 });
  });

  it('[Falha de banco] 503 DEPENDENCY_UNAVAILABLE: "Erro ao salvar", o texto fica na tela e no rascunho local, e a retentativa salva', async () => {
    const fetchMock = mockApi({
      putSection: (call) =>
        call === 1 ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE') : saved('NEED_DESCRIPTION', 1),
    });
    const user = userEvent.setup();
    renderWithShell(<EtpEditor processId={PROCESS_ID} etpId={ETP_ID} />);
    const field = await screen.findByLabelText<HTMLTextAreaElement>(
      'Texto da seção Descrição da necessidade',
    );
    await user.type(field, 'Texto durante a queda');
    expect(await screen.findByText('Erro ao salvar — tentando novamente')).toBeTruthy();
    expect(field.value).toBe('Texto durante a queda');
    const stored = await editorDraftStore().loadAll(SCOPE);
    expect(stored['SECTION:NEED_DESCRIPTION']).toMatchObject({
      base: 's0',
      value: { text: 'Texto durante a queda', notApplicable: false },
    });
    await waitFor(
      () => {
        expect(sectionPuts(fetchMock)).toHaveLength(2);
      },
      { timeout: 6_000 },
    );
    expect(await screen.findByText(/^Salvo às/)).toBeTruthy();
  });

  it('[Falha de integração] conexão perdida: guarda no navegador; ao reabrir, "Restaurar" reenvia o autosave pendente sobre a revisão-base', async () => {
    let online = false;
    const fetchMock = mockApi({
      putSection: () =>
        online
          ? saved('RECOMMENDED_SOLUTION', 1)
          : Promise.reject(new TypeError('Failed to fetch')),
    });
    const user = userEvent.setup();
    renderWithShell(<EtpEditor processId={PROCESS_ID} etpId={ETP_ID} />);
    await user.type(
      await screen.findByLabelText('Texto da seção Descrição da necessidade'),
      'Solução sem conexão',
    );
    expect(await screen.findByText('Erro ao salvar — tentando novamente')).toBeTruthy();
    expect(
      (await editorDraftStore().loadAll(SCOPE))['SECTION:NEED_DESCRIPTION']?.value,
    ).toMatchObject({ text: 'Solução sem conexão' });
    cleanup();
    online = true;
    fetchMock.mockClear();
    renderWithShell(<EtpEditor processId={PROCESS_ID} etpId={ETP_ID} />);
    expect(
      await screen.findByText(/^Recuperamos alterações não salvas de \d{2}:\d{2}\.$/),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Restaurar' }));
    await waitFor(() => {
      expect(sectionPuts(fetchMock)).toHaveLength(1);
    });
    expect(ifMatchOf(sectionPuts(fetchMock)[0]?.[1])).toBe('"s0"');
    expect(
      screen.getByLabelText<HTMLTextAreaElement>('Texto da seção Descrição da necessidade').value,
    ).toBe('Solução sem conexão');
    await waitFor(async () => {
      expect(await editorDraftStore().loadAll(SCOPE)).toEqual({});
    });
  });

  it('[Tenant incorreto] ETP-03 404: não abre o editor e oferece nova tentativa', async () => {
    const base = mockApi();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((input, init) =>
        requestUrl(input) === `/api/v1/etps/${ETP_ID}`
          ? Promise.resolve(problemResponse(404, 'NOT_FOUND'))
          : base(input, init),
      ),
    );
    renderWithShell(<EtpEditor processId={PROCESS_ID} etpId={ETP_ID} />);
    expect(await screen.findByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Seções do ETP' })).toBeNull();
  });
});

describe('etp-editor-model', () => {
  it('sectionDraftOf / sectionSaveBody: texto, "não se aplica" e "Manter a minha versão"', () => {
    expect(sectionDraftOf(undefined)).toEqual({
      text: '',
      notApplicable: false,
      justification: '',
    });
    const na = sectionDraftOf({
      state: 'NOT_APPLICABLE',
      content: null,
      justification: JUSTIFICATION_30,
    });
    expect(na).toEqual({ text: '', notApplicable: true, justification: JUSTIFICATION_30 });
    expect(sectionSaveBody({ ...na, justification: `  ${JUSTIFICATION_30}  ` }, 4)).toEqual({
      content: null,
      notApplicable: true,
      justification: JUSTIFICATION_30,
      overwrittenRevision: 4,
    });
    expect(sectionSaveBody({ text: '   ', notApplicable: false, justification: 'x' })).toEqual({
      content: null,
      notApplicable: false,
      justification: null,
    });
    expect(sectionDraftOf({ state: 'FILLED', content: doc('Olá'), justification: null }).text).toBe(
      'Olá',
    );
  });

  it('canEditEtp: UPDATE e DRAFT/RETURNED', () => {
    expect(canEditEtp('DRAFT', ['UPDATE'])).toBe(true);
    expect(canEditEtp('RETURNED', ['UPDATE'])).toBe(true);
    expect(canEditEtp('IN_REVIEW', ['UPDATE'])).toBe(false);
    expect(canEditEtp('DRAFT', [])).toBe(false);
  });
});
