# `tenancy`

Tenants, órgãos, configurações do tenant, provisionamento e estado do tenant (DEC-040).

## Provisionamento e ciclo de vida (US-099 · DEC-078)

- **Casos de uso:** `ProvisionTenantCommand` (checklist retomável), `ChangeTenantStatusCommand`
  (ativar, suspender, encerrar, desativar — máquina de estados em `domain/tenant.ts`),
  `ApplyTenantSeedersCommand`, `ResendFirstAdminInvitationCommand`, `ListTenantsQuery` e
  `GetTenantQuery`. A API de plataforma (`presentation/platform-tenants.controller.ts`, PLT-01..05)
  e a CLI (`src/cli/tenant.cli.ts`, `pnpm cf tenant:*`) chamam os mesmos casos de uso.
- **Acesso a dados:** `tenants`, a auditoria das ações de plataforma e os eventos `Tenant*` passam
  pelo `SystemDbService` (`cf_platform`), atrás da porta `PLATFORM_TRANSACTIONS`; dados de negócio
  só pelos seeders, cada um na `TenantTransaction` do tenant novo.
- **Operação:** runbook RB-12 em `docs/architecture/observability.md`.

## Como registrar um seeder (stories donas: US-101, US-103, US-104, US-106, US-110, US-042…)

1. Implemente `TenantSeeder` (`#shared/tenancy/tenant-seeding.js`) no `application/` do módulo dono:
   `key` (a chave da etapa no checklist, ex.: `catalog.items`), `module`, `version` (ex.:
   `2026.10.1` — suba ao mudar o conteúdo), `dependsOn` (chaves que precisam estar prontas antes) e
   `applyToExistingTenants` (`true` se `tenant:seed` puder aplicá-lo a tenants já provisionados).
2. `seed(ctx)`: roda como ator `SYSTEM` com o tenant novo no contexto — abra a própria
   `TenantTransaction` (uma etapa = uma transação), grave só o que falta pela chave natural e nunca
   sobrescreva dado existente. `ctx.request` traz o `tenant.json` (órgão principal, primeiro
   administrador) e é `null` em `tenant:seed`.
3. `verify(ctx)`: `DONE`/`PENDING` calculado do banco, com contagens em `details` (ex.:
   `{ items: 84 }`) — é o que aparece no checklist e o que decide a retomada.
4. Importe `TenantSeedingModule` no módulo e registre no `onModuleInit`:
   `this.seeders.register(this.meuSeeder)`. Ciclo ou dependência ausente derruba o boot.
5. Teste: idempotência (segunda execução sem linhas novas) e isolamento (só o tenant do contexto).

Seeders registrados hoje: `access.defaultRoles`, `document.systemTypes` e `identity.firstAdmin`
(este também é o `FirstAdminInvitationPort`; token e e-mail do convite chegam com a US-091/US-112, e
o papel `ADMIN_ORGAO` no escopo `TENANT` com a US-096).
