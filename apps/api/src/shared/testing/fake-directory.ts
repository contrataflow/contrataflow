import type { MembershipStatus, TenantStatus, UserStatus } from '../auth/ports.js';

/**
 * Diretório fixo dos adaptadores em memória: testes da API (matrizes dos guards — base da suíte
 * "tenant leak" — e casos de uso de identidade) e o modo de identidade fake de local/dev/test
 * (`OIDC_FAKE_SIGNING_KEY`). Em produção a identidade vem do Authentik e das tabelas reais.
 */

interface FakeTenant {
  readonly id: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly timezone: string;
}

export const FAKE_TENANTS = {
  prefeituraA: {
    id: '0192a000-0000-7000-8000-00000000000a',
    name: 'Prefeitura A',
    status: 'ACTIVE',
    timezone: 'America/Sao_Paulo',
  },
  prefeituraB: {
    id: '0192a000-0000-7000-8000-00000000000b',
    name: 'Prefeitura B',
    status: 'ACTIVE',
    timezone: 'America/Manaus',
  },
  prefeituraSuspensa: {
    id: '0192a000-0000-7000-8000-00000000000c',
    name: 'Prefeitura Suspensa',
    status: 'SUSPENDED',
    timezone: 'America/Sao_Paulo',
  },
  /** Instituição em encerramento: leitura só para ADMIN_ORGAO/AUDITOR (DEC-132). */
  prefeituraEncerrando: {
    id: '0192a000-0000-7000-8000-00000000000d',
    name: 'Prefeitura de Santa Luzia',
    status: 'OFFBOARDING',
    timezone: 'America/Sao_Paulo',
  },
} as const satisfies Record<string, FakeTenant>;

export interface FakeUser {
  readonly id: string;
  /** `sub` do token = `User.externalSubject`; `null` = convidado que ainda não entrou. */
  readonly subject: string | null;
  readonly authentikUserId: string | null;
  readonly email: string;
  readonly name: string;
  readonly socialName: string | null;
  readonly status: UserStatus;
  /** Operadora da plataforma (`User.isPlatformOperator` — US-099); padrão `false`. */
  readonly isPlatformOperator?: boolean;
}

