// @vitest-environment jsdom
import type { DfdDto, DfdMeta, DocumentValidationDto } from '@contrataflow/validation';
import { cleanup, configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { editorDraftStore } from '@/lib/drafts/encrypted-drafts';
import { seriousA11yViolations } from '@test/support/axe';
import {
  DFD_ID,
  ID,
  MANUTENCAO,
  PROCESS_ID,
  bodyOf,
  callsTo,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { TENANT_A, jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { DfdWizard } from './dfd-wizard';

configure({ asyncUtilTimeout: 8_000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-015 — autosave, retomada e conflito na SCR-007 com a API simulada: indicador (DEC-182),
 * DOC-05 com `If-Match: "s<revision>"`, DFD-04 com só os campos alterados e merge do 412, diálogo
 * de conflito (FA-01), bloqueio (FA-05/06), contingência cifrada e "Recuperamos alterações não
 * salvas" (FA-03/FA-08) e a retomada do passo (RN-DFD-34). Relógio real: o debounce é 1,5 s.
 */

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
const BRUNO = '0192a000-0000-7000-8000-0000000000b7';

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
    draftRevision: 3,
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
    version: 8,
    ...extra,
  };
}

const section = (key: string, title: string, order: number) => ({
  key,
  title,
  order,
  requirement: 'REQUIRED' as const,
  helpText: null,
  legalBasis: null,
  minChars: null,
  maxChars: 50_000,
});

const META: DfdMeta = {
  allowedActions: ['UPDATE', 'FINALIZE', 'DELETE'],
  template: {
    versionId: ID(801),
    versionNumber: 1,
    sections: [
      section('JUSTIFICATION', 'Justificativa da necessidade', 1),
      section('EXPECTED_RESULTS', 'Resultados esperados', 2),
      { ...section('NOTES', 'Observações', 3), requirement: 'OPTIONAL' },
    ],
    fieldConfig: {},
  },
};

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const draftSection = (text: string, revision: number) => ({
  state: 'FILLED',
  content: doc(text),
  justification: null,
  revision,
  updatedAt: '2026-10-17T15:00:00.000Z',
  updatedById: ANA,
});

function validationDto(blocking: number): DocumentValidationDto {
  return {
    documentId: DFD_ID,
    isComplete: blocking === 0,
    draftRevision: 3,
    evaluatedAt: '2026-10-17T15:00:00.000Z',
    summary: { blocking, warnings: 0 },
    sections: [],
    violations: Array.from({ length: blocking }, () => ({
      code: 'SECTION_REQUIRED',
      severity: 'BLOCKING' as const,
      message: 'Preencha a seção.',
      ruleId: null,
      sectionKey: 'JUSTIFICATION',
      field: null,
      itemId: null,
      params: {},
    })),
  };
}

interface AutosaveApiOptions {
  readonly dfd?: DfdDto;
  readonly putSection?: (call: number, init?: RequestInit) => Response | Promise<Response>;
  readonly patchDfd?: (call: number, init?: RequestInit) => Response;
  readonly validation?: DocumentValidationDto;
}

const savedSection = (revision: number) =>
  jsonResponse(
    {
      data: {
        sectionKey: 'JUSTIFICATION',
        state: 'FILLED',
        revision,
        updatedAt: new Date().toISOString(),
        updatedBy: { id: ANA, name: 'Ana Souza' },
        draftRevision: revision,
      },
    },
    { headers: { ETag: `"s${String(revision)}"` } },
  );

function mockApi(options: AutosaveApiOptions = {}) {
  const base = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
  let sectionCalls = 0;
  let patchCalls = 0;
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === `/api/v1/dfds/${DFD_ID}`) {
      return Promise.resolve(
        jsonResponse({ data: options.dfd ?? dfdDto(), meta: META }, { headers: { ETag: '"8"' } }),
      );
    }
    if (method === 'PATCH' && url === `/api/v1/dfds/${DFD_ID}`) {
      patchCalls += 1;
      const body = bodyOf(init) as Partial<DfdDto>;
      return Promise.resolve(
        options.patchDfd?.(patchCalls, init) ??
          jsonResponse({ data: dfdDto({ ...body, version: 9 }), meta: META }),
      );
    }
    if (method === 'GET' && url === `/api/v1/documents/${DFD_ID}`) {
      return Promise.resolve(
        jsonResponse({
          data: {
            id: DFD_ID,
            draftContent: {
              sections: {
                JUSTIFICATION: draftSection('Texto anterior da justificativa', 3),
                EXPECTED_RESULTS: draftSection('Resultados anteriores', 1),
              },
            },
            version: 1,
          },
          meta: { allowedActions: ['UPDATE'] },
        }),
      );
    }
    if (method === 'PUT' && url.startsWith(`/api/v1/documents/${DFD_ID}/sections/`)) {
      sectionCalls += 1;
      return Promise.resolve(options.putSection?.(sectionCalls, init) ?? savedSection(4));
    }
    if (url === `/api/v1/documents/${DFD_ID}/items`) {
      return Promise.resolve(jsonResponse({ data: [] }, { headers: { ETag: '"1"' } }));
    }
    if (method === 'GET' && url === `/api/v1/documents/${DFD_ID}/validation`) {
      return Promise.resolve(jsonResponse({ data: options.validation ?? validationDto(0) }));
    }
    if (url.startsWith(`/api/v1/attachments`) || url.includes('/attachments?')) {
      return Promise.resolve(jsonResponse({ data: [], meta: { page: 1, totalItems: 0 } }));
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

const SCOPE = { tenantId: TENANT_A.id, userId: ANA, documentId: DFD_ID };

beforeEach(async () => {
  nav.set(`/processos/${PROCESS_ID}/dfd/${DFD_ID}?passo=justificativa`);
  nav.replace.mockClear();
  await editorDraftStore().clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SCR-007 — autosave, retomada e conflito (US-015)', () => {
  it('[Sucesso] salva a seção 1,5 s após a pausa com If-Match "s3" e mostra "Salvo às HH:mm"', async () => {
    const fetchMock = mockApi();
    const user = userEvent.setup();
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    const field = await screen.findByLabelText('Justificativa da necessidade *');
    await user.type(field, ' A UBS Centro está sem luvas.');
    expect(screen.getByText('Alterações não salvas')).toBeTruthy();
    expect(sectionPuts(fetchMock)).toHaveLength(0);
    await waitFor(() => {
      expect(sectionPuts(fetchMock)).toHaveLength(1);
    });
    const [input, init] = sectionPuts(fetchMock)[0] ?? [];
    expect(requestUrl(input as RequestInfo)).toBe(
      `/api/v1/documents/${DFD_ID}/sections/JUSTIFICATION`,
    );
    expect(ifMatchOf(init)).toBe('"s3"');
    expect(bodyOf(init)).toEqual({
      content: doc('Texto anterior da justificativa A UBS Centro está sem luvas.'),
      notApplicable: false,
      justification: null,
    });
    expect(await screen.findByText(/^Salvo às \d{2}:\d{2}$/)).toBeTruthy();
    expect(screen.getByRole('status', { name: '' }).getAttribute('aria-live')).toBe('polite');
    // Gravação confirmada: nada fica no navegador (RN-DFD-33).
    expect(await editorDraftStore().loadAll(SCOPE)).toEqual({});
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Sucesso] retoma no passo salvo; Conclusão com pendência abre a Revisão (RN-DFD-34)', async () => {
    nav.set(`/processos/${PROCESS_ID}/dfd/${DFD_ID}`);
    mockApi({ dfd: dfdDto({ wizardStep: 'PLANNING' }) });
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Planejamento' })).toBeTruthy();
    cleanup();

    mockApi({ dfd: dfdDto({ wizardStep: 'CONCLUSION' }), validation: validationDto(1) });
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Revisão' })).toBeTruthy();
  });

  it('[Sucesso] "Continuar" grava o passo e os passos concluídos pelo DFD-04 (só esses campos)', async () => {
    nav.set(`/processos/${PROCESS_ID}/dfd/${DFD_ID}?passo=identificacao`);
    const fetchMock = mockApi();
    const user = userEvent.setup();
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    await user.click(await screen.findByRole('button', { name: 'Continuar' }));
    await waitFor(() => {
      expect(callsTo(fetchMock, 'PATCH', `/api/v1/dfds/${DFD_ID}`)).toHaveLength(1);
    });
    const [patch] = callsTo(fetchMock, 'PATCH', `/api/v1/dfds/${DFD_ID}`);
    expect(ifMatchOf(patch?.init)).toBe('"8"');
    expect(bodyOf(patch?.init)).toEqual({
      wizardStep: 'JUSTIFICATION',
      completedSteps: ['IDENTIFICATION'],
    });
  });

  it('[Validação] texto acima do limite: "Erro ao salvar" com a explicação e o conteúdo guardado neste navegador', async () => {
    mockApi({
      putSection: () =>
        problemResponse(422, 'VALIDATION_ERROR', {
          errors: [
            { field: 'content', code: 'TOO_LONG', message: 'O texto excede 50.000 caracteres.' },
          ],
        }),
    });
    const user = userEvent.setup();
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    await user.type(await screen.findByLabelText('Justificativa da necessidade *'), ' mais texto');
    expect(
      await screen.findByText('Erro ao salvar: O texto excede 50.000 caracteres.'),
    ).toBeTruthy();
    const stored = await editorDraftStore().loadAll<string>(SCOPE);
    expect(stored['SECTION:JUSTIFICATION']).toMatchObject({
      base: 's3',
      value: 'Texto anterior da justificativa mais texto',
    });
  });

  it('[Permissão] perda de custódia: o autosave para e a faixa oferece "Copiar meu texto"', async () => {
    const fetchMock = mockApi({
      putSection: () => problemResponse(403, 'NOT_PROCESS_CUSTODIAN'),
    });
    const user = userEvent.setup();
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    const field = await screen.findByLabelText('Justificativa da necessidade *');
    await user.type(field, ' urgente');
    expect(
      await screen.findByText('Somente quem está com o processo (ou colaboradores) pode editar.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Suas últimas alterações foram guardadas neste navegador.'),
    ).toBeTruthy();
    expect(screen.getByText('Edição interrompida')).toBeTruthy();
    expect(
      screen.getByLabelText<HTMLTextAreaElement>('Justificativa da necessidade *').readOnly,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Copiar meu texto' }));
    expect(await screen.findByText('Texto copiado.')).toBeTruthy();
    expect(await navigator.clipboard.readText()).toContain(
      'Justificativa da necessidade\nTexto anterior da justificativa urgente',
    );
    expect(sectionPuts(fetchMock)).toHaveLength(1);
  });

  it('[Permissão] DFD enviado para aprovação em outra aba: "Este documento não pode mais ser editado (Em revisão desde 14:40)."', async () => {
    mockApi({
      putSection: () =>
        problemResponse(409, 'DOCUMENT_NOT_EDITABLE', {
          extension: {
            meta: { status: 'IN_REVIEW', statusSince: '2026-10-17T17:40:00.000Z' },
          },
        }),
    });
    const user = userEvent.setup();
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    await user.type(await screen.findByLabelText('Justificativa da necessidade *'), ' pendente');
    expect(
      await screen.findByText('Este documento não pode mais ser editado (Em revisão desde 14:40).'),
    ).toBeTruthy();
  });

  it('[Concorrência] 412 na mesma seção: diálogo com as três opções; "Manter a minha versão" reenvia com "s6" e overwrittenRevision', async () => {
    const fetchMock = mockApi({
      putSection: (call) =>
        call === 1
          ? problemResponse(412, 'SECTION_REVISION_CONFLICT', {
              extension: {
                meta: {
                  current: {
                    sectionKey: 'JUSTIFICATION',
                    state: 'FILLED',
                    revision: 6,
                    content: doc('Texto do Bruno'),
                    justification: null,
                    updatedAt: '2026-10-17T17:31:00.000Z',
                    updatedBy: { id: BRUNO, name: 'Bruno Carvalho' },
                  },
                },
              },
            })
          : savedSection(7),
    });
    const user = userEvent.setup();
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    await user.type(await screen.findByLabelText('Justificativa da necessidade *'), ' da Cláudia');
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Alterado por Bruno Carvalho às 14:31.');
    expect(screen.getByText('Conflito de edição — escolha qual versão manter')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Ver diferenças' }));
    expect(screen.getByText('[inserido]')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Descartar a minha e recarregar' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Manter a minha versão' }));
    await waitFor(() => {
      expect(sectionPuts(fetchMock)).toHaveLength(2);
    });
    const [, init] = sectionPuts(fetchMock)[1] ?? [];
    expect(ifMatchOf(init)).toBe('"s6"');
    expect(bodyOf(init)).toMatchObject({ overwrittenRevision: 6 });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('[Concorrência] "Descartar a minha e recarregar" fica com o texto do servidor sem chamar a API', async () => {
    const fetchMock = mockApi({
      putSection: () =>
        problemResponse(412, 'SECTION_REVISION_CONFLICT', {
          extension: {
            meta: {
              current: {
                sectionKey: 'JUSTIFICATION',
                state: 'FILLED',
                revision: 6,
                content: doc('Texto do Bruno'),
                justification: null,
                updatedAt: '2026-10-17T17:31:00.000Z',
                updatedBy: { id: ANA, name: 'Ana Souza' },
              },
            },
          },
        }),
    });
    const user = userEvent.setup();
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    await user.type(await screen.findByLabelText('Justificativa da necessidade *'), ' x');
    const dialog = await screen.findByRole('dialog');
    // FA-10: a mesma pessoa, em outra aba.
    expect(dialog.textContent).toContain('Você mesma, em outra aba, às 14:31.');
    await user.click(screen.getByRole('button', { name: 'Descartar a minha e recarregar' }));
    await waitFor(() => {
      expect(
        screen.getByLabelText<HTMLTextAreaElement>('Justificativa da necessidade *').value,
      ).toBe('Texto do Bruno');
    });
    expect(sectionPuts(fetchMock)).toHaveLength(1);
    expect(await editorDraftStore().loadAll(SCOPE)).toEqual({});
  });

  it('[Concorrência] cabeçalho em campos diferentes: 412 e reenvio automático com "9" só com a prioridade', async () => {
    nav.set(`/processos/${PROCESS_ID}/dfd/${DFD_ID}?passo=identificacao`);
    const fetchMock = mockApi({
      patchDfd: (call) =>
        call === 1
          ? problemResponse(412, 'VERSION_CONFLICT', {
              extension: {
                currentVersion: 9,
                meta: {
                  current: {
                    ...dfdDto({ expectedDate: '2027-03-01', version: 9 }),
                    updatedBy: { id: BRUNO, name: 'Bruno Carvalho' },
                  },
                },
              },
            })
          : jsonResponse({
              data: dfdDto({ expectedDate: '2027-03-01', priority: 'HIGH', version: 10 }),
              meta: META,
            }),
    });
    const user = userEvent.setup();
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    await user.click(await screen.findByRole('radio', { name: 'Alta' }));
    await waitFor(() => {
      expect(callsTo(fetchMock, 'PATCH', `/api/v1/dfds/${DFD_ID}`)).toHaveLength(2);
    });
    const patches = callsTo(fetchMock, 'PATCH', `/api/v1/dfds/${DFD_ID}`);
    expect(ifMatchOf(patches[0]?.init)).toBe('"8"');
    expect(bodyOf(patches[0]?.init)).toEqual({ priority: 'HIGH' });
    expect(ifMatchOf(patches[1]?.init)).toBe('"9"');
    expect(bodyOf(patches[1]?.init)).toEqual({ priority: 'HIGH' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText(/^Salvo às/)).toBeTruthy();
  });

  it('[Falha de integração] sem conexão: guarda cifrado; ao reabrir, "Recuperamos…" e "Restaurar" salva sobre a revisão-base', async () => {
    let online = false;
    const fetchMock = mockApi({
      putSection: () =>
        online ? savedSection(4) : Promise.reject(new TypeError('Failed to fetch')),
    });
    const user = userEvent.setup();
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    await user.type(await screen.findByLabelText('Justificativa da necessidade *'), ' offline');
    expect(
      await screen.findByText('Sem conexão — alterações guardadas neste navegador'),
    ).toBeTruthy();
    const stored = await editorDraftStore().loadAll<string>(SCOPE);
    expect(stored['SECTION:JUSTIFICATION']?.value).toBe('Texto anterior da justificativa offline');
    // Recarga da aba.
    cleanup();
    online = true;
    fetchMock.mockClear();
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    expect(
      await screen.findByText(/^Recuperamos alterações não salvas de \d{2}:\d{2}\.$/),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Restaurar' }));
    await waitFor(() => {
      expect(sectionPuts(fetchMock)).toHaveLength(1);
    });
    expect(ifMatchOf(sectionPuts(fetchMock)[0]?.[1])).toBe('"s3"');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Justificativa da necessidade *').value).toBe(
      'Texto anterior da justificativa offline',
    );
    await waitFor(async () => {
      expect(await editorDraftStore().loadAll(SCOPE)).toEqual({});
    });
  });

  it('[Falha de integração] "Descartar" apaga a pendência recuperada', async () => {
    await editorDraftStore().save(SCOPE, 'SECTION:JUSTIFICATION', { base: 's3', value: 'antigo' });
    const fetchMock = mockApi();
    const user = userEvent.setup();
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    await user.click(await screen.findByRole('button', { name: 'Descartar' }));
    await waitFor(async () => {
      expect(await editorDraftStore().loadAll(SCOPE)).toEqual({});
    });
    expect(sectionPuts(fetchMock)).toHaveLength(0);
  });

  it('[Falha de banco] 503: guarda e retenta com backoff até salvar sem intervenção', async () => {
    const fetchMock = mockApi({
      putSection: (call) =>
        call === 1 ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE') : savedSection(4),
    });
    const user = userEvent.setup();
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    await user.type(await screen.findByLabelText('Justificativa da necessidade *'), ' banco');
    expect(
      await screen.findByText('Sem conexão — alterações guardadas neste navegador'),
    ).toBeTruthy();
    await waitFor(
      () => {
        expect(sectionPuts(fetchMock)).toHaveLength(2);
      },
      { timeout: 6_000 },
    );
    expect(await screen.findByText(/^Salvo às/)).toBeTruthy();
  });

  it('Modo leitura: sem UPDATE o hook não grava nem mostra o indicador', async () => {
    const fetchMock = mockApi();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((input, init) => {
        if ((init?.method ?? 'GET') === 'GET' && requestUrl(input) === `/api/v1/dfds/${DFD_ID}`) {
          return Promise.resolve(
            jsonResponse({ data: dfdDto(), meta: { ...META, allowedActions: [] } }),
          );
        }
        return fetchMock(input, init);
      }),
    );
    renderWithShell(<DfdWizard processId={PROCESS_ID} dfdId={DFD_ID} />);
    expect(await screen.findByText('Este DFD está em modo leitura.')).toBeTruthy();
    expect(screen.queryByText('Alterações não salvas')).toBeNull();
    expect(sectionPuts(fetchMock)).toHaveLength(0);
  });
});
