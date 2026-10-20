import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { NumberSequenceRepository } from './numbering-ports.js';
import { NumberingFacade } from './numbering.facade.js';
import { InvalidNumberMaskError } from '../domain/number-mask.js';
import {
  InMemoryNumberingSettingsReader,
  InMemoryNumberSequenceRepository,
} from '../infrastructure/in-memory-number-sequence.repository.js';

const A = '0192c000-0000-7000-8000-00000000105a';
const B = '0192c000-0000-7000-8000-00000000105b';
const ORG_A = '0192c000-0000-7000-8000-0000000105a1';
const ORG_A2 = '0192c000-0000-7000-8000-0000000105a2';
const NOW = new Date('2026-10-15T12:00:00.000Z');

function setup(now: () => Date = () => NOW, sequences?: NumberSequenceRepository) {
  const repository = new InMemoryNumberSequenceRepository();
  const settings = new InMemoryNumberingSettingsReader();
  const facade = new NumberingFacade(sequences ?? repository, settings, now);
  const inTenant = <T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> =>
    runWithRequestContext({ correlationId: 'corr-numbering', ip: '', userAgent: '' }, () => {
      updateRequestContext({
        tenantId,
        actor: { type: 'SYSTEM', userId: null, membershipId: null, name: 'Teste' },
      });
      return runSimulatedTransaction(work);
    });
  settings.addOrganization(A, { id: ORG_A, shortName: 'PMSJ' });
  settings.addOrganization(A, { id: ORG_A2, shortName: 'SEMED' });
  return { repository, settings, facade, inTenant };
}

