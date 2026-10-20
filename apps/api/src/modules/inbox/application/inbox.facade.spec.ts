import { describe, expect, it, vi } from 'vitest';

import type { TenantTx } from '#shared/database/prisma.js';

import type { InboxViewerResolver } from './inbox-viewer.resolver.js';
import { InboxFacade } from './inbox.facade.js';
import type { InboxCounts, InboxReader } from './ports.js';
import type { InboxViewer } from '../domain/task-inbox.js';

const COUNTS: InboxCounts = {
  MINE: 3,
  UNIT_QUEUE: 2,
  PENDING_APPROVALS: 1,
  RETURNED: 0,
  OVERDUE: 1,
  FOLLOWING: 4,
};

const viewer = (queueDepartmentIds: string[]) => ({ queueDepartmentIds }) as unknown as InboxViewer;

describe('InboxFacade.countersIn (US-076 · RN-DASH-03)', () => {
  const tx = {} as TenantTx;
  const now = new Date('2026-10-20T12:00:00.000Z');

  it('usa o leitor de TSK-02 no tx do chamador, com o recorte pedido', async () => {
    const counts = vi.fn<InboxReader['counts']>().mockResolvedValue(COUNTS);
    const resolveIn = vi.fn().mockResolvedValue(viewer(['d1']));
    const facade = new InboxFacade({ counts, page: vi.fn() }, {
      resolveIn,
    } as unknown as InboxViewerResolver);
    const restriction = { secretariatId: 's1', departmentIds: ['d1', 'd2'] };
    await expect(facade.countersIn(tx, now, restriction)).resolves.toEqual({
      counts: COUNTS,
      unitQueueApplies: true,
    });
    expect(resolveIn).toHaveBeenCalledWith(tx, now);
    expect(counts).toHaveBeenCalledWith(tx, viewer(['d1']), now, restriction);
  });

  it('sem fila da unidade (FA-01 de US-056) e sem recorte', async () => {
    const counts = vi.fn<InboxReader['counts']>().mockResolvedValue(COUNTS);
    const facade = new InboxFacade({ counts, page: vi.fn() }, {
      resolveIn: vi.fn().mockResolvedValue(viewer([])),
    } as unknown as InboxViewerResolver);
    const snapshot = await facade.countersIn(tx, now);
    expect(snapshot.unitQueueApplies).toBe(false);
    expect(counts.mock.calls[0]?.[3]).toBeNull();
  });
});
