import type { ProvisioningStepStatus } from '@contrataflow/types';
import type { ProvisionTenant } from '@contrataflow/validation';
import { Injectable, Module } from '@nestjs/common';

/*
 * Seeders de tenant (US-099 · RN-TEN-05..07 · RM-07 · DEC-040/041). Cada módulo é dono do conteúdo
 * que semeia (perfis, tipos de documento, catálogos…) e o registra aqui no `onModuleInit`; o
 * módulo `tenancy` só orquestra — ordena por `dependsOn`, executa e calcula o checklist — sem
 * importar nada dos módulos donos (mesmo padrão das projeções do outbox e do uso de tipos de
 * documento). Ciclo ou dependência ausente impede o boot.
 *
 * Contrato: `seed` roda com o contexto do ator `SYSTEM` no tenant novo (`runAsSystem`) e abre a
 * PRÓPRIA `TenantTransaction` — uma transação por etapa, retomável; é idempotente pela chave
 * natural do módulo e nunca sobrescreve dado existente. `verify` recalcula a etapa a partir do
 * banco (`DONE`/`PENDING` + contagens).
 */

export interface TenantSeedContext {
  readonly tenantId: string;
  readonly slug: string;
  readonly now: Date;
  /**
   * Dados do provisionamento (`tenant.json`/PLT-01): órgão principal e primeiro administrador.
   * `null` ao aplicar seeders a um tenant existente (FA-08) ou ao só calcular o checklist.
   */
  readonly request: ProvisionTenant | null;
}

export interface TenantSeedResult {
  /** Registros criados nesta execução (0 na reexecução). */
  readonly created: number;
  /** Registros que já existiam e foram mantidos. */
  readonly skipped?: number;
}

export interface TenantSeedStatus {
  readonly status: ProvisioningStepStatus;
  /** Contagens exibidas no checklist (`{ items: 84 }`). */
  readonly details?: Readonly<Record<string, number>>;
}

export interface TenantSeeder {
  /** Chave da etapa no checklist (`catalog.items`, `access.defaultRoles`…). */
  readonly key: string;
  /** Módulo dono (DEC-040). */
  readonly module: string;
  /** Versão do conteúdo semeado (ex.: `2026.10.1`), gravada na auditoria `tenant.provision`. */
  readonly version: string;
  readonly dependsOn: readonly string[];
  /** Aplicável a tenants já provisionados por `tenant:seed` (FA-08 · RM-07). */
  readonly applyToExistingTenants: boolean;
  seed(ctx: TenantSeedContext): Promise<TenantSeedResult>;
  verify(ctx: TenantSeedContext): Promise<TenantSeedStatus>;
}

/** Situação do convite do primeiro administrador (resposta de PLT-01 · FA-07). */
export interface FirstAdminInvitation {
  /** E-mail completo (a apresentação mascara). */
  readonly email: string;
  readonly membershipStatus: string;
  readonly invitationDispatched: boolean;
}

/**
 * Envio do convite do primeiro administrador (RN-TEN-08): implementado pelo módulo `identity`
 * (fachada de convite da US-091). Chamado só depois do commit da ativação.
 */
export interface FirstAdminInvitationPort {
  /** Situação atual, sem enviar nada; `null` se o tenant ainda não tem o administrador. */
  describe(tenantId: string): Promise<FirstAdminInvitation | null>;
  /** Gera o token (validade a partir do envio) e enfileira o e-mail. Nunca lança por fila fora. */
  dispatch(tenantId: string): Promise<FirstAdminInvitation | null>;
}

/** Erro de programação no registro (falha na subida). */
export class TenantSeederRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantSeederRegistrationError';
  }
}

/** Registro único dos seeders (implementação do `TENANT_SEEDERS` de RN-TEN-07). */
@Injectable()
export class TenantSeederRegistry {
  private readonly seeders = new Map<string, TenantSeeder>();
  private invitation: FirstAdminInvitationPort | null = null;

  register(seeder: TenantSeeder): void {
    if (this.seeders.has(seeder.key)) {
      throw new TenantSeederRegistrationError(`Seeder ${seeder.key} já registrado.`);
    }
    this.seeders.set(seeder.key, seeder);
  }

  registerFirstAdminInvitation(port: FirstAdminInvitationPort): void {
    if (this.invitation !== null) {
      throw new TenantSeederRegistrationError('Convite do primeiro administrador já registrado.');
    }
    this.invitation = port;
  }

  /** Seeders na ordem de registro (a ordem de execução é do `tenancy`). */
  all(): readonly TenantSeeder[] {
    return [...this.seeders.values()];
  }

  firstAdminInvitation(): FirstAdminInvitationPort | null {
    return this.invitation;
  }
}

/** Importado por `tenancy` (orquestrador) e pelos módulos donos; a instância é única. */
@Module({ providers: [TenantSeederRegistry], exports: [TenantSeederRegistry] })
export class TenantSeedingModule {}
