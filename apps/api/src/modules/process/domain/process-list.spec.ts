import { localDateOf } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import {
  canViewConfidentialBudget,
  compareForOrder,
  deadlineDateRange,
  effectiveOrder,
  foldText,
  isProcessOverdue,
  isTargetDateOverdue,
  matchesCriteria,
  searchRank,
  sortValue,
  stageDeadline,
} from './process-list.js';
import type {
  ProcessListCriteria,
  ProcessListFacts,
  StageDeadlineCalendar,
} from './process-list.js';

const TZ = 'America/Sao_Paulo';
const NOW = new Date('2026-10-05T15:00:00.000Z');
const clock = {
  now: NOW,
  today: '2026-10-05',
  localDate: (instant: Date) => localDateOf(instant, TZ),
};

const NONE: ProcessListCriteria = {
  search: null,
  statuses: null,
  stageIdsByKey: null,
  currentWorkflowStageIds: null,
  currentDepartmentIds: null,
  requestingSecretariatIds: null,
  requestingDepartmentIds: null,
  organizationIds: null,
  responsible: null,
  priorities: null,
  contractingTypeIds: null,
  modality: null,
  originIds: null,
  years: null,
  tagIds: null,
  overdue: null,
  targetDateOverdue: null,
  createdFrom: null,
  createdTo: null,
  targetDateFrom: null,
  targetDateTo: null,
  estimatedValueMin: null,
  estimatedValueMax: null,
};

function facts(overrides: Partial<ProcessListFacts> = {}): ProcessListFacts {
  return {
    id: '0192f000-0000-7000-8000-000000000001',
    organizationId: 'org',
    number: 12,
    year: 2026,
    code: '0012/2026',
    internalCode: null,
    title: 'Aquisição de cimento para manutenção de vias',
    object: 'Cimento CP-II',
    description: null,
    status: 'IN_PROGRESS',
    priority: 'HIGH',
    requestingSecretariatId: 'obras',
    requestingDepartmentId: 'manutencao',
    currentDepartmentId: 'cotacoes',
    currentResponsibleId: null,
    currentWorkflowStageId: 'stage-1',
    currentStageDueAt: null,
    overdueSince: null,
    contractingTypeId: 'ct',
    modalityId: null,
    originId: 'origin',
    isBudgetConfidential: false,
    estimatedValue: '85000.00',
    targetDate: null,
    openedAt: null,
    createdAt: new Date('2026-10-05T02:30:00.000Z'),
    updatedAt: new Date('2026-10-02T18:40:00.000Z'),
    tagIds: [],
    ...overrides,
  };
}

const matches = (f: ProcessListFacts, criteria: Partial<ProcessListCriteria>, canView = true) =>
  matchesCriteria(f, { ...NONE, ...criteria }, clock, canView);

