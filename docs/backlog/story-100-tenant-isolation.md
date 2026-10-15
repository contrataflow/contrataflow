---
id: US-100
title: "Contexto de tenant e isolamento de dados"
epic: EP-017
feature: FT-055
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-080, US-081]
modules: [platform, tenancy, identity, audit]
screens: [SCR-111]
endpoints: []
permissions: []
events: []
---

# US-100 — Contexto de tenant e isolamento de dados

## Título
Garantir contexto de tenant e isolamento de dados em todas as camadas

## Descrição
**Como** time de engenharia e segurança da plataforma, **quero** que toda requisição, transação, consulta, job, chave de cache e objeto de storage execute no contexto de exatamente um tenant e que o banco recuse qualquer acesso cruzado, **para** que nenhum dado de uma instituição contratante seja lido ou alterado por outra — inclusive diante de bugs.

A story implementa as quatro barreiras independentes de isolamento (architecture.md, princípio P3): (1) **contexto obrigatório** na aplicação — `TenantContext` em AsyncLocalStorage, aberto pelo guard da API e pela base de jobs; (2) **Prisma Client Extension** que injeta e verifica `tenantId` e bloqueia consultas sem contexto; (3) **RLS** `ENABLE` + `FORCE` em todas as tabelas com `tenant_id`, com `set_config('app.tenant_id', …, true)` por transação e papel de aplicação sem `BYPASSRLS`; (4) **FKs compostas** `(tenant_id, id)`. Completam o pacote: helpers de chave de cache e de storage, contexto em jobs, `tenantId` em logs e traces, leituras cross-tenant controladas, a suíte automatizada **"tenant leak"**, testes diretos de RLS e o runbook de suspeita de vazamento.

## Contexto
- DEC-080 a DEC-083 (coluna `tenant_id`, FKs compostas, RLS, colunas padrão), DEC-132 (contexto de requisição e acesso por status do tenant), DEC-164 (contexto em jobs), DEC-105 (idempotência com escopo de tenant), DEC-139 (operadores sem acesso a dados); ADR-002.
- Riscos tratados (risks-and-decisions §4): RM-01 (consulta sem filtro), RM-02 (contexto vazando no pool), RM-03 (cache sem tenant), RM-04 (storage), RM-05 (jobs sem contexto); RT-02 (sobrecarga e compatibilidade com pooler — spike da Sprint 0).
- Princípio 10 do produto ("isolamento total entre tenants") e KPI C5 = 0 incidentes de isolamento; RSK-06 tem impacto crítico.
- Está no caminho crítico do MVP 1 (sprint 2): todas as stories de negócio dependem desta fundação.

## Objetivo
- 100% das tabelas com `tenant_id` com RLS `ENABLE` + `FORCE` + política, verificado por meta-teste no CI.
- 100% das operações da OpenAPI classificadas na suíte "tenant leak", com zero achados.
- Zero acesso a modelos de tenant fora de contexto (falha fechada) e zero chaves de cache/storage sem tenant.
- Sobrecarga do contexto (`set_config` + verificações) ≤ 2 ms p95 por transação.

## Persona
- **Principal:** Time de engenharia — toda story de negócio usa a fundação sem precisar "lembrar" de filtrar por tenant.
- **Secundárias:** Segurança/SRE (alertas e runbook); Consultoria externa (P15 — vínculos em vários tenants, "nunca confundir"); Controle Interno e Auditor (evidências de isolamento); indiretamente, todos os usuários.

## Pré-condições
- US-080 (API modular com guards, interceptors e AsyncLocalStorage base) e US-081 (Prisma, migrações versionadas, coluna `version`).
- Papéis de banco criados por IaC (Terraform) em todos os ambientes, com credenciais por papel no Secrets Manager.
- Validação de JWT disponível (US-087) ou tokens de teste emitidos pela fixture de autenticação.

## Fluxo principal
1. O BFF encaminha a requisição com `Authorization`, `X-Tenant-Id` (tenant ativo da sessão) e `X-Correlation-Id`.
2. O `AuthGuard` valida o JWT e resolve o `User`.
3. O `TenantContextGuard` valida `X-Tenant-Id` (UUID) e consulta o vínculo `(userId, tenantId)` em uma `TenantTransaction` curta desse tenant: vínculo ausente, não `ACTIVE` ou expirado → 403 `MEMBERSHIP_INACTIVE` (mesma resposta para tenant inexistente).
4. Com vínculo válido, lê o status no `TenantStatusCache` e aplica a matriz de acesso por status (RN-TEN-10, US-099): bloqueio → 403 `TENANT_SUSPENDED`; `OFFBOARDING` com `ADMIN_ORGAO`/`AUDITOR` → `accessMode = READ_EXPORT`.
5. Abre `TenantContext.run({ tenantId, userId, membershipId, actorType: 'USER', correlationId, requestId, ip, userAgent, accessMode })`.
6. Os casos de uso acessam dados apenas pelo `TenantPrismaService`: comandos em `TenantTransaction` interativa (unidade de trabalho); leituras avulsas em transação curta em lote — em ambos, o primeiro comando é `SELECT set_config('app.tenant_id', $1, true)`.
7. A extensão do Prisma injeta `tenantId` nas criações e o acrescenta ao filtro de leituras, atualizações e exclusões; qualquer divergência lança `TenantIsolationViolation`.
8. O PostgreSQL aplica RLS (`USING` e `WITH CHECK`) a cada linha; as FKs compostas rejeitam referência cruzada.
9. Auditoria e outbox herdam `tenantId` do contexto; cache via `TenantCache`; storage via `StorageKeyBuilder`; jobs enfileirados com `TenantJobData`.
10. Logs e spans recebem `tenantId`, `userId`, `membershipId` e `correlationId`; o contexto é descartado ao fim da requisição.

