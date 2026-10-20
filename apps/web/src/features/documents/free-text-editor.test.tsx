// @vitest-environment jsdom
import type {
  DocumentDto,
  DocumentMeta,
  DocumentTemplateMetaDto,
  DocumentTemplateSectionDto,
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

import { FreeTextEditor } from './free-text-editor';
import {
  allowsNotApplicable,
  canEditFreeText,
  freeTextJustificationProblem,
  freeTextNavItems,
  freeTextReadOnlyReason,
  sectionLimitProblem,
} from './free-text-editor-model';
import { CreateDocumentDialog } from '../process-documents/create-document-dialog';

configure({ asyncUtilTimeout: 8_000 });
vi.setConfig({ testTimeout: 30_000 });

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => '/processos',
}));

/*
 * US-063 — SCR-105 do documento livre com a API simulada: seções na ordem do template com
 * orientação e base legal, autosave com `If-Match: "s<revision>"` (DOC-05 — o mesmo mecanismo do
 * ETP/TR), aviso de limite sem enviar (FA-03 · V-06), "Não se aplica" só fora das `REQUIRED` com
 * justificativa ≥ 20 (V-07), conflito de seção (FA-02 · V-08), falha de rede (FA-01), modo leitura
 * (V-09) e o `CreateDocumentDialog` do livre (título + responsável opcional → DOC-02 → SCR-105).
 * Relógio real: o debounce é 1,5 s.
 */

const ANA = '0192a000-0000-7000-8000-0000000000a1';
const BRUNO = '0192a000-0000-7000-8000-0000000000b7';
const DOC_ID = ID(950);
const AT = '2026-10-19T17:31:00.000Z';
const SCOPE = { tenantId: TENANT_A.id, userId: ANA, documentId: DOC_ID };
const JUSTIFICATION_30 = 'Não há unidade destinatária ok';

const section = (
  key: string,
  title: string,
  order: number,
  extra: Partial<DocumentTemplateSectionDto> = {},
): DocumentTemplateSectionDto => ({
  key,
  title,
  order,
  requirement: 'REQUIRED',
  helpText: null,
  legalBasis: null,
  minChars: null,
  maxChars: 50_000,
  ...extra,
});

