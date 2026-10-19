import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { ApprovalSubjectModule } from '#shared/approval/approval-subject.js';
import { ProcessAccessModule } from '#shared/auth/process-access.js';
import {
  DocumentApprovalModule,
  DocumentApprovalRegistry,
} from '#shared/document/document-approval.js';

import { ApprovalCancellationService } from './application/approval-cancellation.service.js';
import { ApprovalDecisionPolicy } from './application/approval-decision.policy.js';
import { ApprovalRequestService } from './application/approval-request.service.js';
import { ApprovalFacade } from './application/approval.facade.js';
import { ApprovalPresenter } from './application/approval.presenter.js';
import { ApproverResolver } from './application/approver-resolver.js';
import { DecideApprovalCommand } from './application/decide-approval.command.js';
import { GetApprovalQuery } from './application/get-approval.query.js';
import { APPROVAL_CLOCK, APPROVAL_REPOSITORY, APPROVAL_TRANSACTIONS } from './application/ports.js';
import {
  InMemoryApprovalRepository,
  InMemoryApprovalTransactions,
  PrismaApprovalRepository,
  PrismaApprovalTransactions,
} from './infrastructure/approval.repositories.js';
import { ApprovalController } from './presentation/approval.controller.js';
import { AccessModule } from '../access/access.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): aprovações em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `approval` (DEC-040): outros módulos usam somente a fachada exportada. US-051: a
 * solicitação de aprovação (`ApprovalRequestService`) e a resolução do aprovador
 * (`ApproverResolver`) — a de etapa pela fachada (encaminhamento, US-047) e a avulsa da submissão
 * de documento pela porta `DocumentApprovalRegistry` do shared kernel (`document` está no mesmo
 * nível — US-065). US-052: a decisão (APV-02/APV-03 — `DecideApprovalCommand`, coordenador da
 * transação) com POL-03, delegando os efeitos ao dono do sujeito pela porta
 * `ApprovalSubjectRegistry` (`process` para `PROCESS_STAGE`, `document` para `DOCUMENT`).
 */
@Module({
  imports: [
    DocumentApprovalModule,
    ApprovalSubjectModule,
    ProcessAccessModule,
    AccessModule,
    IdentityModule,
    OrganizationModule,
    TenancyModule,
  ],
  controllers: [ApprovalController],
  providers: [
    ApprovalFacade,
    ApproverResolver,
    ApprovalRequestService,
    ApprovalCancellationService,
    ApprovalDecisionPolicy,
    ApprovalPresenter,
    DecideApprovalCommand,
    GetApprovalQuery,
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
    PrismaApprovalTransactions,
    InMemoryApprovalTransactions,
    {
      provide: APPROVAL_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaApprovalTransactions, InMemoryApprovalTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaApprovalTransactions,
        memory: InMemoryApprovalTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    { provide: APPROVAL_CLOCK, useValue: () => new Date() },
  ],
  exports: [ApprovalFacade],
})
export class ApprovalModule implements OnModuleInit {
  constructor(
    private readonly registry: DocumentApprovalRegistry,
    private readonly requester: ApprovalRequestService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.requester);
  }
}