## Fluxos alternativos
- **FA-01 — Rotas sem contexto de tenant:** toda rota declara `@TenantScope('TENANT' | 'PLATFORM' | 'NONE' | 'CROSS_TENANT_LOOKUP')`. `NONE`: `/health/*`, `/metrics`. `PLATFORM`: `/platform/*` (US-099). `CROSS_TENANT_LOOKUP`: `ME-04` (vínculos do usuário em todos os tenants — US-093) e `USR-06` (aceite de convite por token — US-091). Rota sem declaração falha o build (meta-teste).
- **FA-02 — Operação de plataforma sobre um tenant:** `TenantTransaction.run({ tenantId: alvo, actor: PLATFORM_OPERATOR })`, permitido apenas a casos de uso `PLATFORM` (provisionamento — US-099).
- **FA-03 — Jobs:** o worker restaura o contexto a partir de `TenantJobData` antes do handler (classe base `TenantJob`); jobs de plataforma que precisam percorrer tenants enumeram tenants `ACTIVE` pelo `SystemDbService` e enfileiram um job por tenant; tenant fora de `ACTIVE` → job concluído sem efeito (RN-TEN-12).
- **FA-04 — SQL bruto:** só por `tx.$queryRaw` dentro de `TenantTransaction` (a extensão bloqueia fora dela); continua sob RLS e passa por revisão obrigatória no PR.
- **FA-05 — Leituras cross-tenant controladas:** funções `SECURITY DEFINER` com colunas mínimas — `cf_user_memberships(user_id)` (ME-04 e login no BFF), `cf_find_invitation(token_hash)` (USR-06) — invocadas só pelo `SystemDbService`; e `cf_set_primary_organization(org_id)`, que atualiza `tenants.primary_organization_id` apenas do tenant de `app.tenant_id` (US-099/US-101).
- **FA-06 — Violação detectada:** `TenantIsolationViolation` ou `TenantContextMissing` abortam a transação; cliente recebe 500 `INTERNAL_ERROR` sem detalhes; log `error`, métrica e alerta de severidade S1 acionam o runbook.
- **FA-07 — Troca de instituição no front (US-093):** limpa caches do TanStack Query e estado local; todas as chaves começam por `tenantId`.
- **FA-08 — Modo leitura e exportação (`OFFBOARDING`):** com `accessMode = READ_EXPORT`, métodos mutáveis não marcados com `@OffboardingExport()` respondem 403 `TENANT_SUSPENDED`.