describe('NumberingFacade (US-105 · DEC-028)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('processo: sequência do tenant no ano corrente, formatada pela máscara configurada', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { repository, facade, inTenant } = setup();
    repository.seed(A, 'PROCESS:*:2026', 11);

    const assigned = await inTenant(A, (tx) =>
      facade.assignProcessNumber(tx, { organizationId: ORG_A }),
    );

    expect(assigned).toEqual({
      sequenceKey: 'PROCESS:*:2026',
      number: 12,
      year: 2026,
      code: '0012/2026',
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'numbering.assigned',
        sequenceKey: 'PROCESS:*:2026',
        value: 12,
        tenantId: A,
      }),
      'numbering.assigned',
    );
  });

  it('escopo ORGANIZATION com {org}: uma sequência por órgão e a sigla do órgão do processo', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { settings, facade, inTenant } = setup();
    settings.set(A, { processScope: 'ORGANIZATION', processMask: '{org}-{seq:4}/{year}' });

    const codes = await inTenant(A, async (tx) => [
      (await facade.assignProcessNumber(tx, { organizationId: ORG_A })).code,
      (await facade.assignProcessNumber(tx, { organizationId: ORG_A2 })).code,
      (await facade.assignProcessNumber(tx, { organizationId: ORG_A })).code,
    ]);

    expect(codes).toEqual(['PMSJ-0001/2026', 'SEMED-0001/2026', 'PMSJ-0002/2026']);
  });

  it('RN-TEN-68: escopo alterado no meio do ano só vale no próximo exercício', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    let now = NOW;
    const { repository, settings, facade, inTenant } = setup(() => now);
    repository.seed(A, 'PROCESS:*:2026', 40);
    settings.set(A, { processScope: 'ORGANIZATION', processMask: '{org}-{seq:4}/{year}' });

    const sameYear = await inTenant(A, (tx) =>
      facade.assignProcessNumber(tx, { organizationId: ORG_A2 }),
    );
    expect(sameYear).toMatchObject({ sequenceKey: 'PROCESS:*:2026', code: 'SEMED-0041/2026' });

    // FA-01: virada do ano no fuso do tenant — nova sequência, já com o escopo novo.
    now = new Date('2027-01-01T03:00:01.000Z');
    const nextYear = await inTenant(A, (tx) =>
      facade.assignProcessNumber(tx, { organizationId: ORG_A2 }),
    );
    expect(nextYear).toMatchObject({
      sequenceKey: `PROCESS:${ORG_A2}:2027`,
      number: 1,
      year: 2027,
      code: 'SEMED-0001/2027',
    });
    expect(repository.valueOf(A, 'PROCESS:*:2026')).toBe(41);
  });

  it('documento: máscara do tipo, override e padrão, com sequência por tipo e ano no tenant', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { settings, facade, inTenant } = setup();
    settings.set(A, {
      processScope: 'ORGANIZATION',
      documentMasks: new Map([['OFICIO', 'OF-{org} {seq:3}/{year}']]),
    });

    const result = await inTenant(A, async (tx) => ({
      risk: await facade.assignDocumentNumber(tx, {
        documentTypeCode: 'RISK_MAP',
        typeMask: 'MR {seq:4}/{year}',
        organizationId: ORG_A,
      }),
      dfd: await facade.assignDocumentNumber(tx, {
        documentTypeCode: 'DFD',
        typeMask: null,
        organizationId: ORG_A,
      }),
      dfd2: await facade.assignDocumentNumber(tx, {
        documentTypeCode: 'DFD',
        typeMask: null,
        organizationId: ORG_A2,
      }),
      oficio: await facade.assignDocumentNumber(tx, {
        documentTypeCode: 'OFICIO',
        typeMask: null,
        organizationId: ORG_A2,
      }),
    }));

    expect(result.risk).toEqual({
      sequenceKey: 'DOCUMENT:RISK_MAP:*:2026',
      number: 1,
      year: 2026,
      code: 'MR 0001/2026',
    });
    expect(result.dfd.code).toBe('DFD 0001/2026');
    // Documento numera no tenant mesmo com escopo ORGANIZATION para processos.
    expect(result.dfd2).toMatchObject({
      sequenceKey: 'DOCUMENT:DFD:*:2026',
      code: 'DFD 0002/2026',
    });
    expect(result.oficio.code).toBe('OF-SEMED 001/2026');
  });

  it('sequências de tenants diferentes nunca se misturam', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { repository, facade, inTenant } = setup();
    repository.seed(B, 'PROCESS:*:2026', 900);

    const fromA = await inTenant(A, (tx) =>
      facade.assignProcessNumber(tx, { organizationId: ORG_A }),
    );

    expect(fromA.number).toBe(1);
    expect(repository.valueOf(B, 'PROCESS:*:2026')).toBe(900);
  });

  it('espera acima de 200 ms no bloqueio gera warn numbering.lock_wait', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const slow: NumberSequenceRepository = {
      increment: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(7);
          }, 230);
        }),
      lastValue: () => Promise.resolve(0),
      openedProcessKeyOfYear: () => Promise.resolve(null),
    };
    const { facade, inTenant } = setup(() => NOW, slow);

    expect(await inTenant(A, (tx) => facade.next(tx, 'PROCESS:*:2026'))).toBe(7);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'numbering.lock_wait', sequenceKey: 'PROCESS:*:2026' }),
      'numbering.lock_wait',
    );
  });

  describe('preview (SET-04 · RN-TEN-73)', () => {
    it('próximo valor hipotético sem incrementar a sequência', async () => {
      const { repository, facade, inTenant } = setup();
      repository.seed(A, 'PROCESS:*:2026', 11);

      const preview = await inTenant(A, (tx) => facade.preview(tx, { mask: '{seq:4}/{year}' }));

      expect(preview).toEqual({ example: '0012/2026', nextValue: '12' });
      expect(repository.valueOf(A, 'PROCESS:*:2026')).toBe(11);
    });

    it('escopo informado prevalece sobre o gravado; {org} usa o órgão principal', async () => {
      const { repository, settings, facade, inTenant } = setup();
      repository.seed(A, `PROCESS:${ORG_A}:2026`, 4);

      const preview = await inTenant(A, (tx) =>
        facade.preview(tx, { mask: '{org}-{seq:5}/{year}', scope: 'ORGANIZATION' }),
      );
      expect(preview).toEqual({ example: 'PMSJ-00005/2026', nextValue: '5' });

      settings.set(A, { processScope: 'ORGANIZATION' });
      await expect(
        inTenant(A, (tx) => facade.preview(tx, { mask: '{seq:4}/{year}' })),
      ).rejects.toMatchObject({ problem: 'MISSING_ORG' });
    });

    it('máscara de documento por tipo e máscara inválida', async () => {
      const { repository, facade, inTenant } = setup();
      repository.seed(A, 'DOCUMENT:DFD:*:2026', 4);

      expect(
        await inTenant(A, (tx) =>
          facade.preview(tx, { mask: '{type} {seq:4}/{year}', documentTypeCode: 'DFD' }),
        ),
      ).toEqual({ example: 'DFD 0005/2026', nextValue: '5' });
      await expect(
        inTenant(A, (tx) => facade.preview(tx, { mask: '{type} {seq:4}/{year}' })),
      ).rejects.toBeInstanceOf(InvalidNumberMaskError);
      await expect(
        inTenant(A, (tx) => facade.preview(tx, { mask: '{seq:4}' })),
      ).rejects.toMatchObject({ problem: 'MISSING_YEAR' });
    });

    it('sem órgão principal conhecido, {org} fica vazio', async () => {
      const { facade, inTenant } = setup();
      expect(
        await inTenant(B, (tx) =>
          facade.preview(tx, { mask: '{org}{seq:2}/{year}', scope: 'ORGANIZATION' }),
        ),
      ).toEqual({ example: '01/2026', nextValue: '1' });
    });
  });

  it('formatMask aplica a máscara', () => {
    const { facade } = setup();
    expect(
      facade.formatMask('{type} {seq:4}/{year}', { sequence: 5, year: 2026, type: 'DFD' }),
    ).toBe('DFD 0005/2026');
  });
});
