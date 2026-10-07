---
id: US-082
title: "Eventos de domínio com outbox transacional"
epic: EP-015
feature: FT-048
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-081]
modules: [platform]
screens: []
endpoints: []
permissions: []
events: []
---

# US-082 — Eventos de domínio com outbox transacional

## Título
Eventos de domínio com outbox transacional

## Descrição
**Como** pessoa desenvolvedora backend do ContrataFlow, **quero** um `OutboxWriter` que grave eventos de domínio na mesma transação da mudança de estado e um relay que os publique de forma confiável, **para** que nenhum fato de negócio (ex.: `ProcessCreated`) seja perdido, duplicado de forma visível ou publicado antes de o estado correspondente existir.

Esta story entrega a camada de aplicação sobre a tabela `outbox_events` (criada em US-081): o `OutboxWriter` (grava o envelope do evento — DEC-160 — na transação do caso de uso), os handlers síncronos in-process (`TimelineProjector`, `ProcessAccessProjector`), e o relay no worker (líder único, lotes com `SKIP LOCKED` + `LISTEN/NOTIFY`, publicação na fila `domain-events` com `jobId = eventId`) com fan-out por `routingKey` para as filas consumidoras e purga dos eventos já publicados.

## Contexto
- O produto depende de projeções e integrações reagirem a fatos de negócio (timeline, notificações, e-mail, métricas, auditoria de permissões) sem acoplar a latência desses efeitos à resposta da API, e sem o risco clássico de "escrevi no banco mas não publiquei o evento" (ou o inverso).
- [ADR-004](../adr/adr-004-outbox-events.md) decidiu o padrão *Transactional Outbox* em vez de publicar após o commit (perde eventos em queda) ou CDC/Debezium (operação complexa para o volume do MVP 1); a tabela já existe (US-081), esta story entrega o comportamento.
- DEC-160 define o envelope único; DEC-161 define a separação entre handlers síncronos (mesma transação) e assíncronos (via relay); DEC-162 define que nomes especializados (`DFDCreated`, `ProcessForwarded`…) são o **mesmo** evento genérico publicado com `routingKey` especializada — não eventos novos.
- US-001 (criação de processo) já pressupõe este mecanismo nos seus critérios de aceite ("evento `ProcessCreated` permanece `PENDING` até o relay voltar"); esta story é o que torna aquele comportamento verdadeiro.

## Objetivo
100% das mudanças de estado relevantes publicam seu evento no outbox na mesma transação (zero perda, zero publicação de evento "fantasma" sem commit); o lag do relay (commit → `PUBLISHED`) fica sob o SLO de revisão do ADR-004 (p95 < 5 s com relay saudável) mesmo após reinício do worker; nenhum consumidor recebe o mesmo efeito de negócio duas vezes de forma não idempotente.

## Persona
- **Principal:** Pessoa desenvolvedora backend do ContrataFlow (usa `OutboxWriter` em cada caso de uso; implementa consumidores do relay).
- **Secundárias:** Pessoa desenvolvedora de observabilidade (monitora lag e `dead-letter` do relay — US-085); operador de plataforma (reprocessamento/replay, US-083).

## Pré-condições
- US-081 concluída: tabela `outbox_events` com RLS, papel `cf_relay` criado (privilégios restritos) e `TenantTransaction` disponível.
- Fila `domain-events` e demais filas do MVP 1 reservadas em BullMQ (consumidas plenamente a partir de US-083).