## Regras de negócio
- **RN-TEN-19** — Rota `TENANT` exige `X-Tenant-Id` em formato UUID; ausente ou malformado → 400 `MALFORMED_REQUEST`. Toda rota declara `@TenantScope` (meta-teste).
- **RN-TEN-20** — O guard verifica o vínculo **antes** do status do tenant; tenant inexistente e tenant sem vínculo produzem a mesma resposta (403 `MEMBERSHIP_INACTIVE`), sem revelar existência ou situação.
- **RN-TEN-21** — O contexto é imutável durante a requisição ou job; abrir `TenantTransaction` para outro tenant dentro de contexto `TENANT` é erro de programação. Só casos de uso `PLATFORM` abrem transações para um tenant alvo.
- **RN-TEN-22** — `set_config('app.tenant_id', <id>, true)` é sempre o primeiro comando da transação; `SET` de sessão e `set_config(…, false)` são proibidos (lint + teste). Compatível com pooler em modo transação (RDS Proxy/PgBouncer).
- **RN-TEN-23** — Extensão do Prisma, para modelos da lista `TENANT_SCOPED_MODELS`: `create`, `createMany` e `upsert` recebem `tenantId` do contexto (valor diferente informado → violação); `findUnique`, `findFirst`, `findMany`, `count`, `aggregate`, `groupBy`, `update`, `updateMany`, `delete` e `deleteMany` recebem `tenantId` no `where`; operação sem contexto → `TenantContextMissing`.
- **RN-TEN-24** — `TENANT_SCOPED_MODELS` é gerada do schema Prisma (modelos com campo `tenantId`) a cada `prisma generate`; diferença não versionada falha o CI. Modelos de plataforma (`Tenant`, `User`, `Permission`) ficam fora da lista e só são acessados por serviços autorizados.
- **RN-TEN-25** — Toda tabela com `tenant_id` tem `ENABLE` e `FORCE ROW LEVEL SECURITY` e a política `tenant_isolation` (`USING` e `WITH CHECK` `tenant_id = current_setting('app.tenant_id')::uuid`) para `cf_app`. Sem contexto definido a consulta **falha com erro** — nunca devolve dados.
- **RN-TEN-26** — Papéis de banco: `cf_app` (API e worker) não é dono das tabelas e não tem `BYPASSRLS`; `cf_relay` tem `BYPASSRLS` e privilégios só de `SELECT`/`UPDATE` em `outbox_events`; `cf_migrator` é o dono do schema e só roda no pipeline de migração; `cf_platform` (sem `BYPASSRLS`) atende o `SystemDbService`; `cf_definer` (`NOLOGIN`) é dono das funções `SECURITY DEFINER`.
- **RN-TEN-27** — Toda tabela de negócio tem `UNIQUE (tenant_id, id)` e toda FK entre tabelas de negócio é composta `(tenant_id, <fk>)` (DEC-081); verificado por meta-teste em `pg_constraint`.
- **RN-TEN-28** — `SystemDbService` (`systemPrisma`) é a única via para escrever em `tenants`, gravar auditoria de plataforma, gravar outbox do agregado `Tenant` e chamar as funções cross-tenant; exige `reason` de uma lista fechada (`TENANT_LIFECYCLE`, `TENANT_PROVISIONING`, `TENANT_ENUMERATION`, `USER_MEMBERSHIPS_LOOKUP`, `INVITATION_LOOKUP`, `PLATFORM_AUDIT`); só pode ser importado pelos módulos autorizados (dependency-cruiser); toda chamada gera log e métrica, e toda escrita gera auditoria.
- **RN-TEN-29** — Cache: chaves `cf:{env}:t:{tenantId}:<módulo>:<chave>` pelo `TenantCache`; chaves de plataforma `cf:{env}:p:<chave>` pelo `PlatformCache`; o cliente Redis não pode ser usado diretamente fora de `platform` (lint). Idempotência (DEC-105) e rate limit (api.md §1.6) incluem `tenantId` na chave.
- **RN-TEN-30** — Storage: chaves `tenants/{tenantId}/…` geradas só pelo `StorageKeyBuilder`; o `StorageService` recusa chave fora do tenant do contexto (storage.md §2).
- **RN-TEN-31** — Todo job de fila de tenant carrega `TenantJobData` (`tenantId`, `actor`, `correlationId`, `traceparent`); enfileirar sem `tenantId` em fila de tenant é erro na origem; apenas filas marcadas como de plataforma aceitam jobs sem tenant (DEC-164).
- **RN-TEN-32** — Recurso de outro tenant: ID no caminho → 404 `<RESOURCE>_NOT_FOUND`; ID referenciado no corpo → 422 `VALIDATION_ERROR` com `REFERENCE_NOT_FOUND`; nunca 403, 409 ou 500 que revelem existência (api.md §1.5).
- **RN-TEN-33** — Violação de FK composta (SQLSTATE 23503) que chegue ao banco é traduzida para 422 `REFERENCE_NOT_FOUND`; escrita barrada por RLS (42501) é erro de programação → 500 + alerta.
- **RN-TEN-34** — Todo log e span de rota `TENANT` ou job carrega `tenantId`; mensagens de erro ao cliente nunca citam IDs ou nomes de outro tenant.
- **RN-TEN-35** — Frontend: chaves do TanStack Query começam por `['t', tenantId, …]`; `sessionStorage` e IndexedDB usam `cf:{tenantId}:{userId}:…`; a troca de instituição limpa caches e estado local.
- **RN-TEN-36** — Toda operação da OpenAPI é classificada na suíte "tenant leak" (coberta, ou isenta com motivo); rota nova sem classificação falha o build.
- **RN-TEN-37** — Em `OFFBOARDING` são permitidos todos os `GET` e as rotas marcadas `@OffboardingExport()` — no MVP 1: DOC-20, DOC-21, DOC-23, ATT-05, AUD-03, PRS-22 e PRC-34.

