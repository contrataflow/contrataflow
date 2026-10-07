---
id: US-081
title: "Persistência com Prisma e concorrência otimista"
epic: EP-015
feature: FT-048
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-078, US-080]
modules: [platform]
screens: []
endpoints: []
permissions: []
events: []
---

# US-081 — Persistência com Prisma e concorrência otimista

## Título
Persistência com Prisma e concorrência otimista

## Descrição
**Como** pessoa desenvolvedora backend do ContrataFlow, **quero** uma camada de persistência Prisma com convenções fixas (mapeamento `@map`, UUIDv7, decimais, concorrência otimista) e um mecanismo único que define o contexto de tenant em toda transação, **para** que todo módulo de negócio futuro herde isolamento multi-tenant e controle de concorrência sem reimplementar nada.

Esta story entrega o schema Prisma base, os papéis de banco (`cf_owner`, `cf_migrator`, `cf_app`, `cf_worker`, `cf_relay`), a extensão `TenantTransaction` (define `app.tenant_id` por transação) e o padrão de migração (RLS `ENABLE`+`FORCE`, colunas padrão, SQL bruto para o que o Prisma não expressa). O exemplo concreto e testável é a tabela `outbox_events`, criada aqui conforme entities.md; sua lógica de escrita/relay é entregue em US-082.

## Contexto
- A Lei 14.133/2021 não impõe este desenho, mas a plataforma é multi-tenant (uma instância para várias prefeituras/órgãos) e um vazamento entre tenants seria uma falha grave de conformidade e confiança — por isso o isolamento é garantido no banco (RLS), não só na aplicação (DEC-080/DEC-082, [multi-tenancy.md](../architecture/multi-tenancy.md)).
- US-077 preparou o monorepo e US-080 entregou o esqueleto da API com `RequestContext`/`AsyncLocalStorage`, guards e o filtro de erros — mas ainda sem acesso a dados. Esta story é o próximo elo: toda consulta/gravação de qualquer módulo (DEC-040) passa a depender dela.
- Convenções de nomenclatura e tipos vêm de DEC-001 (`@map`/`@@map`, PascalCase/snake_case), DEC-002 (UUIDv7 gerado pela aplicação), DEC-003 (datas em `timestamptz`, decimais com `decimal.js`), DEC-055 (concorrência otimista por `version` + `ETag`/`If-Match`, pessimista pontual via `FOR UPDATE`), DEC-083 (colunas padrão) e DEC-084 (snapshots imutáveis — função/trigger reutilizável, aplicada por tabelas concretas em stories futuras).
- Sem esta fundação, nenhuma story de negócio (a partir de US-001) consegue persistir nada com garantias de isolamento e concorrência.

## Objetivo
Toda tabela de negócio futura nasce com RLS `ENABLE`+`FORCE` e colunas padrão (DEC-083) sem código extra por módulo; 100% das transações de escrita/leitura abrem contexto via `TenantTransaction`; o teste automatizado "tenant leak" (Testcontainers) comprova zero vazamento entre dois tenants seedados; conflitos de concorrência otimista são detectados em 100% dos `UPDATE`s de agregados mutáveis (0 linhas afetadas ⇒ erro tratável).

## Persona
- **Principal:** Pessoa desenvolvedora backend do ContrataFlow (usa a camada de persistência para construir repositórios de cada módulo).
- **Secundárias:** Pessoa desenvolvedora de infraestrutura/DBA (opera papéis e migrações em produção); pipeline de CI (US-079, valida RLS e proíbe `set_config` de sessão).

## Pré-condições
- US-077 concluída (`apps/api`/`apps/worker` com scripts e ESLint de fronteira de DEC-041).
- US-078 disponível: PostgreSQL 17 com `pgvector`/`pg_trgm`/`unaccent`/`citext` rodando localmente.
- US-080 concluída: `RequestContextModule`/`AsyncLocalStorage` disponível para fornecer `tenantId` à `TenantTransaction`.