## Fluxo principal
1. Um caso de uso de qualquer módulo (ex.: `CreateProcessHandler`, US-001) altera o estado do agregado e chama `OutboxWriter.record(event)` **na mesma transação** (`TenantTransaction` — US-081), passando o envelope conforme DEC-160 (`eventId` UUIDv7, `eventType`, `routingKey`, `eventVersion`, `occurredAt`, `tenantId`, `aggregateType`, `aggregateId`, `processId`, `actor`, `correlationId`, `causationId`, `payload`).
2. Ainda na mesma transação, os **handlers síncronos in-process** (`TimelineProjector`, `ProcessAccessProjector` — os únicos previstos no MVP 1, DEC-161) reagem ao evento e gravam suas projeções; qualquer erro desfaz a transação inteira (nem o agregado, nem o evento, nem a projeção são gravados).
3. Ao confirmar o commit, o PostgreSQL entrega `pg_notify('cf_outbox', …)` — sinal de baixa latência, nunca a única garantia.
4. No worker (`apps/worker`, DEC-052), o relay roda como **líder único** por *advisory lock*; a cada ciclo, seleciona até 100 linhas `PENDING` com `SELECT … FOR UPDATE SKIP LOCKED ORDER BY (occurred_at, id)` usando o papel `cf_relay`.
5. Para cada linha, o relay publica um job na fila BullMQ `domain-events` com `jobId = eventId` (deduplicação natural do BullMQ em caso de reprocessamento) e marca a linha como `PUBLISHED` com `publishedAt = now()`.
6. O `DomainEventsProcessor` consome `domain-events` e faz **fan-out por `routingKey`**: enfileira os consumidores assinantes (`notifications`, depois `email` em cadeia) e executa handlers leves idempotentes in-process (`PermissionCacheInvalidator`, `BusinessMetricsCollector`), cada um deduplicado por `eventId`.
7. Falha ao publicar uma linha incrementa `attempts` e calcula `nextAttemptAt` (backoff); após 10 tentativas a linha vira `FAILED` com alerta crítico — o restante do lote continua normalmente.
8. O job diário `outbox-purge` (US-083) remove linhas `PUBLISHED` com `publishedAt` há mais de 7 dias (DEC-085), em lotes, sem tocar `PENDING`/`FAILED`.

## Fluxos alternativos
- **FA-01 — Redis das filas indisponível:** o relay não consegue publicar; a transação de marcação sofre rollback (linhas voltam a `PENDING`, travas liberadas) e o laço tenta de novo com backoff até 30 s — nenhum evento é perdido nem publicado em duplicidade quando o Redis volta.
- **FA-02 — Queda do líder do relay:** outra réplica assume a trava em até 5 s; o lote em andamento na réplica caída sofre rollback (linhas continuam `PENDING`).
- **FA-03 — Linha com payload inválido/maior que o limite:** só aquela linha segue para backoff isolado; o restante do lote é processado normalmente.
- **FA-04 — Replay manual:** CLI auditada do worker (`PLATFORM_QUEUE_ADMIN` + MFA) republica um intervalo de eventos já `PUBLISHED` para um consumidor específico, sem duplicar efeito graças à idempotência por `eventId` (US-083).

## Regras de negócio
- **RN-FND-49** — Toda mudança de estado que produz um fato de domínio grava uma linha em `outbox_events` **na mesma transação** da mudança (DEC-161), via `OutboxWriter.record`; nenhum caso de uso publica diretamente em um broker.
- **RN-FND-50** — O envelope do evento segue DEC-160 integralmente; campos ausentes ou de tipo incorreto são rejeitados pelo `OutboxWriter` antes do commit (falha do caso de uso, não gravação parcial).
- **RN-FND-51** — Nomes especializados (DEC-162, ex.: `DFDCreated`, `ProcessForwarded`) não geram linha própria: é o mesmo `eventType` genérico com `routingKey` especializada calculada a partir do tipo/causa do agregado.
- **RN-FND-52** — Handlers síncronos in-process (mesma transação) só existem para `TimelineProjector` e `ProcessAccessProjector` (DEC-161); qualquer outro efeito é assíncrono via relay. Handler síncrono que lança erro desfaz a transação inteira, inclusive a linha do outbox.
- **RN-FND-53** — A auditoria (`AuditLog`) é gravada explicitamente pelo caso de uso via `AuditService`, na mesma transação — **não depende** do outbox nem é acoplada à publicação (DEC-161).
- **RN-FND-54** — O relay roda com líder único por *advisory lock* (DEC-052); réplicas em espera não processam lotes simultaneamente.
- **RN-FND-55** — O relay seleciona lotes de até 100 linhas `PENDING` com `FOR UPDATE SKIP LOCKED ORDER BY (occurred_at, id)`, publica cada uma com `jobId = eventId` e marca `PUBLISHED`+`publishedAt` somente após confirmação do enfileiramento.
- **RN-FND-56** — O relay usa exclusivamente o papel `cf_relay` (`BYPASSRLS` restrito a `SELECT`/`UPDATE` em `outbox_events`); nenhuma outra tabela é acessível por esse papel.
- **RN-FND-57** — Falha ao publicar uma linha incrementa `attempts` e agenda `nextAttemptAt` com backoff; após 10 tentativas a linha vira `FAILED` com alerta crítico; o restante do lote não é bloqueado por essa falha.
- **RN-FND-58** — O fan-out por `routingKey` (`DomainEventsProcessor`) distribui para as filas assinantes do MVP 1 (`notifications`, `email` em cadeia) e para os handlers leves (`PermissionCacheInvalidator`, `BusinessMetricsCollector`); todo assinante é idempotente por `eventId`.
- **RN-FND-59** — Linhas `PUBLISHED` são purgadas 7 dias após `publishedAt` (DEC-085), em lotes, sem afetar `PENDING`/`FAILED`.
- **RN-FND-60** — Indisponibilidade do PostgreSQL ou do Redis durante o relay nunca perde nem duplica visivelmente um evento: o estado de cada linha (`PENDING`/`PUBLISHED`/`FAILED`) mais `jobId = eventId` garantem *at-least-once* com deduplicação no consumo.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| — | — | — | — | Não aplicável: story de infraestrutura; o envelope do evento (DEC-160) não é preenchido por um formulário. | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Envelope do evento completo e tipado (DEC-160) | `OutboxWriter` (TypeScript) | Não aplicável (erro de programação) | — |
| V-02 | `payload` do evento valida contra o schema Zod do `eventType` (DEC-054, `packages/validation`) | `OutboxWriter` | — | — |
| V-03 | `eventType` existe no registro de `packages/types` e tem decisão de roteamento (queues.md §6.2) | CI (checagem estática) | — | falha de build |
| V-04 | Linha de job com payload > 16 KB ou fora do schema não bloqueia o lote | Relay (worker) | — | linha isolada em backoff/`FAILED` |

