import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import {
  DocumentApprovalModule,
  DocumentApprovalRegistry,
} from '#shared/document/document-approval.js';

import { ApprovalFacade } from './application/approval.facade.js';
import { DocumentApprovalRequestService } from './application/document-approval.requester.js';
import { APPROVAL_REPOSITORY } from './application/ports.js';
import { StageApprovalService } from './application/stage-approval.service.js';
import {
  InMemoryApprovalRepository,
  PrismaApprovalRepository,
} from './infrastructure/approval.repositories.js';
import { AccessModule } from '../access/access.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationModule } from '../organization/organization.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): aprovações em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `approval` (DEC-040): outros módulos usam somente a fachada exportada. US-065: a aprovação
 * avulsa da submissão de documento (`subjectType = DOCUMENT`), registrada na porta
 * `DocumentApprovalRegistry` do shared kernel (`document` está no mesmo nível). US-047: a aprovação
 * de etapa aberta pelo encaminhamento (`StageApprovalService` — aprovador, cobertura e evento).
 */
@Module({
  imports: [DocumentApprovalModule, AccessModule, IdentityModule, OrganizationModule],
  providers: [
    ApprovalFacade,
    DocumentApprovalRequestService,
    StageApprovalService,
    PrismaApprovalRepository,
    InMemoryApprovalRepository,
    {
      provide: APPROVAL_REPOSITORY,
      inject: [APP_CONFIG, PrismaApprovalRepository, InMemoryApprovalRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaApprovalRepository,
        memory: InMemoryApprovalRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
  ],
  exports: [ApprovalFacade],
})
export class ApprovalModule implements OnModuleInit {
  constructor(
    private readonly registry: DocumentApprovalRegistry,
    private readonly requester: DocumentApprovalRequestService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.requester);
  }
}
