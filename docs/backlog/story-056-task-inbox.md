---
id: US-056
title: "Caixa de tarefas unificada"
epic: EP-009
feature: FT-036
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-049, US-051]
modules: [process, approval, access]
screens: [SCR-013]
endpoints: [TSK-01, TSK-02, PRC-21]
permissions: [INBOX_VIEW, PROCESS_CLAIM]
events: []
---

# US-056 — Caixa de tarefas unificada

## Título
Caixa de tarefas unificada

## Descrição
**Como** servidor com processos sob custódia (ou titular/substituto de unidade), **quero** ver em um único lugar os processos que exigem minha atenção — comigo, na fila da minha unidade, aprovações pendentes, devolvidos, atrasados e os que acompanho —, **para** priorizar meu trabalho sem precisar vasculhar a lista geral de processos.

A caixa de tarefas (SCR-013) não é uma entidade própria: é uma consulta sobre o estado atual de `ProcessStage`/`ProcessAssignment` e sobre as `Approval` pendentes em que o usuário é aprovador (DEC-026). A tela apresenta visões (abas) com contadores, permite ordenar e oferece a ação rápida "Assumir" para processos na fila da unidade sem responsável.

## Contexto
- Hoje, saber "o que preciso fazer hoje" exige abrir a lista geral de processos e aplicar filtros manualmente a cada acesso; não há visão consolidada de pendências, atrasos ou aprovações.
- DEC-026 definiu deliberadamente que o MVP 1 não terá uma entidade `Task`: a caixa é projetada como consulta sobre dados já existentes (etapas ativas, responsabilidades, aprovações pendentes), evitando duplicar estado e mantendo uma única fonte de verdade.
- A visão "Na fila da minha unidade" é exibida a quem está lotado na unidade com `PROCESS_CLAIM` (pode assumir — POL-04) e ao titular e ao substituto da unidade (capacidade implícita, §7 de permissions.md — podem atribuir, POL-05).
- "Aprovações pendentes" usa a mesma regra de cobertura de aprovador do módulo de aprovação (DEC-022/POL-03): direto (`approverUserId`), por perfil (`ROLE`, quando o escopo da atribuição cobre a unidade solicitante do processo) ou por titularidade de unidade (`DEPARTMENT_HEAD`, incluindo o substituto quando `allowDeputy`).
- Esta story depende de US-049 (assumir processo) para a ação rápida da fila e de US-051 (solicitação de aprovação) para que existam `Approval` `PENDING` a listar.

## Objetivo
Permitir que qualquer usuário com vínculo ativo identifique, em uma única tela e em até 2 cliques, todos os processos que exigem sua ação, com contadores corretos por visão e tempo de resposta da consulta unificada (UNION) com p95 < 500 ms mesmo sob carga típica de tenant.

## Persona
- **Principal:** Qualquer usuário com vínculo ativo (perfis operacionais: `REQUISITANTE`, `GESTOR_CONTRATACOES`, `PLANEJAMENTO`, `COMPRAS`, `GESTOR_CONTRATO`).
- **Secundárias:** membros lotados com `PROCESS_CLAIM`, titular (`headUserId`) e substituto (`deputyUserId`) de unidade (visão "Na fila da minha unidade"); aprovadores diretos, por perfil ou por titularidade (visão "Aprovações pendentes").

## Pré-condições
- Usuário autenticado (US-087), tenant `ACTIVE`, vínculo `ACTIVE` e não expirado.
- Usuário possui `INBOX_VIEW` (capacidade praticamente universal — permissions.md §5).
- Existem processos com `ProcessStage` ativa e/ou `Approval` `PENDING` visíveis ao usuário (senão a visão mostra estado vazio).