## Permissões
- **Permissão:** esta story não introduz permissão `RESOURCE_ACTION` de negócio — a escrita no outbox herda a autorização já verificada pelo caso de uso que a originou; o acesso do relay é controlado pelo papel de banco `cf_relay` (US-081), não por RBAC de aplicação.
- **Políticas:** nenhuma política contextual própria.
- **MFA:** não aplicável diretamente; o replay manual (FA-04) exige `PLATFORM_QUEUE_ADMIN` + MFA, especificado em US-083.
- **Sem permissão:** não aplicável (sem rota própria); falhas de privilégio do `cf_relay` fora de `outbox_events` são rejeitadas pelo PostgreSQL.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Não aplicável como catálogo próprio: esta story entrega o **mecanismo genérico** (`OutboxWriter`, handlers síncronos, relay, fan-out); eventos de negócio específicos nascem em cada story (ex.: `ProcessCreated` em US-001), listados em [events.md](../mvp-01/events.md). |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Não aplicável nesta story: a entrega a `notifications`/`email` é fan-out genérico; o conteúdo e os destinatários de cada notificação são definidos pela story que a origina. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Eventos de domínio com outbox transacional

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And existe um caso de uso que altera o estado de um agregado e usa o "OutboxWriter"

  Scenario: [Sucesso] Evento gravado na transação e publicado pelo relay
    Given que o caso de uso grava o agregado e chama "OutboxWriter.record" na mesma transação
    When a transação for confirmada
    Then deve existir uma linha em "outbox_events" com status "PENDING"
    And o relay deve publicar o evento na fila "domain-events" com "jobId" igual ao "eventId"
    And a linha deve passar para o status "PUBLISHED" com "publishedAt" preenchido

  Scenario: [Validação] Payload fora do schema do evento é rejeitado antes do commit
    Given que o "eventType" exige um "payload" validado por schema Zod
    When o caso de uso tentar gravar um payload com campo obrigatório ausente
    Then o "OutboxWriter" deve rejeitar antes do commit
    And nenhuma linha deve ser gravada em "outbox_events"

  Scenario: [Permissão] Relay restrito à tabela outbox_events
    Given que o papel "cf_relay" tem "BYPASSRLS" apenas para a finalidade do relay
    When uma rotina com "cf_relay" tentar ler a tabela "processes"
    Then o banco deve negar por falta de privilégio
    And apenas "SELECT"/"UPDATE" em "outbox_events" devem ser permitidos a esse papel

  Scenario: [Tenant incorreto] Handler síncrono não cruza tenant
    Given que o "TimelineProjector" roda na mesma transação do caso de uso do tenant "Prefeitura A"
    When o evento for processado
    Then a entrada de timeline criada deve ter "tenant_id" da "Prefeitura A"
    And nenhuma linha do tenant "Prefeitura B" deve ser lida ou alterada pelo projetor

  Scenario: [Duplicidade] Reentrega do relay não publica o mesmo evento duas vezes
    Given que uma linha "PENDING" já foi enfileirada com "jobId" igual ao "eventId", mas o "UPDATE" para "PUBLISHED" falhou antes de confirmar
    When o relay processar a linha novamente no próximo lote
    Then o enfileiramento com o mesmo "jobId" deve ser absorvido pela deduplicação do BullMQ
    And a linha deve terminar como "PUBLISHED" uma única vez, processada pelos consumidores apenas uma vez

  Scenario: [Concorrência] SKIP LOCKED evita que duas réplicas processem a mesma linha
    Given que duas réplicas do relay disputam a liderança por advisory lock
    When ambas tentarem selecionar o mesmo lote de "outbox_events"
    Then apenas a líder deve obter as linhas via "FOR UPDATE SKIP LOCKED"
    And a segunda réplica não deve publicar nenhuma linha em duplicidade

  Scenario: [Falha de banco] PostgreSQL indisponível durante o laço do relay
    Given que o PostgreSQL fica indisponível durante o laço do relay
    When o relay tentar selecionar o próximo lote
    Then o relay deve tentar novamente com backoff
    And nenhum evento deve ser perdido, permanecendo "PENDING" até o banco voltar

  Scenario: [Falha de integração] Redis das filas indisponível ao publicar
    Given que o Redis das filas está indisponível
    When o relay tentar publicar um lote de eventos
    Then a transação de marcação deve sofrer rollback, voltando as linhas a "PENDING" e liberando as travas
    And o relay deve repetir com backoff até 30 s, sem publicar eventos em duplicidade quando o Redis voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento |
