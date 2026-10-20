/**
 * Políticas contextuais de autorização (permissions.md §6 · POL-01..18 · DEC-134): regras em
 * código que dependem do estado do recurso, aplicadas depois da permissão (US-097 · RN-IAM-100).
 * `denialCode` é o código da recusa principal da política — 403 é negação de acesso auditada como
 * `access.denied` com o ID da política em `reasonCode` (RN-IAM-105); 409/422 são estados do recurso
 * que a própria política descreve. Fonte única para o decorator `@Policy` da API e para o meta-teste
 * da matriz de autorização.
 */

export interface ContextualPolicyDefinition {
  readonly id: string;
  /** Rótulo pt-BR (permissions.md §6). */
  readonly name: string;
  readonly denialCode: string;
  readonly denialStatus: 403 | 409 | 422;
}

export const CONTEXTUAL_POLICIES = [
  { id: 'POL-01', name: 'Custódia', denialCode: 'NOT_PROCESS_CUSTODIAN', denialStatus: 403 },
  {
    id: 'POL-02',
    name: 'Edição de documento',
    denialCode: 'DOCUMENT_NOT_EDITABLE',
    denialStatus: 409,
  },
  {
    id: 'POL-03',
    name: 'Decisão de aprovação',
    denialCode: 'NOT_DESIGNATED_APPROVER',
    denialStatus: 403,
  },
  { id: 'POL-04', name: 'Assumir', denialCode: 'PROCESS_ALREADY_ASSIGNED', denialStatus: 409 },
  { id: 'POL-05', name: 'Atribuir', denialCode: 'PERMISSION_DENIED', denialStatus: 403 },
  { id: 'POL-06', name: 'Cancelar', denialCode: 'PERMISSION_DENIED', denialStatus: 403 },
  { id: 'POL-07', name: 'Suspender/retomar', denialCode: 'PERMISSION_DENIED', denialStatus: 403 },
  { id: 'POL-08', name: 'Concluir', denialCode: 'NOT_PROCESS_CUSTODIAN', denialStatus: 403 },
  { id: 'POL-09', name: 'Orçamento sigiloso', denialCode: 'PERMISSION_DENIED', denialStatus: 403 },
  { id: 'POL-10', name: 'Participantes', denialCode: 'PERMISSION_DENIED', denialStatus: 403 },
  {
    id: 'POL-11',
    name: 'Reabrir documento',
    denialCode: 'NOT_PROCESS_CUSTODIAN',
    denialStatus: 403,
  },
  { id: 'POL-12', name: 'Anti-bloqueio', denialCode: 'LAST_ADMIN_REQUIRED', denialStatus: 409 },
  {
    id: 'POL-13',
    name: 'Anti-escalonamento',
    denialCode: 'PRIVILEGE_ESCALATION_FORBIDDEN',
    denialStatus: 403,
  },
  { id: 'POL-14', name: 'MFA', denialCode: 'MFA_REQUIRED', denialStatus: 403 },
  { id: 'POL-15', name: 'Externos', denialCode: 'EXTERNAL_HIGH_RISK_ROLE', denialStatus: 403 },
  { id: 'POL-16', name: 'Autoproteção', denialCode: 'PERMISSION_DENIED', denialStatus: 403 },
  {
    id: 'POL-17',
    name: 'Retirar solicitação de aprovação',
    denialCode: 'PERMISSION_DENIED',
    denialStatus: 403,
  },
  // EP-020 (US-115/US-116): `AI_GENERATE` + edição do tipo + POL-02 + IA ligada e limites.
  { id: 'POL-18', name: 'Gerar com IA', denialCode: 'PERMISSION_DENIED', denialStatus: 403 },
] as const satisfies readonly ContextualPolicyDefinition[];

export type PolicyId = (typeof CONTEXTUAL_POLICIES)[number]['id'];

export const POLICY_IDS: readonly PolicyId[] = CONTEXTUAL_POLICIES.map((policy) => policy.id);

const POLICY_ID_SET: ReadonlySet<string> = new Set(POLICY_IDS);

export function isPolicyId(value: string): value is PolicyId {
  return POLICY_ID_SET.has(value);
}