const TEMPLATE: DocumentTemplateMetaDto = {
  versionId: ID(951),
  versionNumber: 1,
  sections: [
    section('RECIPIENT', 'Destinatário', 2, { requirement: 'REQUIRED_OR_JUSTIFY', maxChars: 40 }),
    section('SUBJECT', 'Assunto', 1, {
      helpText: 'Indique o encaminhamento ou a decisão.',
      legalBasis: 'Lei 14.133/2021, art. 40',
    }),
    section('NOTES', 'Observações', 3, { requirement: 'OPTIONAL' }),
  ],
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

function documentDto(extra: Partial<DocumentDto> = {}): DocumentDto {
  return {
    id: DOC_ID,
    processId: PROCESS_ID,
    documentType: {
      id: ID(960),
      code: 'DESPACHO',
      name: 'Despacho',
      kind: 'FREE_TEXT',
      systemModule: null,
      requiresApproval: false,
    },
    templateVersionId: TEMPLATE.versionId,
    number: 1,
    year: 2026,
    code: 'DESP 0001/2026',
    title: 'Encaminhamento à Secretaria de Obras',
    status: 'DRAFT',
    confidentiality: 'INTERNAL',
    draftContent: {
      sections: {
        SUBJECT: emptySection(1),
        RECIPIENT: emptySection(1),
        NOTES: emptySection(1),
      },
    },
    draftRevision: 1,
    currentVersionId: null,
    currentVersionNumber: null,
    approvedVersionId: null,
    pendingApprovalId: null,
    responsibleId: ANA,
    submittedAt: null,
    submittedById: null,
    finalizedAt: null,
    finalizedById: null,
    approvedAt: null,
    returnedAt: null,
    rejectedAt: null,
    reopenedAt: null,
    reopenedById: null,
    reopenReason: null,
    canceledAt: null,
    canceledById: null,
    cancellationReason: null,
    sourceDocumentId: null,
    createdAt: AT,
    updatedAt: AT,
    createdById: ANA,
    version: 1,
    ...extra,
  };
}

const META: DocumentMeta = { allowedActions: ['UPDATE', 'FINALIZE'], template: TEMPLATE };

const saved = (sectionKey: string, revision: number, state = 'FILLED') =>
  jsonResponse(
    {
      data: {
        sectionKey,
        state,
        revision,
        updatedAt: new Date().toISOString(),
        updatedBy: { id: ANA, name: 'Ana Souza' },
        draftRevision: 2,
      },
    },
    { headers: { ETag: `"s${String(revision)}"` } },
  );

function mockApi(
  options: { putSection?: (call: number) => Response | Promise<Response> | undefined } = {},
) {
  const base = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
  let calls = 0;
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    if (init?.method === 'PUT' && url.startsWith(`/api/v1/documents/${DOC_ID}/sections/`)) {
      calls += 1;
      const key = url.split('/').at(-1) ?? '';
      const body = bodyOf(init) as { notApplicable?: boolean };
      return Promise.resolve(
        options.putSection?.(calls) ??
          saved(key, 1 + calls, body.notApplicable === true ? 'NOT_APPLICABLE' : 'FILLED'),
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
const headerOf = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers).get(name);
function desktopNav(): HTMLElement {
  const nav = screen.getAllByRole('navigation', { name: 'Seções do documento' }).at(-1);
  if (nav === undefined) throw new Error('navegação ausente');
  return nav;
}
const navButton = (name: RegExp) => within(desktopNav()).getByRole('button', { name });

function renderEditor(document = documentDto(), meta: DocumentMeta = META) {
  return renderWithShell(<FreeTextEditor document={document} meta={meta} template={TEMPLATE} />);
}

beforeEach(async () => {
  push.mockReset();
  await editorDraftStore().clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SCR-105 — editor do documento livre (US-063)', () => {
  it('[Sucesso] seções na ordem do template, com estado, exigência, orientação e base legal', async () => {
    mockApi();
    renderEditor();
    expect(await screen.findByRole('heading', { name: 'Conteúdo do documento' })).toBeTruthy();
    const first = navButton(/^1\. Assunto, Obrigatória, Vazia$/);
    expect(first.getAttribute('aria-current')).toBe('true');
    expect(navButton(/^2\. Destinatário, Obrigatória ou justificada, Vazia$/)).toBeTruthy();
    expect(navButton(/^3\. Observações, Opcional, Vazia$/)).toBeTruthy();
    expect(screen.getByText(/Base legal: Lei 14\.133\/2021, art\. 40/)).toBeTruthy();
    expect(screen.getByText('Indique o encaminhamento ou a decisão.')).toBeTruthy();
  });

  it('[Sucesso] autosave após a pausa com If-Match "s1": "Salvo às HH:mm", seção preenchida e nada pendente no navegador', async () => {
    const fetchMock = mockApi();
    const user = userEvent.setup();
    renderEditor();
    const field = await screen.findByLabelText('Texto da seção Assunto');
    await user.type(field, 'Encaminhem-se os autos.');
    expect(screen.getByText('Alterações não salvas')).toBeTruthy();
    expect(sectionPuts(fetchMock)).toHaveLength(0);
    await waitFor(() => {
      expect(sectionPuts(fetchMock)).toHaveLength(1);
    });
    const [input, init] = sectionPuts(fetchMock)[0] ?? [];
    expect(requestUrl(input as RequestInfo)).toBe(`/api/v1/documents/${DOC_ID}/sections/SUBJECT`);
    expect(headerOf(init, 'If-Match')).toBe('"s1"');
    expect(bodyOf(init)).toEqual({
      content: doc('Encaminhem-se os autos.'),
      notApplicable: false,
      justification: null,
    });
    expect(await screen.findByText(/^Salvo às \d{2}:\d{2}$/)).toBeTruthy();
    expect(navButton(/Assunto, Obrigatória, Preenchida/)).toBeTruthy();
    expect(await editorDraftStore().loadAll(SCOPE)).toEqual({});
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Validação] FA-03: texto acima do limite mostra "O texto desta seção excede o limite permitido." e não é enviado', async () => {
    const fetchMock = mockApi();
    const user = userEvent.setup();
    renderEditor();
    await user.click(await screen.findByRole('button', { name: /^2\. Destinatário/ }));
    const field = await screen.findByLabelText('Texto da seção Destinatário');
    await user.click(field);
    await user.paste('x'.repeat(41));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'O texto desta seção excede o limite permitido.',
    );
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('41 de 40 caracteres')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(sectionPuts(fetchMock)).toHaveLength(0);
  });

  it('[Validação] "Não se aplica" só fora das REQUIRED; justificativa curta é recusada (V-07) e a válida grava NOT_APPLICABLE', async () => {
    const fetchMock = mockApi();
    const user = userEvent.setup();
    renderEditor();
    await screen.findByLabelText('Texto da seção Assunto');
    expect(screen.queryByRole('button', { name: 'Não se aplica' })).toBeNull();
    await user.click(navButton(/^2\. Destinatário/));
    await user.click(await screen.findByRole('button', { name: 'Não se aplica' }));
    const justification = screen.getByLabelText('Justificativa *');
    await user.type(justification, 'Sem destino');
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Justifique por que esta seção não se aplica (mín. 20 caracteres).',
    );
    expect(sectionPuts(fetchMock)).toHaveLength(0);

    await user.clear(justification);
    await user.type(justification, JUSTIFICATION_30);
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
      expect(navButton(/Destinatário, Obrigatória ou justificada, Não se aplica/)).toBeTruthy();
    });
  });

  it('[Concorrência] 412 SECTION_REVISION_CONFLICT: o diálogo oferece ver e sobrescrever; manter reenvia sobre "s4"', async () => {
    const conflict = problemResponse(412, 'SECTION_REVISION_CONFLICT', {
      extension: {
        meta: {
          current: {
            sectionKey: 'SUBJECT',
            state: 'FILLED',
            revision: 4,
            content: doc('Texto da Carla'),
            justification: null,
            updatedAt: AT,
            updatedBy: { id: BRUNO, name: 'Carla Dias' },
          },
        },
      },
    });
    const fetchMock = mockApi({
      putSection: (call) => (call === 1 ? conflict : saved('SUBJECT', 5)),
    });
    const user = userEvent.setup();
    renderEditor();
    await user.type(await screen.findByLabelText('Texto da seção Assunto'), 'Texto da Ana');
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Esta seção foi alterada por outra pessoa');
    expect(dialog.textContent).toContain('Carla Dias');
    expect(within(dialog).getByRole('button', { name: 'Ver diferenças' })).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Manter a minha versão' }));
    await waitFor(() => {
      expect(sectionPuts(fetchMock)).toHaveLength(2);
    });
    const [, init] = sectionPuts(fetchMock)[1] ?? [];
    expect(headerOf(init, 'If-Match')).toBe('"s4"');
    expect(bodyOf(init)).toMatchObject({ content: doc('Texto da Ana'), overwrittenRevision: 4 });
  });

  it('[Falha de banco] FA-01: 503 no autosave mantém o texto no editor e na contingência local', async () => {
    mockApi({ putSection: () => problemResponse(503, 'DEPENDENCY_UNAVAILABLE') });
    const user = userEvent.setup();
    renderEditor();
    const field = await screen.findByLabelText<HTMLTextAreaElement>('Texto da seção Assunto');
    await user.type(field, 'Texto que não pode se perder');
    expect((await screen.findAllByText(/Não foi possível salvar/)).length).toBeGreaterThan(0);
    expect(field.value).toBe('Texto que não pode se perder');
    await waitFor(async () => {
      expect(Object.keys(await editorDraftStore().loadAll(SCOPE))).toEqual(['SECTION:SUBJECT']);
    });
  });

  it('[Permissão] sem UPDATE ou fora de DRAFT/RETURNED: somente leitura, sem autosave nem "Não se aplica"', async () => {
    mockApi();
    renderEditor(documentDto(), { allowedActions: [], template: TEMPLATE });
    expect(await screen.findByText('Você não pode editar este documento agora.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Texto da seção Assunto').readOnly).toBe(
      true,
    );
    expect(screen.queryByText('Alterações não salvas')).toBeNull();
    cleanup();
    renderEditor(documentDto({ status: 'FINALIZED' }), META);
    expect(await screen.findByText('Este documento não pode ser editado no momento.')).toBeTruthy();
  });
});

