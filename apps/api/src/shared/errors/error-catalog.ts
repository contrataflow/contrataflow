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
  APPROVAL_NOT_PENDING: {
    status: 409,
    title: 'Aprovação não pendente',
    detail: 'Já existe uma aprovação em andamento para este item.',
  },
  APPROVAL_NOT_FOUND: {
    status: 404,
    title: 'Aprovação não encontrada',
    detail: 'Não encontramos a aprovação solicitada.',
  },
  NOT_DESIGNATED_APPROVER: {
    status: 403,
    title: 'Aprovador não designado',
    detail: 'Você não pode decidir esta aprovação.',
  },
  SELF_APPROVAL_FORBIDDEN: {
    status: 403,
    title: 'Autoaprovação vedada',
    detail: 'Você não pode decidir esta aprovação: é autor de um documento coberto.',
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
  WORKFLOW_IN_USE: {
    status: 409,
    title: 'Versão do workflow em uso',
    detail: 'Publique uma nova versão antes de aposentar esta.',
  },
  NO_APPLICABLE_WORKFLOW: {
    status: 422,
    title: 'Nenhum workflow aplicável',
    detail: 'Não há fluxo configurado para este tipo de contratação.',
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
  ROLE_ASSIGNMENT_NOT_FOUND: {
    status: 404,
    title: 'Atribuição não encontrada',
    detail: 'Atribuição de perfil não encontrada.',
  },
  ROLE_ASSIGNMENT_ALREADY_EXISTS: {
    status: 409,
    title: 'Atribuição já existente',
    detail: 'Este perfil já está atribuído neste escopo.',
  },
  EXTERNAL_HIGH_RISK_ROLE: {
    status: 422,
    title: 'Perfil não permitido para externo',
    detail: 'Este perfil não pode ser atribuído a um vínculo externo.',
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
  SUPPLIER_ALREADY_EXISTS: {
    status: 409,
    title: 'Fornecedor já cadastrado',
    detail: 'Já existe um fornecedor cadastrado com este documento.',
  },
  SUPPLIER_IN_USE: {
    status: 409,
    title: 'Fornecedor em uso',
    detail: 'Este fornecedor está em uso em pesquisas de preço e não pode ser excluído.',
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
  TEMPLATE_IN_USE: {
    status: 409,
    title: 'Template em uso',
    detail: 'Publique outra versão antes de aposentar esta.',
  },
  PROCESS_NOT_FOUND: {
    status: 404,
    title: 'Processo não encontrado',
    detail: 'Não encontramos o recurso solicitado.',
  },
  POSSIBLE_DUPLICATE_PROCESS: {
    status: 409,
    title: 'Possível processo duplicado',
    detail: 'Encontramos processos parecidos criados recentemente.',
  },
  DUPLICATE_INTERNAL_CODE: {
    status: 409,
    title: 'Código interno já utilizado',
    detail: 'Já existe um processo com este código interno.',
  },
  NOT_PROCESS_CUSTODIAN: {
    status: 403,
    title: 'Sem custódia do processo',
    detail: 'Apenas o responsável atual pelo processo pode realizar esta ação.',
  },
  PROCESS_ALREADY_ASSIGNED: {
    status: 409,
    title: 'Processo já assumido',
    detail: 'Este processo já tem um responsável.',
  },
  INVALID_PROCESS_STATUS: {
    status: 409,
    title: 'Status do processo incompatível',
    detail: 'Esta ação não está disponível para o status atual do processo.',
  },
  CANNOT_DISCARD_NUMBERED_PROCESS: {
    status: 409,
    title: 'Processo já numerado',
    detail: 'Este processo já tem número; cancele-o em vez de descartar.',
  },
  DOCUMENT_INCOMPLETE: {
    status: 422,
    title: 'Documento incompleto',
    detail: 'Há pendências que impedem esta ação.',
  },
  WARNINGS_NOT_ACKNOWLEDGED: {
    status: 422,
    title: 'Avisos não reconhecidos',
    detail: 'Reconheça os avisos para continuar.',
  },
  DOCUMENT_ALREADY_EXISTS: {
    status: 409,
    title: 'Documento já existente',
    detail: 'Este processo já tem um documento deste tipo.',
  },
  DOCUMENT_NOT_EDITABLE: {
    status: 409,
    title: 'Documento não editável',
    detail: 'O documento não pode ser editado no status atual.',
  },
  RECOMMENDED_ALTERNATIVE_EXISTS: {
    status: 409,
    title: 'Alternativa recomendada existente',
    detail: 'Já existe uma alternativa recomendada. Substituir pela atual?',
  },
  DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE: {
    status: 422,
    title: 'Tipo não permitido na etapa',
    detail: 'Este tipo de documento não é permitido na etapa atual do processo.',
  },
  NOTIFICATION_NOT_FOUND: {
    status: 404,
    title: 'Notificação não encontrada',
    detail: 'Notificação não encontrada.',
  },
  USER_NOT_FOUND: {
    status: 404,
    title: 'Usuário não encontrado',
    detail: 'Usuário ou convite não encontrado nesta instituição.',
  },
  MEMBERSHIP_ALREADY_EXISTS: {
    status: 409,
    title: 'Vínculo já existente',
    detail: 'Esta pessoa já tem um vínculo com esta instituição.',
  },
  INVITATION_INVALID: {
    status: 404,
    title: 'Convite inválido',
    detail: 'Este convite não é válido.',
  },
  INVITATION_EXPIRED: {
    status: 410,
    title: 'Convite expirado',
    detail: 'Este convite expirou. Peça para reenviarem.',
  },
  // US-115: camada de IA (story "Casos de erro" · api/16-ai.md).
  AI_DISABLED: {
    status: 403,
    title: 'IA desligada',
    detail: 'A IA está desligada neste órgão.',
  },
  AI_PROVIDER_UNAVAILABLE: {
    status: 503,
    title: 'IA indisponível',
    detail: 'A IA está indisponível agora. Tente novamente em instantes.',
  },
  AI_USAGE_LIMIT_REACHED: {
    status: 422,
    title: 'Limite de uso de IA',
    detail: 'O limite mensal de uso de IA foi atingido.',
  },
  AI_USER_DAILY_LIMIT_REACHED: {
    status: 422,
    title: 'Limite diário de IA',
    detail: 'Você atingiu o limite diário de pedidos de IA.',
  },
  // US-116: ligar a IA exige o aceite da versão vigente dos termos (RN-AI-16 · V-01).
  AI_TERMS_NOT_ACCEPTED: {
    status: 422,
    title: 'Termos de uso da IA',
    detail: 'Aceite os termos de uso da versão atual para ativar a IA.',
  },
  AI_GENERATION_IN_PROGRESS: {
    status: 409,
    title: 'Geração em andamento',
    detail: 'Já existe uma geração em andamento para este alvo.',
  },
  AI_PREREQUISITE_MISSING: {
    status: 422,
    title: 'Documento anterior ausente',
    detail: 'Falta um documento anterior para gerar este.',
  },
  AI_SECTION_EMPTY: {
    status: 422,
    title: 'Seção sem conteúdo',
    detail: "A seção precisa de ao menos 50 caracteres. Use 'Completar' ou escreva um pouco mais.",
  },
  AI_SECTION_NOT_SUPPORTED: {
    status: 422,
    title: 'Seção não suportada',
    detail: 'Esta seção não pode ser ajustada com IA.',
  },
  // US-121: a seção mudou desde o pedido de ajuste (RN-AI-49 · DOC-26).
  AI_SUGGESTION_STALE: {
    status: 410,
    title: 'Sugestão desatualizada',
    detail: 'A seção mudou desde o pedido. Gere o ajuste novamente.',
  },
  AI_GENERATION_NOT_FOUND: {
    status: 404,
    title: 'Geração não encontrada',
    detail: 'Geração não encontrada.',
  },
  AI_GENERATION_NOT_APPLICABLE: {
    status: 409,
    title: 'Geração não aplicável',
    detail: 'Esta geração não pode mais ser descartada.',
  },
  AI_GENERATION_NOT_OWNED: {
    status: 403,
    title: 'Geração de outra pessoa',
    detail: 'Só quem pediu a geração pode descartá-la.',
  },
  // US-068: upload seguro de anexos (api/12-comments-attachments.md ATT-02..06).
  FILE_TYPE_NOT_ALLOWED: {
    status: 415,
    title: 'Tipo de arquivo não permitido',
    detail: 'Este tipo de arquivo não é permitido.',
  },
  FILE_TOO_LARGE: {
    status: 413,
    title: 'Arquivo muito grande',
    detail: 'O arquivo excede o limite permitido.',
  },
  UPLOAD_NOT_RECEIVED: {
    status: 409,
    title: 'Upload não recebido',
    detail: 'Não encontramos o arquivo enviado. Tente novamente.',
  },
  ATTACHMENT_NOT_AVAILABLE: {
    status: 409,
    title: 'Anexo indisponível',
    detail: 'O anexo ainda não está disponível.',
  },
  RENDITION_NOT_READY: {
    status: 409,
    title: 'PDF indisponível',
    detail: 'O PDF ainda está sendo gerado. Aguarde.',
  },
  STORAGE_QUOTA_EXCEEDED: {
    status: 422,
    title: 'Limite de armazenamento atingido',
    detail: 'O órgão atingiu o limite de armazenamento de arquivos.',
  },
  ITEM_IN_USE: {
    status: 409,
    title: 'Item em uso',
    detail: 'Este item está em uso em documentos do processo.',
  },
  PARTICIPANT_NOT_ELIGIBLE: {
    status: 422,
    title: 'Participante não elegível',
    detail: 'Este usuário não pode receber o papel selecionado.',
  },
  PARTICIPANT_ALREADY_EXISTS: {
    status: 409,
    title: 'Participante já existe',
    detail: 'Esta pessoa (ou unidade) já participa do processo.',
  },
  PARTICIPANT_NOT_FOUND: {
    status: 404,
    title: 'Participante não encontrado',
    detail: 'Este participante não existe mais.',
  },
  // US-071: comentários (api.md §2.2 · api/12-comments-attachments.md CMT-01..04).
  COMMENT_NOT_FOUND: {
    status: 404,
    title: 'Comentário não encontrado',
    detail: 'Comentário não encontrado.',
  },
  COMMENT_EDIT_WINDOW_EXPIRED: {
    status: 409,
    title: 'Prazo de edição encerrado',
    detail: 'O prazo de 15 minutos para editar terminou.',
  },
  RICH_TEXT_INVALID: {
    status: 422,
    title: 'Formatação não permitida',
    detail: 'O comentário contém formatação não permitida.',
  },
  SECTION_NOT_IN_TEMPLATE: {
    status: 422,
    title: 'Seção inexistente',
    detail: 'Seção inexistente neste documento.',
  },
  // US-014: DFD (api/05-dfd.md DFD-03).
  DFD_NOT_FOUND: { status: 404, title: 'DFD não encontrado', detail: 'DFD não encontrado.' },
  // US-015: autosave de seção (api/03-documents.md DOC-05 · RN-DFD-25).
  SECTION_REVISION_CONFLICT: {
    status: 412,
    title: 'A seção foi alterada por outra pessoa',
    detail: 'Esta seção foi alterada por outra pessoa.',
  },
  // US-026: fonte de pesquisa sem os campos que o tipo exige (api/07 PRS-10/11 · RN-PRICE-21).
  QUOTATION_REQUIRED_FIELDS: {
    status: 422,
    title: 'Campos obrigatórios da fonte',
    detail: 'Informe os campos exigidos por este tipo de fonte.',
  },
  // US-028: prévia da importação de cotações vencida (api/07 PRS-19 · RN-PRICE-38).
  IMPORT_PREVIEW_EXPIRED: {
    status: 410,
    title: 'Prévia expirada',
    detail: 'A prévia expirou. Envie a planilha novamente.',
  },
  // US-031: mapa comparativo (api/07 PRS-21/22) — pesquisa inexistente, de outro tenant ou não visível.
  PRICE_RESEARCH_NOT_FOUND: {
    status: 404,
    title: 'Pesquisa não encontrada',
    detail: 'Pesquisa não encontrada.',
  },
  // US-032: conclusão da pesquisa com pendências de completude (api/07 PRS-23 · RN-PRICE-59).
  PRICE_RESEARCH_INCOMPLETE: {
    status: 422,
    title: 'Pesquisa incompleta',
    detail: 'Há itens pendentes. Revise antes de concluir a pesquisa.',
  },
  // US-047: encaminhamento do processo (story "Casos de erro" · api/02-processes.md PRC-19).
  STAGE_CHANGED: {
    status: 409,
    title: 'Processo movimentado',
    detail: 'O processo acabou de ser movimentado por outra pessoa.',
  },
  TRANSITION_NOT_AVAILABLE: {
    status: 422,
    title: 'Caminho indisponível',
    detail: 'Este caminho não está disponível para a etapa atual.',
  },
  TRANSITION_BLOCKED: {
    status: 422,
    title: 'Pendências na etapa',
    detail: 'Há pendências obrigatórias na etapa.',
  },
  DEPARTMENT_REQUIRED: {
    status: 422,
    title: 'Unidade de destino obrigatória',
    detail: 'Escolha a unidade de destino.',
  },
  DUE_DATE_OVERRIDE_NOT_ALLOWED: {
    status: 422,
    title: 'Prazo não alterável',
    detail: 'Esta etapa não permite alterar o prazo.',
  },
  ASSIGNEE_NOT_ELIGIBLE: {
    status: 422,
    title: 'Pessoa não elegível',
    detail: 'Esta pessoa não pode receber o processo nesta unidade.',
  },
});

/** `type` do problem+json: URL estável derivada do código (`VALIDATION_ERROR` → `validation-error`). */
export function problemType(code: string): string {
  return `https://docs.contrataflow.com.br/errors/${code.toLowerCase().replaceAll('_', '-')}`;
}
