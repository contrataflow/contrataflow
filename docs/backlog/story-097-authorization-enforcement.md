---
id: US-097
title: "Autorização na API e no frontend"
epic: EP-016
feature: FT-053
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-094, US-096, US-100]
modules: [access, platform]
screens: []            # mecanismo transversal; hooks consumidos por todas as telas
endpoints: [ME-03]
permissions: []        # motor que aplica todo o catálogo (permissions.md §2); não é gated por uma única permissão
events: []              # não gera evento próprio; consome eventos de outros módulos para invalidar cache
---

# US-097 — Autorização na API e no frontend

## Título
Autorização na API e no frontend

## Descrição
**Como** plataforma, **quero** um mecanismo único que decida, em toda rota mutável e em toda listagem, se o vínculo autenticado pode realizar a ação — combinando permissão por perfil/escopo, participação no processo e políticas contextuais — **para** que nenhuma regra de acesso dependa de verificação espalhada pelo código ou do cliente, e para que o frontend saiba o que mostrar sem duplicar a lógica de autorização.

Esta story entrega o `AuthorizationService` (decorators `@RequirePermission`/`@Policy`), o cálculo e cache de `EffectivePermissions`, o predicado de visibilidade de processos (DEC-024) reutilizável, o endpoint `GET /me/permissions` (`ME-03`) e os hooks de frontend que o consomem. É a fundação sobre a qual toda rota protegida do produto é construída, inclusive as já especificadas em outras stories.

## Contexto
- DEC-134 define RBAC granular com escopo; DEC-024 define visibilidade de processos; DEC-023 define o princípio da custódia; DEC-132 define o contexto de requisição (tenant/usuário/vínculo resolvidos e propagados por `AsyncLocalStorage`).
- Sem um mecanismo único, cada módulo tenderia a reimplementar checagens de permissão e visibilidade de forma inconsistente — o risco central que esta story elimina com um *guard* central e um meta-teste de build.
- US-096 fornece os dados (`RoleAssignment`) que esta story consulta; US-100 fornece o contexto de requisição (tenant ativo, usuário, vínculo, `correlationId`) sobre o qual a decisão é tomada.
- Permissões.md §1, §5, §6, §7 e §10 são a especificação funcional completa deste mecanismo (modelo de decisão, predicado SQL de visibilidade, políticas POL-01..17, capacidades implícitas e estratégia de testes).

## Objetivo
Garantir que 100% das rotas mutáveis declarem permissão/política (gate de build), que o overhead de autorização com cache quente mantenha p95 < 5 ms, e que o frontend nunca seja a fonte da decisão de acesso.

## Persona
- **Principal:** Todo usuário autenticado, em qualquer perfil — a story não introduz uma tela própria, mas decide o que cada perfil vê e pode fazer em todas as telas.
- **Secundárias:** Administrador do órgão (define perfis, escopos e atribuições que esta story aplica — US-095/US-096).

## Pré-condições
- Contexto de requisição resolvido (tenant `ACTIVE`, usuário, vínculo `ACTIVE` — DEC-132/US-100).
- Perfis, permissões e atribuições existentes (US-094, US-096).

## Fluxo principal
1. O front faz uma chamada autenticada; o BFF anexa `X-Tenant-Id` e repassa à API (DEC-053).
2. O middleware de contexto resolve `tenantId`, `userId`, `membershipId` e os publica em `AsyncLocalStorage` (DEC-132).
3. O guard de rota lê os metadados `@RequirePermission(code, { scope })` e `@Policy(...)` do handler.
4. `AuthorizationService.assertCan(code, context)`: busca `EffectivePermissions(membershipId)` no cache Redis (TTL 5 min; recalcula e grava se ausente); verifica se algum par `(permission, scope)` cobre o recurso **ou** se existe participação (`ProcessParticipant`) que concede a permissão; se a permissão for `HIGH` e a política de MFA exigir, verifica a claim `amr`; executa a política contextual (`@Policy`), se houver.
5. Permitido: a requisição segue ao handler. Negado: a API responde 403 (ou 404, se o recurso não for visível) e grava `access.denied`.
6. No frontend, `usePermission(code)` e `useProcessCapabilities(processId)` consultam `GET /me/permissions` (`ME-03`) e o endpoint de ações disponíveis do recurso para esconder/desabilitar elementos — nunca como fonte da decisão.
7. Mudanças em perfis, atribuições, lotação ou vínculo (`RoleUpdated`, `RoleAssigned`, `RoleRevoked`, `MembershipUpdated`, `MembershipSuspended`, `MembershipRevoked`, `DepartmentMoved`) disparam `PermissionCacheInvalidator`, que remove a chave de cache dos vínculos afetados.

