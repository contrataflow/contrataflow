import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AuditSeal,
  GENESIS_CHAIN_HASH,
  SealChainVerifier,
  chainHashOf,
  periodDigest,
  sealPeriodOf,
} from './audit-seal.js';
import type { SealCheck, SealableRecord } from './audit-seal.js';

const TENANT = '0192d074-0000-7000-8000-00000000000a';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Vetores fixos — os mesmos de `apps/worker/src/audit/audit-sealer.spec.ts`. */
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const DIGEST_AB = 'fa0dafbf43f1f551e536353e9d1a942a8e86e41a0b58dfeaf264ef217f6b862a';
const CHAIN_GENESIS_AB = '550ad8ae79c5f931e3ebdd72f09a1b7f05b13af5d5bbe6d3e7e4d1bf452aa6f7';

let sequence = 0;
function records(count: number, salt: string): SealableRecord[] {
  return Array.from({ length: count }, (_, index) => {
    sequence += 1;
    return {
      id: `0192d074-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`,
      rowHash: sha(`${salt}-${String(index)}`),
    };
  });
}

function sealOf(
  hour: string,
  previous: AuditSeal | null,
  rows: readonly SealableRecord[],
): AuditSeal {
  sequence += 1;
  const seal = AuditSeal.create({
    id: `0192d074-0000-7000-8000-5${sequence.toString(16).padStart(11, '0')}`,
    tenantId: TENANT,
    period: sealPeriodOf(new Date(hour)),
    previous,
    records: rows,
    sealedAt: new Date(new Date(hour).getTime() + 65 * 60_000),
  });
  if (!seal) throw new Error('selo vazio');
  return seal;
}

/** Cadeia de 3 selos (10h, 11h, 13h — 12h sem atividade) com os registros de cada período. */
function chain(): { seals: AuditSeal[]; checks: SealCheck[] } {
  const rows10 = records(3, '10');
  const rows11 = records(2, '11');
  const rows13 = records(4, '13');
  const s10 = sealOf('2026-10-05T10:00:00Z', null, rows10);
  const s11 = sealOf('2026-10-05T11:00:00Z', s10, rows11);
  const s13 = sealOf('2026-10-05T13:00:00Z', s11, rows13);
  return {
    seals: [s10, s11, s13],
    checks: [
      { seal: s10, records: rows10 },
      { seal: s11, records: rows11 },
      { seal: s13, records: rows13 },
    ],
  };
}

describe('AuditSeal.create (RN-AUD-11/12)', () => {
  it('digest e chainHash seguem os vetores fixos (mesma definição do worker)', () => {
    expect(periodDigest([A, B])).toBe(DIGEST_AB);
    expect(chainHashOf(GENESIS_CHAIN_HASH, DIGEST_AB)).toBe(CHAIN_GENESIS_AB);
    expect(GENESIS_CHAIN_HASH).toBe('0'.repeat(64));
  });

  it('[Sucesso] 10 registros: recordCount, digest dos rowHash ordenados e chainHash = SHA-256(H0 ∥ digest)', () => {
    const rows = records(10, 'p14');
    const h0 = sha('H0');
    const seal = AuditSeal.create({
      id: '0192d074-0000-7000-8000-0000000000ff',
      tenantId: TENANT,
      period: sealPeriodOf(new Date('2026-10-05T14:37:12.345Z')),
      previous: { id: '0192d074-0000-7000-8000-0000000000fe', chainHash: h0 },
      records: rows,
      sealedAt: new Date('2026-10-05T15:05:00Z'),
    });
    expect(seal).toMatchObject({
      recordCount: 10,
      periodStart: new Date('2026-10-05T14:00:00.000Z'),
      periodEnd: new Date('2026-10-05T14:59:59.999Z'),
      firstAuditId: rows[0]?.id,
      lastAuditId: rows[9]?.id,
      previousSealId: '0192d074-0000-7000-8000-0000000000fe',
      digest: sha(rows.map((row) => row.rowHash).join('')),
    });
    expect(seal?.chainHash).toBe(sha(h0 + (seal?.digest ?? '')));
  });

  it('é determinístico e o primeiro selo do tenant encadeia nos 64 zeros', () => {
    const rows = records(2, 'det');
    const input = {
      id: '0192d074-0000-7000-8000-0000000000fd',
      tenantId: TENANT,
      period: sealPeriodOf(new Date('2026-10-05T09:00:00Z')),
      previous: null,
      records: rows,
      sealedAt: new Date('2026-10-05T10:05:00Z'),
    };
    const first = AuditSeal.create(input);
    expect(AuditSeal.create(input)).toEqual(first);
    expect(first?.previousSealId).toBeNull();
    expect(first?.chainHash).toBe(chainHashOf(GENESIS_CHAIN_HASH, first?.digest ?? ''));
  });

  it('período vazio não gera selo (RN-AUD-12)', () => {
    expect(
      AuditSeal.create({
        id: '0192d074-0000-7000-8000-0000000000fc',
        tenantId: TENANT,
        period: sealPeriodOf(new Date('2026-10-05T09:00:00Z')),
        previous: null,
        records: [],
        sealedAt: new Date(),
      }),
    ).toBeNull();
  });

  it('a hora do período é a hora cheia UTC que contém o instante', () => {
    expect(sealPeriodOf(new Date('2026-10-05T14:00:00.000Z'))).toEqual({
      start: new Date('2026-10-05T14:00:00.000Z'),
      end: new Date('2026-10-05T14:59:59.999Z'),
    });
    expect(sealPeriodOf(new Date('2026-10-05T14:59:59.999Z')).start).toEqual(
      new Date('2026-10-05T14:00:00.000Z'),
    );
  });
});

