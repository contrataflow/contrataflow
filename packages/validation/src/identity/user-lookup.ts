import { z } from 'zod';

import { INVITATION_MEMBERSHIP_TYPES } from './invitation.js';

/*
 * USR-02 — busca de usuários para seleção (api/14-tenant-administration.md · contrato definido na
 * US-012, seletor de participantes do SCR-112): vínculos `ACTIVE` e não vencidos do tenant ativo.
 * US-050: `departmentId` restringe aos lotados na unidade (membros do diálogo SCR-115).
 */

export const USER_LOOKUP_LIMIT = 20;
/** Com `departmentId` (US-050 · SCR-115): os lotados na unidade, até este limite. */
export const DEPARTMENT_MEMBER_LOOKUP_LIMIT = 50;

const LOOKUP_Q_MESSAGE = 'Informe ao menos 2 caracteres para buscar.';

/**
 * `q` (nome ou e-mail) é obrigatório, salvo com `departmentId` (US-050): aí lista os lotados na
 * unidade — `q` só filtra.
 */
export const userLookupQuerySchema = z
  .strictObject({
    q: z
      .string({ error: LOOKUP_Q_MESSAGE })
      .trim()
      .min(2, { error: LOOKUP_Q_MESSAGE })
      .max(100, { error: 'Informe no máximo 100 caracteres.' })
      .optional(),
    departmentId: z.uuid({ error: 'Informe uma unidade válida.' }).optional(),
  })
  .refine((query) => query.q !== undefined || query.departmentId !== undefined, {
    error: LOOKUP_Q_MESSAGE,
    path: ['q'],
  });
export type UserLookupQuery = z.infer<typeof userLookupQuerySchema>;

export const userLookupItemSchema = z
  .object({
    /** `userId`. */
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    membershipType: z.enum(INVITATION_MEMBERSHIP_TYPES),
    /** Validade do vínculo (`EXTERNAL`); limita a validade do Consultor (RN-PROC-127). */
    membershipExpiresAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .meta({ id: 'UserLookupItem' });
export type UserLookupItem = z.infer<typeof userLookupItemSchema>;