## Fluxos alternativos
- **FA-01 — Cache indisponível:** sem Redis, recalcula a cada requisição (sem cache), loga `warn` e mantém a decisão correta às custas de mais latência.
- **FA-02 — Permissão por participação:** processo com `ProcessParticipant` ativo concede o conjunto fixo do papel (permissions.md §4), mesmo sem perfil correspondente.
- **FA-03 — MFA pendente:** permissão `HIGH` sem MFA → 403 `MFA_REQUIRED`; o BFF redireciona a *step-up* e repete a chamada original após sucesso.
- **FA-04 — Rota sem decorator:** o meta-teste falha o build/CI antes de chegar a produção — gate de qualidade, não comportamento em runtime.
- **FA-05 — Visibilidade negativa:** recurso existente mas não visível (DEC-024) → 404, nunca 403, para não confirmar a existência a quem não deveria saber.

## Regras de negócio
- **RN-IAM-100** — Fórmula de decisão: autenticado ∧ tenant `ACTIVE` ∧ vínculo `ACTIVE` e não expirado ∧ (MFA satisfeito, se a permissão for `HIGH` e a política exigir) ∧ permissão concedida por (perfil com escopo que cubra o recurso) ∪ (participação no processo) ∧ política contextual da ação.
- **RN-IAM-101** — Toda rota mutável deve declarar `@RequirePermission` (e `@Policy`, quando aplicável) ou constar na lista explícita de rotas públicas/implícitas; um meta-teste percorre o roteador e falha o CI caso encontre rota sem declaração.
- **RN-IAM-102** — `EffectivePermissions(membershipId)` é cacheada no Redis (chave `cf:{env}:t:{tenantId}:access:eff:{membershipId}`, TTL 5 min) e invalidada (`DEL`, idempotente) pelos eventos `RoleUpdated`, `RoleAssigned`, `RoleRevoked`, `MembershipUpdated`, `MembershipSuspended`, `MembershipRevoked`, `DepartmentMoved` via `PermissionCacheInvalidator`.
- **RN-IAM-103** — O predicado de visibilidade de processos (DEC-024, SQL de referência em permissions.md §5) é a única implementação usada por toda listagem/consulta de processos e recursos filhos.
- **RN-IAM-104** — Recurso de outro tenant, inexistente ou não visível → 404 `<RESOURCE>_NOT_FOUND`; visível mas sem permissão/política para a ação → 403 com o código específico (`PERMISSION_DENIED` ou código da política).
- **RN-IAM-105** — Toda negação gera auditoria `access.denied` (`result = DENIED`, `reasonCode` = permissão ou política), com amostragem de no máximo 1 registro por usuário/rota/minuto.
- **RN-IAM-106** — `GET /me/permissions` (`ME-03`) retorna `{ permissions: [{ code, scopes: [{ type, organizationId?, departmentId?, includeSubtree }] }], implicit: { headOfDepartmentIds: [] } }` e é a única fonte usada pelos hooks do frontend.
- **RN-IAM-107** — O frontend somente esconde ou desabilita elementos; a decisão final é sempre da API — nenhuma tela assume acesso a partir de estado local sem confirmação do backend.
- **RN-IAM-108** — O `AuthorizationService` com cache quente deve manter p95 < 5 ms por verificação, medido em teste de carga dedicado.

## Campos
Esta story não introduz formulário de usuário. O único dado trafegado é o payload de leitura de `GET /me/permissions` (RN-IAM-106; formato detalhado na seção API).

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Sessão/token inválido | BFF/API | "Sua sessão expirou. Entre novamente." | `UNAUTHENTICATED`/`SESSION_EXPIRED` |
| V-02 | Tenant não `ACTIVE` | API | "Seu acesso a este órgão não está disponível." | `TENANT_SUSPENDED` |
| V-03 | Vínculo inativo/expirado | API | "Seu acesso a este órgão não está ativo." | `MEMBERSHIP_INACTIVE` |
| V-04 | Permissão ausente no escopo | API | "Você não tem permissão para esta ação." | `PERMISSION_DENIED` |
| V-05 | MFA exigido e não satisfeito | API | "Confirme sua identidade para continuar." | `MFA_REQUIRED` |
| V-06 | Recurso inexistente/de outro tenant/não visível | API | "Não encontramos o recurso solicitado." | `<RESOURCE>_NOT_FOUND` |
| V-07 | Rota mutável sem `@RequirePermission`/`@Policy` | Build (CI) | — (falha de build, não é erro HTTP) | — |

## Permissões
- **Permissão:** não há um código de permissão próprio — esta story é o motor que aplica POL-01..17 e as 68 permissões do catálogo (permissions.md §2) a cada requisição. `ME-03` é capacidade implícita (vínculo ativo).
- **Políticas:** todas (POL-01 a POL-17); esta story é a camada que as executa de forma uniforme.
- **MFA:** aplicado conforme POL-14 a cada permissão `HIGH`, não apenas aqui.
- **Sem permissão:** qualquer elemento de UI gated por uma permissão ausente é ocultado/desabilitado pelos hooks desta story; a API sempre responde 403/404 independentemente do estado da UI.

