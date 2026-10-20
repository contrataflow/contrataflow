import { describe, expect, it } from 'vitest';

import { isPresenceActive, otherActiveEditors } from './document-presence.js';
import type { PresenceRecord } from './document-presence.js';

/* US-070 · RN-DOC-89/90: poda das presenças expiradas e exclusão do próprio chamador. */

const NOW = new Date('2026-10-19T13:00:00.000Z');
const TTL = 60_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

function record(
  userId: string,
  lastSeenOffset: number,
  sinceOffset = lastSeenOffset,
): PresenceRecord {
  return {
    userId,
    sectionKey: 'JUSTIFICATIVA',
    since: at(sinceOffset),
    lastSeenAt: at(lastSeenOffset),
  };
}

describe('isPresenceActive', () => {
  it('ativa com heartbeat nos últimos 60 s; expirada a partir de 60 s sem heartbeat', () => {
    expect(isPresenceActive(record('a', 0), NOW, TTL)).toBe(true);
    expect(isPresenceActive(record('a', -59_999), NOW, TTL)).toBe(true);
    expect(isPresenceActive(record('a', -60_000), NOW, TTL)).toBe(false);
    expect(isPresenceActive(record('a', -120_000), NOW, TTL)).toBe(false);
  });
});

describe('otherActiveEditors', () => {
  it('exclui o próprio chamador, mesmo ativo', () => {
    expect(otherActiveEditors([record('eu', 0), record('ana', -1_000)], 'eu', NOW, TTL)).toEqual([
      record('ana', -1_000),
    ]);
  });

  it('poda quem passou de 60 s sem heartbeat', () => {
    const editors = otherActiveEditors(
      [record('ana', -10_000), record('bruno', -60_000), record('carla', -61_000)],
      'eu',
      NOW,
      TTL,
    );
    expect(editors.map((editor) => editor.userId)).toEqual(['ana']);
  });

  it('um por usuário (o heartbeat mais recente) e em ordem de chegada à seção, com desempate pelo id', () => {
    const editors = otherActiveEditors(
      [
        record('bruno', -5_000, -30_000),
        record('ana', -20_000, -30_000),
        record('carla', -1_000, -50_000),
        record('ana', -2_000, -10_000),
      ],
      'eu',
      NOW,
      TTL,
    );
    expect(editors.map((editor) => [editor.userId, editor.lastSeenAt])).toEqual([
      ['carla', at(-1_000)],
      ['bruno', at(-5_000)],
      ['ana', at(-2_000)],
    ]);
  });

  it('mesma chegada à seção: desempate estável pelo id', () => {
    const editors = otherActiveEditors(
      [record('bruno', -1_000, -9_000), record('ana', -3_000, -9_000)],
      'eu',
      NOW,
      TTL,
    );
    expect(editors.map((editor) => editor.userId)).toEqual(['ana', 'bruno']);
  });

  it('sem registros ou só o chamador → lista vazia', () => {
    expect(otherActiveEditors([], 'eu', NOW, TTL)).toEqual([]);
    expect(otherActiveEditors([record('eu', 0)], 'eu', NOW, TTL)).toEqual([]);
  });
});