export const FAKE_USERS = {
  /** Ana: vínculo ativo só na Prefeitura A (Gherkin da US-080). */
  ana: {
    id: '0192a000-0000-7000-8000-0000000000a1',
    subject: 'sub-ana',
    authentikUserId: '101',
    email: 'ana@prefeitura-a.test',
    name: 'Ana Souza',
    socialName: null,
    status: 'ACTIVE',
  },
  /** Bruno: vínculo suspenso na Prefeitura A. */
  bruno: {
    id: '0192a000-0000-7000-8000-0000000000b1',
    subject: 'sub-bruno',
    authentikUserId: '102',
    email: 'bruno@prefeitura-a.test',
    name: 'Bruno Lima',
    socialName: null,
    status: 'ACTIVE',
  },
  /** Carla: vínculo ativo, porém expirado, na Prefeitura A. */
  carla: {
    id: '0192a000-0000-7000-8000-0000000000c1',
    subject: 'sub-carla',
    authentikUserId: '103',
    email: 'carla@prefeitura-a.test',
    name: 'Carla Dias',
    socialName: null,
    status: 'ACTIVE',
  },
  /** Davi: vínculo ativo na prefeitura suspensa. */
  davi: {
    id: '0192a000-0000-7000-8000-0000000000d1',
    subject: 'sub-davi',
    authentikUserId: '104',
    email: 'davi@prefeitura-suspensa.test',
    name: 'Davi Rocha',
    socialName: null,
    status: 'ACTIVE',
  },
  /** Eva: usuária bloqueada na plataforma (vínculo ativo na Prefeitura A). */
  eva: {
    id: '0192a000-0000-7000-8000-0000000000e1',
    subject: 'sub-eva',
    authentikUserId: '105',
    email: 'eva@prefeitura-a.test',
    name: 'Eva Prado',
    socialName: null,
    status: 'BLOCKED',
  },
  /** Fábio: vínculos ativos nas Prefeituras A e B (seleção de instituição — SCR-101). */
  fabio: {
    id: '0192a000-0000-7000-8000-0000000000f1',
    subject: 'sub-fabio',
    authentikUserId: '106',
    email: 'fabio@prefeitura-a.test',
    name: 'Fábio Nunes',
    socialName: 'Fabi Nunes',
    status: 'ACTIVE',
  },
  /** Paulo: AUDITOR na prefeitura em encerramento (somente leitura — FA-08). */
  paulo: {
    id: '0192a000-0000-7000-8000-0000000000a2',
    subject: 'sub-paulo',
    authentikUserId: '107',
    email: 'paulo@santa-luzia.test',
    name: 'Paulo Mendes',
    socialName: null,
    status: 'ACTIVE',
  },
  /** Rafael: convidado (ADMIN_ORGAO) que ainda não entrou — `sub` vazio (RN-IAM-06). */
  rafael: {
    id: '0192a000-0000-7000-8000-0000000000a3',
    subject: null,
    authentikUserId: '108',
    email: 'rafael@prefeitura-a.test',
    name: 'Rafael Nogueira',
    socialName: null,
    status: 'ACTIVE',
  },
  /** Marta: ADMIN_ORGAO ativa na Prefeitura A (US-061 — gerencia tipos de documento). */
  marta: {
    id: '0192a000-0000-7000-8000-0000000000a4',
    subject: 'sub-marta',
    authentikUserId: '109',
    email: 'marta@prefeitura-a.test',
    name: 'Marta Ribeiro',
    socialName: null,
    status: 'ACTIVE',
  },
  /** Otávio: segundo ADMIN_ORGAO da Prefeitura A (edição concorrente — US-061). */
  otavio: {
    id: '0192a000-0000-7000-8000-0000000000a5',
    subject: 'sub-otavio',
    authentikUserId: '110',
    email: 'otavio@prefeitura-a.test',
    name: 'Otávio Campos',
    socialName: null,
    status: 'ACTIVE',
  },
  /** Lúcia: GESTOR_CONTRATACOES na Prefeitura A (consulta tipos; sem DOCUMENT_TYPE_MANAGE). */
  lucia: {
    id: '0192a000-0000-7000-8000-0000000000a6',
    subject: 'sub-lucia',
    authentikUserId: '111',
    email: 'lucia@prefeitura-a.test',
    name: 'Lúcia Matos',
    socialName: null,
    status: 'ACTIVE',
  },
  /** Heitor: vínculo só na Prefeitura B (aprovador de outro tenant — US-061). */
  heitor: {
    id: '0192a000-0000-7000-8000-0000000000a7',
    subject: 'sub-heitor',
    authentikUserId: '112',
    email: 'heitor@prefeitura-b.test',
    name: 'Heitor Barros',
    socialName: null,
    status: 'ACTIVE',
  },
  /** Carla Antunes: operadora da plataforma (implantação — US-099), sem vínculo com tenants. */
  operadora: {
    id: '0192a000-0000-7000-8000-0000000000c9',
    subject: 'sub-operadora',
    authentikUserId: '120',
    email: 'carla@contrataflow.com.br',
    name: 'Carla Antunes',
    socialName: null,
    status: 'ACTIVE',
    isPlatformOperator: true,
  },
} as const satisfies Record<string, FakeUser>;

export interface FakeMembership {
  readonly id: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly type: 'INTERNAL' | 'EXTERNAL' | 'SERVICE';
  readonly status: MembershipStatus;
  /** Fim do vínculo (`TenantMembership.expiresAt`); `null` = sem prazo. */
  readonly expiresAt: Date | null;
  readonly roleKeys: readonly string[];
}

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;

