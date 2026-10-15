import { PERMISSIONS } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import { permissionFilters, permissionListQuerySchema, permissionSchema } from './permission.js';

const filtersOf = (query: unknown) => permissionFilters(permissionListQuerySchema.parse(query));

describe('ROL-01 — catálogo de permissões (US-094)', () => {
  it('aceita os filtros conhecidos', () => {
    expect(filtersOf({ module: 'access', riskLevel: 'HIGH' })).toEqual({
      module: 'access',
      riskLevel: 'HIGH',
    });
  });

  it('[Validação] ignora valores desconhecidos, repetidos e parâmetros extras (RN-IAM-78)', () => {
    expect(filtersOf({ module: 'inexistente', riskLevel: 'EXTREME', page: '2' })).toEqual({});
    expect(filtersOf({ riskLevel: ['LOW', 'HIGH'] })).toEqual({});
    expect(filtersOf({})).toEqual({});
  });

  it('todo item do catálogo em código respeita o contrato da resposta', () => {
    for (const permission of PERMISSIONS) {
      expect(permissionSchema.parse(permission)).toEqual(permission);
    }
  });
});