## Eventos gerados
Nenhum evento de domínio é gerado por esta story. Eventos consumidos para invalidação de cache:

| Evento | Routing key | Consumidor | Observação |
|---|---|---|---|
| `RoleUpdated` / `RoleAssigned` / `RoleRevoked` | `role.*` | `PermissionCacheInvalidator` | `DEL` da chave de cache do(s) vínculo(s) afetados |
| `MembershipUpdated` / `MembershipSuspended` / `MembershipRevoked` | `membership.*` | `PermissionCacheInvalidator` | idem |
| `DepartmentMoved` | `department.moved` | `PermissionCacheInvalidator` | recalcula escopos `DEPARTMENT`/`OWN_DEPARTMENTS` afetados |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Autorização na API e no frontend

  Background:
    Given que o usuário "Diego" está autenticado no tenant "Prefeitura A"
    And "Diego" possui o perfil "REQUISITANTE" com escopo "OWN_DEPARTMENTS"

  Scenario: [Sucesso] Permissão concedida e cacheada
    When "Diego" criar um processo em uma unidade de sua lotação
    Then a API deve autorizar a ação sem consultar o banco na segunda chamada em até 5 minutos
    And a resposta deve ser servida do cache de permissões efetivas

  Scenario: [Validação] Rota mutável sem decorator de permissão
    Given que uma rota mutável nova foi registrada sem "@RequirePermission" nem está na lista de rotas implícitas
    When a suíte de meta-teste for executada no CI
    Then o build deve falhar apontando a rota sem decorator

  Scenario: [Permissão] Ação sem a permissão necessária
    Given que "Diego" não possui "PROCESS_CANCEL"
    When "Diego" tentar cancelar um processo visível a ele
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com "reasonCode" igual a "PROCESS_CANCEL"

  Scenario: [Tenant incorreto] Recurso de outro tenant
    Given que existe um processo no tenant "Prefeitura B"
    When "Diego", no tenant "Prefeitura A", consultar esse processo pelo id
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"
    And a resposta não deve revelar que o processo existe em outro tenant

  Scenario: [Duplicidade] Invalidações repetidas do cache são seguras
    Given que o evento "RoleRevoked" é entregue duas vezes por reprocessamento do outbox
    When o "PermissionCacheInvalidator" processar ambas as entregas
    Then a chave de cache deve ser removida apenas uma vez de forma idempotente
    And nenhum erro deve ser lançado na segunda entrega

  Scenario: [Concorrência] Revogação de perfil durante requisições simultâneas
    Given que "Diego" perde o perfil "REQUISITANTE" no exato momento de duas requisições concorrentes
    When as duas requisições forem processadas
    Then nenhuma delas deve usar uma combinação de cache parcialmente invalidada que conceda acesso indevido

  Scenario: [Falha de banco] Banco indisponível ao recalcular permissões efetivas
    Given que o banco de dados fica indisponível
    And o cache de "Diego" está expirado
    When "Diego" fizer uma requisição protegida
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"

  Scenario: [Falha de integração] Redis indisponível
    Given que o Redis de cache está indisponível
    When "Diego" fizer uma requisição protegida
    Then a API deve recalcular a decisão sem cache e responder corretamente
    And deve ser registrado log "warn" "authorization.cache_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem token válido | 401 | `UNAUTHENTICATED` | "Entre para continuar." | Redireciona ao login |
