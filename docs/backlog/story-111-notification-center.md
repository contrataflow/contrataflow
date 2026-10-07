---
id: US-111
title: "Central de notificações in-app"
epic: EP-019
feature: FT-059
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-083, US-086]
modules: [notification]
screens: [SCR-036]
endpoints: [NTF-01, NTF-02, NTF-03, NTF-04, NTF-05]
permissions: []
events: []
---

# US-111 — Central de notificações in-app

## Título
Central de notificações in-app

## Descrição
**Como** usuário com vínculo ativo em um tenant, **quero** ver em um só lugar os avisos sobre o que aconteceu nos processos que me interessam, **para** saber o que precisa da minha atenção sem depender de e-mail ou de perguntar a colegas.

Esta story entrega o `NotificationDispatcher`: o consumidor que lê a fila `notifications` (alimentada pelo roteador do outbox — DEC-161/163), resolve os destinatários de cada evento de domínio conforme o registro `NotificationType` (events.md §6), grava `Notification` com idempotência e agrupamento, e expõe a central in-app (sininho + lista) com contagem de não lidas, marcação de leitura e arquivamento.

## Contexto
- Hoje o usuário só descobre que um processo chegou, foi devolvido ou precisa de aprovação olhando a caixa de tarefas (US-013) ou por aviso informal (corredor, WhatsApp). Isso atrasa decisões e dá a sensação de que "o processo trava sem avisar".
- O registro `NotificationType` (events.md §6) já define, por evento, quem é notificado, se há e-mail por padrão e se o tipo é obrigatório; esta story implementa o motor genérico que aplica esse registro a **todo** evento do catálogo (events.md §4), não um caso por tipo.
- Regras gerais do registro aplicadas pelo motor: nunca notificar o próprio ator, respeitar a visibilidade do processo (DEC-024), agrupar notificações iguais em 5 minutos, nunca incluir dados sigilosos (POL-09) e só enfileirar e-mail conforme `notifications.emailEnabled` e preferência do usuário (US-113).
- Entrega *at-least-once* pelo outbox (DEC-161); o dispatcher precisa ser idempotente por natureza, não apenas "tentar não duplicar".

## Objetivo
Garantir que 100% dos eventos mapeados no registro `NotificationType` gerem notificação in-app para os destinatários corretos em até 1 minuto, sem duplicidade por reentrega, e que o usuário veja a contagem de não lidas atualizada em qualquer tela do produto.

## Persona
- **Principal:** qualquer usuário com vínculo ativo no tenant (destinatário).
- **Secundárias:** Gestor de contratações e Autoridade (acompanham aprovações e devoluções); administrador do órgão (diagnostica avisos não entregues via logs).

## Pré-condições
- Usuário autenticado (US-087), vínculo `ACTIVE` no tenant.
- Infraestrutura de filas e outbox em operação (US-083) e os demais pré-requisitos de plataforma indicados no backlog do épico (US-086).
- O evento de origem já foi publicado no outbox na mesma transação do caso de uso que o gerou (DEC-161).

## Fluxo principal
1. Um caso de uso qualquer do produto grava seu evento (ex.: `ProcessStageChanged`) em `outbox_events` na própria transação.
2. O relay do outbox publica o evento; o roteador de domain-events replica para a fila `notifications` (DEC-163).
3. O `NotificationDispatcher` consome o job, carrega o evento e consulta o registro `NotificationType` (events.md §6) pelo `eventType`; sem correspondência, descarta e registra log `warn`.
4. Resolve os destinatários conforme a coluna "Destinatários" do tipo encontrado, excluindo sempre o ator do evento e qualquer destinatário sem visibilidade do processo (DEC-024).
5. Para cada destinatário, verifica se já existe uma `Notification` do mesmo `(tenant, destinatário, type, processId)` criada há menos de 5 minutos e não arquivada: se existir e o evento ainda não constar em `sourceEventId`/`groupedEventIds`, **atualiza** essa linha (`groupCount + 1`, evento acrescentado a `groupedEventIds`, `title`/`body`/`link` atualizados, `readAt = NULL`; `sourceEventId` preserva o primeiro evento); se já constar, é reentrega e nada muda; senão, **insere** uma nova linha com `sourceEventId = eventId` (a unicidade `(tenant_id, recipient_id, source_event_id, type)` torna a reentrega do mesmo evento um no-op).
6. Decide `emailStatus`: `PENDING` se o tipo permite e-mail (padrão do registro ou preferência do usuário — US-113) e `notifications.emailEnabled` do tenant está ativo; caso contrário `SKIPPED`. Se `PENDING`, enfileira na fila `email` com `jobId = notificationId` (US-112).
7. O front mantém o contador de não lidas (`NTF-02`) atualizado; ao abrir o painel de notificações (SCR-036), chama `NTF-01` paginado por cursor.
8. O usuário marca uma notificação como lida (`NTF-03`), todas como lidas (`NTF-04`) ou arquiva uma notificação (`NTF-05`); a lista e o contador são atualizados de imediato.

