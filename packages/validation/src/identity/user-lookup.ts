import { z } from 'zod';

import { INVITATION_MEMBERSHIP_TYPES } from './invitation.js';

/*
 * USR-02 — busca de usuários para seleção (api/14-tenant-administration.md · contrato definido na
 * US-012, seletor de participantes do SCR-112): vínculos `ACTIVE` e não vencidos do tenant ativo.
 */

export const USER_LOOKUP_LIMIT = 20;

export const userLookupQuerySchema = z.strictObject({
  q: z
    .string({ error: 'Informe ao menos 2 caracteres para buscar.' })
    .trim()
    .min(2, { error: 'Informe ao menos 2 caracteres para buscar.' })
    .max(100, { error: 'Informe no máximo 100 caracteres.' }),
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