## Fluxo principal
1. A pessoa desenvolvedora roda a migração inicial (`pnpm prisma migrate dev`), que cria os papéis de banco — `cf_owner` (dono dos objetos, sem `BYPASSRLS`), `cf_migrator` (membro de `cf_owner`, usado só pela task de deploy), `cf_app` (login da API), `cf_worker` (login do worker) e `cf_relay` (login do relay, `BYPASSRLS` restrito a `outbox_events`) — e concede os privilégios mínimos de cada um por `GRANT`.
2. A mesma migração cria `outbox_events` (entities.md, módulo `platform`) aplicando o padrão de colunas (DEC-083, com as exceções do próprio modelo — `tenantId` nulo só para eventos de plataforma), `ENABLE`/`FORCE ROW LEVEL SECURITY`, a política `tenant_id = current_setting('app.tenant_id')::uuid` e os índices `(status, occurred_at) WHERE status = 'PENDING'` e `(tenant_id, aggregate_type, aggregate_id, occurred_at)`.
3. Um pacote interno expõe a extensão de cliente Prisma `TenantTransaction`: recebe o `tenantId` do contexto ativo (`AsyncLocalStorage` — US-080) e, como primeira instrução de toda transação interativa, executa `SELECT set_config('app.tenant_id', $1, true)` (terceiro argumento `true` = escopo da transação). Nenhum repositório de módulo de negócio instancia o `PrismaClient` fora desse wrapper.
4. Entidades mutáveis seguem o padrão de concorrência otimista (DEC-055): coluna `version` (`int`, padrão `1`); todo `UPDATE` do repositório inclui `WHERE version = @expected` e lê o número de linhas afetadas; `0` linhas ⇒ a camada de aplicação lança um erro de conflito de versão (consumido pela API como `VERSION_CONFLICT` — DEC-104).
5. Campos monetários, de quantidade e de percentual usam `Decimal` do Prisma nas escalas de DEC-003 (`Decimal(18,2)`, `Decimal(18,4)`, `Decimal(9,4)`); os mapeadores de cada módulo convertem para `decimal.js` antes de qualquer cálculo, nunca para `number`.
6. Uma suíte de integração (Testcontainers PostgreSQL) abre o mesmo pool para dois tenants seedados e comprova: contexto ausente falha fechado; contexto do tenant A nunca retorna linhas do tenant B; `INSERT`/`UPDATE` com `tenant_id` de B sob contexto de A viola a política e falha; a mesma conexão reaproveitada para A e depois B não vaza contexto.
7. O estágio de qualidade do CI (US-079) roda um lint de SQL que falha a build se alguma migração usar `set_config(..., false)` (escopo de sessão) ou se uma tabela nova com `tenant_id` não tiver RLS `ENABLE`+`FORCE`+política — ambos verificados também por consulta de catálogo (`pg_class`/`pg_policy`).

## Fluxos alternativos
- **FA-01 — Pool em modo transação:** como o contexto vive só na transação, PgBouncer (modo `transaction`) ou RDS Proxy podem compartilhar conexões entre tenants sem vazamento; o comportamento de *pinning* do RDS Proxy deve ser revalidado pela suíte de reuso de conexão antes de habilitá-lo em produção.
- **FA-02 — Leitura também abre transação:** toda leitura roda em transação (mesmo somente leitura), pois `set_config(..., true)` só vale dentro dela; repositórios nunca chamam `prisma.$queryRaw`/`$executeRaw` fora do wrapper `TenantTransaction`.
- **FA-03 — Papel de leitura para relatórios:** `cf_readonly_report` é criado nesta migração (reservado para exportações pesadas e réplica futura), mas sem nenhum caso de uso ligado a ele ainda.
- **FA-04 — Rollback após obter trava de linha:** quando uma transação com bloqueio pessimista pontual (`SELECT … FOR UPDATE`, ex.: sequência de numeração de US-001) falha antes do commit, a transação inteira desfaz — a trava é liberada e nenhum valor é consumido ou perdido.

