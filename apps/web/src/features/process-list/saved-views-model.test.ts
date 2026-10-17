import { SAVED_VIEW_MESSAGES } from '@contrataflow/validation';
import type { ProcessColumnKey, SavedViewDto, SavedViewFilters } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import {
  applyView,
  buildAvailability,
  classifyExportError,
  classifyViewError,
  columnIdOf,
  columnIdsFromView,
  columnKeyOf,
  columnKeysFromVisible,
  countCsvRows,
  currentDefinition,
  exceedsExportLimit,
  exportFailureMessage,
  exportQuery,
  findDefaultView,
  groupViews,
  hasUnsavedChanges,
  pruneStaleFilters,
  summarizeCriteria,
  upsertView,
  validateViewName,
  viewFailureMessage,
} from './saved-views-model';
import type { CriteriaLabels } from './saved-views-model';

const ID = (n: number) => `0192a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function view(overrides: Partial<SavedViewDto> = {}): SavedViewDto {
  return {
    id: ID(900),
    name: 'Atrasados por prioridade',
    scope: 'PROCESS_LIST',
    filters: { v: 1, status: ['IN_PROGRESS', 'RETURNED'], overdue: true },
    sort: '-priority',
    columns: ['code', 'title', 'status', 'currentResponsible'],
    isShared: false,
    isDefault: false,
    owner: { id: ID(1), name: 'Patrícia' },
    isOwner: true,
    version: 3,
    ...overrides,
  };
}

const LABELS: CriteriaLabels = {
  filter: (key) => (key === 'status' ? 'Status' : key === 'q' ? 'Busca' : key),
  value: (key, raw) => (key === 'status' ? 'Em andamento' : raw),
  flag: (key) => (key === 'overdue' ? 'Atrasados' : 'Prazo alvo vencido'),
  sortTerm: (field, direction) => `${field === 'priority' ? 'Prioridade' : field} (${direction})`,
  sortPrefix: 'Ordenação',
  empty: 'Todos os processos',
};

describe('colunas: tela ⇄ visão', () => {
  it('mapeia responsible ⇄ currentResponsible e ignora o que a tela não tem', () => {
    expect(columnIdOf('currentResponsible')).toBe('responsible');
    expect(columnIdOf('tags')).toBeNull();
    expect(columnIdOf('status')).toBe('status');
    expect(columnKeyOf('responsible')).toBe('currentResponsible');
    expect(columnKeyOf('estimatedValue')).toBe('estimatedValue');
    expect(columnKeyOf('desconhecida')).toBeNull();
    expect(columnIdsFromView(['code', 'tags', 'currentResponsible', 'code'])).toEqual([
      'code',
      'responsible',
    ]);
  });

  it('colunas visíveis viram chaves na ordem da tela, com code e title sempre presentes', () => {
    expect(columnKeysFromVisible(['code', 'title', 'status', 'responsible'])).toEqual([
      'code',
      'title',
      'status',
      'currentResponsible',
    ]);
    expect(columnKeysFromVisible(['status', 'status', 'x'])).toEqual(['code', 'title', 'status']);
    expect(columnKeysFromVisible([])).toEqual(['code', 'title']);
  });
});

describe('filtros desatualizados (FA-05 · RN-PROC-39)', () => {
  const filters: SavedViewFilters = {
    v: 1,
    currentDepartmentId: ['mine', ID(10), ID(11)],
    requestingSecretariatId: [ID(12)],
    modalityId: ['none', ID(20)],
    contractingTypeId: [ID(30)],
    organizationId: [ID(40)],
    originId: [ID(50)],
    currentResponsibleId: ['me'],
    overdue: true,
  };

  it('descarta ids que não existem e mantém os existentes, inativos e valores reservados', () => {
    const availability = buildAvailability({
      units: [{ id: ID(10) }],
      organizations: [{ id: ID(40) }],
      contractingTypes: [{ id: ID(30) }], // inclui inativos: as opções carregadas já os trazem
      modalities: [],
      origins: [{ id: ID(51) }],
    });
    const result = pruneStaleFilters(filters, availability);
    expect(result.dropped).toBe(true);
    expect(result.filters).toEqual({
      v: 1,
      currentDepartmentId: ['mine', ID(10)],
      modalityId: ['none'],
      contractingTypeId: [ID(30)],
      organizationId: [ID(40)],
      currentResponsibleId: ['me'],
      overdue: true,
    });
  });

  it('sem opções confirmadas (não carregadas ou truncadas) nada é descartado', () => {
    const truncated = Array.from({ length: 50 }, (_, index) => ({ id: ID(index + 100) }));
    const availability = buildAvailability({ units: truncated, organizations: undefined });
    expect(availability.units).toBeUndefined();
    expect(availability.organizations).toBeUndefined();
    const result = pruneStaleFilters(filters, availability);
    expect(result.dropped).toBe(false);
    expect(result.filters).toEqual(filters);
  });

  it('nenhum valor descartado = sem aviso', () => {
    const availability = buildAvailability({
      units: [{ id: ID(10) }, { id: ID(11) }, { id: ID(12) }],
    });
    expect(pruneStaleFilters(filters, availability).dropped).toBe(false);
  });

  it('aplicar a visão escreve filtros e ordenação nos parâmetros e devolve as colunas da tela', () => {
    const applied = applyView(view(), buildAvailability({}));
    expect(applied.params).toEqual({
      status: 'IN_PROGRESS,RETURNED',
      overdue: 'true',
      sort: '-priority',
    });
    expect(applied.columnIds).toEqual(['code', 'title', 'status', 'responsible']);
    expect(applied.dropped).toBe(false);

    const stale = applyView(
      view({ filters: { v: 1, currentDepartmentId: [ID(99)] }, sort: null }),
      buildAvailability({ units: [] }),
    );
    expect(stale.params).toEqual({});
    expect(stale.dropped).toBe(true);
  });
});

describe('estado atual → visão e "Alterações não salvas"', () => {
  const visible = ['code', 'title', 'status', 'responsible'];
  const available = new Set<ProcessColumnKey>([
    'code',
    'title',
    'status',
    'currentResponsible',
    'priority',
  ]);

  it('monta filtros, ordenação e colunas sem paginação', () => {
    expect(
      currentDefinition({ status: 'RETURNED,IN_PROGRESS', overdue: 'true', page: '3' }, visible),
    ).toEqual({
      filters: { v: 1, status: ['RETURNED', 'IN_PROGRESS'], overdue: true },
      sort: null,
      columns: ['code', 'title', 'status', 'currentResponsible'],
    });
    expect(currentDefinition({ sort: ' -priority ' }, visible).sort).toBe('-priority');
  });

  it('igual à visão (mesmo com outra ordem de valores e colunas) = sem alterações', () => {
    const current = currentDefinition(
      { status: 'RETURNED,IN_PROGRESS', overdue: 'true', sort: '-priority', page: '2' },
      ['code', 'title', 'responsible', 'status'],
    );
    expect(hasUnsavedChanges(view(), current, available)).toBe(false);
  });

  it('detecta mudança de filtro, de ordenação e de colunas', () => {
    const same = { status: 'IN_PROGRESS,RETURNED', overdue: 'true', sort: '-priority' };
    expect(
      hasUnsavedChanges(
        view(),
        currentDefinition({ status: same.status, sort: same.sort }, visible),
      ),
    ).toBe(true);
    expect(
      hasUnsavedChanges(view(), currentDefinition({ ...same, status: 'RETURNED' }, visible)),
    ).toBe(true);
    expect(hasUnsavedChanges(view(), currentDefinition({ ...same, sort: 'code' }, visible))).toBe(
      true,
    );
    expect(
      hasUnsavedChanges(
        view(),
        currentDefinition({ status: same.status, overdue: same.overdue }, visible),
      ),
    ).toBe(true);
    expect(
      hasUnsavedChanges(view(), currentDefinition(same, [...visible, 'priority']), available),
    ).toBe(true);
    expect(hasUnsavedChanges(view(), currentDefinition(same, ['code', 'title']), available)).toBe(
      true,
    );
  });

  it('colunas que a tela não oferece (tags, órgão com um só órgão) não contam como alteração', () => {
    const withTags = view({ columns: ['code', 'title', 'status', 'currentResponsible', 'tags'] });
    const current = currentDefinition(
      { status: 'IN_PROGRESS,RETURNED', overdue: 'true', sort: '-priority' },
      visible,
    );
    expect(hasUnsavedChanges(withTags, current, available)).toBe(false);
    const withOrganization = view({
      columns: ['code', 'title', 'status', 'currentResponsible', 'organization'],
    });
    expect(hasUnsavedChanges(withOrganization, current, available)).toBe(false);
  });

  it('sort vazio e nulo são equivalentes', () => {
    const current = currentDefinition({ status: 'IN_PROGRESS,RETURNED', overdue: 'true' }, visible);
    expect(hasUnsavedChanges(view({ sort: '' }), current)).toBe(false);
    expect(hasUnsavedChanges(view({ sort: null }), current)).toBe(false);
  });
});

describe('resumo dos critérios', () => {
  it('lista filtros, atalhos booleanos e ordenação na mesma ordem da tela', () => {
    expect(
      summarizeCriteria({ status: 'IN_PROGRESS', overdue: 'true', sort: '-priority' }, LABELS),
    ).toBe('Status: Em andamento · Atrasados · Ordenação: Prioridade (desc)');
    expect(summarizeCriteria({ q: 'cimento', sort: 'priority,-code' }, LABELS)).toBe(
      'Busca: cimento · Ordenação: Prioridade (asc), code (desc)',
    );
  });

  it('sem critérios, usa o texto de "todos"; paginação não entra', () => {
    expect(summarizeCriteria({}, LABELS)).toBe('Todos os processos');
    expect(summarizeCriteria({ page: '2', pageSize: '50' }, LABELS)).toBe('Todos os processos');
  });
});

describe('exportação (PRC-34)', () => {
  it('query sem paginação, com colunas na ordem da tela e a visão de origem', () => {
    expect(
      exportQuery(
        { status: 'IN_PROGRESS', sort: '-priority', page: '4', pageSize: '50' },
        ['code', 'title', 'currentResponsible'],
        ID(900),
      ),
    ).toEqual({
      status: 'IN_PROGRESS',
      sort: '-priority',
      columns: 'code,title,currentResponsible',
      savedViewId: ID(900),
    });
    expect(exportQuery({}, ['code', 'title'])).toEqual({ columns: 'code,title' });
  });

  it('limite de 10.000 linhas (RN-PROC-41)', () => {
    expect(exceedsExportLimit(10_000)).toBe(false);
    expect(exceedsExportLimit(10_001)).toBe(true);
  });

  it('conta as linhas de dados: ignora BOM, cabeçalho, CRLF e quebras dentro de aspas', () => {
    expect(countCsvRows('')).toBe(0);
    expect(countCsvRows('\uFEFFCódigo;Título\r\n')).toBe(0);
    expect(countCsvRows('\uFEFFCódigo;Título\r\n0012/2026;A\r\n0031/2026;B\r\n')).toBe(2);
    expect(countCsvRows('Código;Título\r\n0012/2026;A\r\n0031/2026;B')).toBe(2);
    expect(countCsvRows('C;T\r\n1;"linha 1\r\nlinha 2"\r\n2;"a ""b"""\r\n')).toBe(2);
  });

  it('classifica os erros de PRC-34', () => {
    const tooLarge = new ApiError({
      status: 422,
      code: 'EXPORT_TOO_LARGE',
      problem: {
        type: 'https://x.test/e',
        title: 't',
        status: 422,
        detail: 'd',
        instance: '/',
        code: 'EXPORT_TOO_LARGE',
        correlationId: 'c',
        errors: [],
        violations: [],
        meta: { totalItems: 10_240 },
      },
    });
    const failure = classifyExportError(tooLarge);
    expect(failure).toEqual({ kind: 'tooLarge', total: 10_240 });
    expect(exportFailureMessage(failure)).toBe(
      'A consulta tem 10.240 processos. Refine os filtros para exportar até 10.000.',
    );
    expect(classifyExportError(new ApiError({ status: 422, code: 'EXPORT_TOO_LARGE' }))).toEqual({
      kind: 'tooLarge',
      total: null,
    });
    expect(exportFailureMessage({ kind: 'tooLarge', total: null })).toBeNull();
    expect(classifyExportError(new ApiError({ status: 422, code: 'VALIDATION_ERROR' }))).toEqual({
      kind: 'validation',
    });
    expect(classifyExportError(new ApiError({ status: 403, code: 'PERMISSION_DENIED' }))).toEqual({
      kind: 'forbidden',
    });
    expect(
      classifyExportError(
        new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 30 }),
      ),
    ).toEqual({ kind: 'rateLimited', retryAfterSeconds: 30 });
    // 503 sem problem+json = conexão caída no meio do envio (apiDownload).
    expect(
      classifyExportError(new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' })),
    ).toEqual({ kind: 'interrupted' });
    expect(
      exportFailureMessage(
        classifyExportError(new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' })),
      ),
    ).toBe('A exportação foi interrompida. Tente novamente.');
    expect(classifyExportError(new Error('x'))).toEqual({
      kind: 'unexpected',
      correlationId: null,
    });
    expect(
      classifyExportError(
        new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c9' }),
      ),
    ).toEqual({ kind: 'unavailable', correlationId: 'c9' });
    expect(
      classifyExportError(new ApiError({ status: 400, code: 'X', correlationId: 'c1' })),
    ).toEqual({ kind: 'unexpected', correlationId: 'c1' });
    expect(exportFailureMessage({ kind: 'rateLimited', retryAfterSeconds: null })).toBe(
      'Aguarde a exportação em andamento terminar.',
    );
    expect(exportFailureMessage({ kind: 'forbidden' })).toBe(
      'Você não tem permissão para exportar processos.',
    );
    expect(exportFailureMessage({ kind: 'validation' })).toBe(
      'Alguns filtros eram inválidos. Revise a consulta.',
    );
    expect(exportFailureMessage({ kind: 'unavailable', correlationId: null })).toBe(
      'Não foi possível exportar agora. Tente novamente em instantes.',
    );
    expect(exportFailureMessage({ kind: 'unexpected', correlationId: null })).toBeNull();
  });
});

describe('erros de PRC-35..38', () => {
  const failure = (status: number, code: string, extra: object = {}) =>
    new ApiError({ status, code, ...extra });

  it('409 → nome repetido; 412/428/404/403 → conflito, recarga ou posse', () => {
    expect(classifyViewError(failure(409, 'CONFLICT'), 'create')).toEqual({ kind: 'nameTaken' });
    expect(classifyViewError(failure(412, 'VERSION_CONFLICT'), 'change')).toEqual({
      kind: 'versionConflict',
    });
    expect(classifyViewError(failure(428, 'PRECONDITION_REQUIRED'), 'change')).toEqual({
      kind: 'precondition',
    });
    expect(classifyViewError(failure(404, 'NOT_FOUND'), 'change')).toEqual({ kind: 'notFound' });
    expect(classifyViewError(failure(403, 'PERMISSION_DENIED'), 'change')).toEqual({
      kind: 'notOwner',
    });
    expect(classifyViewError(failure(403, 'PERMISSION_DENIED'), 'create')).toEqual({
      kind: 'forbidden',
    });
    expect(
      classifyViewError(failure(503, 'DEPENDENCY_UNAVAILABLE', { correlationId: 'c2' }), 'create'),
    ).toEqual({ kind: 'unavailable', correlationId: 'c2' });
    expect(classifyViewError(failure(400, 'MALFORMED_REQUEST'), 'create')).toEqual({
      kind: 'unexpected',
      correlationId: null,
    });
    expect(classifyViewError('x', 'create')).toEqual({ kind: 'unexpected', correlationId: null });
  });

  it('422 separa erros por campo da mensagem geral (limite de 20, padrão compartilhada…)', () => {
    const fields = classifyViewError(
      failure(422, 'VALIDATION_ERROR', {
        errors: [
          { field: 'name', code: 'INVALID_FORMAT', message: 'Nome longo demais.' },
          { field: 'filters', code: 'INVALID_FORMAT', message: '' },
          { field: 'columns', code: 'INVALID_FORMAT', message: 'Colunas?' },
          { field: 'name', code: 'INVALID_FORMAT', message: 'repetido' },
        ],
      }),
      'create',
    );
    expect(fields).toEqual({
      kind: 'validation',
      fields: {
        name: 'Nome longo demais.',
        filters: SAVED_VIEW_MESSAGES.invalidFilters,
        columns: 'Colunas?',
      },
      message: null,
    });
    const general = classifyViewError(
      failure(422, 'VALIDATION_ERROR', {
        errors: [
          {
            field: 'isDefault',
            code: 'INVALID_FORMAT',
            message: SAVED_VIEW_MESSAGES.sharedDefault,
          },
        ],
      }),
      'change',
    );
    expect(general).toEqual({
      kind: 'validation',
      fields: {},
      message: SAVED_VIEW_MESSAGES.sharedDefault,
    });
    expect(classifyViewError(failure(422, 'VALIDATION_ERROR'), 'create')).toEqual({
      kind: 'validation',
      fields: {},
      message: SAVED_VIEW_MESSAGES.invalid,
    });
  });

  it('mensagens pt-BR das constantes compartilhadas', () => {
    expect(viewFailureMessage({ kind: 'nameTaken' })).toBe(SAVED_VIEW_MESSAGES.nameTaken);
    expect(viewFailureMessage({ kind: 'versionConflict' })).toBe(
      SAVED_VIEW_MESSAGES.versionConflict,
    );
    expect(viewFailureMessage({ kind: 'notOwner' })).toBe(SAVED_VIEW_MESSAGES.notOwner);
    expect(viewFailureMessage({ kind: 'notFound' })).toBe(SAVED_VIEW_MESSAGES.notFound);
    expect(viewFailureMessage({ kind: 'precondition' })).toBe(
      SAVED_VIEW_MESSAGES.preconditionRequired,
    );
    expect(viewFailureMessage({ kind: 'forbidden' })).toBe(SAVED_VIEW_MESSAGES.forbidden);
    expect(viewFailureMessage({ kind: 'validation', fields: {}, message: null })).toBe(
      SAVED_VIEW_MESSAGES.invalid,
    );
    expect(viewFailureMessage({ kind: 'unavailable', correlationId: null })).toBeNull();
    expect(viewFailureMessage({ kind: 'unexpected', correlationId: null })).toBeNull();
  });

  it('V-01: nome de 1 a 80 caracteres após trim', () => {
    expect(validateViewName('Atrasados')).toBeNull();
    expect(validateViewName('a'.repeat(80))).toBeNull();
    expect(validateViewName('  ')).toBe(SAVED_VIEW_MESSAGES.name);
    expect(validateViewName('a'.repeat(81))).toBe(SAVED_VIEW_MESSAGES.name);
    expect(validateViewName(`  ${'a'.repeat(80)}  `)).toBeNull();
  });
});

describe('listas de visões', () => {
  const mineB = view({ id: ID(2), name: 'Beta' });
  const mineA = view({ id: ID(3), name: 'Alfa' });
  const mineDefault = view({ id: ID(4), name: 'Zeta', isDefault: true });
  const shared = view({ id: ID(5), name: 'Compartilhada', isOwner: false, isShared: true });
  const sharedDefault = view({ id: ID(6), name: 'De outro', isOwner: false, isDefault: true });

  it('agrupa em minhas (padrão primeiro, por nome) e compartilhadas', () => {
    const grouped = groupViews([mineB, shared, mineDefault, mineA]);
    expect(grouped.mine.map((item) => item.name)).toEqual(['Zeta', 'Alfa', 'Beta']);
    expect(grouped.shared.map((item) => item.name)).toEqual(['Compartilhada']);
  });

  it('a visão padrão é só a do próprio usuário', () => {
    expect(findDefaultView([mineB, sharedDefault])).toBeUndefined();
    expect(findDefaultView([mineB, mineDefault, sharedDefault])?.id).toBe(ID(4));
  });

  it('upsert substitui no lugar e marcar uma padrão desmarca a anterior', () => {
    const renamed = { ...mineB, name: 'Beta 2', version: 4 };
    expect(upsertView([mineA, mineB], renamed).map((item) => item.name)).toEqual([
      'Alfa',
      'Beta 2',
    ]);
    const next = upsertView([mineA, mineDefault, sharedDefault], { ...mineA, isDefault: true });
    expect(next.find((item) => item.id === ID(4))?.isDefault).toBe(false);
    expect(next.find((item) => item.id === ID(3))?.isDefault).toBe(true);
    expect(next.find((item) => item.id === ID(6))?.isDefault).toBe(true); // de outro dono: intacta
    expect(upsertView([mineA], mineB).map((item) => item.id)).toEqual([ID(3), ID(2)]);
  });
});
