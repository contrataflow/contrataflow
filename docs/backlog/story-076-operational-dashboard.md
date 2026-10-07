---
id: US-076
title: "Dashboard operacional por perfil"
epic: EP-014
feature: FT-046
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-002, US-055, US-056]
modules: [dashboard, process, workflow, timeline, access]
screens: [SCR-003]
endpoints: [DSH-01, DSH-02, DEP-01, ORG-01]
permissions: [DASHBOARD_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: []
---

# US-076 — Dashboard operacional por perfil

## Título
Dashboard operacional por perfil

## Descrição
**Como** usuário com vínculo ativo em um órgão, **quero** abrir um painel inicial com indicadores operacionais dos processos que posso ver, **para** entender rapidamente a situação geral (pendências, atrasos, volume, valores) sem montar filtros manualmente a cada acesso.

O painel (SCR-003, rota `/painel`) é a tela inicial após o login. Combina um resumo rápido (`GET /dashboard/summary`) com cartões carregados de forma independente (`GET /dashboard/widgets/{widgetKey}`): pendências, processos por status, por etapa, atrasados, próximos do prazo, tempo médio por etapa nos últimos 90 dias, processos abertos por mês, valor estimado por secretaria (respeitando o sigilo do orçamento — POL-09) e atividade recente. Todo número respeita a visibilidade de processos do usuário (DEC-024): o mesmo endpoint mostra dados diferentes para cada perfil, sem telas separadas por papel.

## Contexto
- Hoje não há visão consolidada do andamento das contratações: cada gestor abre a lista de processos e aplica filtros manualmente para saber quantos processos estão atrasados ou qual o volume por secretaria.
- A caixa de tarefas (US-056/DEC-026) resolve "o que eu preciso fazer"; o dashboard resolve "como está a operação", olhando o conjunto de processos visíveis ao usuário, não só os atribuídos a ele.
- DEC-180 já estabeleceu o padrão de "responder sem cliques" no detalhe do processo (painel situacional); esta story aplica a mesma filosofia no nível agregado do tenant/secretaria.
- O sigilo do orçamento estimado (art. 24 da Lei 14.133/2021; DEC-030/POL-09) precisa ser respeitado também em agregados (somas por secretaria), não só em campos individuais — é a primeira story do produto a mascarar um **valor agregado**, não um campo de um registro.
- Primeira story do módulo `dashboard`; estabelece o padrão de cartões independentes, com cache e carregamento resiliente, que futuros indicadores (contratos, fornecedores) poderão reaproveitar.

## Objetivo
Permitir que qualquer usuário com `DASHBOARD_VIEW` veja, em até 1 segundo (p95) por indicador, uma visão correta e atualizada (cache de até 60 s) da operação dentro do que lhe é visível, com zero vazamentos entre tenants, usuários ou secretarias e sem expor valores de orçamento sigiloso a quem não tem a permissão correspondente.

## Persona
- **Principal:** Qualquer usuário com vínculo ativo e `DASHBOARD_VIEW` (perfis operacionais: `REQUISITANTE`, `GESTOR_CONTRATACOES`, `PLANEJAMENTO`, `COMPRAS`, `GESTOR_CONTRATO`) — concedida por padrão a todos os perfis.
- **Secundárias:** Gestor/autoridade com `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (vê o widget "valor por secretaria" sem mascaramento).

## Pré-condições
- Usuário autenticado (US-087), tenant `ACTIVE`, vínculo `ACTIVE` e não expirado.
- Usuário possui `DASHBOARD_VIEW`.
- Caixa de tarefas (US-056) e prazos/SLA (US-055) já em operação — o painel reaproveita seus predicados e campos.
- Em tenant novo, sem processos, o painel é acessível e exibe estados vazios (não é bloqueado).

## Fluxo principal
1. O usuário acessa **"Painel"** (SCR-003, rota `/painel`), tela inicial após o login.
2. O sistema chama `DSH-01` (resumo) e, em paralelo, `DSH-02` para cada cartão do layout padrão, exibindo skeleton em cada um enquanto carrega.
3. A API resolve o escopo de visibilidade do usuário (DEC-024) e, para cada consulta, verifica o cache Redis (`dashboard:{tenantId}:{userId}:{widgetKey}:{hashFiltros}`, TTL 60 s); em cache hit responde imediatamente; em miss, agrega os dados e grava o cache.
4. O painel exibe os cartões de resumo (pendências, atrasados, próximos do prazo, abertos) e, abaixo, os gráficos (por status, por etapa, tempo médio por etapa, abertos por mês, valor por secretaria) e a lista de atividade recente.
5. O usuário aplica um filtro (secretaria/unidade); o front reconsulta `DSH-02` para os widgets afetados com os novos parâmetros, mantendo os demais cartões já carregados.
6. Ao clicar em um cartão/segmento (ex.: "Atrasados"), o usuário é levado à caixa de tarefas (SCR-013) ou à lista de processos (SCR-004) já filtrada, reaproveitando os mesmos predicados.
7. A cada 60 s, em segundo plano, o front repete a consulta do resumo (mesma cadência de polling de `TSK-02`), atualizando os números sem recarregar a página.

## Fluxos alternativos
- **FA-01 — Tenant sem processos:** cada cartão mostra estado vazio contextual (ex.: "Nenhum processo por aqui ainda.").
- **FA-02 — Sem permissão de orçamento sigiloso:** o widget "valor por secretaria" soma apenas processos não sigilosos (ou sigilosos sob custódia atual do usuário) e marca os buckets afetados com `confidentialExcluded: true` e o selo "Valores sigilosos não somados".
- **FA-03 — Filtro fora do escopo do usuário:** retorna resultado vazio (RN-DASH-09), nunca erro — não revela que existem processos fora do alcance do usuário.
- **FA-04 — Redis indisponível:** o cache é ignorado; os dados são computados diretamente do banco (RN-DASH-10); resposta mais lenta, porém correta.
- **FA-05 — Widget lento além do esperado:** o cartão exibe erro parcial com "Tentar novamente", sem afetar os demais (requisições independentes por `widgetKey`).
- **FA-06 — Duas abas abertas simultaneamente:** números podem divergir levemente entre abas por até 60 s (cache por usuário; sem WebSocket/long-polling no MVP 1) — mesma limitação aceita em `TSK-02`.

## Regras de negócio
- **RN-DASH-01** — Todo dado exibido respeita a visibilidade de processos do usuário (DEC-024, §5). `DASHBOARD_VIEW` é apenas o portão de acesso à funcionalidade; nunca amplia o escopo de `PROCESS_VIEW` do usuário.
- **RN-DASH-02** — Indicadores suportados (`DashboardWidgetKey`, registro): `PENDING_ITEMS`, `BY_STATUS`, `BY_STAGE`, `OVERDUE`, `DUE_SOON`, `AVG_STAGE_DURATION`, `OPENED_BY_MONTH`, `VALUE_BY_SECRETARIAT`, `RECENT_ACTIVITY`. `widgetKey` fora do registro → 404 `WIDGET_NOT_FOUND`.
- **RN-DASH-03** — `PENDING_ITEMS` reaproveita exatamente os predicados/contadores de `TSK-02` (US-056, RN-INBOX-09) para nunca divergir da caixa de tarefas.
- **RN-DASH-04** — `OVERDUE` usa `Process.overdueSince IS NOT NULL`; `DUE_SOON` usa `overdueSince IS NULL AND currentStageDueAt` dentro de `deadlines.warnBeforeBusinessDays` dias úteis (padrão 2) — ambos restritos à visibilidade do usuário.
- **RN-DASH-05** — `AVG_STAGE_DURATION` calcula a média de `exitedAt − enteredAt` de `ProcessStage` com `exitedAt` nos últimos 90 dias, agrupada por `workflowStageId`; janela fixa de 90 dias, não filtrável.
- **RN-DASH-06** — `OPENED_BY_MONTH` agrupa `Process.openedAt` por mês (fuso do tenant) nos últimos 12 meses; processos ainda não autuados (sem número — `assignOn = START`) não entram na contagem até ganharem `openedAt`.
- **RN-DASH-07** — `VALUE_BY_SECRETARIAT` soma `estimatedValue` por `requestingSecretariatId`. Processos com `isBudgetConfidential = true` cujo usuário não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` nem é a custódia atual são excluídos da soma (POL-09); o bucket afetado retorna o total parcial com `confidentialExcluded: true`, nunca um total silenciosamente incompleto (POL-09, agregados).
- **RN-DASH-08** — `RECENT_ACTIVITY` lista as últimas `limit` (padrão 20, máx. 100) `ProcessTimelineEntry` dos processos visíveis, mais recentes primeiro; entradas `visibility = BUDGET_RESTRICTED` são omitidas para quem não atende POL-09 (mesma regra aplicada à timeline do processo).
- **RN-DASH-09** — Filtros aceitos: `secretariatId`, `departmentId` (com subárvore), sempre aplicados **dentro** da visibilidade do usuário — nunca a amplia. Filtro fora do escopo do usuário → resultado vazio, não erro.
- **RN-DASH-10** — Cache de 60 s por `(tenant, usuário, widgetKey, filtros)` no Redis. Indisponibilidade do Redis não bloqueia a resposta: o indicador é computado direto do banco e o evento é registrado em log `warn`.
- **RN-DASH-11** — Meta de desempenho: p95 < 1 s por endpoint (resumo e cada widget) com até 10.000 processos ativos no tenant — mesma ordem de grandeza de RN-INBOX-12 (US-056).
- **RN-DASH-12** — A paleta de cores dos gráficos deve ser acessível (contraste AA) e não depender só de cor para distinguir séries (uso de padrão/ícone complementar).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Secretaria | `secretariatId` | seleção (`Department` tipo `SECRETARIAT`/`BOARD`) | Não | ativa; do órgão do tenant | todas as secretarias visíveis ao usuário |
| Unidade/Setor | `departmentId` | seleção em árvore | Não | ativa; na subárvore de `secretariatId` quando ambos informados | todas as unidades visíveis |
| Indicador | `widgetKey` | seleção (`DashboardWidgetKey`, registro) | Sim (em `DSH-02`) | um dos 9 valores de RN-DASH-02 | — |
| Limite (só `RECENT_ACTIVITY`) | `limit` | número | Não | 1–100 | 20 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `widgetKey` fora do registro `DashboardWidgetKey` | API | "Indicador não encontrado." | `WIDGET_NOT_FOUND` |
| V-02 | `secretariatId`/`departmentId` inexistente, inativo ou de outro tenant | API | "Selecione uma secretaria/unidade válida." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-03 | `departmentId` fora da subárvore de `secretariatId` | API | "A unidade deve pertencer à secretaria selecionada." | `VALIDATION_ERROR` (`DEPARTMENT_NOT_IN_SECRETARIAT`) |
| V-04 | `limit` de `RECENT_ACTIVITY` fora de 1–100 | Front + API | "Informe um limite entre 1 e 100." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |

## Permissões
- **Permissão:** `DASHBOARD_VIEW` (qualquer escopo) controla o acesso ao painel e aos endpoints `DSH-01`/`DSH-02`.
- **Políticas:** POL-09 no widget `VALUE_BY_SECRETARIAT` (mascaramento agregado) e em `RECENT_ACTIVITY` (omissão de entradas `BUDGET_RESTRICTED`).
- **MFA:** não exigido (`DASHBOARD_VIEW` é risco `L`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** o menu "Painel" não é exibido e a rota `/painel` retorna SCR-111 (403); a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
Nenhum evento é gerado por esta story. `DSH-01`/`DSH-02` são leituras agregadas — mesma convenção de `TSK-01`/`TSK-02` (US-056, DEC-026).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma — o painel é consultado, não empurrado. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Dashboard operacional por perfil

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And "Ana" tem vínculo ativo e o perfil "GESTOR_CONTRATACOES" com "DASHBOARD_VIEW" em escopo "TENANT"
    And existem 42 processos abertos, 3 atrasados e 5 próximos do prazo visíveis para "Ana"

  Scenario: [Sucesso] Carregar o resumo do painel
    When "Ana" abrir o painel em "/painel"
    Then a API deve responder 200 em "GET /api/v1/dashboard/summary"
    And o resumo deve trazer "pendingCount", "overdueCount" igual a 3 e "dueSoonCount" igual a 5
    And cada número deve refletir somente processos visíveis a "Ana"

  Scenario: [Sucesso] Carregar o widget "por status"
    When "Ana" solicitar o widget "BY_STATUS"
    Then a API deve responder 200 com a série de contagens por "ProcessStatus"
    And a soma da série deve ser igual ao total de processos visíveis a "Ana"

  Scenario: [Validação] Indicador inexistente
    When o front solicitar o widget "VALOR_TOTAL_FICTICIO"
    Then a API deve responder 404 com código "WIDGET_NOT_FOUND"

  Scenario: [Validação] Unidade fora da secretaria filtrada
    When "Ana" filtrar por secretaria "Secretaria de Obras" e unidade da "Secretaria de Saúde"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "DEPARTMENT_NOT_IN_SECRETARIAT" no campo "departmentId"

  Scenario: [Permissão] Usuário sem DASHBOARD_VIEW
    Given que "Bruno" não possui a permissão "DASHBOARD_VIEW"
    When "Bruno" acessar "/painel"
    Then o menu "Painel" não deve ser exibido
    When "Bruno" enviar "GET /api/v1/dashboard/summary"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "DASHBOARD_VIEW"

  Scenario: [Permissão] Valor por secretaria mascarado sem a permissão de orçamento sigiloso
    Given que o processo "0030/2026" da "Secretaria de Saúde" tem "isBudgetConfidential" verdadeiro e valor estimado "R$ 500.000,00"
    And "Ana" não possui "PROCESS_VIEW_CONFIDENTIAL_BUDGET" nem é a custodiante atual
    When "Ana" solicitar o widget "VALUE_BY_SECRETARIAT"
    Then o total da "Secretaria de Saúde" não deve incluir o valor do processo "0030/2026"
    And o item da "Secretaria de Saúde" deve retornar "confidentialExcluded" igual a verdadeiro

  Scenario: [Tenant incorreto] Filtro com unidade de outro tenant
    Given que existe o setor "Setor Y" no tenant "Prefeitura B"
    When "Ana", no tenant "Prefeitura de São José", filtrar por "departmentId" do "Setor Y"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "departmentId"
    And a resposta não deve revelar que a unidade existe em outro tenant

  Scenario: [Duplicidade] Repetição dentro da janela de cache
    Given que "Ana" consultou o widget "BY_STATUS" há 10 segundos
    When "Ana" repetir exatamente a mesma consulta
    Then a API deve responder 200 com os mesmos dados da primeira consulta
    And a resposta deve indicar cache ativo ("cache.hit" igual a verdadeiro)
    And nenhuma nova agregação deve ser executada no banco

  Scenario: [Concorrência] Usuários com escopos diferentes em requisições simultâneas
    Given que "Ana" tem escopo "TENANT" e "Carla" tem "PROCESS_VIEW" restrito à "Secretaria de Obras"
    When "Ana" e "Carla" solicitarem o resumo do painel ao mesmo tempo
    Then "Ana" deve receber os números do tenant inteiro
    And "Carla" deve receber somente os números da "Secretaria de Obras"
    And nenhuma resposta deve misturar dados da outra usuária

  Scenario: [Falha de banco] Banco indisponível durante a agregação
    Given que o banco de dados fica indisponível
    When "Ana" solicitar o widget "AVG_STAGE_DURATION"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"

  Scenario: [Falha de integração] Redis indisponível
    Given que o Redis está indisponível
    When "Ana" abrir o painel
    Then a API deve responder 200 computando os dados diretamente do banco
    And deve ser registrado log "warn" "dashboard.cache_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Indicador desconhecido | 404 | `WIDGET_NOT_FOUND` | "Indicador não encontrado." | Cartão não é exibido |
| Referência de filtro inválida | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | "Selecione uma secretaria/unidade válida." | Reseta o filtro para "Todas" |
| Unidade fora da secretaria | 422 | `VALIDATION_ERROR` (`DEPARTMENT_NOT_IN_SECRETARIAT`) | "A unidade deve pertencer à secretaria selecionada." | Marca o campo de filtro |
| Sem `DASHBOARD_VIEW` | 403 | `PERMISSION_DENIED` | "Você não tem permissão para acessar o painel." | Menu oculto; rota redireciona para SCR-111 |
| Vínculo inativo / tenant suspenso | 403 | `MEMBERSHIP_INACTIVE` / `TENANT_SUSPENDED` | "Seu acesso a este órgão não está ativo." | Redireciona para SCR-111 |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After`; pausa o polling |
| Banco/Redis crítico indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar os indicadores agora." | Cartão com "Tentar novamente"; demais cartões continuam |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Cartão com botão de copiar código |

## Dependências
- **Stories:** US-002 (consulta/listagem de processos — predicados e índices de visibilidade reaproveitados pelos widgets); US-055 (prazos/SLA — `overdueSince`, `currentStageDueAt`, `deadlines.warnBeforeBusinessDays`); US-056 (contadores e predicados da caixa de tarefas, reaproveitados no widget `PENDING_ITEMS`).
- **Decisões/ADRs:** DEC-001 (convenções de nomenclatura), DEC-024 (visibilidade de processos), DEC-026 (caixa de tarefas como consulta), DEC-030 (sigilo do orçamento), DEC-180 (painel situacional do processo).
- **Configurações:** `deadlines.warnBeforeBusinessDays`.
- **Lacunas nas fontes canônicas:**
  1. ~~Catálogo de indicadores~~ — resolvida: `DashboardWidgetKey` (registro) em entities.md §2.
  2. ~~Mascaramento de agregados~~ — resolvida: POL-09 cobre agregados (`confidentialExcluded: true`).

## Impacto técnico
- Primeiro uso do módulo `dashboard` (novo); estabelece o padrão de "resumo + widgets independentes com cache" que futuros indicadores (contratos, fornecedores) poderão reaproveitar.
- Nenhuma tabela nova: todas as consultas são agregações sobre `processes`, `process_stages` e `process_timeline_entries` já existentes. O ponto de maior risco de desempenho é `AVG_STAGE_DURATION` (varredura de 90 dias de etapas concluídas); recomenda-se o índice `(tenant_id, workflow_stage_id, exited_at) WHERE exited_at IS NOT NULL` em `process_stages` e monitorar como débito técnico um possível read model dedicado se a base crescer (mesma postura adotada em DEC-026 para a caixa de tarefas).
- O cache Redis de 60 s evita recomputar agregações a cada refresh de polling; a chave precisa incluir tenant, usuário e hash dos filtros para não misturar resultados entre usuários/tenants — ponto de atenção na revisão de segurança.
- Reaproveita os mesmos predicados de visibilidade (DEC-024) e de contadores (RN-INBOX-09, US-056) para manter os números consistentes entre o painel e a caixa de tarefas.

## Backend
- **Módulo(s):** `dashboard` (novo; dono); consome `process` (consultas agregadas), `workflow` (nomes de etapa), `timeline` (`ProcessTimelineEntry`), `access` (predicado de visibilidade DEC-024).
- **Casos de uso:** `GetDashboardSummaryQuery` → `GetDashboardSummaryHandler`; `GetDashboardWidgetQuery({ widgetKey, filters })` → um resolver por `widgetKey`, registrado em um `DashboardWidgetRegistry`.
- **Integrações internas:** `access.AuthorizationService.getVisibleProcessScope(userId)` (DEC-024); serviço de contadores de `TSK-02` (US-056) reaproveitado internamente (chamada de serviço, não HTTP) para `PENDING_ITEMS`; `ConfidentialFieldsInterceptor` adaptado para agregados (POL-09).
- **Cache:** `CacheFacade` (Redis) `get`/`set` com TTL 60 s; em falha do Redis, segue direto ao banco e registra log `warn` (sem quebrar a resposta).
- **Serialização:** `DashboardWidgetPresenter` aplica o mascaramento agregado de POL-09 e omite entradas `BUDGET_RESTRICTED` da timeline.

## Frontend
- **Tela(s):** SCR-003 (`/painel`).
- **Componentes:** `DashboardSummaryCards`, `DashboardWidgetCard` (wrapper com loading/erro por cartão, independente dos demais), gráficos de barra/linha do design system (`packages/ui`), `RecentActivityFeed`, `DepartmentFilterBar` (secretaria/unidade).
- **Dados:** TanStack Query `['t', tenantId, 'dashboard', 'summary', filters]` e `['t', tenantId, 'dashboard', 'widget', widgetKey, filters]`, `refetchInterval: 60000` (mesma cadência de `TSK-02`); cada cartão busca e falha de forma independente.
- **Estados:** skeleton por cartão; vazio contextual por widget (ex.: "Nenhuma atividade recente."); erro por cartão com "Tentar novamente"; filtros refletidos na URL (query string) para permitir compartilhar/recarregar a mesma visão.
- **Acessibilidade:** paleta de cores com contraste AA e redundância de padrão/ícone (RN-DASH-12); dados dos gráficos também disponíveis em tabela (toggle) para leitores de tela; `aria-live` nos cartões ao atualizar via polling sem roubar o foco.
- **Responsivo:** grade de 1 coluna (< 768 px) a 3 colunas (desktop); gráficos com rolagem horizontal quando necessário.

## Banco de dados
- **Tabelas lidas:** `processes`, `process_stages`, `process_timeline_entries`, `process_assignments`, `approvals` (via reaproveitamento do serviço de US-056). Nenhuma tabela nova.
- **Migrações:** nenhuma obrigatória. Recomendado índice adicional em `process_stages`: `(tenant_id, workflow_stage_id, exited_at) WHERE exited_at IS NOT NULL` (suporte a `AVG_STAGE_DURATION`).
- **Índices/constraints relevantes:** reaproveita os índices já existentes de `processes` — `(tenant_id, status, updated_at DESC)`, `(tenant_id, overdue_since) WHERE overdue_since IS NOT NULL`, `(tenant_id, target_date)`, `(tenant_id, created_at DESC)`, `(tenant_id, requesting_secretariat_id, status)`, `(tenant_id, current_stage_due_at) WHERE status IN ('IN_PROGRESS','AWAITING_APPROVAL','RETURNED')`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| DSH-01 | GET | `/api/v1/dashboard/summary` | Query: `secretariatId?`, `departmentId?` | `200 { data: { pendingCount, overdueCount, dueSoonCount, openCount, generatedAt } }` | 200, 401, 403, 422, 429, 500, 503 |
| DSH-02 | GET | `/api/v1/dashboard/widgets/{widgetKey}` | Path: `widgetKey` (`DashboardWidgetKey`); Query: `secretariatId?`, `departmentId?`, `limit?` (só `RECENT_ACTIVITY`) | `200 { data: { widgetKey, series/items, generatedAt } }` | 200, 401, 403, 404, 422, 429, 500, 503 |
| DEP-01, ORG-01 | GET | (leituras de apoio para os seletores de filtro) | — | — | 200 |

Exemplos de resposta `200`:
```json
{
  "data": {
    "pendingCount": 14, "overdueCount": 3, "dueSoonCount": 5, "openCount": 42,
    "generatedAt": "2026-10-07T13:00:00Z"
  },
  "meta": { "cache": { "hit": true, "expiresAt": "2026-10-07T13:01:00Z" } }
}
```
```json
{
  "data": {
    "widgetKey": "VALUE_BY_SECRETARIAT",
    "series": [
      { "key": "org-secretaria-obras", "label": "Secretaria de Obras", "value": "1250000.00", "confidentialExcluded": false },
      { "key": "org-secretaria-saude", "label": "Secretaria de Saúde", "value": "320000.00", "confidentialExcluded": true }
    ]
  },
  "meta": { "generatedAt": "2026-10-07T13:00:00Z", "cache": { "hit": false, "expiresAt": "2026-10-07T13:01:00Z" } }
}
```

## Logs
- `info` `dashboard.widget_served` — `widgetKey`, `tenantId`, `userId`, `durationMs`, `cacheHit`.
- `warn` `dashboard.cache_unavailable` — quando o Redis falhar.
- `warn` `dashboard.widget_slow` — duração > 800 ms (próxima do limite p95).
- `error` `dashboard.widget_failed` — `errorCode`, causa resumida, `correlationId` (stack apenas em nível `debug`).
- **Nunca logar:** valores monetários individuais, títulos/objetos de processo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `access.denied` | `ACCESS` | Tentativa sem `DASHBOARD_VIEW` | `reasonCode = DASHBOARD_VIEW` |

## Testes necessários
- **Unitários:** resolver de cada `widgetKey` (RN-DASH-02); cálculo de média de 90 dias; mascaramento agregado (`confidentialExcluded`); cálculo de `DUE_SOON` com `warnBeforeBusinessDays`.
- **Integração (Testcontainers PostgreSQL + Redis):** cache hit/miss; fallback com Redis indisponível; RLS impede leitura entre tenants; consistência entre `PENDING_ITEMS` e `TSK-02`.
- **API/contrato:** respostas e erros conforme api.md (snapshot do OpenAPI de DSH-01/DSH-02).
- **RBAC e multi-tenant:** matriz de perfis × escopos; usuário sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` recebe agregados mascarados; filtro com unidade de outro tenant → 422 `REFERENCE_NOT_FOUND`.
- **Concorrência:** requisições simultâneas de usuários com escopos de visibilidade diferentes não misturam resultados; duas requisições concorrentes em cache miss geram o mesmo resultado (sem corrida de escrita no cache).
- **E2E (Playwright):** abrir o painel, aplicar filtro de secretaria/unidade, clicar em um cartão e chegar à lista/caixa filtrada.
- **Acessibilidade/performance:** axe sem violações sérias; paleta validada em contraste AA; k6 com carga típica de tenant → p95 < 1 s por indicador.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `DASHBOARD_VIEW` aplicado na API; menu e rota ocultos sem permissão
- [ ] Mascaramento agregado de POL-09 (`confidentialExcluded`) coberto por teste
- [ ] Números de `PENDING_ITEMS` conferem com os de `TSK-02` (US-056) em teste de integração
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de DSH-01 e DSH-02 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas de duração por widget e taxa de acerto do cache
- [ ] Painel acessível (axe), responsivo (360 px) e com paleta validada (contraste AA)
- [ ] Revisão de código e de segurança aprovadas
- [ ] Decisão sobre o índice adicional de `process_stages` registrada (criado ou justificadamente postergado)

## Estimativa
**L** — nove indicadores com regras de agregação distintas (incluindo o primeiro mascaramento de valor agregado do produto), cache com degradação controlada, novo módulo `dashboard` e meta de desempenho p95 < 1 s por indicador, mesmo sem novas tabelas.

## Prioridade
**P0** — é a tela inicial do produto (DEC-180 aplicado em nível agregado) e a referência de "saúde operacional" usada por todos os perfis desde o primeiro acesso.