describe('critérios da lista (RN-PROC-20..25 · RN-PROC-31)', () => {
  it('sem critérios casa tudo; lista vazia não casa nada', () => {
    expect(matches(facts(), {})).toBe(true);
    expect(matches(facts(), { currentDepartmentIds: [] })).toBe(false);
  });

  it('OU dentro do filtro e E entre filtros', () => {
    expect(matches(facts(), { statuses: ['RETURNED', 'IN_PROGRESS'] })).toBe(true);
    expect(matches(facts(), { statuses: ['IN_PROGRESS'], priorities: ['LOW'] })).toBe(false);
  });

  it('responsável: ids e "sem responsável" (RN-PROC-21)', () => {
    expect(matches(facts(), { responsible: { ids: ['ana'], none: true } })).toBe(true);
    expect(matches(facts(), { responsible: { ids: ['ana'], none: false } })).toBe(false);
    expect(
      matches(facts({ currentResponsibleId: 'ana' }), {
        responsible: { ids: ['ana'], none: false },
      }),
    ).toBe(true);
    expect(matches(facts(), { modality: { ids: [], none: true } })).toBe(true);
    expect(matches(facts({ modalityId: 'pregao' }), { modality: { ids: [], none: true } })).toBe(
      false,
    );
  });

  it('etapa por chave e etapa exata (RN-PROC-22)', () => {
    expect(matches(facts(), { stageIdsByKey: ['stage-1', 'stage-9'] })).toBe(true);
    expect(matches(facts(), { currentWorkflowStageIds: ['stage-9'] })).toBe(false);
    expect(matches(facts({ currentWorkflowStageId: null }), { stageIdsByKey: ['stage-1'] })).toBe(
      false,
    );
  });

  it('demais listas fechadas: unidades, órgão, catálogos, ano e etiquetas', () => {
    const f = facts({ tagIds: ['t1', 't2'] });
    expect(
      matches(f, { requestingSecretariatIds: ['obras'], requestingDepartmentIds: ['manutencao'] }),
    ).toBe(true);
    expect(matches(f, { organizationIds: ['outro'] })).toBe(false);
    expect(matches(f, { contractingTypeIds: ['ct'], originIds: ['origin'], years: [2026] })).toBe(
      true,
    );
    expect(matches(f, { years: [2025] })).toBe(false);
    expect(matches(f, { tagIds: ['t9', 't2'] })).toBe(true);
    expect(matches(f, { tagIds: ['t9'] })).toBe(false);
  });

  it('atrasado: status elegível e overdueSince ou prazo vencido; suspenso e final nunca (RN-PROC-23)', () => {
    const due = new Date('2026-10-01T02:59:59.999Z');
    expect(isProcessOverdue(facts({ currentStageDueAt: due }), NOW)).toBe(true);
    expect(isProcessOverdue(facts({ overdueSince: due, currentStageDueAt: null }), NOW)).toBe(true);
    expect(isProcessOverdue(facts({ status: 'SUSPENDED', currentStageDueAt: due }), NOW)).toBe(
      false,
    );
    expect(isProcessOverdue(facts({ status: 'COMPLETED', currentStageDueAt: due }), NOW)).toBe(
      false,
    );
    expect(
      isProcessOverdue(facts({ currentStageDueAt: new Date('2026-10-09T02:59:59Z') }), NOW),
    ).toBe(false);
    expect(matches(facts({ currentStageDueAt: due }), { overdue: true })).toBe(true);
    expect(matches(facts({ currentStageDueAt: due }), { overdue: false })).toBe(false);
  });

  it('prazo alvo vencido: anterior a hoje no fuso e status não final', () => {
    expect(isTargetDateOverdue(facts({ targetDate: '2026-10-04' }), '2026-10-05')).toBe(true);
    expect(isTargetDateOverdue(facts({ targetDate: '2026-10-05' }), '2026-10-05')).toBe(false);
    expect(
      isTargetDateOverdue(facts({ targetDate: '2026-10-04', status: 'CANCELED' }), '2026-10-05'),
    ).toBe(false);
    expect(matches(facts({ targetDate: '2026-10-04' }), { targetDateOverdue: true })).toBe(true);
    expect(matches(facts(), { targetDateOverdue: false })).toBe(true);
  });

  it('datas inclusivas no fuso do tenant (RN-PROC-31)', () => {
    // 2026-10-05T02:30Z = 2026-10-04 23:30 em São Paulo.
    expect(matches(facts(), { createdTo: '2026-10-04' })).toBe(true);
    expect(matches(facts(), { createdFrom: '2026-10-05' })).toBe(false);
    expect(matches(facts(), { createdFrom: '2026-10-04', createdTo: '2026-10-04' })).toBe(true);
    expect(
      matches(facts({ targetDate: '2026-11-30' }), {
        targetDateFrom: '2026-11-30',
        targetDateTo: '2026-11-30',
      }),
    ).toBe(true);
    expect(matches(facts(), { targetDateFrom: '2026-01-01' })).toBe(false);
  });

  it('valor estimado: intervalo exato e sigiloso sem POL-09 sempre fora (RN-PROC-25)', () => {
    expect(matches(facts(), { estimatedValueMin: '85000', estimatedValueMax: '85000.00' })).toBe(
      true,
    );
    expect(matches(facts(), { estimatedValueMin: '85000.01' })).toBe(false);
    expect(matches(facts({ estimatedValue: null }), { estimatedValueMax: '1' })).toBe(false);
    const secret = facts({ isBudgetConfidential: true, estimatedValue: '1200000.00' });
    expect(matches(secret, { estimatedValueMin: '1000000.00' }, true)).toBe(true);
    expect(matches(secret, { estimatedValueMin: '1000000.00' }, false)).toBe(false);
    expect(matches(secret, { estimatedValueMax: '1' }, false)).toBe(false);
  });
});

describe('busca (RN-PROC-26)', () => {
  it('código parcial por trigram e correspondência exata primeiro', () => {
    const p12 = facts();
    const p31 = facts({
      id: 'b',
      code: '0031/2026',
      number: 31,
      title: 'Contratação de limpeza hospitalar',
    });
    expect(searchRank(p12, '12/2026')).not.toBeNull();
    expect((searchRank(p12, '12/2026') ?? 0) > (searchRank(p31, '12/2026') ?? 0)).toBe(true);
    expect(searchRank(p31, '0031/2026')).toBeGreaterThanOrEqual(100);
  });

  it('termos sem acento encontram texto acentuado; sem termo nem trigram não casa', () => {
    expect(foldText('Manutenção')).toBe('manutencao');
    expect(searchRank(facts(), 'manutencao vias')).not.toBeNull();
    expect(searchRank(facts(), 'medicamentos')).toBeNull();
    expect(matches(facts(), { search: 'medicamentos' })).toBe(false);
  });
});

