import type { PermissionCode } from '@contrataflow/types';

/*
 * Especificação dos destinatários das regras de notificação (events.md §6 · US-111): separada de
 * `notification-rules.ts` para que `stage-deadline.ts` (que a monta) não forme ciclo com as regras.
 */

/** Fontes de destinatários dos módulos donos (registradas quando a story deles existir). */
export type RecipientLookup =
  /** Criador, responsável atual e participantes com `notify` (US-001/US-012). */
  | 'PROCESS_STAKEHOLDERS'
  /** Solicitante e responsáveis (`responsibleId`) dos documentos cobertos (US-051/US-052). */
  | 'APPROVAL_STAKEHOLDERS'
  /** Detentores do perfil aprovador com escopo sobre o processo, máx. 50 (US-096/US-051). */
  | 'ROLE_HOLDERS'
  /** Quem enviou o anexo (US-068). */
  | 'ATTACHMENT_UPLOADER'
  /** Quem solicitou a renderização (US-067). */
  | 'RENDITION_REQUESTER';

export type RecipientSpec =
  /** Usuário do payload (`toUserId`, `approverUserId`…); nulo = nada. */
  | { readonly kind: 'USER'; readonly userId: string | null }
  /** Membros ativos lotados na unidade (máx. 50, senão titular e substituto — FA-01). */
  | {
      readonly kind: 'DEPARTMENT_MEMBERS';
      readonly departmentId: string | null;
      readonly permission?: PermissionCode;
    }
  /** Titular da unidade e, se pedido, o substituto. */
  | {
      readonly kind: 'DEPARTMENT_HEADS';
      readonly departmentId: string | null;
      readonly includeDeputy: boolean;
    }
  /**
   * Vínculos ativos com a permissão em qualquer escopo do tenant, até 50 (US-116 — avisos de
   * administração do órgão, ex.: `SETTINGS_MANAGE`). Acima disso, os 50 primeiros por id.
   */
  | { readonly kind: 'TENANT_PERMISSION_HOLDERS'; readonly permission: PermissionCode }
  /** Dono do vínculo (`membershipId` do payload). */
  | { readonly kind: 'MEMBERSHIP_USER'; readonly membershipId: string | null }
  | { readonly kind: 'LOOKUP'; readonly lookup: RecipientLookup }
  /** A primeira especificação que resolver alguém ("`toUserId`; se nulo, membros da unidade"). */
  | { readonly kind: 'FIRST_OF'; readonly specs: readonly RecipientSpec[] };