## Regras de negócio
- **RN-FND-39** — Toda chave primária de tabela de negócio é **UUIDv7 gerado pela aplicação** (nunca `gen_random_uuid()` do banco nem sequencial/previsível) — DEC-002.
- **RN-FND-40** — O mapeamento Prisma usa `@map`/`@@map` para traduzir modelo PascalCase singular/campo camelCase (código) em tabela snake_case plural/coluna snake_case (banco) — DEC-001.
- **RN-FND-41** — Colunas monetárias, de preço unitário/quantidade e de percentual usam `Decimal` do Prisma nas escalas `(18,2)`, `(18,4)` e `(9,4)` respectivamente; todo cálculo em TypeScript usa `decimal.js`, nunca `number`/float — DEC-003.
- **RN-FND-42** — Toda entidade mutável tem coluna `version` (`int`, padrão `1`), incrementada pelo próprio `UPDATE` do repositório (`SET version = version + 1 WHERE version = @expected`), nunca por trigger; `0` linhas afetadas é tratado como conflito de concorrência — DEC-055.
- **RN-FND-43** — Toda transação de leitura ou escrita passa por `TenantTransaction`, que executa `SELECT set_config('app.tenant_id', $1, true)` como primeira instrução; nenhum código de módulo de negócio usa o `PrismaClient` fora desse wrapper.
- **RN-FND-44** — É proibido `set_config(..., false)` (escopo de sessão) em qualquer rotina da aplicação ou migração — vazaria contexto entre clientes do pool; verificado por lint de SQL no CI e por teste de reuso de conexão.
- **RN-FND-45** — Toda migração que cria tabela com `tenant_id` aplica, na mesma migração, `ENABLE`/`FORCE ROW LEVEL SECURITY` e a política `tenant_id = current_setting('app.tenant_id')::uuid`; tabela sem esse padrão falha a checagem de catálogo do CI — DEC-082.
- **RN-FND-46** — Papéis de banco mínimos criados por esta story: `cf_owner`/`cf_migrator` (dono dos objetos, sem `BYPASSRLS`, só via `SET ROLE` do migrador), `cf_app` e `cf_worker` (login das aplicações, sem `BYPASSRLS`) e `cf_relay` (login do relay, `BYPASSRLS` restrito a `SELECT`/`UPDATE` em `outbox_events`; habilitado em uso a partir de US-082).
- **RN-FND-47** — SQL bruto (RLS, triggers de imutabilidade de snapshot — DEC-084, partições) vive em migrações versionadas do Prisma (`migration.sql`/`Unsupported`), nunca gerado pelo cliente em tempo de execução.
- **RN-FND-48** — O pool de conexões (PgBouncer modo `transaction`) é compatível porque o contexto dura só a transação; é proibido abrir transação implícita fora do `TenantTransaction`.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| — | — | — | — | Não aplicável: story de infraestrutura, sem formulário nem entidade de negócio própria. | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Escala decimal respeitada (`(18,2)`/`(18,4)`/`(9,4)`) antes de persistir | Prisma schema + `decimal.js` | Não aplicável (erro de programação, pego em teste) | — |
| V-02 | Toda tabela de negócio tem `tenant_id NOT NULL`, exceto a lista fechada de DEC-080 | CI (checagem de catálogo) | — | falha de build |
| V-03 | Toda tabela com `tenant_id` tem RLS `ENABLE`+`FORCE`+política | CI (checagem de catálogo) | — | falha de build |
| V-04 | `UPDATE` de agregado mutável sempre filtra por `version` | Revisão de código + lint de arquitetura | — | falha de build/PR |
| V-05 | Nenhuma migração usa `set_config(..., false)` | CI (lint de SQL) | — | falha de build |

