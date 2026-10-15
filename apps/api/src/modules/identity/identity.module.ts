import { Module } from '@nestjs/common';
import type { OnModuleInit, Provider } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import {
  MEMBERSHIP_PORT,
  PLATFORM_OPERATOR_PORT,
  TOKEN_VERIFIER,
  USER_PORT,
} from '#shared/auth/ports.js';
import { TenantSeederRegistry, TenantSeedingModule } from '#shared/tenancy/tenant-seeding.js';

import { FirstAdminSeeder } from './application/first-admin.seeder.js';
import { IdentityFacade } from './application/identity.facade.js';
import { GetMyProfileQuery, ListMyMembershipsQuery } from './application/me.queries.js';
import {
  AUTHENTIK_DIRECTORY,
  FIRST_ADMIN_STORE,
  IDENTITY_CLOCK,
  IDENTITY_REPOSITORY,
  IDENTITY_TENANT_TRANSACTIONS,
  SESSION_AUDIT,
  TENANT_MFA_POLICY,
} from './application/ports.js';
import { RecordSessionEndingsCommand } from './application/record-session-endings.command.js';
import { RecordSessionTenantCommand } from './application/record-session-tenant.command.js';
import { StartSessionCommand } from './application/start-session.command.js';
import { AuditTrailSessionRecorder } from './infrastructure/audit-trail-session.recorder.js';
import {
  AuthentikAdminClient,
  DisabledAuthentikDirectory,
} from './infrastructure/authentik-admin.client.js';
import { FakeJwksProvider } from './infrastructure/fake-jwks.provider.js';
import {
  InMemoryFirstAdminStore,
  PrismaFirstAdminStore,
  PrismaIdentityTenantTransactions,
} from './infrastructure/first-admin.store.js';
import {
  InMemoryAuthentikDirectory,
  InMemoryIdentityRepository,
} from './infrastructure/in-memory-identity.repositories.js';
import { JwksTokenVerifier } from './infrastructure/jwks-token-verifier.js';
import { PrismaIdentityRepository } from './infrastructure/prisma-identity.repository.js';
import { SessionSweepScheduler } from './infrastructure/session-sweep.scheduler.js';
import {
  InMemoryTenantMfaPolicy,
  RegistryDefaultMfaPolicy,
} from './infrastructure/tenant-mfa-policy.js';
import { MeController } from './presentation/me.controller.js';
import { SessionEventsController } from './presentation/session-events.controller.js';

/** Repositório de identidade efetivo (Prisma, ou em memória no modo de identidade fake). */
const IDENTITY_STORE = Symbol('IdentityStore');
/** Primeiro administrador e operadores de plataforma (US-099), Prisma ou em memória. */
const FIRST_ADMIN_BACKEND = Symbol('FirstAdminBackend');

/**
 * Modo de identidade fake (`OIDC_FAKE_SIGNING_KEY`, só local/dev/test — FA-02 da US-080): token
 * HS256 e diretório em memória. Sem a chave (padrão e único caminho em staging/produção): JWKS do
 * Authentik e as tabelas reais (US-087).
 */