|---|---|---|---|---|
| Payload do evento fora do schema | 500 (ao chamador síncrono) | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Transação do caso de uso desfaz; bug de programação, não erro do usuário |
| Relay sem publicar (Redis fora) | — (assíncrono) | — | — | Evento permanece `PENDING`; sem impacto na resposta da API que já respondeu 2xx |
| Linha `FAILED` após 10 tentativas | — (assíncrono) | — | — | Alerta crítico ao time de operação; requer republicação manual (US-083) |
| PostgreSQL indisponível durante relay | — (assíncrono) | — | — | Retry com backoff; sem perda, sem impacto imediato ao usuário final |
| Réplica do relay sem a trava de líder | — (interno) | — | — | Não processa; aguarda a próxima tentativa de aquisição |

## Dependências
- **Stories:** US-081 (tabela `outbox_events`, papel `cf_relay`, `TenantTransaction`); US-083 (fila `domain-events` plenamente operacional no worker, job `outbox-purge`, replay via CLI); US-001 (primeiro consumidor de ponta a ponta do mecanismo).
- **Decisões/ADRs:** DEC-052, DEC-160, DEC-161, DEC-162, DEC-163, DEC-164, DEC-085; [ADR-004](../adr/adr-004-outbox-events.md).
- **Configurações:** nenhuma chave de `TenantSetting` (infraestrutura).
- **Lacunas nas fontes canônicas:** nenhuma — ADR-004 e queues.md §5 especificam lotes, `SKIP LOCKED`, `LISTEN/NOTIFY`, `jobId = eventId`, fan-out e purga com detalhe suficiente.

## Impacto técnico
- Estabelece o **padrão de entrega assíncrona** reutilizado por toda story de negócio que precisa de projeções/integrações fora da transação (notificações, e-mail, métricas, futuramente webhooks/IA).
- Lag do relay é a métrica central de saúde do produto: critério de revisão do ADR-004 (p95 > 5 s sustentado, ou vazão > 1.000 eventos/s) aponta para evolução a relay particionado ou CDC — fora do escopo do MVP 1.
- `jobId = eventId` é a âncora de idempotência de todo o pipeline; qualquer consumidor que ignore isso introduz duplicidade visível.
- Purga de `outbox_events` (7 dias) depende do job agendado `outbox-purge`, entregue em US-083 — sem ele, a tabela cresce indefinidamente.

## Backend
- **Módulo(s):** `platform` (dono de `OutboxEvent`, `OutboxWriter`, relay, `DomainEventsProcessor`); consumido por todos os módulos de DEC-040 que emitem eventos.
- **Casos de uso:** não introduz comando/consulta de negócio própria; é infraestrutura chamada por casos de uso de outros módulos (`OutboxWriter.record(event)` dentro de cada handler).
- **Domínio:** `DomainEvent` (value object do envelope, DEC-160); `TimelineProjector`, `ProcessAccessProjector` (handlers síncronos).
- **Integrações internas:** fachada `OutboxWriter` chamada por qualquer módulo; relay e `DomainEventsProcessor` vivem em `apps/worker` (DEC-052).
- **Transação:** gravação do agregado + handlers síncronos + linha do outbox + auditoria, tudo na mesma `TenantTransaction` do caso de uso (passo 1–3 do fluxo principal); publicação pelo relay é uma transação separada, só de marcação (`SELECT … FOR UPDATE SKIP LOCKED` + `UPDATE`).