describe('SealChainVerifier (RN-AUD-15/16)', () => {
  it('cadeia íntegra com lacuna de período (FA-03): tudo VALID', () => {
    const { checks } = chain();
    const result = SealChainVerifier.verify(null, checks);
    expect(result.brokenAtPeriodStart).toBeNull();
    expect(result.results.map((item) => item.status)).toEqual(['VALID', 'VALID', 'VALID']);
    expect(result.results.map((item) => item.recordCount)).toEqual([3, 2, 4]);
  });

  it('linha alterada no período: INVALID com quebra no digest; os seguintes seguem avaliados', () => {
    const { checks } = chain();
    const [c10, c11, c13] = checks as [SealCheck, SealCheck, SealCheck];
    const tampered = c11.records.map((row, index) =>
      index === 0 ? { ...row, rowHash: sha('alterado') } : row,
    );
    const result = SealChainVerifier.verify(null, [c10, { ...c11, records: tampered }, c13]);
    expect(result.results.map((item) => [item.status, item.brokenAt])).toEqual([
      ['VALID', undefined],
      ['INVALID', 'digest'],
      ['VALID', undefined],
    ]);
    expect(result.brokenAtPeriodStart).toEqual(c11.seal.periodStart);
  });

  it('linha removida ou inserida no período também quebra o digest', () => {
    const { checks } = chain();
    const [c10] = checks as [SealCheck];
    const removed = SealChainVerifier.verify(null, [{ ...c10, records: c10.records.slice(1) }]);
    expect(removed.results[0]).toMatchObject({ status: 'INVALID', brokenAt: 'digest' });
    expect(removed.results[0]?.recordCount).toBe(2);
    const inserted = SealChainVerifier.verify(null, [
      { ...c10, records: [...c10.records, ...records(1, 'novo')] },
    ]);
    expect(inserted.results[0]).toMatchObject({ status: 'INVALID', brokenAt: 'digest' });
    const swapped = SealChainVerifier.verify(null, [
      { ...c10, records: [...c10.records].reverse() },
    ]);
    expect(swapped.results[0]).toMatchObject({ status: 'INVALID', brokenAt: 'digest' });
  });

  it('selo intermediário removido: o seguinte quebra no chainHash', () => {
    const { checks } = chain();
    const [c10, , c13] = checks as [SealCheck, SealCheck, SealCheck];
    const result = SealChainVerifier.verify(null, [c10, c13]);
    expect(result.results.map((item) => item.brokenAt)).toEqual([undefined, 'chain']);
    expect(result.brokenAtPeriodStart).toEqual(c13.seal.periodStart);
  });

  it('primeiro selo do tenant removido: o que sobrou aponta para um antecessor ausente', () => {
    const { checks } = chain();
    const [, c11] = checks as [SealCheck, SealCheck];
    const result = SealChainVerifier.verify(null, [c11]);
    expect(result.results[0]).toMatchObject({ status: 'INVALID', brokenAt: 'chain' });
  });

  it('chainHash do selo anterior adulterado: o anterior quebra no chain e o atual também', () => {
    const { seals, checks } = chain();
    const [s10] = seals as [AuditSeal];
    const [c10, c11] = checks as [SealCheck, SealCheck];
    const forged = { ...s10, chainHash: sha('forjado') };
    const result = SealChainVerifier.verify(null, [{ ...c10, seal: forged }, c11]);
    expect(result.results.map((item) => item.brokenAt)).toEqual(['chain', 'chain']);
    expect(result.brokenAtPeriodStart).toEqual(s10.periodStart);
  });

  it('intervalo no meio da cadeia usa o antecessor real fora do intervalo', () => {
    const { seals, checks } = chain();
    const [s10] = seals as [AuditSeal];
    const [, c11, c13] = checks as [SealCheck, SealCheck, SealCheck];
    expect(SealChainVerifier.verify(s10, [c13, c11]).brokenAtPeriodStart).toBeNull();
    expect(SealChainVerifier.verify(null, [c11, c13]).results[0]?.brokenAt).toBe('chain');
  });
});
