import { describe, expect, it } from 'vitest';

import {
  createOrganization,
  PrimaryOrganizationRequiredError,
  updateOrganization,
} from './organization.js';
import type { Organization } from './organization.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const LATER = new Date('2026-10-16T09:00:00.000Z');
const TENANT = '0192c000-0000-7000-8000-00000000a101';
const USER = '0192c000-0000-7000-8000-00000000a102';

function organization(overrides: Partial<Organization> = {}): Organization {
  return {
    ...createOrganization(
      {
        name: 'Fundo Municipal de Saúde',
        shortName: 'FMS',
        cnpj: '11444777000161',
        type: 'FUND',
        email: 'fms@saude.gov.br',
      },
      { id: '0192c000-0000-7000-8000-00000000a103', tenantId: TENANT, now: NOW, userId: null },
    ),
    ...overrides,
  };
}

const context = (overrides: Partial<Parameters<typeof updateOrganization>[2]> = {}) => ({
  now: LATER,
  userId: USER,
  isPrimary: false,
  otherActiveCount: 2,
  ...overrides,
});

describe('createOrganization (RN-TEN-38 · RN-TEN-43)', () => {
  it('nasce ativo, na versão 1, com metadata vazio e sem logotipo', () => {
    const created = organization();
    expect(created).toMatchObject({
      isActive: true,
      version: 1,
      metadata: {},
      logoAttachmentId: null,
      tenantId: TENANT,
      createdAt: NOW,
      updatedAt: NOW,
      createdById: null,
    });
  });

  it('campos opcionais ausentes viram null', () => {
    const created = organization();
    expect(created.phone).toBeNull();
    expect(created.addressZipCode).toBeNull();
    expect(created.email).toBe('fms@saude.gov.br');
  });
});

describe('updateOrganization', () => {
  it('aplica só o que mudou e informa campos, valores anterior/novo e o ator', () => {
    const current = organization();
    const result = updateOrganization(
      current,
      { name: 'Fundo Municipal de Saúde de São José', shortName: 'FMS', phone: '4833810000' },
      context(),
    );
    expect(result.changedFields).toEqual(['name', 'phone']);
    expect(result.changes).toEqual([
      {
        path: 'name',
        old: 'Fundo Municipal de Saúde',
        new: 'Fundo Municipal de Saúde de São José',
      },
      { path: 'phone', old: null, new: '4833810000' },
    ]);
    expect(result.next).toMatchObject({
      name: 'Fundo Municipal de Saúde de São José',
      phone: '4833810000',
      updatedAt: LATER,
      updatedById: USER,
      shortName: 'FMS',
    });
    // O agregado anterior não é alterado (imutável).
    expect(current.name).toBe('Fundo Municipal de Saúde');
  });

  it('nada alterado: sem campos, sem mudança de auditoria nem de updatedAt', () => {
    const current = organization();
    const result = updateOrganization(current, { name: current.name }, context());
    expect(result.changedFields).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(result.next.updatedAt).toBe(NOW);
  });

  it('null limpa um campo opcional', () => {
    const result = updateOrganization(organization(), { email: null }, context());
    expect(result.next.email).toBeNull();
    expect(result.changedFields).toEqual(['email']);
  });

  it('metadata não é editável pela API (RN-TEN-43)', () => {
    const result = updateOrganization(
      organization(),
      { metadata: { pncp: 1 } } as never,
      context(),
    );
    expect(result.next.metadata).toEqual({});
    expect(result.changedFields).toEqual([]);
  });

  it('logotipo novo é devolvido para validação; limpar não valida nada', () => {
    const logo = '0192c000-0000-7000-8000-00000000a104';
    const set = updateOrganization(organization(), { logoAttachmentId: logo }, context());
    expect(set.logoToValidate).toBe(logo);
    const cleared = updateOrganization(
      organization({ logoAttachmentId: logo }),
      { logoAttachmentId: null },
      context(),
    );
    expect(cleared.logoToValidate).toBeNull();
    expect(cleared.next.logoAttachmentId).toBeNull();
    const same = updateOrganization(
      organization({ logoAttachmentId: logo }),
      { logoAttachmentId: logo },
      context(),
    );
    expect(same.logoToValidate).toBeNull();
  });

  describe('RN-TEN-41 — inativar', () => {
    it('órgão comum com outros órgãos ativos pode ser inativado e reativado', () => {
      const off = updateOrganization(organization(), { isActive: false }, context());
      expect(off.next.isActive).toBe(false);
      const on = updateOrganization(off.next, { isActive: true }, context({ otherActiveCount: 0 }));
      expect(on.next.isActive).toBe(true);
    });

    it('o órgão principal não pode ser inativado, mesmo havendo outros ativos', () => {
      expect(() =>
        updateOrganization(organization(), { isActive: false }, context({ isPrimary: true })),
      ).toThrow(PrimaryOrganizationRequiredError);
      try {
        updateOrganization(organization(), { isActive: false }, context({ isPrimary: true }));
      } catch (error) {
        expect((error as PrimaryOrganizationRequiredError).reason).toBe('PRIMARY');
      }
    });

    it('o único órgão ativo do tenant não pode ser inativado', () => {
      try {
        updateOrganization(organization(), { isActive: false }, context({ otherActiveCount: 0 }));
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(PrimaryOrganizationRequiredError);
        expect((error as PrimaryOrganizationRequiredError).reason).toBe('LAST_ACTIVE');
      }
    });

    it('órgão já inativo reenviado como inativo não dispara a regra', () => {
      const inactive = organization({ isActive: false });
      const result = updateOrganization(
        inactive,
        { isActive: false },
        context({ isPrimary: true, otherActiveCount: 0 }),
      );
      expect(result.changedFields).toEqual([]);
    });
  });
});
