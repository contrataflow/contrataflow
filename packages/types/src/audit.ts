/**
 * Auditoria (entities.md §2 e §4 `AuditLog` · docs/mvp-01/events.md §7 · US-073): tipos de ator,
 * categorias, resultados e o catálogo FECHADO de ações `resource.action`. A categoria de cada ação
 * é fixa (o caso de uso não a escolhe); ação nova entra primeiro em events.md §7 e depois aqui.
 */

export const ACTOR_TYPES = ['USER', 'SYSTEM', 'PLATFORM_OPERATOR', 'INTEGRATION'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const AUDIT_CATEGORIES = [
  'DATA_CHANGE',
  'WORKFLOW',
  'ACCESS',
  'SECURITY',
  'EXPORT',
  'CONFIGURATION',
  'SYSTEM',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_RESULTS = ['SUCCESS', 'DENIED', 'FAILURE'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

// Ações por área de events.md §7, agrupadas pela categoria.
const AUTH_SECURITY = [
  'auth.session_start',
  'auth.session_end',
  'auth.session_expired',
  'auth.mfa_required',
] as const;
const AUTH_ACCESS = ['auth.tenant_switch', 'access.denied'] as const;
const PLATFORM_SYSTEM = [
  'tenant.provision',
  'tenant.update',
  'tenant.activate',
  'tenant.suspend',
  'tenant.offboard',
  'tenant.deactivate',
] as const;
const PLATFORM_SECURITY = ['support.access_grant', 'support.access_revoke'] as const;
const CONFIGURATION = [
  'settings.update',
  'organization.create',
  'organization.update',
  'department.create',
  'department.update',
  'department.move',
  'department.deactivate',
  'department.delete',
  'catalog.create',
  'catalog.update',
  'catalog.deactivate',
  'holiday.create',
  'holiday.update',
  'holiday.delete',
  'tag.create',
  'tag.update',
  'tag.deactivate',
  'document_type.create',
  'document_type.update',
  'template.create',
  'template.update',
  'template.version_create',
  'template.version_publish',
  'template.version_retire',
  'workflow.create',
  'workflow.update',
  'workflow.version_create',
  'workflow.version_publish',
  'workflow.version_retire',
  'workflow.set_default',
] as const;
const IDENTITY_SECURITY = [
  'membership.invite',
  'membership.activate',
  'membership.update',
  'membership.departments_update',
  'membership.suspend',
  'membership.reactivate',
  'membership.revoke',
  'membership.expire',
  'membership.mfa_reset',
  'role.create',
  'role.update',
  'role.permissions_update',
  'role.deactivate',
  'role.assign',
  'role.revoke',
  'profile.update',
  'notification.preferences_update',
] as const;
const PROCESS_DATA_CHANGE = [
  'process.create',
  'process.update',
  'process.items_update',
  'process.tags_update',
  'process.discard_draft',
  'process.number_assign',
  'process.duplicate',
  'process.participant_add',
  'process.participant_remove',
  'process.confidentiality_change',
] as const;
const PROCESS_WORKFLOW = [
  'process.forward',
  'process.return',
  'process.claim',
  'process.assign',
  'process.suspend',
  'process.resume',
  'process.cancel',
  'process.complete',
] as const;
const APPROVAL_WORKFLOW = [
  'approval.request',
  'approval.decide',
  'approval.withdraw',
  'approval.reassign',
  'approval.cancel',
] as const;
const DOCUMENT_DATA_CHANGE = [
  'document.create',
  'document.draft_update',
  'document.items_update',
  'document.version_create',
  'document.submit',
  'document.finalize',
  'document.withdraw',
  'document.reopen',
  'document.cancel',
  'document.delete',
  'document.render_request',
  'document.duplicate',
] as const;
const TYPED_DATA_CHANGE = [
  'etp.alternative_create',
  'etp.alternative_update',
  'etp.alternative_delete',
  'etp.alternative_decide',
  'price_research.source_create',
  'price_research.source_update',
  'price_research.source_delete',
  'price_research.quotation_create',
  'price_research.quotation_update',
  'price_research.quotation_delete',
  'price_research.quotation_exclude',
  'price_research.quotation_restore',
  'price_research.method_change',
  'price_research.recalculate',
  'price_research.import',
  'price_research.complete',
  'risk.create',
  'risk.update',
  'risk.assess',
  'risk.delete',
  'risk.treatment_create',
  'risk.treatment_update',
  'risk.treatment_delete',
  'term.import_etp',
] as const;
const COLLABORATION_DATA_CHANGE = [
  'comment.create',
  'comment.update',
  'comment.delete',
  'comment.moderate',
  'attachment.upload_intent',
  'attachment.confirm',
  'attachment.delete',
  'supplier.create',
  'supplier.update',
  'supplier.deactivate',
  'supplier.delete',
] as const;
const EXPORTS = [
  'process.export',
  'document.download',
  'price_research.export',
  'attachment.download',
  'audit.export',
] as const;
const ACCESS = ['process.confidential_view', 'audit.search', 'queue_dashboard.access'] as const;
/** Geração com IA (EP-020 · events.md §7): nunca texto do resumo, contexto ou saída. */
const AI_DATA_CHANGE = [
  'ai.generation_request',
  'ai.generation_discard',
  'ai.content_apply',
  'ai.content_review',
] as const;
const AI_SYSTEM = ['ai.generation_complete', 'ai.generation_fail'] as const;
const SYSTEM = [
  'attachment.scan_result',
  'audit.seal',
  'outbox.republish',
  'dead_letter.retry',
  'dead_letter.discard',
] as const;

export type AuditAction =
  | (typeof AUTH_SECURITY)[number]
  | (typeof AUTH_ACCESS)[number]
  | (typeof PLATFORM_SYSTEM)[number]
  | (typeof PLATFORM_SECURITY)[number]
  | (typeof CONFIGURATION)[number]
  | (typeof IDENTITY_SECURITY)[number]
  | (typeof PROCESS_DATA_CHANGE)[number]
  | (typeof PROCESS_WORKFLOW)[number]
  | (typeof APPROVAL_WORKFLOW)[number]
  | (typeof DOCUMENT_DATA_CHANGE)[number]
  | (typeof TYPED_DATA_CHANGE)[number]
  | (typeof COLLABORATION_DATA_CHANGE)[number]
  | (typeof EXPORTS)[number]
  | (typeof ACCESS)[number]
  | (typeof AI_DATA_CHANGE)[number]
  | (typeof AI_SYSTEM)[number]
  | (typeof SYSTEM)[number];

export interface AuditActionSpec {
  readonly category: AuditCategory;
  /**
   * Ação de alto volume coalescida (RN-AUD-06): no máximo 1 registro por entidade/escopo/ator na
   * janela `audit.coalesce.windowMinutes`, salvo salto de revisão ou de tamanho.
   */
  readonly coalescible: boolean;
}

/** Ações coalescíveis (events.md §7: `document.draft_update`). */
const COALESCIBLE: ReadonlySet<string> = new Set<AuditAction>(['document.draft_update']);

const BY_CATEGORY: readonly (readonly [AuditCategory, readonly AuditAction[]])[] = [
  ['SECURITY', [...AUTH_SECURITY, ...PLATFORM_SECURITY, ...IDENTITY_SECURITY]],
  ['ACCESS', [...AUTH_ACCESS, ...ACCESS]],
  ['SYSTEM', [...PLATFORM_SYSTEM, ...SYSTEM, ...AI_SYSTEM]],
  ['CONFIGURATION', CONFIGURATION],
  [
    'DATA_CHANGE',
    [
      ...PROCESS_DATA_CHANGE,
      ...DOCUMENT_DATA_CHANGE,
      ...TYPED_DATA_CHANGE,
      ...COLLABORATION_DATA_CHANGE,
      ...AI_DATA_CHANGE,
    ],
  ],
  ['WORKFLOW', [...PROCESS_WORKFLOW, ...APPROVAL_WORKFLOW]],
  ['EXPORT', EXPORTS],
];

/** Catálogo fechado de ações de auditoria (events.md §7), com a categoria de cada uma. */
export const AUDIT_ACTIONS: Readonly<Record<AuditAction, AuditActionSpec>> = Object.freeze(
  Object.fromEntries(
    BY_CATEGORY.flatMap(([category, actions]) =>
      actions.map((action) => [
        action,
        Object.freeze({ category, coalescible: COALESCIBLE.has(action) }),
      ]),
    ),
  ) as Record<AuditAction, AuditActionSpec>,
);

/** Todas as ações do catálogo, em ordem alfabética. */
export const AUDIT_ACTION_NAMES: readonly AuditAction[] = Object.freeze(
  (Object.keys(AUDIT_ACTIONS) as AuditAction[]).sort(),
);

export function isAuditAction(value: string): value is AuditAction {
  return Object.hasOwn(AUDIT_ACTIONS, value);
}
