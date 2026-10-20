import type { HolidayScope } from '@contrataflow/types';
import type { CreateHoliday, UpdateHoliday } from '@contrataflow/validation';

/*
 * `Holiday` (US-106 · entities.md §4 · RN-TEN-74..79): regras puras de criação e edição, sem
 * NestJS nem Prisma. A data nasce na criação e nunca muda (excluir e recadastrar); feriado de
 * sistema (`isSystem`, semeado) pode ser desativado e ter o escopo ajustado, nunca excluído nem
 * renomeado (o nome é a chave natural do seeder — RN-TEN-77).
 */

export interface Holiday {
  readonly id: string;
  readonly tenantId: string;
  /** `YYYY-MM-DD`, sem fuso (DEC-003). */
  readonly date: string;
  readonly name: string;
  readonly scope: HolidayScope;
  readonly isRecurring: boolean;
  readonly isSystem: boolean;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

/** Campo editável por CAL-03 (entra em `changes` da auditoria). */
export type HolidayUpdatableField = 'name' | 'scope' | 'isRecurring' | 'isActive';

export interface HolidayFieldChange {
  readonly path: HolidayUpdatableField;
  readonly old: unknown;
  readonly new: unknown;
}

/** V-04 · RN-TEN-77: alterar o nome (ou excluir) feriado de sistema. */
export class HolidaySystemError extends Error {
  constructor() {
    super('Feriados padrão do sistema não podem ser excluídos nem renomeados.');
    this.name = 'HolidaySystemError';
  }
}

/** RN-TEN-74: `NATIONAL` só existe por seed — o administrador não promove feriado a nacional. */
export class HolidayScopeNotAllowedError extends Error {
  constructor() {
    super('O escopo nacional é reservado aos feriados padrão do sistema.');
    this.name = 'HolidayScopeNotAllowedError';
  }
}

export interface CreateHolidayContext {
  readonly id: string;
  readonly tenantId: string;
  readonly now: Date;
  readonly userId: string | null;
}

/** RN-TEN-75/77: feriado novo do administrador, sempre `isSystem = false` e ativo. */
export function createHoliday(body: CreateHoliday, ctx: CreateHolidayContext): Holiday {
  return {
    id: ctx.id,
    tenantId: ctx.tenantId,
    date: body.date,
    name: body.name,
    scope: body.scope,
    isRecurring: body.isRecurring ?? false,
    isSystem: false,
    isActive: true,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    createdById: ctx.userId,
    updatedById: ctx.userId,
    version: 1,
  };
}

export interface UpdateHolidayContext {
  readonly now: Date;
  readonly userId: string | null;
}

export interface HolidayUpdate {
  readonly next: Holiday;
  /** Só os campos que realmente mudaram (vazio → nada a gravar). */
  readonly changes: readonly HolidayFieldChange[];
}

/**
 * Aplica o PATCH (CAL-03): ignora campos iguais aos atuais. Feriado de sistema com nome diferente
 * → `HolidaySystemError`; escopo `NATIONAL` num feriado que não é nacional nem de sistema →
 * `HolidayScopeNotAllowedError`. `version` e `updatedAt` são do repositório/caso de uso.
 */
export function updateHoliday(
  current: Holiday,
  patch: UpdateHoliday,
  ctx: UpdateHolidayContext,
): HolidayUpdate {
  const changes: HolidayFieldChange[] = [];
  let next = current;

  if (patch.name !== undefined && patch.name !== current.name) {
    if (current.isSystem) throw new HolidaySystemError();
    changes.push({ path: 'name', old: current.name, new: patch.name });
    next = { ...next, name: patch.name };
  }
  if (patch.scope !== undefined && patch.scope !== current.scope) {
    if (patch.scope === 'NATIONAL' && !current.isSystem) throw new HolidayScopeNotAllowedError();
    changes.push({ path: 'scope', old: current.scope, new: patch.scope });
    next = { ...next, scope: patch.scope };
  }
  if (patch.isRecurring !== undefined && patch.isRecurring !== current.isRecurring) {
    changes.push({ path: 'isRecurring', old: current.isRecurring, new: patch.isRecurring });
    next = { ...next, isRecurring: patch.isRecurring };
  }
  if (patch.isActive !== undefined && patch.isActive !== current.isActive) {
    changes.push({ path: 'isActive', old: current.isActive, new: patch.isActive });
    next = { ...next, isActive: patch.isActive };
  }

  if (changes.length === 0) return { next: current, changes };
  return { next: { ...next, updatedAt: ctx.now, updatedById: ctx.userId }, changes };
}

/** Chave de unicidade `(date, lower(name))` do tenant (RN-TEN-75), para comparar em memória. */
export function holidayKey(date: string, name: string): string {
  return `${date}|${name.toLowerCase()}`;
}
