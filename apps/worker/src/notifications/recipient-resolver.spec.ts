import { NOTIFICATION_MAX_UNIT_RECIPIENTS } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import { planNotification } from './notification-rules.js';
import type { NotificationPlan, RecipientSpec } from './notification-rules.js';
import { RecipientResolver } from './recipient-resolver.js';
import type {
  PermissionHolders,
  ProcessVisibility,
  RecipientLookupSource,
} from './recipient-resolver.js';
import { ACTOR, FakeDirectory, NO_SQL, PROCESS, envelope, testId } from './testing.js';

const NOW = new Date('2026-10-15T12:00:00Z');
const CARLA = testId();
const BRUNO = testId();
const INATIVO = testId();
const HEAD = testId();
const DEPUTY = testId();
const DEPARTMENT = testId();

function planWith(recipients: readonly RecipientSpec[], processId: string | null = PROCESS) {
  const base = planNotification(
    envelope('ProcessAssigned', { assignmentType: 'MANUAL' }, { processId }),
  );
  if (base.kind !== 'notify') throw new Error('plano esperado');
  return { plan: { ...base, recipients } satisfies NotificationPlan, processId };
}

const seeAll: ProcessVisibility = {
  visibleTo: (_client, _processId, userIds) => Promise.resolve(new Set(userIds)),
};

function directory(): FakeDirectory {
  const fake = new FakeDirectory();
  for (const userId of [CARLA, BRUNO, ACTOR, HEAD, DEPUTY]) fake.active.add(userId);
  fake.heads.set(DEPARTMENT, { headUserId: HEAD, deputyUserId: DEPUTY });
  return fake;
}

async function resolve(
  recipients: readonly RecipientSpec[],
  options: {
    readonly fake?: FakeDirectory;
    readonly visibility?: ProcessVisibility | null;
    readonly permissions?: PermissionHolders | null;
    readonly lookups?: readonly RecipientLookupSource[];
    readonly processId?: string | null;
  } = {},
) {
  const resolver = new RecipientResolver({
    directory: options.fake ?? directory(),
    visibility: options.visibility === undefined ? seeAll : options.visibility,
    permissions: options.permissions ?? null,
    lookups: options.lookups ?? [],
  });
  const { plan, processId } = planWith(
    recipients,
    options.processId === undefined ? PROCESS : options.processId,
  );
  return resolver.resolve(NO_SQL, plan, envelope('ProcessAssigned', {}, { processId }), NOW);
}