## Campos
| Elemento | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Tenant ativo da requisição | `X-Tenant-Id` | uuid | Sim (rotas `TENANT`) | RN-TEN-19 | BFF, a partir da sessão |
| Contexto — tenant | `TenantContext.tenantId` | uuid | Sim | Imutável (RN-TEN-21) | Guard, job ou caso de uso de plataforma |
| Contexto — usuário e vínculo | `userId`, `membershipId` | uuid | Sim para `USER` | — | JWT + vínculo |
| Contexto — ator | `actorType` | `ActorType` | Sim | `USER`, `SYSTEM`, `PLATFORM_OPERATOR` | — |
| Contexto — correlação | `correlationId`, `requestId`, `traceparent` | texto | Sim | ≤ 64 caracteres | BFF/OpenTelemetry |
| Contexto — origem | `ip`, `userAgent` | inet / texto | Não | IP do `X-Forwarded-For` confiável | BFF |
| Contexto — modo | `accessMode` | `FULL` \| `READ_EXPORT` | Sim | RN-TEN-37 | Status do tenant |
| Variável de banco | `app.tenant_id` | texto (uuid) | Sim por transação | Local à transação | `TenantTransaction` |
| Dados do job | `TenantJobData.{tenantId, actor, correlationId, traceparent}` | objeto | Sim | DEC-164 | Quem enfileira |
| Chave de cache | `cf:{env}:t:{tenantId}:…` | texto | — | RN-TEN-29 | `TenantCache` |
| Chave de storage | `tenants/{tenantId}/…` | texto | — | RN-TEN-30 | `StorageKeyBuilder` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `X-Tenant-Id` ausente ou malformado | API (guard) | "Não foi possível identificar a instituição ativa. Entre novamente." | `MALFORMED_REQUEST` (400) |
| V-02 | Sem vínculo ativo, vínculo expirado ou tenant inexistente | API (guard) | "Você não tem acesso ativo a esta instituição." | `MEMBERSHIP_INACTIVE` |
| V-03 | Tenant fora de `ACTIVE` ou comando em `OFFBOARDING` | API (guard) | "O acesso a esta instituição está indisponível no momento." | `TENANT_SUSPENDED` |
| V-04 | ID de outro tenant no caminho | Extensão + RLS | "{Recurso} não encontrado." | `<RESOURCE>_NOT_FOUND` (404) |
| V-05 | ID de outro tenant no corpo | Validação + FK composta | "Selecione um {campo} válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-06 | Operação em modelo de tenant sem contexto | Extensão | Mensagem genérica com correlationId | `INTERNAL_ERROR` (500) + alerta |
| V-07 | `tenantId` divergente nos dados ou escrita barrada por RLS | Extensão / banco | Mensagem genérica com correlationId | `INTERNAL_ERROR` (500) + alerta |
| V-08 | Chave de storage ou de cache fora do tenant | `StorageService` / `TenantCache` | Mensagem genérica com correlationId | `INTERNAL_ERROR` (500) + alerta |
| V-09 | Job sem `tenantId` em fila de tenant | Produtor / worker | — | Rejeitado na origem; alerta |