## Permissões
- **Permissão:** esta story não introduz nenhuma permissão `RESOURCE_ACTION` de negócio — ela cria os **papéis de banco** e o **mecanismo** (`TenantTransaction`) que toda permissão futura depende para isolar dados por tenant.
- **Políticas:** nenhuma política contextual de RBAC; o controle aqui é feito pelo PostgreSQL (RLS, `GRANT`/`BYPASSRLS`), não pela camada de autorização da aplicação.
- **MFA:** não aplicável.
- **Sem permissão:** tentativas de alterar a definição das tabelas com `cf_app`/`cf_worker`/`cf_relay` são rejeitadas pelo banco (sem privilégio de DDL); só `cf_owner`, via `SET ROLE` do migrador, altera objetos.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Não aplicável: eventos de domínio nascem a partir do mecanismo de outbox (US-082) e do primeiro agregado de negócio (US-001); esta story não produz nenhum. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Não aplicável nesta story. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Persistência com Prisma e concorrência otimista

  Background:
    Given que a migração aplica RLS "ENABLE" e "FORCE" com a política de isolamento por tenant em toda tabela com "tenant_id"
    And existem os papéis "cf_owner", "cf_app", "cf_worker" e "cf_relay"
    And existem os tenants "Prefeitura A" e "Prefeitura B" com dados equivalentes

  Scenario: [Sucesso] Gravação dentro de uma TenantTransaction define o contexto e persiste
    Given que o papel "cf_app" abre uma "TenantTransaction" para o tenant "Prefeitura A"
    When a aplicação insere um registro em "outbox_events" para esse tenant
    Then o registro deve ser gravado com "tenant_id" da "Prefeitura A"
    And a leitura subsequente na mesma transação deve retornar o registro

  Scenario: [Validação] Decimal fora da escala configurada é rejeitado antes do banco
    Given que um campo usa "Decimal(18,2)"
    When a aplicação tentar persistir o valor "10.999" (3 casas)
    Then a camada de mapeamento deve rejeitar ou normalizar conforme DEC-003 antes de qualquer gravação
    And nenhuma linha com escala inválida deve existir no banco

  Scenario: [Permissão] Papel da aplicação não é dono dos objetos
    Given que o papel "cf_app" tenta executar "ALTER TABLE outbox_events DISABLE ROW LEVEL SECURITY"
    Then o banco deve rejeitar por falta de privilégio
    And apenas "cf_owner", via "SET ROLE" do migrador, pode alterar a definição das tabelas

  Scenario: [Tenant incorreto] RLS impede leitura e escrita cruzadas entre tenants
    Given que existem registros em "outbox_events" para "Prefeitura A" e "Prefeitura B"
    When uma "TenantTransaction" define o contexto para "Prefeitura A"
    Then a consulta não deve retornar nenhuma linha de "Prefeitura B"
    And um "INSERT" com "tenant_id" de "Prefeitura B" dentro desse contexto deve violar a política e falhar

  Scenario: [Duplicidade] Reaproveitar a mesma conexão do pool entre tenants não vaza contexto
    Given que a mesma conexão é usada para "Prefeitura A" e, em seguida, para "Prefeitura B"
    When a segunda transação definir "app.tenant_id" para "Prefeitura B"
    Then a leitura deve refletir somente "Prefeitura B"
    And nenhum dado de "Prefeitura A" deve aparecer nesse contexto

  Scenario: [Concorrência] Duas atualizações simultâneas do mesmo agregado
    Given que um registro tem "version" igual a 3
    When dois processos tentarem atualizar simultaneamente com "version" esperado "3"
    Then exatamente uma atualização deve afetar 1 linha e avançar para "version" 4
    And a outra deve afetar 0 linhas e ser tratada como conflito de concorrência

  Scenario: [Falha de banco] PostgreSQL indisponível durante a abertura da TenantTransaction
    Given que o PostgreSQL está indisponível
    When a aplicação tentar abrir uma "TenantTransaction"
    Then a operação deve falhar com erro classificado como transitório
    And nenhuma alteração parcial deve persistir

  Scenario: [Falha de integração] set_config de sessão é bloqueado antes de chegar à produção
    Given que uma migração usa "set_config(..., false)" (escopo de sessão) por engano
    When o lint de SQL do CI analisar a migração
    Then o CI deve falhar apontando o uso proibido de contexto de sessão
    And a migração não deve ser promovida
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento |
|---|---|---|---|---|
| `UPDATE` com `version` divergente | 412 | `VERSION_CONFLICT` | "Este registro foi alterado por outra pessoa." | Tratado pela story de negócio que expõe o recurso (DEC-104); aqui, a camada de repositório apenas detecta e propaga |
| Transação sem contexto de tenant | — (interno) | — | — | Falha fechada: erro de variável inexistente no `current_setting`; nunca retorna dados |
| Banco/pool indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível completar a operação agora. Tente novamente em instantes." | Propagado pelo filtro global (US-080); retry fica a cargo do chamador |
| Tabela nova sem RLS no catálogo | — (build) | — | "Migração bloqueada: tabela sem RLS." | CI falha antes do deploy |
| `set_config` de sessão detectado | — (build) | — | "Migração bloqueada: contexto de sessão proibido." | CI falha antes do deploy |

