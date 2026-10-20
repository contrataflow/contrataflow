/**
 * Tenancy de plataforma (US-099 · entities.md §2 `Tenant` · DEC-132 · DEC-141): listas fechadas do
 * provisionamento e do ciclo de vida do tenant, compartilhadas pela API (validação e máquina de
 * estados), pela CLI e pelo web (SCR-111).
 */

/** entities.md §2 — `TenantType`. */
export const TENANT_TYPES = [
  'MUNICIPALITY',
  'CITY_COUNCIL',
  'AUTARCHY',
  'PUBLIC_CONSORTIUM',
  'FOUNDATION',
  'PUBLIC_COMPANY',
  'OTHER',
] as const;

export type TenantType = (typeof TENANT_TYPES)[number];

/** Tipos de ente que exigem o código IBGE do município (RN-TEN-03). */
export const TENANT_TYPES_REQUIRING_IBGE: readonly TenantType[] = ['MUNICIPALITY', 'CITY_COUNCIL'];

/** entities.md §2 — `TenantStatus` (DEC-132). */
export const TENANT_STATUSES = [
  'PROVISIONING',
  'ACTIVE',
  'SUSPENDED',
  'OFFBOARDING',
  'DEACTIVATED',
] as const;

export type TenantLifecycleStatus = (typeof TENANT_STATUSES)[number];

/**
 * Slugs reservados (RN-TEN-01): nomes de subdomínios e rotas próprias da plataforma, guardados para
 * eventuais domínios por tenant (DEC-141).
 */
export const RESERVED_TENANT_SLUGS: readonly string[] = [
  'admin',
  'api',
  'app',
  'auth',
  'www',
  'static',
  'assets',
  'status',
  'docs',
  'ajuda',
  'suporte',
  'plataforma',
  'platform',
  'contrataflow',
  'entrar',
  'login',
  'mail',
  'cdn',
  'demo',
  'teste',
  'homolog',
  'staging',
];

/** RN-TEN-01: 3–63 caracteres, minúsculas, dígitos e hífen simples entre eles. */
export const TENANT_SLUG_PATTERN = /^[a-z0-9](-?[a-z0-9])*$/;

/**
 * UFs com o código IBGE (os dois primeiros dígitos do código de município — RN-TEN-03).
 */
export const BRAZILIAN_STATES: Readonly<Record<string, string>> = {
  RO: '11',
  AC: '12',
  AM: '13',
  RR: '14',
  PA: '15',
  AP: '16',
  TO: '17',
  MA: '21',
  PI: '22',
  CE: '23',
  RN: '24',
  PB: '25',
  PE: '26',
  AL: '27',
  SE: '28',
  BA: '29',
  MG: '31',
  ES: '32',
  RJ: '33',
  SP: '35',
  PR: '41',
  SC: '42',
  RS: '43',
  MS: '50',
  MT: '51',
  GO: '52',
  DF: '53',
};

export const BRAZILIAN_STATE_CODES = Object.keys(BRAZILIAN_STATES) as readonly string[];

/** Fusos IANA do território brasileiro aceitos no tenant (RN-TEN-03). */
export const BRAZILIAN_TIMEZONES = [
  'America/Sao_Paulo',
  'America/Bahia',
  'America/Fortaleza',
  'America/Recife',
  'America/Maceio',
  'America/Belem',
  'America/Araguaina',
  'America/Santarem',
  'America/Manaus',
  'America/Cuiaba',
  'America/Campo_Grande',
  'America/Porto_Velho',
  'America/Boa_Vista',
  'America/Rio_Branco',
  'America/Eirunepe',
  'America/Noronha',
] as const;

export type BrazilianTimezone = (typeof BRAZILIAN_TIMEZONES)[number];

export const DEFAULT_TENANT_TIMEZONE: BrazilianTimezone = 'America/Sao_Paulo';
export const DEFAULT_TENANT_LOCALE = 'pt-BR';
/** PEND-17: plano único, sem limites aplicados no MVP 1. */
export const DEFAULT_TENANT_PLAN = 'STANDARD';

/**
 * Permissão de plataforma (permissions.md §8): concedida a `User.isPlatformOperator`, fora dos
 * perfis de tenant, sempre com MFA.
 */
export const PLATFORM_TENANT_MANAGE = 'PLATFORM_TENANT_MANAGE';

/** Etapas do checklist que pertencem ao próprio `tenancy` (as demais vêm dos seeders). */
export const TENANT_RECORD_STEP = 'tenancy.tenantRecord';
export const TENANT_COMPLETE_STEP = 'tenancy.complete';

export const PROVISIONING_STEP_STATUSES = ['DONE', 'PENDING'] as const;

export type ProvisioningStepStatus = (typeof PROVISIONING_STEP_STATUSES)[number];

/** Canal da ação de plataforma (`metadata.channel` — RN-TEN-17). */
export const PLATFORM_CHANNELS = ['API', 'CLI'] as const;

export type PlatformChannel = (typeof PLATFORM_CHANNELS)[number];
