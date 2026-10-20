# ADR-002 — Multi-tenancy: banco e schema compartilhados com tenant_id, RLS e FKs compostas

| Campo | Valor |
|---|---|
| **Status** | Aceito |
| **Data** | 2026-10-06 |
| **Decisores** | Arquitetura/Tech Lead, Produto |
| **Decisões relacionadas** | DEC-011, DEC-012, DEC-080, DEC-081, DEC-082, DEC-076 (implementação — US-100) |
| **Documentos** | [multi-tenancy.md](../architecture/multi-tenancy.md) (completo) · [entities.md](../mvp-01/entities.md) · US-099, US-100 · [ADR-001](adr-001-modular-monolith.md) |

## Contexto

- O ContrataFlow atende múltiplos entes públicos como tenants distintos num mesmo SaaS. Hierarquia (DEC-011): `Tenant` é o cliente/conta e a fronteira de isolamento e faturamento; `Organization` é o órgão/entidade com CNPJ dentro do tenant (1..N, base para numeração e PNCP); `Department` é a unidade administrativa em árvore. Uma Câmara Municipal é, em regra, **outro tenant**, mesmo no mesmo município.
- A identidade é global e desacoplada do tenant (DEC-012): `User` é mapeado ao `sub` do Authentik e não contém dados de negócio; `TenantMembership` é o vínculo (interno, externo ou de serviço) que permite a um usuário ter acesso a vários tenants e escolher o tenant ativo na sessão.
- Vazar dados entre entes públicos é inaceitável administrativamente; ao mesmo tempo, custo e operação proporcionais ao número de tenants também não se sustentam, já que o público-alvo inclui centenas de órgãos pequenos.
- É necessário provisionar um tenant em segundos (US-099) e permitir consultas de plataforma (suporte, auditoria) sem depender de N conexões a N bancos distintos.

## Decisão

1. **Banco e schema compartilhados, `tenant_id` obrigatório** em toda tabela de negócio (DEC-080); lista fechada de tabelas de plataforma sem `tenant_id`: `tenants`, `users`, `permissions`, `_prisma_migrations`; `audit_logs` aceita `tenant_id` nulo somente para eventos de plataforma.
2. **Isolamento em quatro barreiras independentes** (defesa em profundidade, multi-tenancy.md §3–5):
   - **Contexto por transação:** `set_config('app.tenant_id', …, true)` é sempre o primeiro comando da transação (Unit of Work); abrir uma `TenantTransaction` para um tenant diferente dentro de um contexto `TENANT` é erro de programação — só casos de uso `PLATFORM` abrem transação para um tenant alvo (RN-TEN-21/22).
   - **Prisma Client Extension:** para os modelos de `TENANT_SCOPED_MODELS` (gerados do schema a cada `prisma generate`), `create`/`createMany`/`upsert` recebem o `tenantId` do contexto e as demais operações recebem `tenantId` no `where`; operação sem contexto lança `TenantContextMissing` (RN-TEN-23/24).
   - **Row-Level Security:** `ENABLE` + `FORCE` em toda tabela com `tenant_id`; política `tenant_isolation` (`USING`/`WITH CHECK tenant_id = current_setting('app.tenant_id')::uuid`); sem contexto definido, a consulta **falha fechada** — nunca devolve dados (DEC-082, RN-TEN-25).
   - **FKs compostas:** toda tabela de negócio expõe `UNIQUE (tenant_id, id)` e referencia outras por `(tenant_id, <fk>)` (DEC-081); uma linha do tenant A referenciando um id do tenant B falha no banco mesmo que a aplicação erre (RN-TEN-27).
