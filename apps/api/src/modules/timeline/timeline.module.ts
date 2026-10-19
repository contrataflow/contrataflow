import { Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

import { GetProcessTimelineHandler } from './application/get-process-timeline.query.js';
import {
  TIMELINE_ENTRY_STORE,
  TIMELINE_LOOKUP_SOURCES,
  TIMELINE_TRANSACTIONS,
} from './application/ports.js';
import type { AnyTimelineLookupSource } from './application/ports.js';
import { TimelineLookupResolver } from './application/timeline-lookup.resolver.js';
import { TimelineProjector } from './application/timeline-projector.js';
import { TimelineFacade } from './application/timeline.facade.js';
import { ApprovalLookupSource } from './infrastructure/approval-lookup.source.js';
import { AttachmentLookupSource } from './infrastructure/attachment-lookup.source.js';
import {
  DocumentLookupSource,
  DocumentVersionLookupSource,
} from './infrastructure/document-lookup.sources.js';
import { EtpAlternativeLookupSource } from './infrastructure/etp-alternative-lookup.source.js';
import { IdentityUserLookupSource } from './infrastructure/identity-user.lookup-source.js';
import { InMemoryTimelineEntryStore } from './infrastructure/in-memory-timeline-entry.store.js';
import { PrismaTimelineEntryStore } from './infrastructure/prisma-timeline-entry.store.js';
import {
  DepartmentLookupSource,
  ProcessLookupSource,
  ProcessParticipantLookupSource,
  ProcessStageLookupSource,
  RiskLookupSource,
} from './infrastructure/process-lookup.sources.js';
import { RoleLookupSource } from './infrastructure/role-lookup.source.js';
import {
  InMemoryTimelineTransactions,
  PrismaTimelineTransactions,
} from './infrastructure/timeline-transactions.js';
import { TimelineController } from './presentation/timeline.controller.js';
import { AccessModule } from '../access/access.module.js';
import { ApprovalModule } from '../approval/approval.module.js';
import { DocumentModule } from '../document/document.module.js';
import { EtpModule } from '../etp/etp.module.js';
import { CommentLookupSource } from './infrastructure/comment-lookup.source.js';
import { CollaborationModule } from '../collaboration/collaboration.module.js';
import { FilesModule } from '../files/files.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { ProcessModule } from '../process/process.module.js';
import { RiskModule } from '../risk/risk.module.js';

/**
 * Módulo `timeline` (DEC-040, nível 5): outros módulos usam somente a fachada exportada. Dono de
 * `ProcessTimelineEntry`; o `TimelineProjector` (US-059) se registra no `SYNC_EVENT_HANDLERS` do
 * `platform` e projeta, na transação do caso de uso, os eventos de events.md §5. Os nomes
 * congelados vêm das fontes de `TIMELINE_LOOKUP_SOURCES`, pelas fachadas dos módulos donos —
 * a story que passa a publicar um evento mapeado registra aqui a fonte das referências dele.
 * US-060: a leitura da timeline (PRC-12 — `TimelineController`/`GetProcessTimelineHandler`).
 */
@Module({
  imports: [
    AccessModule,
    ApprovalModule,
    IdentityModule,
    OrganizationModule,
    ProcessModule,
    DocumentModule,
    FilesModule,
    RiskModule,
    EtpModule,
    CollaborationModule,
  ],
  controllers: [TimelineController],
  providers: [
    TimelineFacade,
    GetProcessTimelineHandler,
    PrismaTimelineTransactions,
    {
      provide: TIMELINE_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaTimelineTransactions],
      useFactory: (config: AppConfig, prisma: PrismaTimelineTransactions) =>
        config.oidc.fakeSigningKey === null ? prisma : new InMemoryTimelineTransactions(),
    },
    TimelineProjector,
    TimelineLookupResolver,
    PrismaTimelineEntryStore,
    {
      provide: TIMELINE_ENTRY_STORE,
      inject: [APP_CONFIG, PrismaTimelineEntryStore],
      // Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): timeline em memória.
      useFactory: (config: AppConfig, prisma: PrismaTimelineEntryStore) =>
        config.oidc.fakeSigningKey === null ? prisma : new InMemoryTimelineEntryStore(),
    },
    IdentityUserLookupSource,
    DepartmentLookupSource,
    ProcessLookupSource,
    ProcessStageLookupSource,
    ProcessParticipantLookupSource,
    DocumentLookupSource,
    DocumentVersionLookupSource,
    AttachmentLookupSource,
    RiskLookupSource,
    CommentLookupSource,
    RoleLookupSource,
    ApprovalLookupSource,
    EtpAlternativeLookupSource,
    {
      provide: TIMELINE_LOOKUP_SOURCES,
      // US-001: unidade, processo e etapa das referências de `ProcessCreated`. US-065: documento e
      // versão dos eventos `Document*`. US-068: anexo (`ATTACHMENT_REMOVED`). US-012: participante
      // (`PARTICIPANT_REMOVED`). US-033: risco (`RISK_ADDED`/`RISK_LEVEL_CHANGED`/`RISK_REMOVED`).
      // US-071: comentário (`COMMENT_ADDED` — trecho e sigilo do documento-alvo). US-051: perfil
      // aprovador (`APPROVAL_REQUESTED` com `approverType = ROLE`). US-009: título da aprovação
      // (`APPROVAL_CANCELED`). US-021: nome da alternativa (`ETP_ALTERNATIVE_RECOMMENDED`).
      inject: [
        IdentityUserLookupSource,
        DepartmentLookupSource,
        ProcessLookupSource,
        ProcessStageLookupSource,
        ProcessParticipantLookupSource,
        DocumentLookupSource,
        DocumentVersionLookupSource,
        AttachmentLookupSource,
        RiskLookupSource,
        CommentLookupSource,
        RoleLookupSource,
        ApprovalLookupSource,
        EtpAlternativeLookupSource,
      ],
      useFactory: (...sources: AnyTimelineLookupSource[]): AnyTimelineLookupSource[] => sources,
    },
  ],
  exports: [TimelineFacade],
})
export class TimelineModule {}