describe('ordenação (RN-PROC-27 · RN-PROC-25(c))', () => {
  const byOrder = (
    rows: ProcessListFacts[],
    sort: Parameters<typeof effectiveOrder>[0],
    canView = () => true,
  ) =>
    [...rows]
      .sort(compareForOrder(effectiveOrder(sort, false), null, canView))
      .map((row) => row.id);

  it('padrão -updatedAt; com busca e sem sort, relevância', () => {
    expect(effectiveOrder(undefined, false)).toEqual({
      kind: 'FIELDS',
      terms: [{ field: 'updatedAt', direction: 'desc' }],
    });
    expect(effectiveOrder(undefined, true)).toEqual({ kind: 'RELEVANCE' });
    expect(effectiveOrder([{ field: 'title', direction: 'asc' }], true).kind).toBe('FIELDS');
  });

  it('prioridade URGENT > HIGH > MEDIUM > LOW e desempate por id decrescente', () => {
    const rows = [
      facts({ id: 'a', priority: 'MEDIUM' }),
      facts({ id: 'b', priority: 'URGENT' }),
      facts({ id: 'c', priority: 'MEDIUM' }),
    ];
    expect(byOrder(rows, [{ field: 'priority', direction: 'desc' }])).toEqual(['b', 'c', 'a']);
  });

  it('código por ano e número, sem número ao final', () => {
    const rows = [
      facts({ id: 'a', number: null, code: null }),
      facts({ id: 'b', number: 31, code: '0031/2026' }),
      facts({ id: 'c', number: 5, year: 2025, code: '0005/2025' }),
    ];
    expect(byOrder(rows, [{ field: 'code', direction: 'asc' }])).toEqual(['c', 'b', 'a']);
    expect(byOrder(rows, [{ field: 'code', direction: 'desc' }])).toEqual(['b', 'c', 'a']);
  });

  it('valor mascarado ordena como nulo, sempre ao final', () => {
    const secret = facts({ id: 'b', estimatedValue: '1200000.00', isBudgetConfidential: true });
    const rows = [
      facts({ id: 'a', estimatedValue: '85000.00' }),
      secret,
      facts({ id: 'c', estimatedValue: null }),
    ];
    expect(byOrder(rows, [{ field: 'estimatedValue', direction: 'desc' }], () => false)).toEqual([
      'a',
      'c',
      'b',
    ]);
    expect(byOrder(rows, [{ field: 'estimatedValue', direction: 'desc' }])).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(sortValue(secret, 'estimatedValue', false)).toEqual([null]);
  });

  it('demais campos e vários termos', () => {
    const rows = [
      facts({ id: 'a', status: 'RETURNED', title: 'Beta', targetDate: '2026-12-01' }),
      facts({ id: 'b', status: 'DRAFT', title: 'Álamo', targetDate: null }),
    ];
    expect(byOrder(rows, [{ field: 'status', direction: 'asc' }])).toEqual(['b', 'a']);
    expect(byOrder(rows, [{ field: 'title', direction: 'asc' }])).toEqual(['b', 'a']);
    expect(byOrder(rows, [{ field: 'targetDate', direction: 'desc' }])).toEqual(['a', 'b']);
    for (const field of ['createdAt', 'openedAt', 'currentStageDueAt', 'updatedAt'] as const) {
      expect(
        byOrder(rows, [
          { field, direction: 'asc' },
          { field: 'title', direction: 'desc' },
        ]),
      ).toHaveLength(2);
    }
  });

  it('relevância usa o ranking da busca', () => {
    const rows = [facts({ id: 'z', code: '0031/2026', title: 'Limpeza' }), facts({ id: 'a' })];
    expect(
      rows.sort(compareForOrder({ kind: 'RELEVANCE' }, '12/2026', () => true)).map((r) => r.id),
    ).toEqual(['a', 'z']);
  });
});

describe('POL-09 por linha (RN-PROC-25)', () => {
  const viewer = {
    userId: 'ana',
    tenantWide: false,
    organizationIds: [],
    departmentIds: [],
    custodyDepartmentIds: ['manutencao'],
  };
  const secret = facts({ isBudgetConfidential: true });

  it('não sigiloso, escopo amplo, órgão, unidade com acesso ou custódia desmascaram', () => {
    expect(canViewConfidentialBudget(facts(), viewer, [])).toBe(true);
    expect(canViewConfidentialBudget(secret, viewer, [])).toBe(false);
    expect(canViewConfidentialBudget(secret, { ...viewer, tenantWide: true }, [])).toBe(true);
    expect(canViewConfidentialBudget(secret, { ...viewer, organizationIds: ['org'] }, [])).toBe(
      true,
    );
    expect(
      canViewConfidentialBudget(secret, { ...viewer, departmentIds: ['obras'] }, ['obras']),
    ).toBe(true);
    expect(canViewConfidentialBudget({ ...secret, currentResponsibleId: 'ana' }, viewer, [])).toBe(
      true,
    );
    expect(
      canViewConfidentialBudget({ ...secret, currentDepartmentId: 'manutencao' }, viewer, []),
    ).toBe(true);
    expect(
      canViewConfidentialBudget(
        { ...secret, currentDepartmentId: 'manutencao', currentResponsibleId: 'outro' },
        viewer,
        [],
      ),
    ).toBe(false);
  });
});