## Permissões
- **Permissão:** nenhuma permissão própria; esta story fornece o contexto sobre o qual US-097 avalia permissões e escopos.
- **Políticas:** RN-TEN-20 (vínculo antes do status) e matriz de status de DEC-132; rotas `PLATFORM` exigem `isPlatformOperator` + MFA (US-099).
- **MFA:** inalterado (DEC-133).
- **Sem acesso:** 403 `MEMBERSHIP_INACTIVE` ou `TENANT_SUSPENDED`; a UI exibe SCR-111 com a opção "Trocar de instituição".

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Não produz eventos. Consome `TenantActivated` e `TenantSuspended` (US-099) para invalidar o `TenantStatusCache`. Todo evento do outbox recebe `tenantId` do contexto. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação de produto. Violações geram **alerta operacional** (plantão de SRE/segurança), não notificação ao usuário. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Contexto de tenant e isolamento de dados

  Background:
    Given que existem os tenants "Prefeitura A" e "Prefeitura B", provisionados com dados de teste marcados "LEAK-A" e "LEAK-B"
    And "Bruno" tem vínculo ativo apenas na "Prefeitura A" com o perfil "GESTOR_CONTRATACOES" no escopo "TENANT"
    And "Carla" (consultora) tem vínculos ativos nas duas prefeituras

  Scenario: [Sucesso] Requisição executa no contexto do tenant ativo
    When "Bruno" listar processos com "X-Tenant-Id" da "Prefeitura A"
    Then a transação deve executar "set_config('app.tenant_id', <A>, true)" antes de qualquer consulta
    And a resposta deve conter somente registros marcados "LEAK-A"
    And os logs e spans da requisição devem conter o "tenantId" da "Prefeitura A"

  Scenario: [Sucesso] Job restaura o contexto do tenant de origem
    Given um job "notifications" enfileirado com "tenantId" da "Prefeitura B"
    When o worker processar o job
    Then o handler deve executar com "app.tenant_id" da "Prefeitura B" e com o "correlationId" da origem

  Scenario: [Validação] Cabeçalho de tenant ausente ou malformado
    When "Bruno" chamar "/api/v1/processes" sem "X-Tenant-Id"
    Then a API deve responder 400 com código "MALFORMED_REQUEST"
    When "Bruno" chamar com "X-Tenant-Id" igual a "abc"
    Then a API deve responder 400 com código "MALFORMED_REQUEST"

  Scenario: [Validação] Consulta sem contexto é bloqueada antes do banco
    Given um serviço que consulta "Process" fora de requisição ou job
    When a consulta for executada
    Then deve ser lançado "TenantContextMissing" sem nenhum comando enviado ao banco
    And deve ser registrado log "error" "security.tenant_context_missing" com a métrica correspondente

  Scenario: [Permissão] Vínculo inexistente e tenant inexistente respondem igual
    When "Bruno" enviar "X-Tenant-Id" da "Prefeitura B"
    Then a API deve responder 403 com código "MEMBERSHIP_INACTIVE"
    When "Bruno" enviar "X-Tenant-Id" de um UUID que não corresponde a nenhum tenant
    Then a resposta deve ser idêntica, exceto pelo "correlationId"

  Scenario: [Permissão] Papel da aplicação não contorna RLS
    When o teste de banco inspecionar os papéis
    Then "cf_app" deve ter "rolbypassrls" falso e não ser dono de nenhuma tabela
    And "cf_relay" deve ter privilégios apenas em "outbox_events"
    And "cf_platform" não deve conseguir ler nenhuma tabela de negócio

  Scenario: [Tenant incorreto] IDs de outro tenant no caminho e no corpo
    Given o processo "P-B" da "Prefeitura B"
    When "Bruno" enviar GET "/api/v1/processes/{P-B}"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"
    When "Bruno" criar um processo com "requestingDepartmentId" de uma unidade da "Prefeitura B"
    Then a API deve responder 422 com "REFERENCE_NOT_FOUND" no campo "requestingDepartmentId"

  Scenario: [Tenant incorreto] RLS bloqueia acesso direto mesmo com bug na aplicação
    Given uma transação como "cf_app" com "app.tenant_id" da "Prefeitura A"
    When executar "SELECT" sem filtro em "processes"
    Then devem retornar somente linhas da "Prefeitura A"
    When executar "INSERT" em "processes" com "tenant_id" da "Prefeitura B"
    Then o banco deve recusar com "new row violates row-level security policy"
    When executar "UPDATE" e "DELETE" sobre linhas da "Prefeitura B"
    Then nenhuma linha deve ser afetada

  Scenario: [Tenant incorreto] Suíte "tenant leak" cobre todas as rotas
    When a suíte percorrer todas as operações da OpenAPI como usuário da "Prefeitura A" usando IDs da "Prefeitura B"
    Then cada operação deve responder 404 para IDs no caminho ou 422 "REFERENCE_NOT_FOUND" para IDs no corpo
    And nenhuma resposta deve conter "LEAK-B" nem IDs da "Prefeitura B"
    And o retrato das tabelas da "Prefeitura B" deve ser idêntico antes e depois da suíte

  Scenario: [Duplicidade] Chave de idempotência não atravessa tenants
    Given que "Carla" criou um comentário na "Prefeitura A" com a chave "K9"
    When "Carla" enviar uma criação na "Prefeitura B" com a mesma chave "K9"
    Then a requisição deve ser executada na "Prefeitura B" sem reproduzir a resposta da "Prefeitura A"

  Scenario: [Concorrência] Contexto não vaza entre transações no pool
    Given um pool com 2 conexões em modo transação
    When 500 requisições alternarem entre "Prefeitura A" e "Prefeitura B" em paralelo
    Then cada resposta deve conter somente dados do próprio tenant
    And nenhuma conexão devolvida ao pool deve manter "app.tenant_id" definido fora de transação

  Scenario: [Falha de banco] Falha ao definir o contexto aborta a transação
    Given que a conexão cai ao executar "set_config"
    When "Bruno" enviar um comando
    Then nenhuma consulta de negócio deve ser executada
    And a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"

  Scenario: [Falha de integração] Redis indisponível não derruba a verificação de status
    Given que o Redis está indisponível
    When "Bruno" enviar uma requisição à "Prefeitura A"
    Then o status do tenant deve ser lido do banco e a requisição atendida
    And deve ser registrado log "warn" "tenant.status_cache_unavailable"

  Scenario: [Falha de integração] Chave de storage de outro tenant é recusada
    When um serviço em contexto da "Prefeitura A" pedir URL de download de "tenants/<B>/processes/…"
    Then o "StorageService" deve lançar "TenantIsolationViolation" sem assinar a URL
    And deve ser disparado alerta de segurança com o correlationId
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| `X-Tenant-Id` ausente/malformado | 400 | `MALFORMED_REQUEST` | "Não foi possível identificar a instituição ativa. Entre novamente." | BFF refaz a seleção de instituição (SCR-101) |
| Sem vínculo ativo | 403 | `MEMBERSHIP_INACTIVE` | "Você não tem acesso ativo a esta instituição." | SCR-111 com "Trocar de instituição" |
| Tenant fora de `ACTIVE` / comando em `OFFBOARDING` | 403 | `TENANT_SUSPENDED` | "O acesso a esta instituição está indisponível no momento." | SCR-111 ou faixa de encerramento |
| Recurso de outro tenant | 404 | `<RESOURCE>_NOT_FOUND` | "{Recurso} não encontrado." | Página 404 (SCR-111) |
| Referência de outro tenant no corpo | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Selecione um {campo} válido." | Erro no campo |
| Violação de isolamento detectada | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Exibe o código; nada é gravado |
| Banco/Redis crítico indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Serviço indisponível no momento. Tente novamente em instantes." | Botão "Tentar novamente" (respeita `Retry-After`) |

