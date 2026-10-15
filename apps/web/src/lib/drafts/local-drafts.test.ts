import { describe, expect, it } from 'vitest';

import { DRAFT_TTL_MS, LocalDrafts, MemoryDraftBackend, localDrafts } from './local-drafts';

/* Rascunhos locais por usuário + instituição (RN-IAM-30/31). */

const CLAUDIA = 'user-claudia';
const BRUNO = 'user-bruno';
const SAO_JOSE = 'tenant-sao-jose';
const SANTA_LUZIA = 'tenant-santa-luzia';

function drafts(clock = { now: Date.parse('2026-10-14T08:00:00Z') }) {
  return { clock, subject: new LocalDrafts(new MemoryDraftBackend(), () => clock.now) };
}

const justification = {
  tenantId: SAO_JOSE,
  target: 'dfd:1:JUSTIFICATION',
  content: 'trecho digitado',
  baseRevision: 3,
};

describe('rascunhos locais (RN-IAM-30)', () => {
  it('[Sucesso] sobrevivem à expiração e voltam ao mesmo usuário na mesma instituição', async () => {
    const { clock, subject } = drafts();
    await subject.save({ ...justification, userId: CLAUDIA });
    clock.now += 31 * 60_000;
    expect(await subject.recoverable(CLAUDIA, SAO_JOSE)).toMatchObject([
      { content: 'trecho digitado', baseRevision: 3, synced: false },
    ]);
    expect(await subject.recoverable(CLAUDIA, SANTA_LUZIA)).toEqual([]);
    expect(await subject.recoverable(BRUNO, SAO_JOSE)).toEqual([]);
  });

  it('vencem em 24 h e somem quando sincronizados', async () => {
    const { clock, subject } = drafts();
    await subject.save({ ...justification, userId: CLAUDIA });
    await subject.markSynced({ ...justification, userId: CLAUDIA });
    expect(await subject.recoverable(CLAUDIA, SAO_JOSE)).toEqual([]);
    expect(await subject.hasUnsynced(CLAUDIA)).toBe(false);
    await subject.markSynced({ ...justification, userId: BRUNO });
    await subject.save({ ...justification, userId: CLAUDIA, content: 'nova versão' });
    clock.now += DRAFT_TTL_MS + 1;
    expect(await subject.recoverable(CLAUDIA, SAO_JOSE)).toEqual([]);
  });

  it('[Tenant incorreto] outro usuário no navegador: rascunhos de terceiros são apagados', async () => {
    const { clock, subject } = drafts();
    await subject.save({ ...justification, userId: CLAUDIA });
    await subject.save({ ...justification, userId: BRUNO, target: 'etp:2:NEED' });
    await subject.purgeForeign(BRUNO);
    expect(await subject.hasUnsynced(CLAUDIA)).toBe(false);
    expect(await subject.hasUnsynced(BRUNO)).toBe(true);
    // Os vencidos do próprio usuário também saem.
    clock.now += DRAFT_TTL_MS + 1;
    await subject.purgeForeign(BRUNO);
    expect(await subject.hasUnsynced(BRUNO)).toBe(false);
  });
});

describe('logout (RN-IAM-31)', () => {
  it('sinaliza rascunho não sincronizado e apaga os do usuário', async () => {
    const { subject } = drafts();
    expect(await subject.hasUnsynced(CLAUDIA)).toBe(false);
    await subject.save({ ...justification, userId: CLAUDIA });
    await subject.save({ ...justification, userId: BRUNO });
    expect(await subject.hasUnsynced(CLAUDIA)).toBe(true);
    await subject.clearUser(CLAUDIA);
    expect(await subject.hasUnsynced(CLAUDIA)).toBe(false);
    expect(await subject.hasUnsynced(BRUNO)).toBe(true);
  });

  it('sem IndexedDB (testes, modo privado restrito) usa memória', async () => {
    const shared = localDrafts();
    expect(localDrafts()).toBe(shared);
    await shared.save({ ...justification, userId: CLAUDIA });
    expect(await shared.hasUnsynced(CLAUDIA)).toBe(true);
    await shared.clearUser(CLAUDIA);
  });
});