describe('RecipientResolver (events.md §6 · US-111)', () => {
  it('[RN-NTF-02] nunca inclui o ator, mesmo que a regra o resolva', async () => {
    const result = await resolve([
      { kind: 'USER', userId: ACTOR },
      { kind: 'USER', userId: CARLA },
    ]);
    expect(result.recipients).toEqual([CARLA]);
  });

  it('[events.md §6] o aviso de trabalho assíncrono de IA vai ao próprio solicitante (ator)', async () => {
    const resolver = new RecipientResolver({
      directory: directory(),
      visibility: seeAll,
      lookups: [],
    });
    const event = envelope('AiGenerationCompleted', {
      generationId: testId(),
      documentId: null,
      requestedById: ACTOR,
    });
    const plan = planNotification(event);
    if (plan.kind !== 'notify') throw new Error('plano esperado');
    expect((await resolver.resolve(NO_SQL, plan, event, NOW)).recipients).toEqual([ACTOR]);
  });

  it('[US-116] o aviso de limite de IA vai a quem tem SETTINGS_MANAGE no tenant (máx. 50), inclusive o ator', async () => {
    const fake = directory();
    const admins = Array.from({ length: NOTIFICATION_MAX_UNIT_RECIPIENTS + 5 }, () => testId());
    for (const userId of admins) fake.active.add(userId);
    fake.holders.set('SETTINGS_MANAGE', [ACTOR, ...admins]);
    const resolver = new RecipientResolver({ directory: fake, visibility: null, lookups: [] });
    const event = envelope(
      'AiUsageThresholdReached',
      { month: '2026-10', threshold: 80, usedTokens: 41_000, limitTokens: 50_000 },
      { processId: null, aggregateType: 'Tenant' },
    );
    const plan = planNotification(event);
    if (plan.kind !== 'notify') throw new Error('plano esperado');
    const { recipients } = await resolver.resolve(NO_SQL, plan, event, NOW);
    expect(recipients).toHaveLength(NOTIFICATION_MAX_UNIT_RECIPIENTS);
    expect(recipients).toContain(ACTOR);
  });

  it('remove repetidos e quem não tem vínculo ativo; ordena para travar sempre na mesma ordem', async () => {
    const result = await resolve([
      { kind: 'USER', userId: BRUNO },
      { kind: 'USER', userId: CARLA },
      { kind: 'USER', userId: BRUNO },
      { kind: 'USER', userId: INATIVO },
    ]);
    expect(result.recipients).toEqual([CARLA, BRUNO].sort());
  });

  it('[FA-03 · RN-NTF-06] quem perdeu a visibilidade do processo não recebe; os demais sim', async () => {
    const onlyCarla: ProcessVisibility = {
      visibleTo: () => Promise.resolve(new Set([CARLA])),
    };
    const result = await resolve(
      [
        { kind: 'USER', userId: CARLA },
        { kind: 'USER', userId: BRUNO },
      ],
      { visibility: onlyCarla },
    );
    expect(result.recipients).toEqual([CARLA]);
  });

  it('sem fonte de visibilidade, notificação de processo não é criada (falha fechada)', async () => {
    const result = await resolve([{ kind: 'USER', userId: CARLA }], { visibility: null });
    expect(result).toEqual({ recipients: [], unresolved: ['VISIBILITY_UNAVAILABLE'] });
  });

  it('sem processo (ex.: ROLE_CHANGED) não há checagem de visibilidade', async () => {
    const result = await resolve([{ kind: 'USER', userId: CARLA }], {
      visibility: null,
      processId: null,
    });
    expect(result.recipients).toEqual([CARLA]);
  });

  it('FIRST_OF: o responsável quando há; senão os membros da unidade', async () => {
    const fake = directory();
    fake.members.set(DEPARTMENT, [CARLA, BRUNO]);
    const first = await resolve(
      [
        {
          kind: 'FIRST_OF',
          specs: [
            { kind: 'USER', userId: CARLA },
            { kind: 'DEPARTMENT_MEMBERS', departmentId: DEPARTMENT },
          ],
        },
      ],
      { fake },
    );
    expect(first.recipients).toEqual([CARLA]);
    const fallback = await resolve(
      [
        {
          kind: 'FIRST_OF',
          specs: [
            { kind: 'USER', userId: null },
            { kind: 'DEPARTMENT_MEMBERS', departmentId: DEPARTMENT },
          ],
        },
      ],
      { fake },
    );
    expect(fallback.recipients).toEqual([CARLA, BRUNO].sort());
  });

  it('[FA-01] unidade com mais de 50 membros: avisa titular e substituto', async () => {
    const fake = directory();
    const crowd = Array.from({ length: NOTIFICATION_MAX_UNIT_RECIPIENTS + 5 }, () => testId());
    for (const userId of crowd) fake.active.add(userId);
    fake.members.set(DEPARTMENT, crowd);
    const result = await resolve([{ kind: 'DEPARTMENT_MEMBERS', departmentId: DEPARTMENT }], {
      fake,
    });
    expect(result.recipients).toEqual([HEAD, DEPUTY].sort());

    // Exatamente 50: cada um.
    fake.members.set(DEPARTMENT, crowd.slice(0, NOTIFICATION_MAX_UNIT_RECIPIENTS));
    const fifty = await resolve([{ kind: 'DEPARTMENT_MEMBERS', departmentId: DEPARTMENT }], {
      fake,
    });
    expect(fifty.recipients).toHaveLength(NOTIFICATION_MAX_UNIT_RECIPIENTS);
  });

  it('[FA-01] permissão exigida (PROCESS_CLAIM): filtra pelos detentores; sem a fonte, ninguém', async () => {
    const fake = directory();
    fake.members.set(DEPARTMENT, [CARLA, BRUNO]);
    const spec: RecipientSpec = {
      kind: 'DEPARTMENT_MEMBERS',
      departmentId: DEPARTMENT,
      permission: 'PROCESS_CLAIM',
    };
    const onlyBruno: PermissionHolders = {
      filter: (_client, userIds) => Promise.resolve(userIds.filter((userId) => userId === BRUNO)),
    };
    expect((await resolve([spec], { fake, permissions: onlyBruno })).recipients).toEqual([BRUNO]);
    expect(await resolve([spec], { fake })).toEqual({
      recipients: [],
      unresolved: ['PERMISSION_UNAVAILABLE:PROCESS_CLAIM'],
    });
  });

  it('titular e substituto da unidade (substituto só se pedido); unidade inexistente → ninguém', async () => {
    expect(
      (
        await resolve([
          { kind: 'DEPARTMENT_HEADS', departmentId: DEPARTMENT, includeDeputy: false },
        ])
      ).recipients,
    ).toEqual([HEAD]);
    expect(
      (await resolve([{ kind: 'DEPARTMENT_HEADS', departmentId: DEPARTMENT, includeDeputy: true }]))
        .recipients,
    ).toEqual([HEAD, DEPUTY].sort());
    expect(
      (await resolve([{ kind: 'DEPARTMENT_HEADS', departmentId: testId(), includeDeputy: true }]))
        .recipients,
    ).toEqual([]);
    expect(
      (await resolve([{ kind: 'DEPARTMENT_HEADS', departmentId: null, includeDeputy: true }]))
        .recipients,
    ).toEqual([]);
  });

  it('dono do vínculo (ROLE_CHANGED)', async () => {
    const fake = directory();
    const membership = testId();
    fake.memberships.set(membership, CARLA);
    expect(
      (await resolve([{ kind: 'MEMBERSHIP_USER', membershipId: membership }], { fake })).recipients,
    ).toEqual([CARLA]);
    expect(
      (await resolve([{ kind: 'MEMBERSHIP_USER', membershipId: testId() }], { fake })).recipients,
    ).toEqual([]);
    expect(
      (await resolve([{ kind: 'MEMBERSHIP_USER', membershipId: null }], { fake })).recipients,
    ).toEqual([]);
  });

  it('fonte de módulo dono: usada quando registrada; ausente → não resolvido', async () => {
    const stakeholders: RecipientLookupSource = {
      lookup: 'PROCESS_STAKEHOLDERS',
      resolve: () => Promise.resolve([CARLA, ACTOR]),
    };
    expect(
      (
        await resolve([{ kind: 'LOOKUP', lookup: 'PROCESS_STAKEHOLDERS' }], {
          lookups: [stakeholders],
        })
      ).recipients,
    ).toEqual([CARLA]);
    expect(await resolve([{ kind: 'LOOKUP', lookup: 'ROLE_HOLDERS' }])).toEqual({
      recipients: [],
      unresolved: ['LOOKUP_UNAVAILABLE:ROLE_HOLDERS'],
    });
  });

  it('unidade nula em DEPARTMENT_MEMBERS não consulta nada', async () => {
    expect(
      (
        await resolve([
          { kind: 'DEPARTMENT_MEMBERS', departmentId: null, permission: 'PROCESS_CLAIM' },
        ])
      ).recipients,
    ).toEqual([]);
  });
});