describe('StageDeadlineCalculator (DTO deadline)', () => {
  // Feriado de 12/10 (Nossa Senhora Aparecida); fins de semana não úteis.
  const holidays = new Set(['2026-10-12']);
  const calendar: StageDeadlineCalendar = {
    today: '2026-10-05',
    localDate: (instant) => localDateOf(instant, TZ),
    isBusinessDay: (date) => {
      const day = new Date(`${date}T12:00:00Z`).getUTCDay();
      return day !== 0 && day !== 6 && !holidays.has(date);
    },
    warnBeforeBusinessDays: 2,
  };
  const endOfDay = (date: string) => new Date(`${date}T23:59:59.999-03:00`);
  const deadline = (input: Partial<Parameters<typeof stageDeadline>[0]>, cal = calendar) =>
    stageDeadline(
      {
        dueAt: null,
        slaType: 'BUSINESS',
        isPaused: false,
        isOverdue: false,
        overdueSince: null,
        ...input,
      },
      cal,
    );

  it('atrasado há 3 dias úteis (Gherkin: venceu em 30/09, hoje 05/10)', () => {
    expect(deadline({ dueAt: endOfDay('2026-09-30'), isOverdue: true })).toMatchObject({
      overdueDays: 3,
      daysLeft: null,
      isOverdue: true,
      isDueSoon: false,
    });
  });

  it('atrasado em dias corridos e por overdueSince sem prazo', () => {
    expect(
      deadline({ dueAt: endOfDay('2026-09-30'), isOverdue: true, slaType: 'CALENDAR' }).overdueDays,
    ).toBe(5);
    expect(deadline({ overdueSince: endOfDay('2026-10-02'), isOverdue: true }).overdueDays).toBe(1);
    expect(deadline({ isOverdue: true }).overdueDays).toBe(0);
  });

  it('vence hoje, vence em breve e no prazo', () => {
    expect(deadline({ dueAt: endOfDay('2026-10-05') })).toMatchObject({
      daysLeft: 0,
      isDueSoon: true,
    });
    expect(deadline({ dueAt: endOfDay('2026-10-07') })).toMatchObject({
      daysLeft: 2,
      isDueSoon: true,
    });
    expect(deadline({ dueAt: endOfDay('2026-10-20') })).toMatchObject({
      daysLeft: 10,
      isDueSoon: false,
    });
  });

  it('dias úteis pulam o feriado de 12/10; CALENDAR conta corridos', () => {
    const late = { ...calendar, today: '2026-10-09' };
    expect(deadline({ dueAt: endOfDay('2026-10-13') }, late)).toMatchObject({
      daysLeft: 1,
      isDueSoon: true,
    });
    expect(deadline({ dueAt: endOfDay('2026-10-13'), slaType: 'CALENDAR' }, late)).toMatchObject({
      daysLeft: 4,
      isDueSoon: true,
    });
  });

  it('pausado e sem prazo', () => {
    expect(
      deadline({ dueAt: endOfDay('2026-09-30'), isPaused: true, isOverdue: true }),
    ).toMatchObject({
      isPaused: true,
      isOverdue: false,
      overdueDays: null,
      daysLeft: null,
    });
    expect(deadline({ slaType: null })).toEqual({
      dueAt: null,
      slaType: null,
      daysLeft: null,
      overdueDays: null,
      isDueSoon: false,
      isOverdue: false,
      isPaused: false,
    });
  });

  it('intervalo de datas a ler do calendário', () => {
    expect(
      deadlineDateRange(
        [
          {
            dueAt: endOfDay('2026-09-30'),
            slaType: 'BUSINESS',
            isPaused: false,
            isOverdue: true,
            overdueSince: null,
          },
          {
            dueAt: null,
            slaType: null,
            isPaused: false,
            isOverdue: false,
            overdueSince: endOfDay('2026-09-01'),
          },
          {
            dueAt: endOfDay('2026-11-02'),
            slaType: 'BUSINESS',
            isPaused: false,
            isOverdue: false,
            overdueSince: null,
          },
          { dueAt: null, slaType: null, isPaused: false, isOverdue: false, overdueSince: null },
        ],
        calendar,
      ),
    ).toEqual({ from: '2026-09-01', to: '2026-11-02' });
  });
});
