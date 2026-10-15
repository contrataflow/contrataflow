import { describe, expect, it } from 'vitest';

import {
  createRoleSchema,
  deactivateRoleSchema,
  roleListQuerySchema,
  updateRolePermissionsSchema,
  updateRoleSchema,
} from './role.js';

describe('Perfis — schemas de ROL-02..08 (US-095)', () => {
  it('ROL-03: nome aparado; permissões repetidas descartadas', () => {
    expect(
      createRoleSchema.parse({
        name: '  Fiscal de Obras ',
        permissions: ['PROCESS_VIEW', 'PROCESS_VIEW'],
      }),
    ).toEqual({ name: 'Fiscal de Obras', permissions: ['PROCESS_VIEW'] });
  });

  it.each([undefined, 'Fi', '   ab  ', 'x'.repeat(121)])(
    '[Validação] nome %j → "Informe um nome entre 3 e 120 caracteres."',
    (name) => {
      const result = createRoleSchema.safeParse({ name });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe('Informe um nome entre 3 e 120 caracteres.');
    },
  );

  it('[Validação] descrição até 500 caracteres; código fora do catálogo → REFERENCE_NOT_FOUND no item', () => {
    expect(createRoleSchema.safeParse({ name: 'Abc', description: 'd'.repeat(501) }).success).toBe(
      false,
    );
    const result = updateRolePermissionsSchema.safeParse({
      permissions: ['PROCESS_VIEW', 'NAO_EXISTE'],
    });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['permissions', 1],
        message: 'Selecione permissões válidas.',
        params: { code: 'REFERENCE_NOT_FOUND' },
      }),
    ]);
    expect(updateRolePermissionsSchema.safeParse({}).success).toBe(false);
  });

  it('ROL-05: tudo opcional; descrição pode ser limpa com null', () => {
    expect(updateRoleSchema.parse({})).toEqual({});
    expect(updateRoleSchema.parse({ description: null })).toEqual({ description: null });
  });

  it('ROL-02/08: filtros e confirmação', () => {
    expect(roleListQuerySchema.parse({ isActive: 'false', search: ' fis ' })).toEqual({
      isActive: false,
      search: 'fis',
    });
    expect(deactivateRoleSchema.parse({ confirmDeactivate: true })).toEqual({
      confirmDeactivate: true,
    });
  });
});