## Fluxo principal
1. O usuário aciona **"Caixa de tarefas"** (menu principal) e o sistema navega para **SCR-013** (`/tarefas`).
2. O front chama `TSK-02` (`GET /tasks/counters`) e `TSK-01` (`GET /tasks?view=MINE&page=1&pageSize=20&sort=-dueAt`) em paralelo; exibe skeleton nas abas e na lista até os dados chegarem.
3. O sistema exibe as abas com contadores: **Comigo**, **Na fila da minha unidade** (para lotados com `PROCESS_CLAIM` e para titular/substituto de unidade), **Aprovações pendentes**, **Devolvidos**, **Atrasados**, **Acompanhando**. A aba **Comigo** inicia selecionada.
4. Cada linha mostra código, título, unidade atual, responsável (quando aplicável), etapa, prazo (`dueAt`) com indicação visual de atraso/próximo do vencimento (DEC-031) e, na visão "Aprovações pendentes", o solicitante e a data da solicitação.
5. O usuário troca de aba; o front chama `TSK-01` com o `view` correspondente, mantendo ordenação e página.
6. O usuário ordena por prazo, código ou data de entrada na etapa (`?sort=`); o front reconsulta `TSK-01` com o novo `sort`.
7. Em "Na fila da minha unidade", linhas sem responsável exibem a ação rápida **"Assumir"**; ao clicar, o front chama `PRC-21` (`POST /processes/{id}/claim`, US-049) com `If-Match` e `Idempotency-Key`; em sucesso, a linha sai da fila e entra em "Comigo", e os contadores das duas abas são atualizados.
8. O usuário clica em uma linha para abrir o processo (SCR-006); nenhuma ação é executada a partir do clique simples.
9. A cada 60 s, em segundo plano, o front repete `TSK-02` (contadores) e, se a aba ativa estiver visível, `TSK-01`; atualiza sem perder a posição de rolagem nem a seleção.

## Fluxos alternativos
- **FA-01 — Usuário sem `PROCESS_CLAIM` e sem titularidade/substituição de unidade:** a aba "Na fila da minha unidade" não é exibida; as demais abas funcionam normalmente.
- **FA-02 — Visão vazia:** sem itens na visão, exibe estado vazio contextual (ex.: "Nenhum processo pendente com você. Bom trabalho!" em "Comigo"; "Nenhuma aprovação pendente." em "Aprovações pendentes").
- **FA-03 — Processo ao mesmo tempo atrasado e meu:** aparece em "Comigo" (com selo de atraso) e também em "Atrasados"; não é contado duas vezes dentro da mesma aba.
- **FA-04 — Assumir falha por concorrência:** outro usuário assumiu o processo no intervalo entre a listagem e o clique; `PRC-21` responde 409 `PROCESS_ALREADY_ASSIGNED`; o front exibe "Este processo já foi assumido por outra pessoa." e recarrega a linha.
- **FA-05 — Documento com orçamento sigiloso:** linhas de processos com confidencialidade restrita (POL-09) mostram código/título/status normalmente; valores ficam mascarados conforme §1.4 de api.md.
- **FA-06 — Polling pausado:** com a aba do navegador em segundo plano, o polling de 60 s é suspenso e retomado ao voltar o foco, com atualização imediata.