## Fluxos alternativos
- **FA-01 — Destinatário resolvido para uma unidade:** quando o tipo resolve para "membros lotados" (ex.: `PROCESS_RECEIVED` sem responsável), notifica cada membro ativo da unidade com a permissão indicada no registro, até 50; acima disso, mantém o comportamento de fallback já praticado em `APPROVAL_REQUESTED` (notifica a unidade, não cada pessoa).
- **FA-02 — Tipo obrigatório:** para tipos marcados "obrigatória" (ex.: `APPROVAL_REQUESTED`, `ATTACHMENT_REJECTED`, `ROLE_CHANGED`), a notificação IN_APP é sempre criada, independentemente de preferência (US-113 impede desativar o canal).
- **FA-03 — Destinatário perdeu visibilidade:** se, no momento do processamento, o destinatário resolvido não tem mais visibilidade do processo (DEC-024), a notificação não é criada para ele; os demais destinatários não são afetados.
- **FA-04 — Lista vazia:** sem notificações, SCR-036 mostra estado vazio ("Nenhuma notificação por aqui ainda").
- **FA-05 — Notificação com link para recurso já alterado:** ao clicar, o front navega normalmente; se o recurso não existir mais/não for mais visível, a tela de destino mostra seu próprio estado 404 (esta story não valida o link no momento do clique).

## Regras de negócio
- **RN-NTF-01** — O dispatcher só cria notificação para `eventType` presente no registro `NotificationType` (events.md §6); tipos não mapeados são descartados com log, nunca com erro fatal do job.
- **RN-NTF-02** — O ator do evento nunca é destinatário da própria notificação, mesmo que a resolução de destinatários o incluiria.
- **RN-NTF-03** — Idempotência por `(tenant_id, recipient_id, source_event_id, type)`; reentrega do mesmo evento não gera segunda linha.
- **RN-NTF-04** — Agrupamento: antes de inserir, procura uma `Notification` do mesmo destinatário e `groupKey` (`{type}:{processId}`) criada há menos de 5 minutos e não arquivada; se existir e o evento ainda não constar em `sourceEventId`/`groupedEventIds`, atualiza-a (`groupCount + 1`, evento em `groupedEventIds`, conteúdo e `readAt = NULL`) em vez de inserir outra; se já constar, a reentrega é ignorada (idempotência preservada).
- **RN-NTF-05** — E-mail só é enfileirado (`emailStatus = PENDING`) quando `notifications.emailEnabled` (tenant) é verdadeiro **e** a preferência do usuário para `(type, EMAIL)` permite (ausência de preferência = padrão do registro); caso contrário `emailStatus = SKIPPED`.
- **RN-NTF-06** — Destinatário deve ter visibilidade do processo associado (DEC-024) no momento do processamento; sem visibilidade, não recebe a notificação.
- **RN-NTF-07** — `title` (≤200) e `body` (≤1000) nunca contêm dados sigilosos (POL-09) nem valores mascarados; usam apenas rótulos, nomes e trechos já truncados na origem (ex.: `excerpt` de comentário).
- **RN-NTF-08** — `link` é sempre rota relativa (`/processos/{id}`, `/aprovacoes/{id}`), nunca URL absoluta ou com token.
- **RN-NTF-09** — Notificações com `expiresAt` preenchido e vencido não aparecem na lista padrão nem contam para não lidas.
- **RN-NTF-10** — Contagem de não lidas (`NTF-02`) = não arquivadas, não expiradas e `readAt IS NULL`.
- **RN-NTF-11** — Marcar como lida/arquivar (`NTF-03`/`NTF-05`) só se aplica a notificações do próprio `recipientId`; é idempotente (repetir a ação não é erro).
- **RN-NTF-12** — "Marcar todas como lidas" (`NTF-04`) afeta somente as notificações do usuário autenticado no tenant ativo.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| — | `type` | `NotificationType` (registro) | — | RN-NTF-01 | evento de origem |
| — | `title` / `body` | texto | — | ≤200 / ≤1000; RN-NTF-07 | template do tipo |
| — | `link` | texto | — | rota relativa; RN-NTF-08 | template do tipo |
| — | `readAt` / `archivedAt` | timestamptz (sistema) | — | somente leitura para o usuário via `NTF-03`/`NTF-05` | `NULL` |
| — | `emailStatus` | `EmailDeliveryStatus` | — | RN-NTF-05 | `NOT_APPLICABLE`/`PENDING`/`SKIPPED` |
| Filtro "Não lidas" | `unreadOnly` | booleano (query) | Não | — | `false` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `cursor`/`limit` inválidos em `NTF-01` | API (Zod) | "Não foi possível carregar as notificações." | `VALIDATION_ERROR` |
| V-02 | Notificação de outro destinatário (ou inexistente/outro tenant) em `NTF-03`/`NTF-05` | API | "Notificação não encontrada." | `NOTIFICATION_NOT_FOUND` |
| V-03 | Evento sem correspondência no registro `NotificationType` | Worker (interno) | — (sem impacto visível ao usuário) | — (log `warn`, sem erro de API) |
| V-04 | Destinatário resolvido sem visibilidade do processo | Worker (interno) | — | — (notificação não criada para esse destinatário) |

