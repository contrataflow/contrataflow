import { describe, expect, it } from 'vitest';

import type { TenantTx } from '#shared/database/prisma.js';

import type { AnyTimelineLookupSource } from './ports.js';
import {
  TimelineLookupSourceConflictError,
  TimelineLookupUnavailableError,
} from './timeline-errors.js';
import { TimelineLookupResolver } from './timeline-lookup.resolver.js';

const ANA = '0192f000-0000-7000-8000-000000000010';
const BRUNO = '0192f000-0000-7000-8000-000000000011';
const DEPT = '0192f000-0000-7000-8000-000000000020';
const tx = {} as TenantTx;

function userSource(calls: string[][]): AnyTimelineLookupSource {
  return {
    kind: 'USER',
    lookup: (_tx, ids) => {
      calls.push([...ids]);
      return Promise.resolve(
        new Map(ids.filter((id) => id === ANA).map((id) => [id, { name: 'Ana' }])),
      );
    },
  };
}

describe('TimelineLookupResolver (RN-TML-04)', () => {
  it('uma leitura por tipo, sem IDs repetidos, no tx recebido', async () => {
    const calls: string[][] = [];
    const seenTx: unknown[] = [];
    const departments: AnyTimelineLookupSource = {
      kind: 'DEPARTMENT',
      lookup: (received, ids) => {
        seenTx.push(received);
        return Promise.resolve(new Map(ids.map((id) => [id, { name: 'Compras' }])));
      },
    };
    const resolver = new TimelineLookupResolver([userSource(calls), departments]);

    const lookups = await resolver.resolve(tx, [
      { kind: 'USER', id: ANA },
      { kind: 'DEPARTMENT', id: DEPT },
      { kind: 'USER', id: BRUNO },
      { kind: 'USER', id: ANA },
    ]);

    expect(calls).toEqual([[ANA, BRUNO]]);
    expect(seenTx).toEqual([tx]);
    expect(lookups.get('USER', ANA)).toEqual({ name: 'Ana' });
    expect(lookups.get('USER', BRUNO)).toBeNull();
    expect(lookups.get('DEPARTMENT', DEPT)).toEqual({ name: 'Compras' });
  });

  it('sem referências não lê nada', async () => {
    const calls: string[][] = [];
    const lookups = await new TimelineLookupResolver([userSource(calls)]).resolve(tx, []);
    expect(calls).toEqual([]);
    expect(lookups.get('USER', ANA)).toBeNull();
  });

  it('tipo sem fonte registrada falha (a projeção não grava nomes nulos por esquecimento)', async () => {
    const resolver = new TimelineLookupResolver([userSource([])]);
    await expect(resolver.resolve(tx, [{ kind: 'PROCESS_STAGE', id: DEPT }])).rejects.toThrow(
      TimelineLookupUnavailableError,
    );
    await expect(resolver.resolve(tx, [{ kind: 'PROCESS_STAGE', id: DEPT }])).rejects.toThrow(
      /PROCESS_STAGE/,
    );
  });

  it('duas fontes para o mesmo tipo falham na subida', () => {
    expect(() => new TimelineLookupResolver([userSource([]), userSource([])])).toThrow(
      TimelineLookupSourceConflictError,
    );
  });
});