function identityProviders(): Provider[] {
  return [
    {
      provide: TOKEN_VERIFIER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.oidc.fakeSigningKey
          ? new FakeJwksProvider({
              signingKey: config.oidc.fakeSigningKey,
              issuer: config.oidc.issuerUrl,
              audiences: config.oidc.audiences,
              clockToleranceSeconds: config.oidc.clockToleranceSeconds,
            })
          : new JwksTokenVerifier({
              issuer: config.oidc.issuerUrl,
              audiences: config.oidc.audiences,
              clockToleranceSeconds: config.oidc.clockToleranceSeconds,
            }),
    },
    PrismaIdentityRepository,
    {
      provide: IDENTITY_STORE,
      inject: [APP_CONFIG, PrismaIdentityRepository],
      useFactory: (config: AppConfig, prisma: PrismaIdentityRepository) =>
        config.oidc.fakeSigningKey ? new InMemoryIdentityRepository() : prisma,
    },
    { provide: IDENTITY_REPOSITORY, useExisting: IDENTITY_STORE },
    { provide: USER_PORT, useExisting: IDENTITY_STORE },
    { provide: MEMBERSHIP_PORT, useExisting: IDENTITY_STORE },
    {
      provide: AUTHENTIK_DIRECTORY,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        if (config.oidc.fakeSigningKey) return new InMemoryAuthentikDirectory();
        return config.authentik
          ? new AuthentikAdminClient(config.authentik)
          : new DisabledAuthentikDirectory();
      },
    },
    PrismaFirstAdminStore,
    PrismaIdentityTenantTransactions,
    {
      provide: FIRST_ADMIN_BACKEND,
      inject: [APP_CONFIG, PrismaFirstAdminStore],
      useFactory: (config: AppConfig, prisma: PrismaFirstAdminStore) =>
        config.oidc.fakeSigningKey ? new InMemoryFirstAdminStore() : prisma,
    },
    { provide: FIRST_ADMIN_STORE, useExisting: FIRST_ADMIN_BACKEND },
    { provide: PLATFORM_OPERATOR_PORT, useExisting: FIRST_ADMIN_BACKEND },
    {
      provide: IDENTITY_TENANT_TRANSACTIONS,
      inject: [FIRST_ADMIN_BACKEND, PrismaIdentityTenantTransactions],
      useFactory: (
        backend: InMemoryFirstAdminStore | PrismaFirstAdminStore,
        prisma: PrismaIdentityTenantTransactions,
      ) => (backend instanceof InMemoryFirstAdminStore ? backend : prisma),
    },
    { provide: SESSION_AUDIT, useClass: AuditTrailSessionRecorder },
    {
      provide: TENANT_MFA_POLICY,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.oidc.fakeSigningKey ? new InMemoryTenantMfaPolicy() : new RegistryDefaultMfaPolicy(),
    },
    { provide: IDENTITY_CLOCK, useValue: () => new Date() },
  ];
}

/**
 * Módulo `identity` (DEC-040): outros módulos usam somente a fachada exportada. Dono de `User`,
 * `TenantMembership` e `MembershipDepartment`; implementa as portas do pipeline de autenticação
 * (`TokenVerifierPort`, `UserPort`, `MembershipPort`), o início de sessão (`POST
 * /internal/session-events`) e ME-01/ME-04 (US-087). Desde a US-088 também roda a varredura de
 * encerramentos de sessão (`SessionSweepScheduler`, 1 min), que audita logout e expiração a partir
 * do Redis de sessões (`SESSION_REGISTRY`, fornecido pelo módulo `platform`). Desde a US-099: a
 * porta `PlatformOperatorPort` (rotas `/platform/*` e CLI) e o seeder `identity.firstAdmin`.
 */
@Module({
  imports: [TenantSeedingModule],
  controllers: [MeController, SessionEventsController],
  providers: [
    IdentityFacade,
    ...identityProviders(),
    StartSessionCommand,
    RecordSessionTenantCommand,
    RecordSessionEndingsCommand,
    SessionSweepScheduler,
    GetMyProfileQuery,
    ListMyMembershipsQuery,
    FirstAdminSeeder,
  ],
  exports: [IdentityFacade, TOKEN_VERIFIER, USER_PORT, MEMBERSHIP_PORT, PLATFORM_OPERATOR_PORT],
})
export class IdentityModule implements OnModuleInit {
  constructor(
    private readonly seeders: TenantSeederRegistry,
    private readonly firstAdmin: FirstAdminSeeder,
  ) {}

  /** Seeder `identity.firstAdmin` e convite do primeiro administrador (US-099). */
  onModuleInit(): void {
    this.seeders.register(this.firstAdmin);
    this.seeders.registerFirstAdminInvitation(this.firstAdmin);
  }
}