## Permissões
- **Permissão:** nenhum código formal no catálogo (permissions.md não lista permissão própria; endpoints `NTF-*` são capacidade implícita sobre o próprio recurso, como os `ME-*`).
- **Políticas:** POL-09 (conteúdo nunca traz valores sigilosos); DEC-024 (visibilidade do processo condiciona a criação, não é checada de novo na leitura — a notificação só existe para quem já era visível).
- **MFA:** não exigido.
- **Sem permissão:** usuário não autenticado → 401 `UNAUTHENTICATED`; notificação de outro usuário → 404 `NOTIFICATION_NOT_FOUND` (nunca revela que pertence a outra pessoa).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum. Esta story **consome** a fila `notifications`; não publica eventos de domínio novos. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| *(todos os tipos de `NotificationType`, exceto `STAGE_DUE_SOON`/`STAGE_OVERDUE` — US-114)* | Conforme events.md §6 | IN_APP sempre; EMAIL conforme registro/preferência | A cada evento mapeado |

## Critérios de aceite em Gherkin
```gherkin
Feature: Central de notificações in-app

  Background:
    Given que o usuário "Carla" está autenticado no tenant "Prefeitura de São José"
    And possui vínculo ativo e visibilidade do processo "0012/2026"

  Scenario: [Sucesso] Evento gera notificação in-app
    Given que o processo "0012/2026" foi devolvido para "Carla"
    When o evento "ProcessStageChanged" (RETURN) for processado
    Then deve ser criada uma notificação do tipo "PROCESS_RETURNED" para "Carla"
    And o contador de não lidas de "Carla" deve aumentar em 1

  Scenario: [Validação] Parâmetro de paginação inválido
    When o front chamar "GET /api/v1/notifications?limit=abc"
    Then a API deve responder 422 com código "VALIDATION_ERROR"

  Scenario: [Permissão] Marcar como lida notificação de outro usuário
    Given que a notificação "N1" pertence ao usuário "Bruno"
    When "Carla" enviar "POST /api/v1/notifications/N1/read"
    Then a API deve responder 404 com código "NOTIFICATION_NOT_FOUND"

  Scenario: [Tenant incorreto] Notificação de outro tenant
    Given que a notificação "N2" pertence ao tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura de São José", solicitar "N2"
    Then a API deve responder 404 com código "NOTIFICATION_NOT_FOUND"

  Scenario: [Duplicidade] Reentrega do mesmo evento
    Given que o evento "E1" já gerou a notificação "PROCESS_RETURNED" para "Carla"
    When o job da fila "notifications" para "E1" for reprocessado (reentrega at-least-once)
    Then nenhuma notificação adicional deve ser criada para "Carla"

  Scenario: [Concorrência] Agrupamento de eventos próximos
    Given que "Carla" recebeu uma notificação "COMMENT_REPLY" no processo "0012/2026" há 2 minutos
    When um novo comentário gerar outro evento "COMMENT_REPLY" no mesmo processo para "Carla"
    Then a notificação existente deve ser atualizada (mesmo "id", novo "sourceEventId")
    And nenhuma segunda notificação deve existir para esse par processo/destinatário

  Scenario: [Falha de banco] Banco indisponível ao processar o job
    Given que o banco de dados está indisponível
    When o "NotificationDispatcher" tentar gravar a notificação
    Then o job deve falhar e ser reprocessado conforme a política da fila "notifications"
    And nenhuma notificação parcial deve ficar gravada

  Scenario: [Falha de integração] Fila ou Redis indisponível
    Given que a fila "notifications" está indisponível
    When um evento mapeado for publicado
    Then o evento deve permanecer "PENDING" no outbox
    And deve ser processado sem perda quando a fila voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Não autenticado | 401 | `UNAUTHENTICATED` | "Faça login para ver suas notificações." | Redireciona ao login |
| Notificação de outro usuário/tenant | 404 | `NOTIFICATION_NOT_FOUND` | "Notificação não encontrada." | Remove da lista local |
| Parâmetros inválidos | 422 | `VALIDATION_ERROR` | "Não foi possível carregar as notificações." | Mantém lista anterior; botão "Tentar novamente" |
| Vínculo inativo | 403 | `MEMBERSHIP_INACTIVE` | "Seu acesso a este órgão não está ativo." | Redireciona para SCR-111 |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar suas notificações agora." | Botão "Tentar novamente"; sininho mostra último contador em cache |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Mantém estado atual |

## Dependências
- **Stories:** US-083 (pré-requisito — fila `notifications` e infraestrutura de workers/outbox); US-086 (pré-requisito de plataforma indicado no backlog do épico — seção 2); US-113 (preferências, consultadas por este motor); US-055 e demais produtoras de eventos (events.md §4) alimentam o dispatcher, mas não precisam estar concluídas para esta story — o motor é genérico.
- **Decisões/ADRs:** DEC-024, DEC-161, DEC-163, DEC-138.
- **Configurações:** `notifications.emailEnabled`.
- **Lacunas nas fontes canônicas:** nenhuma (`groupKey`/`groupCount`/`groupedEventIds` registrados em entities.md para o agrupamento de 5 min com idempotência na reentrega).

## Impacto técnico
- Primeiro consumidor assíncrono real do roteador de domain-events (DEC-161/163); estabelece o padrão de "worker idempotente por chave natural" que `EmailSender` (US-112) e futuros consumidores (`search-index`, `webhooks`) devem seguir.
- O agrupamento por janela de 5 minutos exige leitura+decisão (`SELECT … FOR UPDATE` seguido de `UPDATE` ou `INSERT`) por destinatário; sob alta concorrência (vários eventos quase simultâneos no mesmo processo) o lock de linha evita corrida, mas aumenta a latência do job — aceitável no volume esperado (dezenas de eventos/min por tenant).
- `NotificationPresenter` deve mascarar qualquer campo que viole POL-09 por engano na origem (defesa em profundidade, já que RN-NTF-07 deveria impedir isso na escrita).

## Backend
- **Módulo(s):** `notification` (dono); usa fachadas de `access` (`AuthorizationService` para visibilidade — DEC-024, e verificação de vínculo `ACTIVE`), `organization` (`DepartmentFacade` para resolver titular/membros da unidade).
- **Casos de uso:** `DispatchNotificationJob` (consumidor da fila `notifications`); `ListNotificationsQuery`, `GetUnreadCountQuery`, `MarkNotificationReadCommand`, `MarkAllReadCommand`, `ArchiveNotificationCommand`.
- **Domínio:** `NotificationRegistry` (mapa `eventType` → regra de destinatários/canais, carregado de events.md §6 como configuração versionada em `packages/types`); `Notification.upsertGrouped(...)`.
- **Integrações internas:** enfileira em `email` (US-112) quando `emailStatus = PENDING`.
- **Transação:** por destinatário, busca+decisão (grupo ou nova linha) e gravação de `emailStatus` ocorrem na mesma transação; o enfileiramento em `email` segue o padrão B (após commit, com `jobId = notificationId`).

## Frontend
- **Tela(s):** SCR-036 (`/notificacoes`) e sininho global no cabeçalho (todas as telas).
- **Componentes:** `NotificationBell` (contador), `NotificationPanel` (lista curta no dropdown), `NotificationList` (página completa, paginada por cursor), `NotificationItem` (ícone por tipo, título, tempo relativo, estado lido/não lido).
- **Dados:** TanStack Query — `['t', tenantId, 'notifications', 'unread-count']` (refetch periódico ou via canal em tempo real — US-086), `['t', tenantId, 'notifications', 'list']` (`useInfiniteQuery` por cursor); mutações invalidam ambas.
- **Estados:** skeleton na primeira carga; vazio ("Nenhuma notificação por aqui ainda"); erro com "Tentar novamente"; item "lido" com estilo atenuado.
- **Acessibilidade e responsividade:** contador anunciado via `aria-live="polite"`; lista navegável por teclado; painel do sininho vira página cheia em telas < 768 px.

## Banco de dados
- **Tabelas:** `notifications`.
- **Migrações:** criação de `notifications` conforme entities.md (módulo `notification`), com `UNIQUE (tenant_id, recipient_id, source_event_id, type)` e os índices indicados.
- **Índices/constraints relevantes:** `(tenant_id, recipient_id, read_at, created_at DESC)` para lista e contagem; `(email_status) WHERE email_status = 'PENDING'` para o `EmailSender` (US-112); RLS `ENABLE`+`FORCE` por `tenant_id`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| NTF-01 | GET | `/api/v1/notifications` | `?cursor&limit&unreadOnly` | `200 { data: [Notification], meta: { nextCursor, hasMore } }` | 200, 401, 403, 422 |
| NTF-02 | GET | `/api/v1/notifications/unread-count` | — | `200 { data: { count } }` | 200, 401, 403 |
| NTF-03 | POST | `/api/v1/notifications/{id}/read` | — | `200 { data: Notification }` | 200, 401, 404 |
| NTF-04 | POST | `/api/v1/notifications/read-all` | — | `200 { data: { updated } }` | 200, 401, 403 |
| NTF-05 | POST | `/api/v1/notifications/{id}/archive` | — | `200 { data: Notification }` | 200, 401, 404 |

## Logs
- `info` `notification.dispatched` — `eventType`, `notificationType`, `recipientCount`, `groupedCount`, `durationMs`, `correlationId`.
- `warn` `notification.type_unmapped` — `eventType` sem entrada no registro.
- `warn` `notification.recipient_unresolved` — tipo sem destinatário resolvido.
- `error` `notification.dispatch_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** `title`/`body` completos (podem conter nomes de terceiros), e-mail completo do destinatário (mascarado — DEC-138).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | — | O dispatcher não grava `AuditLog`: criação de notificação é projeção de sistema, não ação de usuário (DEC-161). Leitura/arquivamento tampouco são auditados (baixo valor, alto volume). |