export const FAKE_MEMBERSHIPS: readonly FakeMembership[] = [
  {
    id: '0192a000-0000-7000-8000-0000000001a1',
    userId: FAKE_USERS.ana.id,
    tenantId: A,
    type: 'INTERNAL',
    status: 'ACTIVE',
    expiresAt: null,
    roleKeys: ['REQUISITANTE'],
  },
  {
    id: '0192a000-0000-7000-8000-0000000001b1',
    userId: FAKE_USERS.bruno.id,
    tenantId: A,
    type: 'INTERNAL',
    status: 'SUSPENDED',
    expiresAt: null,
    roleKeys: [],
  },
  {
    id: '0192a000-0000-7000-8000-0000000001c1',
    userId: FAKE_USERS.carla.id,
    tenantId: A,
    type: 'EXTERNAL',
    status: 'ACTIVE',
    expiresAt: new Date('2026-01-01T00:00:00Z'),
    roleKeys: ['CONSULTOR_EXTERNO'],
  },
  {
    id: '0192a000-0000-7000-8000-0000000001d1',
    userId: FAKE_USERS.davi.id,
    tenantId: FAKE_TENANTS.prefeituraSuspensa.id,
    type: 'INTERNAL',
    status: 'ACTIVE',
    expiresAt: null,
    roleKeys: [],
  },
  {
    id: '0192a000-0000-7000-8000-0000000001e1',
    userId: FAKE_USERS.eva.id,
    tenantId: A,
    type: 'INTERNAL',
    status: 'ACTIVE',
    expiresAt: null,
    roleKeys: [],
  },
  {
    id: '0192a000-0000-7000-8000-0000000001f1',
    userId: FAKE_USERS.fabio.id,
    tenantId: A,
    type: 'INTERNAL',
    status: 'ACTIVE',
    expiresAt: null,
    roleKeys: ['COMPRAS'],
  },
  {
    id: '0192a000-0000-7000-8000-0000000002f1',
    userId: FAKE_USERS.fabio.id,
    tenantId: B,
    type: 'EXTERNAL',
    status: 'ACTIVE',
    expiresAt: new Date('2099-12-31T23:59:59Z'),
    roleKeys: ['CONSULTOR_EXTERNO'],
  },
  {
    id: '0192a000-0000-7000-8000-0000000001a2',
    userId: FAKE_USERS.paulo.id,
    tenantId: FAKE_TENANTS.prefeituraEncerrando.id,
    type: 'INTERNAL',
    status: 'ACTIVE',
    expiresAt: null,
    roleKeys: ['AUDITOR'],
  },
  {
    id: '0192a000-0000-7000-8000-0000000001a3',
    userId: FAKE_USERS.rafael.id,
    tenantId: A,
    type: 'INTERNAL',
    status: 'INVITED',
    expiresAt: null,
    roleKeys: ['ADMIN_ORGAO'],
  },
  {
    id: '0192a000-0000-7000-8000-0000000001a4',
    userId: FAKE_USERS.marta.id,
    tenantId: A,
    type: 'INTERNAL',
    status: 'ACTIVE',
    expiresAt: null,
    roleKeys: ['ADMIN_ORGAO'],
  },
  {
    id: '0192a000-0000-7000-8000-0000000001a5',
    userId: FAKE_USERS.otavio.id,
    tenantId: A,
    type: 'INTERNAL',
    status: 'ACTIVE',
    expiresAt: null,
    roleKeys: ['ADMIN_ORGAO'],
  },
  {
    id: '0192a000-0000-7000-8000-0000000001a6',
    userId: FAKE_USERS.lucia.id,
    tenantId: A,
    type: 'INTERNAL',
    status: 'ACTIVE',
    expiresAt: null,
    roleKeys: ['GESTOR_CONTRATACOES'],
  },
  {
    id: '0192a000-0000-7000-8000-0000000002a7',
    userId: FAKE_USERS.heitor.id,
    tenantId: B,
    type: 'INTERNAL',
    status: 'ACTIVE',
    expiresAt: null,
    roleKeys: ['GESTOR_CONTRATACOES'],
  },
];
