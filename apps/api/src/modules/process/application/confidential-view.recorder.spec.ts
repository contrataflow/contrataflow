import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuditEntry, AuditTrailPort } from '#shared/audit/audit-trail.js';
import type { TenantCache } from '#shared/cache/tenant-cache.js';
import { runWithRequestContext } from '#shared/context/request-context.js';

import {
  CONFIDENTIAL_VIEW_TTL_SECONDS,
  ConfidentialViewRecorder,
} from './confidential-view.recorder.js';

const PROCESS = { id: '0192d004-0000-7000-8000-000000000031', code: '0031/2026' };

/** Auditoria e cache de mentira: registra as gravações e guarda as marcas por chave. */
function harness(options: { readonly cacheDown?: boolean } = {}) {
  const entries: AuditEntry[] = [];
  const marks = new Map<string, unknown>();
  const audit: AuditTrailPort = {
    record: () => Promise.reject(new Error('não usado')),
    recordStandalone: async (entry) => {
      await Promise.resolve();
      entries.push(entry);
      return { kind: 'recorded', id: 'x', occurredAt: new Date(), rowHash: 'h' };
    },
  };
  const cache = {
    get: (_module: string, key: string) =>
      options.cacheDown
        ? Promise.reject(new Error('ECONNREFUSED'))
        : Promise.resolve(marks.get(key) ?? null),
    set: (_module: string, key: string, value: unknown, write: { ttlSeconds: number }) => {
      if (options.cacheDown) return Promise.reject(new Error('ECONNREFUSED'));
      expect(write.ttlSeconds).toBe(CONFIDENTIAL_VIEW_TTL_SECONDS);
      marks.set(key, value);
      return Promise.resolve();
    },
  } as unknown as TenantCache;
  return { entries, recorder: new ConfidentialViewRecorder(audit, cache) };
}

const inSession = <T>(sessionIdHash: string | undefined, fn: () => Promise<T>) =>
  runWithRequestContext(
    {
      correlationId: 'c0rre1a7',
      ip: '10.0.0.1',
      userAgent: 'vitest',
      ...(sessionIdHash === undefined ? {} : { sessionIdHash }),
    },
    fn,
  );

describe('ConfidentialViewRecorder (US-004 · RN-PROC-55 · process.confidential_view)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('grava uma vez por sessão e processo — abas simultâneas e recargas não repetem', async () => {
    const { entries, recorder } = harness();
    await inSession('a'.repeat(64), async () => {
      await Promise.all([
        recorder.recordOnce(PROCESS, 'PRC-07'),
        recorder.recordOnce(PROCESS, 'PRC-07'),
      ]);
      await recorder.recordOnce(PROCESS, 'PRC-07');
      await recorder.recordOnce(PROCESS, 'PRC-04');
    });
    expect(entries).toEqual([
      {
        action: 'process.confidential_view',
        entityType: 'Process',
        entityId: PROCESS.id,
        processId: PROCESS.id,
        metadata: { processCode: '0031/2026', source: 'PRC-07' },
      },
    ]);
    // Outra sessão do mesmo usuário é outro acesso.
    await inSession('b'.repeat(64), () => recorder.recordOnce(PROCESS, 'PRC-04'));
    expect(entries.map((entry) => entry.metadata?.source)).toEqual(['PRC-07', 'PRC-04']);
  });

  it('cache fora do ar: grava assim mesmo (nunca deixa de auditar) e avisa', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { entries, recorder } = harness({ cacheDown: true });
    await inSession(undefined, async () => {
      await recorder.recordOnce(PROCESS, 'PRC-07');
      await recorder.recordOnce(PROCESS, 'PRC-07');
    });
    expect(entries).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'process.confidential_view_cache_unavailable' }),
      'process.confidential_view_cache_unavailable',
    );
  });
});