describe('US-063 — CreateDocumentDialog do livre', () => {
  const type = {
    id: ID(960),
    code: 'DESPACHO',
    name: 'Despacho',
    kind: 'FREE_TEXT' as const,
    systemModule: null,
    singular: false,
    sortOrder: 60,
  };

  it('[Sucesso] título + responsável buscado → DOC-02 com Idempotency-Key e responsibleId → SCR-105', async () => {
    const base = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.startsWith('/api/v1/users/lookup')) {
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                id: BRUNO,
                name: 'Bruno Carvalho',
                email: 'bruno@a.test',
                membershipType: 'INTERNAL',
                membershipExpiresAt: null,
              },
            ],
          }),
        );
      }
      if (init?.method === 'POST' && url === `/api/v1/processes/${PROCESS_ID}/documents`) {
        return Promise.resolve(
          jsonResponse(
            { data: documentDto(), meta: META },
            { status: 201, headers: { ETag: '"1"' } },
          ),
        );
      }
      return base(input, init);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderWithShell(<CreateDocumentDialog processId={PROCESS_ID} type={type} onClose={vi.fn()} />);
    const user = userEvent.setup();
    expect(await screen.findByText(/O documento nasce do modelo do tipo/)).toBeTruthy();
    expect(screen.getByText('Em branco, o responsável é você.')).toBeTruthy();
    await user.type(screen.getByLabelText('Título'), 'Encaminhamento à Secretaria de Obras');
    await user.type(screen.getByLabelText('Responsável'), 'Bru');
    await user.click(await screen.findByRole('button', { name: /Bruno Carvalho/ }));
    await user.click(screen.getByRole('button', { name: 'Criar e redigir' }));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}/documentos/${DOC_ID}`);
    });
    const [created] = fetchMock.mock.calls.filter(
      ([input, init]) =>
        init?.method === 'POST' &&
        requestUrl(input) === `/api/v1/processes/${PROCESS_ID}/documents`,
    );
    expect(bodyOf(created?.[1])).toEqual({
      documentTypeId: type.id,
      title: 'Encaminhamento à Secretaria de Obras',
      responsibleId: BRUNO,
    });
    expect(new Headers(created?.[1]?.headers).get('Idempotency-Key')).toBeTruthy();
  });

  it('V-03: tipo sem modelo publicado → a mensagem da API no campo, sem navegar', async () => {
    const base = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((input, init) =>
        init?.method === 'POST'
          ? Promise.resolve(
              problemResponse(422, 'VALIDATION_ERROR', {
                errors: [
                  {
                    field: 'documentTypeId',
                    code: 'REFERENCE_INACTIVE',
                    message:
                      'Este tipo de documento não tem um modelo publicado. Fale com o administrador.',
                  },
                ],
              }),
            )
          : base(input, init),
      ),
    );
    renderWithShell(<CreateDocumentDialog processId={PROCESS_ID} type={type} onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Título'), 'Encaminhamento à Secretaria de Obras');
    await user.click(screen.getByRole('button', { name: 'Criar e redigir' }));
    expect(
      await screen.findByText(
        'Este tipo de documento não tem um modelo publicado. Fale com o administrador.',
      ),
    ).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
});

describe('free-text-editor-model', () => {
  it('canEditFreeText / freeTextReadOnlyReason: UPDATE e DRAFT/RETURNED; senão fora de edição ou sem permissão', () => {
    expect(canEditFreeText('DRAFT', ['UPDATE'])).toBe(true);
    expect(canEditFreeText('RETURNED', ['UPDATE'])).toBe(true);
    expect(canEditFreeText('FINALIZED', ['UPDATE'])).toBe(false);
    expect(canEditFreeText('DRAFT', [])).toBe(false);
    expect(freeTextReadOnlyReason('DRAFT', ['UPDATE'])).toBeNull();
    expect(freeTextReadOnlyReason('RETURNED', [])).toBe('forbidden');
    for (const status of ['FINALIZED', 'APPROVED', 'IN_REVIEW', 'CANCELED'] as const) {
      expect(freeTextReadOnlyReason(status, ['UPDATE'])).toBe('notEditable');
    }
  });

  it('freeTextNavItems: ordem do template e estado gravado (EMPTY quando ausente)', () => {
    expect(freeTextNavItems(TEMPLATE.sections, { SUBJECT: 'FILLED' })).toEqual([
      { key: 'SUBJECT', title: 'Assunto', requirement: 'REQUIRED', state: 'FILLED' },
      {
        key: 'RECIPIENT',
        title: 'Destinatário',
        requirement: 'REQUIRED_OR_JUSTIFY',
        state: 'EMPTY',
      },
      { key: 'NOTES', title: 'Observações', requirement: 'OPTIONAL', state: 'EMPTY' },
    ]);
  });

  it('allowsNotApplicable e freeTextJustificationProblem (RN-DOC-28 · V-07)', () => {
    expect(allowsNotApplicable('REQUIRED')).toBe(false);
    expect(allowsNotApplicable('REQUIRED_OR_JUSTIFY')).toBe(true);
    expect(allowsNotApplicable('OPTIONAL')).toBe(true);
    expect(freeTextJustificationProblem('   curta    ')).toBe(
      'Justifique por que esta seção não se aplica (mín. 20 caracteres).',
    );
    expect(freeTextJustificationProblem(JUSTIFICATION_30)).toBeNull();
  });

  it('sectionLimitProblem: acima de maxChars ou perto de 1 MB (FA-03)', () => {
    expect(sectionLimitProblem('a'.repeat(40), 40)).toBeNull();
    expect(sectionLimitProblem('a'.repeat(41), 40)).toBe(
      'O texto desta seção excede o limite permitido.',
    );
    // 400 mil caracteres de 3 bytes ≈ 1,2 MB: dentro de maxChars, mas acima da folga de 1 MB.
    expect(sectionLimitProblem('€'.repeat(400_000), 500_000)).toBe(
      'O texto desta seção excede o limite permitido.',
    );
  });
});
