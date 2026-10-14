import type { AuthenticatedUser, MembershipRecord, TenantStatus } from '../auth/ports.js';

/**
 * Diretório fixo usado pelos adaptadores em memória (FA-03) até a US-081 ligar o Prisma: tenants,
 * usuários e vínculos das matrizes de teste dos guards (base da suíte "tenant leak"). Removido
 * junto com os adaptadores em memória.
 */
export const FAKE_TENANTS = {
  prefeituraA: { id: '0192a000-0000-7000-8000-00000000000a', status: 'ACTIVE' },
  prefeituraB: { id: '0192a000-0000-7000-8000-00000000000b', status: 'ACTIVE' },
  prefeituraSuspensa: { id: '0192a000-0000-7000-8000-00000000000c', status: 'SUSPENDED' },
} as const satisfies Record<string, { id: string; status: TenantStatus }>;

interface FakeUser extends AuthenticatedUser {
  /** `sub` do token = `User.externalSubject`. */
  readonly subject: string;
}

export const FAKE_USERS = {
  /** Ana: vínculo ativo só na Prefeitura A (Gherkin da US-080). */
  ana: { id: '0192a000-0000-7000-8000-0000000000a1', subject: 'sub-ana', status: 'ACTIVE' },
  /** Bruno: vínculo suspenso na Prefeitura A. */
  bruno: { id: '0192a000-0000-7000-8000-0000000000b1', subject: 'sub-bruno', status: 'ACTIVE' },
  /** Carla: vínculo ativo, porém expirado, na Prefeitura A. */
  carla: { id: '0192a000-0000-7000-8000-0000000000c1', subject: 'sub-carla', status: 'ACTIVE' },
  /** Davi: vínculo ativo na prefeitura suspensa. */
  davi: { id: '0192a000-0000-7000-8000-0000000000d1', subject: 'sub-davi', status: 'ACTIVE' },
  /** Eva: usuário bloqueado na plataforma (vínculo ativo na Prefeitura A). */
  eva: { id: '0192a000-0000-7000-8000-0000000000e1', subject: 'sub-eva', status: 'BLOCKED' },
} as const satisfies Record<string, FakeUser>;

export const FAKE_MEMBERSHIPS: readonly MembershipRecord[] = [
  {
    id: '0192a000-0000-7000-8000-0000000001a1',
    userId: FAKE_USERS.ana.id,
    tenantId: FAKE_TENANTS.prefeituraA.id,
    status: 'ACTIVE',
    expiresAt: null,
  },
  {
    id: '0192a000-0000-7000-8000-0000000001b1',
    userId: FAKE_USERS.bruno.id,
    tenantId: FAKE_TENANTS.prefeituraA.id,
    status: 'SUSPENDED',
    expiresAt: null,
  },
  {
    id: '0192a000-0000-7000-8000-0000000001c1',
    userId: FAKE_USERS.carla.id,
    tenantId: FAKE_TENANTS.prefeituraA.id,
    status: 'ACTIVE',
    expiresAt: new Date('2026-01-01T00:00:00Z'),
  },
  {
    id: '0192a000-0000-7000-8000-0000000001d1',
    userId: FAKE_USERS.davi.id,
    tenantId: FAKE_TENANTS.prefeituraSuspensa.id,
    status: 'ACTIVE',
    expiresAt: null,
  },
  {
    id: '0192a000-0000-7000-8000-0000000001e1',
    userId: FAKE_USERS.eva.id,
    tenantId: FAKE_TENANTS.prefeituraA.id,
    status: 'ACTIVE',
    expiresAt: null,
  },
];
