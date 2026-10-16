import { Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

import { TIMELINE_ENTRY_STORE, TIMELINE_LOOKUP_SOURCES } from './application/ports.js';
import type { AnyTimelineLookupSource } from './application/ports.js';
import { TimelineLookupResolver } from './application/timeline-lookup.resolver.js';
import { TimelineProjector } from './application/timeline-projector.js';
import { TimelineFacade } from './application/timeline.facade.js';
import { IdentityUserLookupSource } from './infrastructure/identity-user.lookup-source.js';
import { InMemoryTimelineEntryStore } from './infrastructure/in-memory-timeline-entry.store.js';
import { PrismaTimelineEntryStore } from './infrastructure/prisma-timeline-entry.store.js';
import {
  DepartmentLookupSource,
  ProcessLookupSource,
  ProcessStageLookupSource,
} from './infrastructure/process-lookup.sources.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { ProcessModule } from '../process/process.module.js';

/**
 * Módulo `timeline` (DEC-040, nível 5): outros módulos usam somente a fachada exportada. Dono de
 * `ProcessTimelineEntry`; o `TimelineProjector` (US-059) se registra no `SYNC_EVENT_HANDLERS` do
 * `platform` e projeta, na transação do caso de uso, os eventos de events.md §5. Os nomes
 * congelados vêm das fontes de `TIMELINE_LOOKUP_SOURCES`, pelas fachadas dos módulos donos —
 * a story que passa a publicar um evento mapeado registra aqui a fonte das referências dele.
 */
@Module({
  imports: [IdentityModule, OrganizationModule, ProcessModule],
  providers: [
    TimelineFacade,
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
    {
      provide: TIMELINE_LOOKUP_SOURCES,
      // US-001: unidade, processo e etapa das referências de `ProcessCreated`.
      inject: [
        IdentityUserLookupSource,
        DepartmentLookupSource,
        ProcessLookupSource,
        ProcessStageLookupSource,
      ],
      useFactory: (...sources: AnyTimelineLookupSource[]): AnyTimelineLookupSource[] => sources,
    },
  ],
  exports: [TimelineFacade],
})
export class TimelineModule {}
