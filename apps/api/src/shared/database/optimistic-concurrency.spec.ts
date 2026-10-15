import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWithRequestContext } from '#shared/context/request-context.js';

import { VersionConflictError } from './errors.js';
import { assertVersionMatched, updateVersioned } from './optimistic-concurrency.js';

const target = { aggregateType: 'Process', aggregateId: 'p-1', expectedVersion: 3 };

describe('concorrência otimista (DEC-055 · RN-FND-42)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1 linha afetada: atualização aceita', async () => {
    await expect(
      updateVersioned(target, () => Promise.resolve({ count: 1 })),
    ).resolves.toBeUndefined();
    expect(() => {
      assertVersionMatched(1, target);
    }).not.toThrow();
  });

  it('[Concorrência] 0 linhas afetadas: VersionConflictError e log info sem dados de negócio', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const attempt = runWithRequestContext({ correlationId: 'corr-1', ip: '', userAgent: '' }, () =>
      updateVersioned(target, () => Promise.resolve(0)),
    );
    await expect(attempt).rejects.toBeInstanceOf(VersionConflictError);
    expect(log).toHaveBeenCalledWith(
      'db.optimistic_concurrency_conflict aggregateType=Process aggregateId=p-1 expectedVersion=3 correlationId=corr-1',
    );
  });

  it('fora de uma requisição o log usa "-" como correlationId', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    expect(() => {
      assertVersionMatched({ count: 0 }, target);
    }).toThrow(VersionConflictError);
    expect(String(log.mock.calls[0]?.[0])).toContain('correlationId=-');
  });

  it('mais de 1 linha: erro de programação (UPDATE sem a chave primária), não conflito', () => {
    expect(() => {
      assertVersionMatched(2, target);
    }).toThrow('UPDATE versionado de Process afetou 2 linhas.');
  });
});