3. **Papéis de banco dedicados, sem privilégio supérfluo** (multi-tenancy.md §5.2, RN-TEN-26): `cf_owner` (dono, só via `SET ROLE` do migrador), `cf_migrator` (deploy de migração), `cf_app`/`cf_worker` (aplicação, sem `BYPASSRLS`; em `tenants`, só as colunas não sensíveis), `cf_relay` (`BYPASSRLS` restrito a `SELECT`/`UPDATE` em `outbox_events`), `cf_maintenance` (`BYPASSRLS` restrito a `SELECT`/`DELETE` em `outbox_events` — DEC-072), `cf_platform` (acesso de plataforma, **sem** `BYPASSRLS`: DML em `tenants` e políticas explícitas `TO cf_platform` só para auditoria de plataforma e eventos do agregado `Tenant`), `cf_definer` (`NOLOGIN`, dono das funções `SECURITY DEFINER` de leitura entre tenants: `cf_user_memberships`, `cf_find_invitation`), `cf_readonly_report` e `cf_purge` (desabilitado por padrão). Toda tabela nova recebe a RLS padrão por `cf_apply_tenant_rls(tabela)`.
4. **Acesso de plataforma isolado em um serviço próprio:** `SystemDbService` (`systemPrisma`, US-100) é um segundo `PrismaClient` conectado como `cf_platform`, **sem** a extensão de tenant; só pode ser importado pelos módulos da allowlist do `dependency-cruiser`; toda chamada exige `reason` de lista fechada — `TENANT_LIFECYCLE`, `TENANT_PROVISIONING`, `TENANT_ENUMERATION`, `USER_MEMBERSHIPS_LOOKUP`, `INVITATION_LOOKUP`, `PLATFORM_AUDIT` — e gera log `system_db.call` com métrica `cf_system_db_calls_total{reason}`; suas transações usam `app.tenant_id` = UUID nulo (nenhum tenant); ações com efeito num tenant são auditadas no próprio tenant (`actorType = SYSTEM`/`PLATFORM_OPERATOR`) e qualquer trabalho sobre dados de um tenant reabre uma UoW com o contexto daquele tenant (RN-TEN-28, DEC-082).
5. **Suíte "tenant leak" obrigatória no CI** (bloqueia *merge*, multi-tenancy.md §14, RN-TEN-36): cobre toda operação do OpenAPI (IDs de outro tenant → 404/422), detecção de vazamento por canários nas respostas, cabeçalho `X-Tenant-Id` forjado (403 `MEMBERSHIP_INACTIVE`), verificação de catálogo (`pg_class`/`pg_policies`/`pg_constraint`: RLS, FK iniciada por `tenant_id`, `UNIQUE (tenant_id, id)`), cache, storage, filas e frontend; meta-testes garantem que toda rota declara `@TenantScope` e está classificada no manifesto da suíte (coberta ou isenta com motivo).
6. **Via de evolução preservada sem mudar o modelo:** um "silo" híbrido futuro (banco dedicado + chave KMS própria, mesmo código e schema) é viável para clientes enterprise porque o código nunca faz junções entre tenants e todo acesso passa pelo contexto.

## Implementação (US-100 · DEC-076)

As propostas da US-100 viraram decisão (detalhes em [DEC-076](../architecture/decisions.md) e no guia [`data-access.md`](../engineering/data-access.md)):
- **Contexto:** `TenantContext` sobre o `RequestContext` (AsyncLocalStorage), aberto pelo `TenantContextGuard` nas rotas `@TenantScope('TENANT')`, pela base `TenantJob` nos jobs e por `runForTenant` nos casos de uso de plataforma; imutável durante a requisição ou o job. Cabeçalho `X-Tenant-Id` ausente ou malformado → 400 `MALFORMED_REQUEST`.
- **Extensão:** `tenant-isolation` em `apps/api/src/shared/database/tenant-isolation.extension.ts`, com o tenant tirado do escopo da transação; listas `TENANT_SCOPED_MODELS`/`PLATFORM_MODELS` versionadas e conferidas com o schema pelo CI.
- **Banco:** migração `20261015120000_tenancy_foundation` (papel `cf_platform`, `cf_apply_tenant_rls`, `cf_find_invitation`, grants por coluna de `tenants`, políticas de plataforma). A política `tenant_isolation` vale para todos os papéis sem `BYPASSRLS`, não só `TO cf_app`. `cf_set_primary_organization` chega com `organizations` (US-101).
- **Plataforma:** `SystemDbService` (`shared/database/system-db.service.ts`, `DATABASE_URL_PLATFORM`).
- **Testes:** `apps/api/test/database/tenancy-foundation.spec.ts` (RLS por tabela, papéis, FKs compostas, funções, `SystemDbService`), `apps/api/test/tenant-leak/` (suíte HTTP sobre a API inteira e concorrência no pool) e meta-testes em `apps/api/src/openapi/tenant-isolation-coverage.spec.ts` — todos na tarefa `test:tenant-leak`; a sobrecarga do contexto (p95 ≤ 2 ms) fica na suíte de performance (`apps/api/test/database/context-overhead.perf.ts`, `test:perf`, medida no endurecimento — DEC-087).

## Alternativas consideradas