## Frontend
- **Tela(s):** não aplicável — story de infraestrutura, sem UI própria.
- **Componentes:** não aplicável.
- **Estados:** não aplicável.
- **Acessibilidade e responsividade:** não aplicável; o efeito perceptível ao usuário (ex.: notificação in-app) é entregue pela story de negócio consumidora, não por esta.

## Banco de dados
- **Tabelas:** reaproveita `outbox_events` (criada em US-081); nenhuma migração de schema nova nesta story — apenas a camada de aplicação (`OutboxWriter`, relay, `DomainEventsProcessor`).
- **Migrações:** nenhuma adicional.
- **Índices/constraints relevantes:** reutiliza os de US-081 (`(status, occurred_at) WHERE status = 'PENDING'`; `(tenant_id, aggregate_type, aggregate_id, occurred_at)`).

## API
Não aplicável como *endpoints de negócio* — nenhum ID do catálogo de `api.md` §3 é criado por esta story. O efeito visível na API é indireto: comandos que gravam eventos continuam respondendo 2xx mesmo com o relay indisponível (evento fica `PENDING`), conforme já previsto nos critérios de aceite de US-001 ("Falha de integração: Relay do outbox indisponível").

## Logs
- `info` `outbox.relay_batch_published` — `batchSize`, `lagMsP95` (commit → `publishedAt`), `correlationId` não aplicável (nível de lote).
- `warn` `outbox.relay_retry` — `eventId`, `attempts`, `nextAttemptAt`.
- `error` `outbox.relay_failed_permanently` — `eventId`, `eventType`, `attempts`, `lastError` (resumido).
- `warn` `outbox.relay_leader_lost` / `info` `outbox.relay_leader_acquired` — transições do *advisory lock*.
- **Nunca logar:** conteúdo completo de `payload` quando o evento referenciar valor sigiloso (POL-09); dados pessoais; `lastError` com stack completa fora do nível `debug`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | — | O outbox não grava `AuditLog` (DEC-161: a auditoria é responsabilidade explícita do `AuditService`, no mesmo caso de uso, independente da publicação do evento). O replay manual de eventos (US-083) é que gera auditoria de plataforma (`outbox.republish`). |

## Testes necessários
- **Unitários:** validação do envelope (DEC-160); fan-out por `routingKey`; cálculo de backoff por tentativa.
- **Integração (Testcontainers PostgreSQL + Redis):** gravação atômica agregado+outbox+projeções síncronas; `SKIP LOCKED` com duas "réplicas" simuladas; marcação `PUBLISHED` idempotente; purga respeitando `publishedAt`.
- **Concorrência:** disputa de *advisory lock* entre réplicas; reentrega do mesmo `jobId` não duplica efeito no consumidor.
- **API/contrato:** não aplicável (sem endpoint próprio); cobertura indireta pelos testes de US-001 que já verificam o comportamento do outbox.
- **RBAC e multi-tenant:** papel `cf_relay` restrito a `outbox_events`; handlers síncronos não cruzam tenant (suíte "tenant leak").
- **E2E (Playwright):** não aplicável diretamente; cenário de ponta a ponta coberto por US-001 (evento `ProcessCreated` publicado após reinício do relay).
- **Acessibilidade/performance:** k6/carga simulando 1.000 eventos para medir lag p95 do relay (meta < 5 s).

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (integração) e passando no CI
- [ ] `OutboxWriter` adotado por ao menos um caso de uso de ponta a ponta (US-001) comprovando atomicidade
- [ ] Relay com líder único, `SKIP LOCKED`, `jobId = eventId` e fan-out por `routingKey` verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak" (handlers síncronos)
- [ ] Job de purga de eventos `PUBLISHED` validado (não remove `PENDING`/`FAILED`)
- [ ] Logs sem dados sensíveis; métricas de lag e `dead-letter` presentes (consumidas por US-085)
- [ ] Revisão de código e de segurança aprovadas
- [ ] Padrão de outbox documentado para reúso pelos módulos de negócio

## Estimativa
**L** — combina três partes não triviais (escrita transacional + handlers síncronos, relay com concorrência segura via `SKIP LOCKED`/advisory lock, e fan-out idempotente), cada uma com testes de concorrência e falha induzida.

## Prioridade
**P0** — sem publicação confiável de eventos, nenhuma notificação, projeção assíncrona ou integração futura do MVP 1 funciona; US-001 já pressupõe este comportamento nos seus critérios de aceite.