## Regras de negócio
- **RN-INBOX-01** — A caixa de tarefas não é uma entidade própria; é sempre uma consulta em tempo real sobre `ProcessStage`/`ProcessAssignment` ativos e `Approval` `PENDING`, restrita ao tenant da sessão e à visibilidade de processos (DEC-024) — DEC-026.
- **RN-INBOX-02** — Visões suportadas pelo parâmetro `view`: `MINE` (comigo), `UNIT_QUEUE` (fila da minha unidade), `PENDING_APPROVALS` (aprovações pendentes), `RETURNED` (devolvidos), `OVERDUE` (atrasados), `FOLLOWING` (acompanhando). Sem `view`, o padrão é `MINE`.
- **RN-INBOX-03** — `MINE`: `ProcessAssignment` ativo com `assigneeId` = usuário atual.
- **RN-INBOX-04** — `UNIT_QUEUE`: `ProcessAssignment` ativo com `assigneeId` nulo e `departmentId` em uma unidade na qual o usuário está lotado com `PROCESS_CLAIM` (POL-04) **ou** é `headUserId`/`deputyUserId` (§7, POL-05); visão oculta para quem não se enquadra em nenhum dos casos (coerente com `PROCESS_RECEIVED`, events.md §6, e com a jornada J-08).
- **RN-INBOX-05** — `RETURNED`: `ProcessAssignment` ativo com `type = RETURN` e (`assigneeId` = usuário ou, se nulo, `departmentId` em unidade do usuário conforme RN-INBOX-04).
- **RN-INBOX-06** — `OVERDUE`: `ProcessStage` ativa com `overdueSince` preenchido, restrita aos processos que apareceriam em `MINE` ou `UNIT_QUEUE` para o usuário.
- **RN-INBOX-07** — `PENDING_APPROVALS`: `Approval` com `status = PENDING` em que o usuário é aprovador designado, conforme cobertura de POL-03/DEC-022 (direto, perfil com escopo sobre a unidade solicitante, ou titular/substituto de `approverDepartmentId`).
- **RN-INBOX-08** — `FOLLOWING`: `ProcessParticipant` ativo (`revokedAt` nulo) do usuário, qualquer `role`. Terceiro ramo da consulta (DEC-026).
- **RN-INBOX-09** — Os contadores de `TSK-02` usam exatamente os mesmos predicados de `TSK-01` por visão, sobre o mesmo instante de leitura (mesma transação/snapshot), para nunca divergir do que a lista mostra.
- **RN-INBOX-10** — Ordenação padrão `-dueAt` (nulos por último); campos permitidos: `dueAt`, `code`, `enteredAt`/`requestedAt` (conforme a visão). Paginação por página (`page`/`pageSize`, máx. 100 — §1.2 de api.md).
- **RN-INBOX-11** — A ação rápida "Assumir" só aparece em `UNIT_QUEUE`, para linhas sem responsável, quando o usuário tem `PROCESS_CLAIM` e está lotado na unidade atual do processo (POL-04); ao executar, reaproveita `PRC-21` (US-049) sem duplicar a regra de negócio.
- **RN-INBOX-12** — A consulta UNION deve usar os índices parciais de `process_assignments` e `approvals` já definidos em entities.md (`WHERE is_active`/`WHERE status = 'PENDING'`); meta de desempenho p95 < 500 ms por visão com até 10.000 processos ativos no tenant.
- **RN-INBOX-13** — O front consulta `TSK-02` e, para a aba ativa, `TSK-01` a cada 60 s (polling), pausado quando a aba do navegador não está visível.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Visão | `view` (query) | enum (`MINE`\|`UNIT_QUEUE`\|`PENDING_APPROVALS`\|`RETURNED`\|`OVERDUE`\|`FOLLOWING`) | Não | RN-INBOX-02 | `MINE` |
| Página | `page` (query) | int | Não | ≥ 1 | 1 |
| Itens por página | `pageSize` (query) | int | Não | 1–100 | 20 |
| Ordenação | `sort` (query) | texto | Não | RN-INBOX-10 | `-dueAt` |
| *(saída)* Prazo | `dueAt` | datetime | — | — | — |
| *(saída)* Em atraso | `isOverdue` | booleano | — | derivado de `overdueSince` | — |
| *(saída)* Contadores | `counters.{view}` | int | — | RN-INBOX-09 | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `view` fora do enum | API (Zod) | — (uso interno; UI não envia valor inválido) | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-02 | `pageSize` acima de 100 | API | — | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-03 | `sort` com campo não permitido para a visão | API | — | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-04 | Assumir sem `If-Match` | API | "Atualize a página e tente novamente." | `PRECONDITION_REQUIRED` |