| Alternativa | Prós | Contras | Motivo da decisão |
|---|---|---|---|
| Banco por tenant | Isolamento físico; backup/restore por cliente; residência de dados dedicada | Custo e operação proporcionais ao número de tenants (centenas de instâncias); migrações orquestradas em N bancos; consultas de plataforma (suporte, contagem) impossíveis sem *fan-out* | **Rejeitada como padrão**; mantida como opção futura só para clientes enterprise ("silo") |
| Schema por tenant | Isolamento lógico mais forte que RLS; restauração por schema | Centenas de schemas × N tabelas tornam migrações lentas e frágeis; catálogo do PostgreSQL inchado; pool de conexões por `search_path`; Prisma sem suporte nativo a múltiplos schemas dinâmicos | **Rejeitada** |
| Banco e schema compartilhados + `tenant_id` | Uma migração para todos os tenants; custo marginal por tenant ≈ 0; operação simples para centenas de órgãos pequenos; provisionamento em segundos; consultas de plataforma possíveis | Risco de vazamento por bug exige defesa em profundidade; *noisy neighbor*; restauração de um único tenant é trabalhosa | **Adotada**, com quatro barreiras independentes e suíte "tenant leak" no CI |

## Consequências

**Positivas**
- Provisionamento de tenant em segundos, sem orquestração de infraestrutura por cliente (US-099).
- Custo marginal por tenant próximo de zero; viável para centenas de órgãos pequenos.
- Defesa em profundidade: uma falha numa camada (ex.: filtro ausente numa query) ainda é bloqueada pela RLS ou pela FK composta.
- Consultas de plataforma (suporte, auditoria) possíveis sem acessar N bancos.
- Caminho de evolução para isolamento físico ("silo") preservado para clientes que exigirem.

**Negativas**
- *Noisy neighbor*: um tenant com carga alta pode degradar outros no mesmo banco.
- Restauração pontual de um único tenant é trabalhosa num banco compartilhado.
- Disciplina obrigatória em todo código novo: nenhuma tabela de negócio pode nascer sem `tenant_id`, RLS e FK composta.
- A suíte "tenant leak" cresce com toda rota nova do OpenAPI e pode alongar o tempo de CI.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Query sem filtro de tenant | RLS falha fechado (sem contexto → erro); Prisma Client Extension injeta `tenantId` automaticamente |
| Uso indevido de `systemPrisma`/papel com `BYPASSRLS` | Allowlist no `dependency-cruiser`; `cf_relay` restrito a uma tabela; `cf_platform` sem `BYPASSRLS`; logs `system_db.call`; revisão trimestral de papéis |
| Pooling de conexão vazando contexto entre tenants | PgBouncer/RDS Proxy em modo transação; proibido `SET`/`set_config(…, false)` de sessão (lint + teste de reconexão) |
| Tabela nova sem `tenant_id`/RLS/FK composta | Meta-teste de catálogo (`pg_class`/`pg_constraint`/`pg_policies`) no CI; checklist para novos módulos (multi-tenancy.md §15) |
| Rota nova sem cobertura na suíte "tenant leak" | Meta-teste compara operações do OpenAPI ao manifesto da suíte; build falha se faltar |
| Vazamento por cache ou storage | Chaves derivadas do `tenantId` (`TenantCache`/`PlatformCache`, `StorageKeyBuilder`); testes dedicados na suíte de isolamento |

## Critérios de revisão

- Cliente enterprise (ex.: capital, estado) exigindo isolamento físico ou residência de dados dedicada → ativar o silo híbrido (banco dedicado + KMS próprio).
- *Noisy neighbor* real impactando SLO de outros tenants → avaliar particionamento de carga ou réplica dedicada.
- Incidente real de vazamento entre tenants → revisão completa das quatro barreiras antes de qualquer outra mudança.
- Limites e quotas por tenant (PEND-17) definidos → pode exigir camada de *enforcement* além das barreiras atuais.

## Referências
- DEC-011, DEC-012, DEC-080, DEC-081, DEC-082 — [decisions.md](../architecture/decisions.md).
- [multi-tenancy.md](../architecture/multi-tenancy.md) §1 (estratégia), §2 (hierarquia), §3–5 (barreiras, RLS, FKs compostas, papéis), §5.3 (`SystemDbService`), §6 (tabelas de plataforma), §14 (testes de isolamento).
- US-099 — RN-TEN-01..18 (provisionamento); US-100 — RN-TEN-19..37 (contexto, RLS, papéis de banco, `SystemDbService`, suíte "tenant leak") e [DEC-076](../architecture/decisions.md) (implementação).
- [ADR-001](adr-001-modular-monolith.md) (módulos autorizados a importar o `SystemDbService`), [ADR-004](adr-004-outbox-events.md) (contexto de tenant propagado em jobs e eventos).
