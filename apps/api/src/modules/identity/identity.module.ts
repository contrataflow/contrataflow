import { Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER, USER_PORT } from '#shared/auth/ports.js';

import { IdentityFacade } from './application/identity.facade.js';
import { FakeJwksProvider } from './infrastructure/fake-jwks.provider.js';
import {
  InMemoryMembershipRepository,
  InMemoryUserRepository,
} from './infrastructure/in-memory-identity.repositories.js';

/**
 * Módulo `identity` (DEC-040): outros módulos usam somente a fachada exportada. Implementa as
 * portas do pipeline de autenticação (`TokenVerifierPort`, `UserPort`, `MembershipPort`) com
 * adaptadores temporários — Prisma na US-081 e JWKS do Authentik na US-087.
 */
@Module({
  providers: [
    IdentityFacade,
    {
      provide: TOKEN_VERIFIER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new FakeJwksProvider({
          signingKey: config.oidc.fakeSigningKey,
          issuer: config.oidc.issuerUrl,
          audiences: config.oidc.audiences,
          clockToleranceSeconds: config.oidc.clockToleranceSeconds,
        }),
    },
    { provide: USER_PORT, useFactory: () => new InMemoryUserRepository() },
    { provide: MEMBERSHIP_PORT, useFactory: () => new InMemoryMembershipRepository() },
  ],
  exports: [IdentityFacade, TOKEN_VERIFIER, USER_PORT, MEMBERSHIP_PORT],
})
export class IdentityModule {}
