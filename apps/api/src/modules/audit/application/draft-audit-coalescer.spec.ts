import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '#config/env.js';
import { InMemoryDraftAuditWindowStore } from '#shared/audit/draft-audit.js';

import { DraftAuditCoalescer } from './draft-audit-coalescer.js';

const config = loadConfig({
  NODE_ENV: 'test',
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://cf_app:test@127.0.0.1:1/contrataflow',
  REDIS_CACHE_URL: 'redis://127.0.0.1:1',
  OIDC_ISSUER_URL: 'https://issuer.contrataflow.test/application/o/contrataflow/',
  OIDC_FAKE_SIGNING_KEY: 'contrataflow-test-only-signing-key-0000',
});

const target = { tenantId: 't', documentId: 'd', target: 'SECTION:JUSTIFICATION', userId: 'u' };

class BrokenStore extends InMemoryDraftAuditWindowStore {
  override open(): Promise<never> {
    return Promise.reject(new Error('ECONNREFUSED'));
  }

  override markAudited(): Promise<void> {
    return Promise.reject(new Error('ECONNREFUSED'));
  }
}

describe('DraftAuditCoalescer (US-015 · RN-DFD-35)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1 registro por janela de 10 min; o seguinte cobre a faixa desde o último auditado', async () => {
    let now = 0;
    const coalescer = new DraftAuditCoalescer(new InMemoryDraftAuditWindowStore(() => now), config);
    const first = await coalescer.open(target);
    expect(first).toMatchObject({ record: true, opened: true, lastAuditedRevision: null });
    expect(coalescer.fromRevision(first, 4)).toBe(4);
    await coalescer.recorded(first, 4);

    now = 5 * 60_000;
    expect((await coalescer.open(target)).record).toBe(false);

    now = 10 * 60_000;
    const next = await coalescer.open(target);
    expect(next).toMatchObject({ record: true, lastAuditedRevision: 4 });
    expect(coalescer.fromRevision(next, 9)).toBe(5);
  });

  it('abandon devolve só a janela que a própria gravação abriu', async () => {
    const coalescer = new DraftAuditCoalescer(new InMemoryDraftAuditWindowStore(() => 0), config);
    const opened = await coalescer.open(target);
    const notOpened = await coalescer.open(target);
    await coalescer.abandon(notOpened);
    expect((await coalescer.open(target)).record).toBe(false);
    await coalescer.abandon(opened);
    expect((await coalescer.open(target)).record).toBe(true);
  });

  it('Redis fora: audita toda gravação (fail-safe) e loga warn uma vez por minuto', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const coalescer = new DraftAuditCoalescer(new BrokenStore(), config);
    const first = await coalescer.open(target);
    const second = await coalescer.open(target);
    expect([first.record, second.record]).toEqual([true, true]);
    expect(first.opened).toBe(false);
    await coalescer.recorded(first, 3);
    await coalescer.abandon(first);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'audit.coalesce_store_unavailable' }),
      'audit.coalesce_store_unavailable',
    );
  });
});