## Dependências
- **Stories:** US-078 (PostgreSQL local disponível), US-080 (`RequestContext`/`AsyncLocalStorage` fornece o `tenantId` à `TenantTransaction`; filtro de erros mapeia `VERSION_CONFLICT`). US-082 (consome `outbox_events` e os papéis `cf_relay`/`cf_worker`).
- **Decisões/ADRs:** DEC-001, DEC-002, DEC-003, DEC-040, DEC-041, DEC-050, DEC-055, DEC-080, DEC-081, DEC-082, DEC-083, DEC-084; [ADR-002](../adr/adr-002-multi-tenancy.md).
- **Configurações:** nenhuma chave de `TenantSetting` (infraestrutura, não configurável por tenant).
- **Lacunas nas fontes canônicas:** `multi-tenancy.md` exige "lint de SQL" contra `set_config` de sessão sem nomear a ferramenta. Proposta: script dedicado de CI (`scripts/lint-sql.ts`, estágio "Lint" da US-079) que inspeciona migrações e falha a build.

## Impacto técnico
- Estabelece o **padrão de persistência** que toda story de negócio a partir de US-001 reutiliza: `TenantTransaction` → repositórios Prisma → colunas padrão (DEC-083) → RLS (DEC-082) → concorrência otimista (DEC-055).
- Função utilitária de imutabilidade de snapshot (DEC-084, trigger que bloqueia `UPDATE` de colunas de conteúdo) é criada de forma genérica nesta story, mas só é **aplicada** a uma tabela concreta quando a primeira entidade de snapshot (ex.: `DocumentVersion`) for migrada em story futura.
- RLS tem custo de planejamento desprezível quando todo índice de tabela de negócio começa por `tenant_id` (multi-tenancy.md §5.2) — convenção que esta story fixa para todas as migrações seguintes.
- Papéis `cf_relay`/`cf_readonly_report` são criados aqui mas só "ativados" em uso por US-082 e por uma story futura de relatórios, respectivamente — evita retrabalho de migração depois.

## Backend
- **Módulo(s):** `platform` (infraestrutura compartilhada).
- **Casos de uso:** não aplicável (story de infraestrutura, sem comando/consulta de negócio).
- **Domínio:** não aplicável; esta story fica inteiramente em `infrastructure` (extensão Prisma, migrações, papéis).
- **Integrações internas:** consumida por `infrastructure/` de todo módulo de DEC-040.
- **Transação:** `TenantTransaction` (extensão de cliente Prisma) envolve toda operação; passos descritos no fluxo principal.

## Frontend
- **Tela(s):** não aplicável — story de infraestrutura, sem UI.
- **Componentes:** não aplicável.
- **Estados:** não aplicável.
- **Acessibilidade e responsividade:** não aplicável; o contrato de `ETag`/`If-Match` (DEC-104) construído sobre `version` é consumido pelo frontend somente a partir da primeira story de negócio com mutação (US-001).

