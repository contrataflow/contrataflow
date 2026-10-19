/**
 * Códigos de erro da API (SCREAMING_SNAKE_CASE — DEC-001; docs/mvp-01/api.md §2).
 * Os genéricos (§2.1) entram com a US-080 (esqueleto HTTP e RFC 9457); os de domínio (§2.2),
 * com as stories donas.
 */
export const ERROR_CODES = [
  'MALFORMED_REQUEST',
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'MFA_REQUIRED',
  'PERMISSION_DENIED',
  'TENANT_SUSPENDED',
  'MEMBERSHIP_INACTIVE',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_STATE',
  'IDEMPOTENCY_IN_PROGRESS',
  'VERSION_CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'VALIDATION_ERROR',
  'BUSINESS_RULE_VIOLATION',
  'IDEMPOTENCY_KEY_REUSED',
  'PRECONDITION_REQUIRED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'DEPENDENCY_UNAVAILABLE',
  'NUMBERING_MASK_INVALID',
  'APPROVER_UNRESOLVED',
  'APPROVAL_NOT_PENDING',
  'TENANT_SLUG_TAKEN',
  'TENANT_NOT_FOUND',
  'PRIMARY_ORGANIZATION_REQUIRED',
  'SETTING_KEY_UNKNOWN',
  'CATALOG_ITEM_SYSTEM',
  'WORKFLOW_VERSION_NOT_DRAFT',
  'WORKFLOW_DRAFT_EXISTS',
  'WORKFLOW_INVALID',
  'WORKFLOW_IN_USE',
  'NO_APPLICABLE_WORKFLOW',
  'ROLE_NOT_FOUND',
  'ROLE_ALREADY_EXISTS',
  'PRIVILEGE_ESCALATION_FORBIDDEN',
  'LAST_ADMIN_REQUIRED',
  'ROLE_ASSIGNMENT_NOT_FOUND',
  'ROLE_ASSIGNMENT_ALREADY_EXISTS',
  'EXTERNAL_HIGH_RISK_ROLE',
  'DEPARTMENT_CYCLE',
  'DEPARTMENT_HAS_REFERENCES',
  'SUPPLIER_ALREADY_EXISTS',
  'SUPPLIER_IN_USE',
  'TEMPLATE_NAME_TAKEN',
  'TEMPLATE_INVALID',
  'TEMPLATE_VERSION_NOT_DRAFT',
  'TEMPLATE_DRAFT_EXISTS',
  'TEMPLATE_IN_USE',
  'NOTIFICATION_NOT_FOUND',
  'USER_NOT_FOUND',
  'MEMBERSHIP_ALREADY_EXISTS',
  'INVITATION_INVALID',
  'INVITATION_EXPIRED',
  // US-097: processo inexistente, de outro tenant ou não visível (RN-IAM-104 · api/02-processes.md).
  'PROCESS_NOT_FOUND',
  // US-001: criação de processo (api.md §2.2).
  'POSSIBLE_DUPLICATE_PROCESS',
  'DUPLICATE_INTERNAL_CODE',
  // US-065: ciclo de vida do documento (api.md §2.2 · api/03-documents.md DOC-04/08..14).
  'NOT_PROCESS_CUSTODIAN',
  // US-049: assumir processo (POL-04 · api/02-processes.md PRC-21).
  'PROCESS_ALREADY_ASSIGNED',
  'INVALID_PROCESS_STATUS',
  // US-009: descartar rascunho que já tem número (api/02-processes.md PRC-06).
  'CANNOT_DISCARD_NUMBERED_PROCESS',
  'DOCUMENT_INCOMPLETE',
  'WARNINGS_NOT_ACKNOWLEDGED',
  'DOCUMENT_ALREADY_EXISTS',
  'DOCUMENT_NOT_EDITABLE',
  'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE',
  // US-115: camada de IA (api.md §2.2 · api/16-ai.md AI-01..04).
  'AI_DISABLED',
  'AI_PROVIDER_UNAVAILABLE',
  'AI_USAGE_LIMIT_REACHED',
  'AI_USER_DAILY_LIMIT_REACHED',
  // US-116: ligar a IA exige o aceite da versão vigente dos termos (RN-AI-16).
  'AI_TERMS_NOT_ACCEPTED',
  'AI_GENERATION_IN_PROGRESS',
  'AI_PREREQUISITE_MISSING',
  'AI_SECTION_EMPTY',
  'AI_SECTION_NOT_SUPPORTED',
  'AI_GENERATION_NOT_FOUND',
  'AI_GENERATION_NOT_APPLICABLE',
  'AI_GENERATION_NOT_OWNED',
  // US-068: upload seguro de anexos (api.md §2.2 · api/12-comments-attachments.md ATT-02..06).
  'FILE_TYPE_NOT_ALLOWED',
  'FILE_TOO_LARGE',
  'UPLOAD_NOT_RECEIVED',
  'ATTACHMENT_NOT_AVAILABLE',
  'STORAGE_QUOTA_EXCEEDED',
  // US-006: itens da contratação (api.md §2.2 · api/02-processes.md PRC-15/16).
  'ITEM_IN_USE',
  // US-067: download de PDF antes de `READY` ou de prévia vencida (api/03-documents.md DOC-23).
  'RENDITION_NOT_READY',
  // US-012: participantes do processo (api.md §2.2 · api/02-processes.md PRC-29/30 · POL-10).
  'PARTICIPANT_NOT_ELIGIBLE',
  'PARTICIPANT_ALREADY_EXISTS',
  'PARTICIPANT_NOT_FOUND',
  // US-071: comentários (api.md §2.2 · api/12-comments-attachments.md CMT-01..04).
  'COMMENT_NOT_FOUND',
  'COMMENT_EDIT_WINDOW_EXPIRED',
  'RICH_TEXT_INVALID',
  'SECTION_NOT_IN_TEMPLATE',
  // US-014: DFD inexistente, de outro tenant ou não visível (api/05-dfd.md DFD-03).
  'DFD_NOT_FOUND',
  // US-047: encaminhamento do processo (api.md §2.2 · api/02-processes.md PRC-19).
  'STAGE_CHANGED',
  'TRANSITION_NOT_AVAILABLE',
  'TRANSITION_BLOCKED',
  'DEPARTMENT_REQUIRED',
  'DUE_DATE_OVERRIDE_NOT_ALLOWED',
  'ASSIGNEE_NOT_ELIGIBLE',
  // US-015: autosave — revisão da seção divergente (api/03-documents.md DOC-05 · DEC-055).
  'SECTION_REVISION_CONFLICT',
  // US-026: campos exigidos pelo tipo de fonte de pesquisa ausentes (api/07 PRS-10/11 · RN-PRICE-21).
  'QUOTATION_REQUIRED_FIELDS',
  // US-021: recomendar com outra alternativa já recomendada (api/06-etp.md ETP-09 · RN-ETP-20).
  'RECOMMENDED_ALTERNATIVE_EXISTS',
  // US-028: token da prévia de importação de cotações vencido (api/07 PRS-19 · api.md §2.2).
  'IMPORT_PREVIEW_EXPIRED',
] as const satisfies readonly string[];

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Códigos por campo usados em `errors[].code` de `VALIDATION_ERROR` (api.md §2.1.1). */
export const FIELD_ERROR_CODES = [
  'REQUIRED',
  'TOO_SHORT',
  'TOO_LONG',
  'INVALID_FORMAT',
  'INVALID_ENUM',
  'OUT_OF_RANGE',
  'DATE_IN_PAST',
  'INVALID_DECIMAL',
  'INVALID_CNPJ',
  'INVALID_CPF',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_INACTIVE',
  'DEPARTMENT_NOT_IN_SECRETARIAT',
  'CONDITIONAL_REQUIRED',
  'DUPLICATE_IN_LIST',
  'NOT_ALLOWED',
] as const satisfies readonly string[];

export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number];
