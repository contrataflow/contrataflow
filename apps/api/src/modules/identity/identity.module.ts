import { Module } from '@nestjs/common';
import type { Provider } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER, USER_PORT } from '#shared/auth/ports.js';

import { IdentityFacade } from './application/identity.facade.js';
import { GetMyProfileQuery, ListMyMembershipsQuery } from './application/me.queries.js';
import {
  AUTHENTIK_DIRECTORY,
  IDENTITY_CLOCK,
  IDENTITY_REPOSITORY,
  SESSION_AUDIT,
} from './application/ports.js';
import { RecordSessionTenantCommand } from './application/record-session-tenant.command.js';
import { StartSessionCommand } from './application/start-session.command.js';
import {
  AuthentikAdminClient,
  DisabledAuthentikDirectory,
} from './infrastructure/authentik-admin.client.js';
import { FakeJwksProvider } from './infrastructure/fake-jwks.provider.js';
import {
  InMemoryAuthentikDirectory,
  InMemoryIdentityRepository,
} from './infrastructure/in-memory-identity.repositories.js';
import { JwksTokenVerifier } from './infrastructure/jwks-token-verifier.js';
import { LogSessionAuditRecorder } from './infrastructure/log-session-audit.recorder.js';
import { PrismaIdentityRepository } from './infrastructure/prisma-identity.repository.js';
import { MeController } from './presentation/me.controller.js';
import { SessionEventsController } from './presentation/session-events.controller.js';

/** Repositório de identidade efetivo (Prisma, ou em memória no modo de identidade fake). */
const IDENTITY_STORE = Symbol('IdentityStore');

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
    { provide: SESSION_AUDIT, useClass: LogSessionAuditRecorder },
    { provide: IDENTITY_CLOCK, useValue: () => new Date() },
  ];
}

/**
 * Módulo `identity` (DEC-040): outros módulos usam somente a fachada exportada. Dono de `User`,
 * `TenantMembership` e `MembershipDepartment`; implementa as portas do pipeline de autenticação
 * (`TokenVerifierPort`, `UserPort`, `MembershipPort`), o início de sessão (`POST
 * /internal/session-events`) e ME-01/ME-04 (US-087).
 */
@Module({
  controllers: [MeController, SessionEventsController],
  providers: [
    IdentityFacade,
    ...identityProviders(),
    StartSessionCommand,
    RecordSessionTenantCommand,
    GetMyProfileQuery,
    ListMyMembershipsQuery,
  ],
  exports: [IdentityFacade, TOKEN_VERIFIER, USER_PORT, MEMBERSHIP_PORT],
})
export class IdentityModule {}