## Testes necessários
- **Unitários:** `NotificationRegistry` (mapeamento completo dos tipos de events.md §6); regra de agrupamento (janela de 5 min, fronteiras); exclusão do ator; exclusão por visibilidade.
- **Integração (Testcontainers PostgreSQL + Redis):** idempotência por `sourceEventId` sob reentrega; agrupamento com `SELECT … FOR UPDATE`; RLS por tenant.
- **API/contrato:** `NTF-01..05` conforme api.md (paginação por cursor, 404 ao acessar notificação de outro usuário).
- **RBAC e multi-tenant:** notificação de outro tenant/usuário sempre 404; nunca vaza em listagem.
- **Concorrência:** dois eventos quase simultâneos do mesmo tipo/processo/destinatário → uma única notificação.
- **E2E (Playwright):** evento de devolução de processo aparece no sininho e na lista em menos de 1 min (ambiente de teste com fila síncrona).
- **Acessibilidade/performance:** axe no painel e na lista; `GET /notifications` com 10k linhas por usuário → p95 < 300 ms.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (worker + API + E2E) e passando no CI
- [ ] `NotificationRegistry` cobre 100% dos tipos de events.md §6 com teste por tipo
- [ ] Idempotência e agrupamento comprovados por teste de reentrega e concorrência
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de NTF-01..05 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas `notification_dispatched_total`, `notification_email_skipped_total`
- [ ] UI do sininho e da lista acessível (axe) e responsiva (360 px)
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — motor genérico reutilizável (idempotência, agrupamento, resolução de destinatários por registro) mais 5 endpoints e a UI do sininho/lista; sem transação de negócio complexa nem numeração concorrente.

## Prioridade
**P0** — sem a central, nenhum outro tipo de aviso (e-mail, preferências, lembretes) tem onde aparecer; é a base das demais stories do épico.