| Sessão expirada | 401 | `SESSION_EXPIRED` | "Sua sessão expirou. Entre novamente." | Redireciona ao login |
| MFA exigido | 403 | `MFA_REQUIRED` | "Confirme sua identidade para continuar." | Dispara step-up |
| Sem permissão/escopo | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta/desabilita elemento |
| Tenant suspenso | 403 | `TENANT_SUSPENDED` | "Seu acesso a este órgão não está disponível." | Redireciona para SCR-111 |
| Vínculo inativo | 403 | `MEMBERSHIP_INACTIVE` | "Seu acesso a este órgão não está ativo." | Redireciona para SCR-111 |
| Não encontrado/não visível | 404 | `<RESOURCE>_NOT_FOUND` | "Não encontramos o recurso solicitado." | Redireciona para SCR-111 (404) |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente." | Botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-094 (catálogo e perfis), US-096 (atribuições com escopo), US-100 (contexto de requisição/`AsyncLocalStorage`). Indiretas: US-092 (vínculos), US-101/US-102 (órgãos/unidades usados nos escopos).
- **Decisões/ADRs:** DEC-134, DEC-024, DEC-023, DEC-132, DEC-139.
- **Configurações:** `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:** nenhuma — o mecanismo já está integralmente especificado em permissions.md §1, §5, §6, §7, §10.

## Impacto técnico
Estabelece o *guard* global e os decorators `@RequirePermission`/`@Policy` como padrão arquitetural obrigatório para toda nova rota mutável, reforçado por um meta-teste que falha o build. O cache Redis é crítico para desempenho mas não para correção (há fallback recalculando sob indisponibilidade). O predicado de visibilidade (DEC-024) deve ser extraído como função reutilizável (`buildVisibilityPredicate`) para evitar reimplementações divergentes por módulo.

## Backend
- **Módulo(s):** `access` (dono), consumido por todos os módulos de negócio; `platform` (contexto de requisição, `AsyncLocalStorage`).
- **Casos de uso:** `GetMyPermissionsQuery` → `GetMyPermissionsHandler` (`ME-03`); `AuthorizationService.assertCan()`/`computeEffectivePermissions()` (biblioteca interna, não um caso de uso HTTP).
- **Domínio:** value object `EffectivePermissionSet`; `PermissionCacheInvalidator` (consumidor leve de `domain-events`).
- **Integrações internas:** todos os módulos de negócio, via decorators no controller.
- **Transação:** leitura apenas (cálculo/consulta); invalidação de cache é operação idempotente fora de transação de negócio.

## Frontend
- **Tela(s):** nenhuma própria; infraestrutura consumida por todas as telas protegidas.
- **Componentes:** `PermissionProvider` (contexto React alimentado por `ME-03` no bootstrap da sessão), hooks `usePermission(code)` e `useProcessCapabilities(processId)`, wrapper `Can`/`Gate`.
- **Estados:** loading (enquanto `ME-03` carrega, elementos protegidos ficam ocultos, não desabilitados, para evitar flash de conteúdo indevido).
- **Acessibilidade e responsividade:** elementos desabilitados mantêm `aria-disabled` e tooltip explicando o motivo quando contextual.

## Banco de dados
- **Tabelas:** nenhuma nova; lê `role_assignments`, `process_participants`, `process_access` (já existentes).
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** já cobertos pelas entidades de origem (entities.md §4).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| ME-03 | GET | `/me/permissions` | — | `200 { data: { permissions: [{ code, scopes }], implicit } }` | 200, 401, 403 |

## Logs
- `info` `authorization.cache_rebuilt` — `membershipId`, `durationMs`.
- `warn` `authorization.cache_unavailable` — quando o Redis falhar.
- `error` `authorization.decision_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** o conteúdo do recurso avaliado, apenas códigos de permissão/política.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `access.denied` | `ACCESS` | Toda negação de permissão/política | `reasonCode`, rota, amostragem 1/usuário/rota/min |
| `auth.mfa_required` | `SECURITY` | Permissão `HIGH` sem MFA satisfeito | `permissionCode` |

## Testes necessários
- **Unitários:** fórmula de decisão (RN-IAM-100); cálculo de `EffectivePermissions` com múltiplas atribuições e escopos sobrepostos.
- **Integração (Testcontainers + Redis):** cache hit/miss; invalidação por cada evento listado (RN-IAM-102); predicado de visibilidade (DEC-024) com histórico de tramitação.
- **Meta-teste:** matriz de todas as rotas × perfis padrão × escopos (permissions.md §10); build falha para rota sem decorator.
- **API/contrato:** `ME-03` conforme api.md; códigos 401/403/404 nos cenários corretos.
- **RBAC e multi-tenant:** suíte "tenant leak" cobrindo toda rota com ID de outro tenant.
- **Concorrência:** revogação concomitante com requisições em voo (RN-IAM-102).
- **E2E (Playwright):** elemento de UI aparece/desaparece corretamente ao perfil mudar entre sessões.
- **Acessibilidade/performance:** k6 medindo p95 < 5 ms do `AuthorizationService` com cache quente (RN-IAM-108).

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados e passando no CI
- [ ] Meta-teste de decorators ativo no pipeline e bloqueando merge em caso de falha
- [ ] Benchmark de overhead (p95 < 5 ms) registrado e repetível
- [ ] `ME-03` compatível com api.md; hooks de frontend cobertos por teste
- [ ] Auditoria `access.denied` verificada em teste para todas as políticas POL-01..17
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] Logs sem dados sensíveis; métricas de cache hit/miss expostas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card) atualizada

## Estimativa
**L** — motor transversal consumido por toda a plataforma, com exigência de cobertura total de rotas (meta-teste) e de desempenho (p95 < 5 ms), além de decorators, cache, invalidação por evento e hooks de frontend.

## Prioridade
**P0** — nenhuma rota protegida do produto funciona sem este mecanismo; é pré-requisito transitivo de praticamente todas as demais stories de negócio do MVP 1.
