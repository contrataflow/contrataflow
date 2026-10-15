import { PERMISSION_MODULES, PERMISSION_RISK_LEVELS } from '@contrataflow/types';
import type { PermissionRiskLevel } from '@contrataflow/types';
import { z } from 'zod';

/*
 * Catálogo de permissões (US-094 · api/14-tenant-administration.md ROL-01). Schemas
 * compartilhados pela API (query/resposta) e pelo painel do catálogo (SCR-031).
 */

/** Parâmetro de query repetido chega como lista; ambos são aceitos (e normalizados abaixo). */
const filterParam = z.union([z.string(), z.array(z.string())]).optional();

/** Query do ROL-01: `module?`, `riskLevel?`; demais parâmetros são ignorados. */
export const permissionListQuerySchema = z.object({
  module: filterParam.describe(
    'Módulo do catálogo (ex.: `access`); valor desconhecido é ignorado.',
  ),
  riskLevel: filterParam.describe('`LOW`, `MEDIUM` ou `HIGH`; valor desconhecido é ignorado.'),
});
export type PermissionListQuery = z.infer<typeof permissionListQuerySchema>;

export interface PermissionFilters {
  readonly module?: string;
  readonly riskLevel?: PermissionRiskLevel;
}

function known<T extends string>(values: readonly T[], value: string | string[] | undefined) {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * Filtros efetivos do ROL-01: valor fora do conhecido (ou repetido) vira ausência (RN-IAM-78 ·
 * V-01) — o filtro nunca quebra a listagem.
 */
export function permissionFilters(query: PermissionListQuery): PermissionFilters {
  const module = known(PERMISSION_MODULES, query.module);
  const riskLevel = known(PERMISSION_RISK_LEVELS, query.riskLevel);
  return {
    ...(module === undefined ? {} : { module }),
    ...(riskLevel === undefined ? {} : { riskLevel }),
  };
}

/** Item do catálogo de permissões, somente leitura (ROL-01). */
export const permissionSchema = z.object({
  code: z.string(),
  module: z.string(),
  name: z.string(),
  description: z.string(),
  riskLevel: z.enum(PERMISSION_RISK_LEVELS),
  scopable: z.boolean(),
  isDeprecated: z.boolean(),
  introducedIn: z.string(),
});
export type PermissionDto = z.infer<typeof permissionSchema>;
