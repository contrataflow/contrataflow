import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { IdentityFacade } from '#modules/identity/application/identity.facade.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { SYNC_EVENT_HANDLERS } from '#shared/outbox/outbox-writer.js';
import type { SyncEventHandlerRegistryPort } from '#shared/outbox/outbox-writer.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { TIMELINE_ENTRY_STORE } from './application/ports.js';
import { TimelineProjector } from './application/timeline-projector.js';
import { IdentityUserLookupSource } from './infrastructure/identity-user.lookup-source.js';
import { InMemoryTimelineEntryStore } from './infrastructure/in-memory-timeline-entry.store.js';
import { PrismaTimelineEntryStore } from './infrastructure/prisma-timeline-entry.store.js';
import { testConfig } from '../../../test/support/api-test-app.js';
import { AppModule } from '../../app.module.js';

describe('TimelineModule (US-059)', () => {
  it('na subida, o TimelineProjector se registra no SYNC_EVENT_HANDLERS do platform', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(testConfig())],
    }).compile();
    const registry = moduleRef.get<SyncEventHandlerRegistryPort>(SYNC_EVENT_HANDLERS);
    const projector = moduleRef.get(TimelineProjector);
    const registered: unknown[] = [];
    const original = registry.register.bind(registry);
    registry.register = (handler) => {
      registered.push(handler);
      original(handler);
    };
    try {
      await moduleRef.init();
      expect(registered).toEqual([projector]);
      // Modo de identidade fake: timeline em memória.
      expect(moduleRef.get(TIMELINE_ENTRY_STORE)).toBeInstanceOf(InMemoryTimelineEntryStore);
    } finally {
      await moduleRef.close();
    }
  });

  it('com banco configurado usa o store Prisma', async () => {
    const config = testConfig();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...config, oidc: { ...config.oidc, fakeSigningKey: null } })],
    }).compile();
    try {
      expect(moduleRef.get(TIMELINE_ENTRY_STORE)).toBeInstanceOf(PrismaTimelineEntryStore);
    } finally {
      await moduleRef.close();
    }
  });

  it('fonte USER: nome exibido pela fachada do identity, só de quem é do tenant', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(testConfig())],
    }).compile();
    try {
      const source = moduleRef.get(IdentityUserLookupSource);
      expect(moduleRef.get(IdentityFacade)).toBeInstanceOf(IdentityFacade);
      const tenantId = FAKE_TENANTS.prefeituraA.id;
      const member = FAKE_MEMBERSHIPS.find((m) => m.tenantId === tenantId);
      const user = Object.values(FAKE_USERS).find((candidate) => candidate.id === member?.userId);
      const outsider = Object.values(FAKE_USERS).find(
        (candidate) =>
          !FAKE_MEMBERSHIPS.some((m) => m.userId === candidate.id && m.tenantId === tenantId),
      );
      const records = await runWithRequestContext(
        { correlationId: 'c', ip: '', userAgent: '' },
        () => {
          updateRequestContext({ tenantId });
          return source.lookup({} as TenantTx, [user?.id ?? '', outsider?.id ?? '']);
        },
      );
      expect(source.kind).toBe('USER');
      expect([...records]).toEqual([[user?.id, { name: user?.socialName ?? user?.name }]]);
    } finally {
      await moduleRef.close();
    }
  });
});
