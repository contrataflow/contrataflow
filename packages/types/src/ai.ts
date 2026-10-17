/**
 * Geração com IA (EP-020 · DEC-037 · DEC-079 · entities.md §2 e §4.11 `AiGeneration`): enums do
 * registro de gerações compartilhados por API, worker e web. O texto pedido e o gerado nunca
 * aparecem em logs, eventos ou auditoria — só ids, versões, hashes e contagens.
 */

/** Documentos que a IA gera (subconjunto de `SystemDocumentModule`). */
export const AI_TARGET_MODULES = ['DFD', 'ETP', 'RISK_MAP', 'TERM_OF_REFERENCE'] as const;
export type AiTargetModule = (typeof AI_TARGET_MODULES)[number];

/** entities.md §2 — `AiGenerationKind`. */
export const AI_GENERATION_KINDS = ['DRAFT', 'SECTION'] as const;
export type AiGenerationKind = (typeof AI_GENERATION_KINDS)[number];

/** entities.md §2 — `AiSectionAction`. */
export const AI_SECTION_ACTIONS = ['REWRITE', 'COMPLETE', 'SUMMARIZE'] as const;
export type AiSectionAction = (typeof AI_SECTION_ACTIONS)[number];

/** entities.md §2 — `AiGenerationStatus` (transições condicionais — RN-AI-03). */
export const AI_GENERATION_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'APPLIED',
  'DISCARDED',
  'EXPIRED',
] as const;
export type AiGenerationStatus = (typeof AI_GENERATION_STATUSES)[number];

/** `QUEUED`/`RUNNING`: no máximo uma por alvo (RN-AI-12). */
export const AI_ACTIVE_STATUSES = ['QUEUED', 'RUNNING'] as const satisfies AiGenerationStatus[];

/** `errorCode` da geração (campo, não HTTP — entities.md §4.11). */
export const AI_GENERATION_ERROR_CODES = [
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_RATE_LIMITED',
  'TIMEOUT',
  'CONTENT_FILTERED',
  'CONTEXT_TOO_LARGE',
  'OUTPUT_INVALID',
  'CANCELED_BY_POLICY',
] as const;
export type AiGenerationErrorCode = (typeof AI_GENERATION_ERROR_CODES)[number];

/** Provedores da camada `AiProvider` (DEC-079 · `AI_PROVIDER`; o real segue a ADR-013). */
export const AI_PROVIDERS = ['fake', 'anthropic', 'bedrock', 'openai', 'azure-openai'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

/** Validade da proposta `SUCCEEDED` (RN-AI-11). */
export const AI_PROPOSAL_TTL_DAYS = 7;

/** Intervalo inicial de consulta do AI-02 pelo cliente (`meta.pollAfterMs`). */
export const AI_POLL_AFTER_MS = 2_000;

/*
 * Configuração da IA no órgão (US-116 · DEC-037 · DEC-079 · PEND-22): limites técnicos de uso,
 * sem cobrança — o custo é só registrado por geração.
 */

/** `ai.monthlyTokenLimit`: mínimo, padrão e teto padrão da plataforma (`AI_TENANT_MAX_MONTHLY_TOKENS`). */
export const AI_MONTHLY_TOKEN_LIMIT_MIN = 50_000;
export const AI_MONTHLY_TOKEN_LIMIT_DEFAULT = 2_000_000;
export const AI_PLATFORM_MAX_MONTHLY_TOKENS_DEFAULT = 20_000_000;
/** Teto técnico do schema da chave; o máximo efetivo é o da plataforma (validado pela API). */
export const AI_MONTHLY_TOKEN_LIMIT_CEILING = 1_000_000_000;

/** `ai.userDailyRequestLimit`: faixa e padrão (RN-AI-19). */
export const AI_USER_DAILY_REQUEST_LIMIT_MIN = 1;
export const AI_USER_DAILY_REQUEST_LIMIT_MAX = 500;
export const AI_USER_DAILY_REQUEST_LIMIT_DEFAULT = 40;

/** Faixas do aviso de consumo do mês (RN-AI-20), em percentual do limite. */
export const AI_USAGE_THRESHOLDS = [80, 100] as const;
export type AiUsageThreshold = (typeof AI_USAGE_THRESHOLDS)[number];

/** Motivos de AI-05 (`reasons[]`) para não poder gerar (RN-AI-23). */
export const AI_AVAILABILITY_REASONS = [
  'AI_DISABLED',
  'AI_PROVIDER_UNAVAILABLE',
  'AI_USAGE_LIMIT_REACHED',
  'AI_USER_DAILY_LIMIT_REACHED',
  'PERMISSION_DENIED',
  'DOCUMENT_NOT_EDITABLE',
] as const;
export type AiAvailabilityReason = (typeof AI_AVAILABILITY_REASONS)[number];