## Dependências
- **Stories:** US-080, US-081 (base). Relacionadas: US-084 (enriquecimento de logs e traces), US-087 (JWT), US-093 (troca de instituição), US-099 (status do tenant e fixtures de dois tenants), US-068 (`StorageService`), US-083 (base de jobs), US-097 (autorização sobre o contexto). Habilita todas as stories com dados de tenant.
- **Decisões/ADRs:** DEC-080, DEC-081, DEC-082, DEC-083, DEC-105, DEC-132, DEC-138, DEC-139, DEC-161, DEC-164; ADR-002.
- **Configurações:** nenhuma.
- **Lacunas nas fontes canônicas:** (1) só `cf_relay` é nome canônico; `cf_app` (papel da aplicação), `cf_migrator`, `cf_platform`, `cf_definer` e as funções `cf_apply_tenant_rls`, `cf_user_memberships`, `cf_find_invitation`, `cf_set_primary_organization` são **propostas** a registrar em ADR-002/decisions.md; (2) as leituras cross-tenant de ME-04 e USR-06 não estão descritas nas fontes — adotadas funções `SECURITY DEFINER`; (3) políticas de `audit_logs` e `outbox_events` para `cf_platform` (inserir registros de plataforma e do agregado `Tenant`) a registrar em entities.md; (4) a lista de rotas de exportação permitidas em `OFFBOARDING` (RN-TEN-37) deve constar em api.md; (5) 400 `MALFORMED_REQUEST` para `X-Tenant-Id` ausente não está explícito em api.md; (6) `multi-tenancy.md`, `security.md` e ADR-002 ainda não existem (architecture.md já referencia `multi-tenancy.md#14-testes-de-isolamento`).

## Impacto técnico
- **Padrão obrigatório** para todas as stories: repositórios só via `TenantPrismaService`; nenhuma consulta a modelo de tenant fora de contexto; SQL bruto só dentro de `TenantTransaction`.
- **Limitações do Prisma tratadas:** escritas aninhadas usam escalares compostos (`tenantId` + FK) em vez de `connect` cruzado; `findUnique` aceita `tenantId` adicional (filtro estendido); RLS é a rede de proteção do que a extensão não alcança.
- **Pooler:** `set_config(…, true)` é local à transação; validado com RDS Proxy/PgBouncer em modo transação (spike RT-02); leituras avulsas em lote `$transaction([set_config, query])`.
- **Desempenho:** custo extra estimado < 1 ms por transação; índices iniciados por `tenant_id` (entities.md) mantêm o plano de execução com RLS.
- **Tabela particionada `audit_logs`:** RLS no pai; acesso direto às partições negado a `cf_app`.
- **Runbook "Suspeita de vazamento entre tenants" (entregável):** (1) abrir incidente S1 (resposta em 1 h, contorno em 4 h — product-overview §11.4); (2) conter: bloquear a rota/funcionalidade afetada por *deploy* de bloqueio e, se necessário, suspender os tenants envolvidos (PLT-05); (3) preservar evidências: logs, traces, auditoria selada e `correlationId`s; (4) delimitar o escopo por `tenantId`, rota, período e registros expostos; (5) corrigir e provar com caso reproduzido na suíte "tenant leak"; (6) como operadora (LGPD), comunicar imediatamente as instituições afetadas (controladoras) e apoiá-las na comunicação à ANPD e aos titulares (Resolução CD/ANPD nº 15/2024 — prazo de 3 dias úteis para o controlador); (7) *postmortem* sem culpados com ações preventivas.