## Permissões
- **Permissão:** `INBOX_VIEW` para acessar `TSK-01`/`TSK-02`; `PROCESS_CLAIM` (+ POL-04) apenas para a ação "Assumir".
- **Políticas:** POL-04 (assumir, reaproveitada de US-049); visibilidade de cada item segue DEC-024 (um processo só aparece se o usuário já o vê pelas regras gerais).
- **MFA:** não exigido (consulta e `PROCESS_CLAIM` são risco `L`).
- **Sem permissão:** sem `INBOX_VIEW` (caso excepcional, ex.: vínculo bloqueado), o menu "Caixa de tarefas" não é exibido e a rota retorna SCR-111 (403); a API responde 403 `PERMISSION_DENIED`.

## Eventos gerados
Nenhum evento é gerado pela própria consulta (`TSK-01`/`TSK-02` são leituras). A ação rápida "Assumir" gera `ProcessAssigned` (`process.assigned`) sob as regras de US-049 — ver story-049 para o payload completo.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação própria desta story; "Assumir" dispara o mesmo evento de US-049 (sem notificação — `PROCESS_CLAIMED` não tem destinatários, conforme events.md §6). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Caixa de tarefas unificada

  Background:
    Given que o usuário "Ana" está autenticado no tenant "Prefeitura de São José"
    And possui vínculo ativo e a permissão "INBOX_VIEW"

  Scenario: [Sucesso] Ver os processos sob minha responsabilidade
    Given que "Ana" é responsável ativa por 3 processos
    When "Ana" abrir a caixa de tarefas na visão "Comigo"
    Then a lista deve mostrar exatamente os 3 processos
    And o contador da aba "Comigo" deve ser 3

  Scenario: [Sucesso] Assumir processo da fila da unidade
    Given que "Ana" é titular da unidade "Setor de Manutenção"
    And existe o processo "0012/2026" na fila dessa unidade sem responsável
    When "Ana" clicar em "Assumir" na linha do processo "0012/2026"
    Then a API deve responder 200 e o processo deve passar a ter "Ana" como responsável
    And o processo deve sair da visão "Na fila da minha unidade" e aparecer em "Comigo"
    And deve gerar o evento "ProcessAssigned"

  Scenario: [Validação] Parâmetro de ordenação inválido para a visão
    When o front enviar "GET /tasks?view=MINE&sort=invalidField"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_ENUM" no campo "sort"

  Scenario: [Permissão] Usuário sem PROCESS_CLAIM e sem titularidade não vê a fila da unidade
    Given que "Bruno" não possui "PROCESS_CLAIM" e não é titular nem substituto de nenhuma unidade
    When "Bruno" abrir a caixa de tarefas
    Then a aba "Na fila da minha unidade" não deve ser exibida

  Scenario: [Tenant incorreto] Processo de outro tenant nunca aparece
    Given que existe um processo atribuído a um usuário com o mesmo e-mail em outro tenant
    When "Ana" abrir a caixa de tarefas no tenant "Prefeitura de São José"
    Then a lista não deve conter nenhum processo do outro tenant

  Scenario: [Duplicidade] Reenvio do "Assumir" com a mesma chave de idempotência
    Given que "Ana" assumiu o processo "0012/2026" com a chave "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o mesmo resultado e o cabeçalho "Idempotent-Replayed: true"

  Scenario: [Concorrência] Dois membros da unidade tentam assumir o mesmo processo
    Given que o processo "0012/2026" está na fila sem responsável
    When "Ana" e "Carlos" clicarem em "Assumir" quase simultaneamente
    Then exatamente um deles deve receber 200
    And o outro deve receber 409 com código "PROCESS_ALREADY_ASSIGNED"

  Scenario: [Falha de banco] Banco indisponível ao consultar a caixa
    Given que o banco de dados está indisponível
    When "Ana" abrir a caixa de tarefas
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And a UI deve exibir "Não foi possível carregar sua caixa de tarefas agora." com botão "Tentar novamente"

  Scenario: [Falha de integração] Redis indisponível durante o polling
    Given que o Redis está indisponível
    When o polling de 60 s executar
    Then a consulta "TSK-01"/"TSK-02" deve continuar funcionando sem idempotência de cache
    And deve ser registrado log "warn" "idempotency.store_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| `view`/`sort` inválidos | 422 | `VALIDATION_ERROR` | — (não ocorre via UI) | Ignora e usa padrão |