## Banco de dados
- **Tabelas:** `outbox_events` (entities.md, módulo `platform`) — único DDL concreto desta story, usado como exemplo testável do padrão completo.
- **Migrações:** criação dos papéis (`cf_owner`, `cf_migrator`, `cf_app`, `cf_worker`, `cf_relay`, `cf_readonly_report`) com `GRANT`s mínimos; criação de `outbox_events` com colunas padrão, RLS e índices; função utilitária reaproveitável de imutabilidade de snapshot (DEC-084), sem tabela própria ainda.
- **Índices/constraints relevantes:** `outbox_events (status, occurred_at) WHERE status = 'PENDING'`; `outbox_events (tenant_id, aggregate_type, aggregate_id, occurred_at)`.

## API
Não aplicável como *endpoints de negócio* — nenhum ID do catálogo de `api.md` §3 é criado por esta story. O que ela entrega é o **mecanismo de persistência** usado por todo endpoint futuro: a base de `ETag`/`If-Match` (api.md §1.3/DEC-104, via coluna `version`) e o isolamento por tenant que sustenta as respostas 404/422 `REFERENCE_NOT_FOUND` de outros tenants (api.md §1.5).

## Logs
- `warn` `db.lock_wait` — espera de bloqueio de linha acima de 200 ms (`lockType`, `tableName`, `durationMs`, `correlationId`).
- `info` `db.optimistic_concurrency_conflict` — `aggregateType`, `aggregateId`, `expectedVersion`, `correlationId` (evento esperado do fluxo, não erro).
- `error` `db.tenant_context_missing` — não deveria ocorrer (falha fechada); `correlationId`, sem dados da consulta.
- **Nunca logar:** valores de colunas de negócio, parâmetros de SQL com dados pessoais, strings de conexão/credenciais.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | — | Não aplicável: esta story não grava `AuditLog` de negócio (responsabilidade do módulo `audit`, DEC-040). O isolamento multi-tenant é verificado por testes automatizados ("tenant leak"), não por registro de auditoria. |

## Testes necessários
- **Unitários:** cálculo de conflito de versão (0 linhas afetadas); arredondamento/validação de escala decimal (`decimal.js`).
- **Integração (Testcontainers PostgreSQL):** RLS nega leitura/escrita cruzada entre tenants; contexto ausente falha fechado; reuso de conexão do pool entre dois tenants não vaza `app.tenant_id`; papéis e `GRANT`s conforme RN-FND-46.
- **Concorrência:** duas atualizações simultâneas do mesmo registro com o mesmo `version` esperado — exatamente uma afeta 1 linha.
- **API/contrato:** não aplicável (sem endpoint próprio).
- **RBAC e multi-tenant:** suíte "tenant leak" de multi-tenancy.md §13 aplicada ao `outbox_events`.
- **E2E (Playwright):** não aplicável.
- **Acessibilidade/performance:** plano de execução (`EXPLAIN`) confirma uso de índice `tenant_id`-líder na política de RLS; sem violação de acessibilidade (sem UI).

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (integração) e passando no CI
- [ ] Papéis de banco criados com os privilégios mínimos de RN-FND-46; nenhum deles com DDL sobre as tabelas
- [ ] RLS `ENABLE`+`FORCE`+política aplicada e testada em `outbox_events`
- [ ] `TenantTransaction` adotada como único ponto de acesso ao `PrismaClient` (verificado por lint de arquitetura)
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] Lint de CI bloqueia `set_config` de sessão e tabela sem RLS
- [ ] Logs sem dados sensíveis; métricas de espera de lock presentes
- [ ] Revisão de código e de segurança aprovadas
- [ ] Padrão de persistência documentado para reúso pelos módulos de negócio

## Estimativa
**M** — escopo bem delimitado (schema base, papéis, extensão de transação, uma tabela concreta de exemplo), mas com testes de isolamento multi-tenant que exigem Testcontainers e cenários de concorrência cuidadosos.

## Prioridade
**P0** — toda story de negócio do MVP 1 depende desta fundação para persistir qualquer dado com isolamento e concorrência corretos.