## Backend
- **Módulos:** `platform` (persistência: `TenantPrismaService`, extensão `tenantIsolationExtension`, `TenantTransaction`, `SystemDbService`, `TenantCache`, `PlatformCache`, `StorageKeyBuilder`; worker: classe base `TenantJob`), `tenancy` (`TenantContextGuard`, `TenantContextService`, `TenantStatusCache`, decorators `@TenantScope` e `@OffboardingExport`), `identity` (consulta de vínculo do guard), `audit` (auditoria de negação).
- **Transação** (ilustrativo):
  ```ts
  await tenantTx.run(async (tx) => {
    // 1º comando executado pelo wrapper: SELECT set_config('app.tenant_id', $tenantId, true)
    await processRepository.create(tx, data);   // tenantId injetado pela extensão
  });
  ```
- **Contexto:** `TenantContext` (AsyncLocalStorage) com `getOrThrow()`; `TenantContextService.current()` lê o próprio tenant (colunas não sensíveis) com cache de 30 s.
- **Status do tenant:** `TenantStatusCache` (TTL 30 s, chave `cf:{env}:p:tenant-status:{tenantId}`) invalidado por `TenantActivated`/`TenantSuspended` e por remoção direta após mudanças da plataforma; Redis indisponível → leitura no banco.
- **Integração com idempotência e rate limit:** chaves com `tenantId` (RN-TEN-29).
- **Tradução de erros:** 23503 → `REFERENCE_NOT_FOUND`; 42501 e violações da extensão → `INTERNAL_ERROR` + alerta; erro de conexão → `DEPENDENCY_UNAVAILABLE`.

## Frontend
- **Tela(s):** SCR-111 (variantes "Sem acesso a esta instituição" e "Acesso indisponível"), com "Trocar de instituição" (SCR-101) quando houver outros vínculos.
- **Cliente de API (US-086):** trata globalmente 403 `MEMBERSHIP_INACTIVE`/`TENANT_SUSPENDED` (redireciona a SCR-111) e 400 de tenant ausente (refaz a seleção).
- **Isolamento no navegador:** RN-TEN-35; ao trocar de instituição, `queryClient.clear()`, descarte de rascunhos locais de outro tenant e recarga do shell (identidade visual via SET-03).
- **Acessibilidade:** páginas de erro com título, explicação e ação primária focável; anúncio por `aria-live`.

## Banco de dados
- **Já entregue pela US-087 (2026-10-14 · DEC-070):** tabela `tenants` (entities.md §4.1, sem a FK de `primary_organization_id`, que vem com organizations), papel `cf_definer` e a função `cf_user_memberships` (só responde ao `app.user_id` da transação; `EXECUTE` para `cf_app`/`cf_worker`), além do `PlatformTransaction` para leituras de plataforma da identidade. Esta story não as recria: acrescenta o restante abaixo e pode mover `cf_user_memberships` para o `SystemDbService`.
- **Migração `tenancy_foundation`:** tabela `tenants` (entities.md §4.1 — já criada pela US-087); funções `cf_apply_tenant_rls(regclass)` (ENABLE + FORCE + política `tenant_isolation` para `cf_app`), `cf_user_memberships`, `cf_find_invitation`, `cf_set_primary_organization` (donas: `cf_definer`, `SET search_path = pg_catalog, public`); `GRANT`s por papel; `cf_app` com `SELECT` apenas nas colunas não sensíveis de `tenants`.
- **Política padrão** (aplicada por `cf_apply_tenant_rls` em toda tabela nova):
  ```sql
  CREATE POLICY tenant_isolation ON processes TO cf_app
    USING (tenant_id = current_setting('app.tenant_id')::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  ```
- **Meta-verificação no CI** (deve retornar zero linhas): tabelas com coluna `tenant_id` em que `NOT relrowsecurity OR NOT relforcerowsecurity` ou sem política em `pg_policy`; FKs entre tabelas com `tenant_id` sem `tenant_id` como primeira coluna.
- **Auditoria e outbox:** políticas adicionais para `cf_platform` — `INSERT` de registros de plataforma (`tenant_id` nulo ou `actor_type = 'PLATFORM_OPERATOR'`) e `SELECT` apenas desses registros; `INSERT` em `outbox_events` restrito a `aggregate_type = 'Tenant'`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| Todas `TENANT` | * | `/api/v1/*` | `X-Tenant-Id` obrigatório | Dados apenas do tenant do contexto | 400, 403 (`MEMBERSHIP_INACTIVE`, `TENANT_SUSPENDED`), 404, 422 |
| ME-04, USR-06 | GET / POST | `/me/memberships`, `/invitations/accept` | Sem `X-Tenant-Id` | Leitura cross-tenant controlada (FA-05) | 200, 401, 404, 410 |
| PLT-01..05 | * | `/api/v1/platform/*` | Sem `X-Tenant-Id` | Contexto de plataforma (US-099) | 403 sem operador/MFA |
| HLT-01..03 | GET | `/health/*`, `/metrics` | — | Sem contexto | 200, 503 |

