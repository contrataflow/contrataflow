import type { ErrorCode } from '@contrataflow/types';

export interface ErrorDefinition {
  readonly status: number;
  readonly title: string;
  /** Mensagem pt-BR exibida ao usuário (`detail`); `{correlationId}` é substituído pelo filtro. */
  readonly detail: string;
}

/** Códigos genéricos de api.md §2.1 com as mensagens da US-080 ("Casos de erro"). */
export const GENERIC_ERRORS: Readonly<Record<ErrorCode, ErrorDefinition>> = Object.freeze({
  MALFORMED_REQUEST: {
    status: 400,
    title: 'Requisição malformada',
    detail: 'A requisição não pôde ser interpretada.',
  },
  UNAUTHENTICATED: {
    status: 401,
    title: 'Não autenticado',
    detail: 'Autenticação necessária.',
  },
  SESSION_EXPIRED: { status: 401, title: 'Sessão expirada', detail: 'Sua sessão expirou.' },
  MFA_REQUIRED: {
    status: 403,
    title: 'Verificação adicional necessária',
    detail: 'Esta ação exige autenticação em dois fatores.',
  },
  PERMISSION_DENIED: {
    status: 403,
    title: 'Acesso negado',
    detail: 'Você não tem permissão para esta ação.',
  },
  TENANT_SUSPENDED: {
    status: 403,
    title: 'Órgão inativo',
    detail: 'Este órgão não está ativo.',
  },
  MEMBERSHIP_INACTIVE: {
    status: 403,
    title: 'Acesso inativo',
    detail: 'Seu acesso a este órgão não está ativo.',
  },
  NOT_FOUND: { status: 404, title: 'Não encontrado', detail: 'O recurso não foi encontrado.' },
  CONFLICT: {
    status: 409,
    title: 'Conflito',
    detail: 'A operação conflita com o estado atual.',
  },
  INVALID_STATE: {
    status: 409,
    title: 'Operação indisponível',
    detail: 'A operação não é permitida no estado atual do recurso.',
  },
  IDEMPOTENCY_IN_PROGRESS: {
    status: 409,
    title: 'Solicitação em andamento',
    detail: 'Estamos concluindo a solicitação. Aguarde.',
  },
  VERSION_CONFLICT: {
    status: 412,
    title: 'Versão desatualizada',
    detail: 'O registro foi alterado por outra pessoa. Recarregue antes de salvar.',
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    title: 'Conteúdo muito grande',
    detail: 'O conteúdo enviado excede o tamanho permitido.',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    title: 'Tipo de conteúdo não suportado',
    detail: 'Envie o conteúdo como JSON (UTF-8).',
  },
  VALIDATION_ERROR: {
    status: 422,
    title: 'Dados inválidos',
    detail: 'Revise os campos destacados.',
  },
  BUSINESS_RULE_VIOLATION: {
    status: 422,
    title: 'Regra de negócio não atendida',
    detail: 'A operação não atende às regras de negócio.',
  },
  IDEMPOTENCY_KEY_REUSED: {
    status: 422,
    title: 'Chave de idempotência reutilizada',
    detail: 'Esta solicitação já foi enviada com outros dados.',
  },
  PRECONDITION_REQUIRED: {
    status: 428,
    title: 'Pré-condição obrigatória',
    detail: 'Envie o cabeçalho If-Match.',
  },
  RATE_LIMITED: {
    status: 429,
    title: 'Muitas requisições',
    detail: 'Muitas tentativas. Aguarde alguns segundos.',
  },
  INTERNAL_ERROR: {
    status: 500,
    title: 'Erro inesperado',
    detail: 'Ocorreu um erro inesperado. Código: {correlationId}.',
  },
  DEPENDENCY_UNAVAILABLE: {
    status: 503,
    title: 'Serviço indisponível',
    detail: 'Serviço temporariamente indisponível.',
  },
  NUMBERING_MASK_INVALID: {
    status: 422,
    title: 'Máscara de numeração inválida',
    detail: 'A máscara deve conter {seq:N} e {year} e usar apenas os campos permitidos.',
  },
  APPROVER_UNRESOLVED: {
    status: 422,
    title: 'Aprovador não resolvível',
    detail: 'Não foi possível determinar quem aprova. Revise o aprovador selecionado.',
  },
  TENANT_SLUG_TAKEN: {
    status: 409,
    title: 'Identificador em uso',
    detail: 'O identificador informado já está em uso.',
  },
  TENANT_NOT_FOUND: {
    status: 404,
    title: 'Instituição não encontrada',
    detail: 'Instituição não encontrada.',
  },
  SETTING_KEY_UNKNOWN: {
    status: 422,
    title: 'Configuração desconhecida',
    detail: 'Configuração desconhecida.',
  },
  CATALOG_ITEM_SYSTEM: {
    status: 409,
    title: 'Item de sistema protegido',
    detail: 'Itens padrão do sistema não podem ser excluídos ou ter o código alterado.',
  },
  PRIMARY_ORGANIZATION_REQUIRED: {
    status: 409,
    title: 'Órgão principal obrigatório',
    detail: 'Este é o único órgão ativo e não pode ser inativado.',
  },
  WORKFLOW_VERSION_NOT_DRAFT: {
    status: 409,
    title: 'Versão do workflow não editável',
    detail: 'Esta versão já foi publicada e não pode ser alterada. Crie uma nova versão.',
  },
  WORKFLOW_DRAFT_EXISTS: {
    status: 409,
    title: 'Rascunho já existente',
    detail: 'Já existe uma versão em rascunho deste workflow.',
  },
  WORKFLOW_INVALID: {
    status: 422,
    title: 'Workflow inválido',
    detail: 'O fluxo tem problemas que impedem a publicação.',
  },
  ROLE_NOT_FOUND: {
    status: 404,
    title: 'Perfil não encontrado',
    detail: 'Perfil não encontrado.',
  },
  ROLE_ALREADY_EXISTS: {
    status: 409,
    title: 'Perfil já existente',
    detail: 'Já existe um perfil com esse nome.',
  },
  PRIVILEGE_ESCALATION_FORBIDDEN: {
    status: 403,
    title: 'Concessão não permitida',
    detail: 'Você não pode conceder uma permissão que você mesmo não possui.',
  },
  LAST_ADMIN_REQUIRED: {
    status: 409,
    title: 'Administrador obrigatório',
    detail:
      'Não é possível desativar o perfil Administrador do órgão: mantenha ao menos um administrador ativo.',
  },
  DEPARTMENT_CYCLE: {
    status: 422,
    title: 'Movimentação inválida',
    detail: 'Não é possível mover uma unidade para dentro dela mesma ou de uma subunidade.',
  },
  DEPARTMENT_HAS_REFERENCES: {
    status: 409,
    title: 'Unidade em uso',
    detail: 'Esta unidade está em uso e não pode ser excluída. Desative-a.',
  },
  TEMPLATE_NAME_TAKEN: {
    status: 409,
    title: 'Nome de template em uso',
    detail: 'Já existe um template com este nome para o tipo selecionado.',
  },
  TEMPLATE_INVALID: {
    status: 422,
    title: 'Template inválido',
    detail: 'O template tem problemas de conteúdo. Revise as seções destacadas.',
  },
  TEMPLATE_VERSION_NOT_DRAFT: {
    status: 409,
    title: 'Versão do template não editável',
    detail: 'Esta versão está publicada e não pode ser alterada.',
  },
  TEMPLATE_DRAFT_EXISTS: {
    status: 409,
    title: 'Rascunho já existente',
    detail: 'Já existe um rascunho em edição para este template.',
  },
  NOTIFICATION_NOT_FOUND: {
    status: 404,
    title: 'Notificação não encontrada',
    detail: 'Notificação não encontrada.',
  },
});

/** `type` do problem+json: URL estável derivada do código (`VALIDATION_ERROR` → `validation-error`). */
export function problemType(code: string): string {
  return `https://docs.contrataflow.com.br/errors/${code.toLowerCase().replaceAll('_', '-')}`;
}
