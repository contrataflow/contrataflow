import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DatabaseUnavailableError } from './errors.js';
import {
  NO_TENANT,
  SYSTEM_DB_REASONS,
  SystemDbNotConfiguredError,
  SystemDbReasonError,
  SystemDbService,
} from './system-db.service.js';
import type { SystemDbReason } from './system-db.service.js';

const settings = { maxWaitMs: 1_000, transactionTimeoutMs: 2_000, statementTimeoutMs: 1_000 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SystemDbService (RN-TEN-28)', () => {
  it('lista fechada de motivos e UUID nulo como app.tenant_id', () => {
    expect(SYSTEM_DB_REASONS).toEqual([
      'TENANT_LIFECYCLE',
      'TENANT_PROVISIONING',
      'TENANT_ENUMERATION',
      'USER_MEMBERSHIPS_LOOKUP',
      'INVITATION_LOOKUP',
      'PLATFORM_AUDIT',
    ]);
    expect(NO_TENANT).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('motivo fora da lista ou usuário que não é UUID: recusado antes de conectar', async () => {
    const service = new SystemDbService({ ...settings, url: 'postgresql://x@127.0.0.1:1/db' });
    const work = vi.fn(() => Promise.resolve());
    await expect(
      service.run('CURIOSIDADE' as SystemDbReason, work, { caller: 'teste' }),
    ).rejects.toBeInstanceOf(SystemDbReasonError);
    await expect(
      service.run('TENANT_LIFECYCLE', work, { caller: 'teste', userId: "x'; --" }),
    ).rejects.toBeInstanceOf(SystemDbReasonError);
    expect(work).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('sem DATABASE_URL_PLATFORM (local/dev/test) toda chamada é recusada', async () => {
    const service = new SystemDbService({ ...settings, url: null });
    await expect(
      service.run('TENANT_ENUMERATION', () => Promise.resolve(), { caller: 'teste' }),
    ).rejects.toBeInstanceOf(SystemDbNotConfiguredError);
    await service.onModuleDestroy();
  });

  it('banco fora do ar: 503 e a chamada fica no log system_db.call com o motivo', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const service = new SystemDbService({ ...settings, url: 'postgresql://x:y@127.0.0.1:1/db' });
    try {
      await expect(
        service.run('PLATFORM_AUDIT', () => Promise.resolve(), { caller: 'AuditoriaDePlataforma' }),
      ).rejects.toBeInstanceOf(DatabaseUnavailableError);
    } finally {
      await service.onModuleDestroy();
    }
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'system_db.call',
        reason: 'PLATFORM_AUDIT',
        caller: 'AuditoriaDePlataforma',
        outcome: 'error',
      }),
      'system_db.call',
    );
  });
});