| Sem `INBOX_VIEW` | 403 | `PERMISSION_DENIED` | "Você não tem acesso à caixa de tarefas." | Oculta menu; rota 403 |
| Assumir já atribuído | 409 | `PROCESS_ALREADY_ASSIGNED` | "Este processo já foi assumido por outra pessoa." | Recarrega a linha |
| Assumir sem `If-Match` | 428 | `PRECONDITION_REQUIRED` | "Atualize a página e tente novamente." | Recarrega a lista |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar sua caixa de tarefas agora." | Botão "Tentar novamente" |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |

## Dependências
- **Stories:** US-049 (assumir — reaproveitado pela ação rápida e por `PRC-21`); US-051 (solicitação de aprovação — origem das `Approval` `PENDING`). Indiretas: US-097 (permissões/escopos), US-102 (unidades, titular/substituto), US-106 (prazos úteis).
- **Decisões/ADRs:** DEC-024, DEC-026, DEC-031.
- **Configurações:** `deadlines.warnBeforeBusinessDays`.
- **Lacunas nas fontes canônicas:** nenhuma (visão "Acompanhando" incorporada a DEC-026).

## Impacto técnico
- Introduz a primeira consulta `UNION` multi-fonte do produto (`process_assignments` ∪ `approvals` ∪ `process_participants`); todas as pernas da UNION devem usar os índices parciais existentes — nenhuma nova migração é necessária além de, possivelmente, um índice para `FOLLOWING` (`(tenant_id, user_id) WHERE revoked_at IS NULL` em `process_participants`, a confirmar com o dono de entities.md).
- Débito técnico monitorado: se a consulta não sustentar p95 < 500 ms em produção, DEC-026 prevê a criação de um read model dedicado (ex.: tabela `inbox_items` mantida por projeção) — não faz parte do escopo desta story.
- Contadores e lista devem ler o mesmo snapshot (uma única transação `READ COMMITTED`) para não divergir sob concorrência.

## Backend
- **Módulo(s):** `process` (dono das consultas sobre `ProcessStage`/`ProcessAssignment`); usa `approval` (consulta de `Approval` `PENDING`), `organization` (resolução de titular/substituto), `access` (filtro de visibilidade DEC-024).
- **Casos de uso:** `GetTaskInboxQuery` → `GetTaskInboxHandler` (TSK-01); `GetTaskInboxCountersQuery` → `GetTaskInboxCountersHandler` (TSK-02).
- **Domínio:** sem novas entidades (DEC-026); `InboxView` como enum técnico desta story (não persistido).
- **Integrações internas:** `AuthorizationService` (visibilidade e `INBOX_VIEW`), `DepartmentFacade.isHeadOrDeputy(userId, departmentId)`.
- **Transação:** leitura única (sem efeitos colaterais); "Assumir" delega inteiramente à transação de `PRC-21` (US-049).

## Frontend
- **Tela(s):** SCR-013 (`/tarefas`).
- **Componentes:** `InboxTabs` (com contadores), `InboxTable` (colunas por visão), `QuickClaimButton`, `OverdueBadge`, `EmptyState` por visão.
- **Estados:** skeleton nas abas e na tabela; vazio por visão (FA-02); erro com "Tentar novamente"; linha em estado "assumindo…" durante a chamada.
- **Acessibilidade e responsividade:** abas navegáveis por teclado (`role="tablist"`); contadores lidos por leitor de tela ao trocar de aba; em telas < 768 px a tabela vira lista de cartões; contraste AA.

