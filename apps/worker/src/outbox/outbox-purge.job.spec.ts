import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { OutboxDatabase } from '#shared/database/outbox-database.js';

import { OutboxPurgeJob } from './outbox-purge.job.js';
import type { JobHandlerContext } from '../queues/run-job.js';

const context = { logger: new Logger('test') } as unknown as JobHandlerContext;
const database = {} as OutboxDatabase;

describe('maintenance.outbox-purge (DEC-085 · queues.md §4.8)', () => {
  it('purga sob a trava própria; sem a trava conclui skipped', async () => {
    const purge = vi.fn(() => Promise.resolve(42));
    const keys: string[] = [];
    const job = new OutboxPurgeJob(
      database,
      {
        withAdvisoryLock: async (key, work) => {
          keys.push(key);
          return { acquired: true, result: await work() };
        },
      },
      purge,
    );
    await expect(job.handle({}, context)).resolves.toBe('completed');
    expect(purge).toHaveBeenCalledWith(database);
    expect(keys).toEqual(['cf:maintenance:outbox-purge']);

    const held = new OutboxPurgeJob(
      database,
      { withAdvisoryLock: () => Promise.resolve({ acquired: false }) },
      purge,
    );
    await expect(held.handle({}, context)).resolves.toBe('skipped');
    expect(purge).toHaveBeenCalledTimes(1);
  });
});
