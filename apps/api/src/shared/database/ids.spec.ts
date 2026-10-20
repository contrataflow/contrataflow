import { describe, expect, it } from 'vitest';

import { isUuid, naturalKeyId, newId } from './ids.js';

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newId (UUIDv7 — DEC-002 · RN-FND-39)', () => {
  it('gera UUID versão 7, variante RFC 9562, com o instante nos 48 bits iniciais', () => {
    const now = Date.UTC(2026, 9, 14, 12, 0, 0);
    const id = newId(now);
    expect(id).toMatch(V7);
    expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(now);
  });

  it('ids do mesmo milissegundo saem em ordem crescente e distintos', () => {
    const now = Date.UTC(2030, 0, 1);
    const ids = Array.from({ length: 50 }, () => newId(now));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('relógio que volta não quebra a ordem nem a unicidade', () => {
    const later = newId(Date.UTC(2031, 0, 1));
    const earlier = newId(Date.UTC(2020, 0, 1));
    expect(earlier > later).toBe(true);
  });

  it('esgotado o contador do milissegundo, avança o tempo em vez de repetir', () => {
    const now = Date.UTC(2032, 0, 1);
    const ids = Array.from({ length: 5000 }, () => newId(now));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    const last = ids.at(-1) ?? '';
    expect(Number.parseInt(last.replaceAll('-', '').slice(0, 12), 16)).toBeGreaterThan(now);
  });

  it('não é previsível: a parte aleatória muda entre chamadas', () => {
    const tail = (id: string) => id.slice(19);
    expect(tail(newId())).not.toBe(tail(newId()));
  });
});

describe('isUuid', () => {
  it('aceita UUID textual e recusa o resto', () => {
    expect(isUuid('0192a000-0000-7000-8000-00000000000a')).toBe(true);
    expect(isUuid(newId())).toBe(true);
    expect(isUuid("' OR 1=1 --")).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});

describe('naturalKeyId (UUIDv7 determinístico)', () => {
  it('é UUIDv7 com o instante informado e determinístico pelo nome', () => {
    const at = new Date('2026-10-01T03:00:00Z');
    const id = naturalKeyId('tenant:2026-10:80', at);
    expect(id).toMatch(V7);
    expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(at.getTime());
    expect(naturalKeyId('tenant:2026-10:80', at)).toBe(id);
    expect(naturalKeyId('tenant:2026-10:100', at)).not.toBe(id);
  });
});