## Banco de dados
- **Tabelas:** leitura em `process_stages`, `process_assignments`, `approvals`, `process_participants`, `processes`; nenhuma tabela nova.
- **Migrações:** nenhuma prevista; possível índice adicional em `process_participants` para a visão `FOLLOWING` (ver Impacto técnico).
- **Índices/constraints relevantes:** reaproveita `(tenant_id, assignee_id) WHERE is_active`, `(tenant_id, department_id) WHERE is_active AND assignee_id IS NULL` (process_assignments); `(tenant_id, approver_user_id|approver_department_id|approver_role_id) WHERE status = 'PENDING'` (approvals); `(tenant_id, due_at) WHERE status = 'ACTIVE'` (process_stages, para `OVERDUE`).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| TSK-01 | GET | `/api/v1/tasks` | `?view=&page=&pageSize=&sort=` | `200 { data: [{ processId, code, title, currentStage, currentDepartment, currentResponsible?, dueAt, isOverdue, approval? }], meta: { page, pageSize, totalItems, totalPages } }` | 200, 401, 403, 422, 429, 500, 503 |
| TSK-02 | GET | `/api/v1/tasks/counters` | — | `200 { data: { mine, unitQueue?, pendingApprovals, returned, overdue, following } }` | 200, 401, 403, 429, 500, 503 |
| PRC-21 | POST | `/api/v1/processes/{id}/claim` | *(reaproveitado de US-049; `If-Match`, `Idempotency-Key`)* | `200 { data: Process }` | 200, 401, 403, 404, 409, 412, 428 |

## Logs
- `info` `inbox.query` — `view`, `resultCount`, `durationMs`, `tenantId`, `userId`, `correlationId`.
- `warn` `inbox.slow_query` — quando `durationMs` > 500 ms.
- `warn` `idempotency.store_unavailable` — quando o Redis falhar durante "Assumir".
- `error` `inbox.query_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** título/objeto do processo, comentários de aprovação.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | Consultas (`TSK-01`/`TSK-02`) não geram auditoria (leitura pura) | — |
| `process.claim` | `WORKFLOW` | Ação "Assumir" (delegada a US-049) | Ver story-049 |

## Testes necessários
- **Unitários:** predicados de cada `view` (RN-INBOX-03..08); ordenação e paginação; cálculo de `isOverdue`.
- **Integração (Testcontainers):** UNION com dados de múltiplas unidades/aprovadores; RLS impede itens de outro tenant; contadores batem com a lista na mesma visão.
- **Concorrência:** duas chamadas de "Assumir" simultâneas sobre o mesmo processo → uma 200, outra 409.
- **API/contrato:** respostas conforme api.md; paginação e `sort` documentados no OpenAPI.
- **RBAC e multi-tenant:** `UNIT_QUEUE` oculta para quem não tem `PROCESS_CLAIM` na unidade nem titularidade/substituição; `PENDING_APPROVALS` restrita à cobertura de POL-03.
- **E2E (Playwright):** trocar de aba, ordenar, assumir um processo e ver o contador atualizar.
- **Acessibilidade/performance:** axe sem violações sérias; k6 com tenant de 10.000 processos ativos → p95 < 500 ms por visão.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `INBOX_VIEW`/`PROCESS_CLAIM` aplicados na API; abas condicionais aplicadas na UI
- [ ] Contadores e lista comprovadamente consistentes (mesmo snapshot) em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de TSK-01 e TSK-02 compatível com api.md
- [ ] Logs sem dados sensíveis; métrica `inbox_query_duration_ms` (p95 monitorado)
- [ ] Acessibilidade (axe) e responsividade (360 px) verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Visão "Acompanhando" (RN-INBOX-08) coberta por teste de integração da consulta (DEC-026)

## Estimativa
**L** — introduz a consulta UNION multi-fonte que sustenta todo o épico, com seis visões, contadores consistentes, ordenação, paginação, ação rápida integrada a outra story e meta de desempenho sob carga.

## Prioridade
**P0** — sem a caixa de tarefas não há ponto de entrada diário para o trabalho operacional; feature central do épico.