## Logs
- `info` `tenant.context_opened` (nível `debug` em produção) — `tenantId`, `userId`, `route`, `accessMode`.
- `warn` `tenant.access_denied` — `reason` (`MEMBERSHIP_INACTIVE`, `TENANT_SUSPENDED`), `userId`, `route` (sem o tenant solicitado quando o usuário não tem vínculo).
- `warn` `tenant.status_cache_unavailable` — fallback para o banco.
- `error` `security.tenant_context_missing` / `security.tenant_isolation_violation` — `barrier` (`prisma_extension`, `rls`, `storage`, `cache`, `job`), `model`/`operation`, `correlationId`.
- `info` `system_db.call` — `reason`, `caller`, `durationMs`.
- Métricas: `cf_tenant_isolation_violations_total{barrier}`, `cf_tenant_context_missing_total`, `cf_system_db_calls_total{reason}`, `cf_tenant_context_overhead_seconds`.
- **Nunca logar:** IDs, nomes ou dados de outro tenant em mensagens destinadas ao cliente; valores de `X-Tenant-Id` de quem não tem vínculo em logs acessíveis a tenants.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `access.denied` | `ACCESS` | Vínculo válido e tenant fora de `ACTIVE` ou comando em `OFFBOARDING` (amostragem de 1 por usuário/rota/minuto — permissions.md §1.2) | `reasonCode = TENANT_SUSPENDED`, rota, `accessMode` |
| `access.denied` | `ACCESS` | `X-Tenant-Id` sem vínculo — gravado na **auditoria de plataforma** (`tenantId` nulo), sem confirmar ao tenant a tentativa | `reasonCode = MEMBERSHIP_INACTIVE`, `metadata.requestedTenantId` |

Violações de isolamento não são "negações": geram log de segurança, alerta S1 e registro de incidente.

## Testes necessários
- **Unitários:** extensão do Prisma (cada operação com e sem contexto; `tenantId` divergente; `createMany`; `upsert`); `TenantContext` (imutabilidade, aninhamento proibido); `TenantCache` e `StorageKeyBuilder`; tradução de SQLSTATE.
- **Integração (Testcontainers com os papéis reais):** RLS por tabela (enumeradas de `information_schema`) — `SELECT`, `UPDATE`, `DELETE` e `INSERT` cruzados como `cf_app`; consulta sem `set_config` falha; FKs compostas rejeitam referência cruzada; `cf_relay` e `cf_platform` restritos; funções `SECURITY DEFINER` retornam só as colunas previstas.
- **Suíte "tenant leak":** dois tenants provisionados (US-099) com marcadores `LEAK-A`/`LEAK-B`; mapa de parâmetros da OpenAPI (`{id}`, `processId`, `documentId`, `versionId`, `renditionId`, `itemId`…) para fixtures; para cada operação: IDs de B no caminho → 404; IDs de B no corpo → 422 `REFERENCE_NOT_FOUND`; varredura profunda das respostas por `LEAK-B` e IDs de B; retrato (contagem e `max(updated_at)`) das tabelas de B antes/depois; meta-teste de classificação de rotas.
- **Concorrência:** pool de 2 conexões, 500 requisições alternando tenants; jobs de tenants diferentes no mesmo worker.
- **Meta-testes de CI:** RLS e FKs (SQL acima), `@TenantScope` em todas as rotas, lint de Redis direto e de `set_config` de sessão, dependency-cruiser para `SystemDbService`.
- **Resiliência:** Redis fora (fallback de status), queda de conexão no `set_config`.
- **Performance:** benchmark do *overhead* por transação (p95 ≤ 2 ms) e k6 de leitura com RLS ativo.

## Definition of Done
- [ ] Quatro barreiras implementadas e cobertas por testes automatizados
- [ ] Suíte "tenant leak" no CI cobrindo 100% das operações classificadas, sem achados
- [ ] Meta-testes de RLS, FKs compostas e classificação de rotas bloqueando o *merge*
- [ ] Papéis e *grants* versionados (IaC + migração) e revisados por segurança
- [ ] Logs e traces com `tenantId`; métricas e alertas de violação ativos
- [ ] Runbook de suspeita de vazamento publicado e ensaiado (exercício de mesa)
- [ ] Guia "Como acessar dados" para desenvolvedores (contexto, transação, SQL bruto, jobs, cache, storage)
- [ ] Revisão de código e de segurança aprovadas; ADR-002 atualizado com as propostas desta story

## Estimativa
**L** — fundação transversal com quatro barreiras, papéis e políticas de banco, extensão do Prisma, base de jobs, helpers, suíte automatizada sobre toda a OpenAPI e runbook; risco técnico relevante (RT-02) mitigado pelo spike da Sprint 0.

## Prioridade
**P0** — caminho crítico do MVP 1: nenhuma story com dados de tenant pode ir a produção sem isolamento comprovado (C5 = 0).
