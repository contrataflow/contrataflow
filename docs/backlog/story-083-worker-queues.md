---
id: US-083
title: "Worker com filas, retries e dead letter"
epic: EP-015
feature: FT-048
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-082]
modules: [platform]
screens: []
endpoints: []
permissions: [PLATFORM_QUEUE_ADMIN]
events: []
---

# US-083 — Worker com filas, retries e dead letter

## Título
Worker com filas, retries e dead letter

## Descrição
**Como** pessoa desenvolvedora backend/operadora de plataforma do ContrataFlow, **quero** o processo `apps/worker` executando todas as filas do MVP 1 com contrato de job padronizado, retries com *jitter*, *dead-letter* e schedulers únicos, **para** que nenhum trabalho assíncrono (relay do outbox, notificações, e-mail, renderização, antivírus, prazos, selagem, manutenção) se perca ou duplique silenciosamente, com operação visível e auditável.

Esta story entrega o processo standalone do worker (DEC-052), o contrato comum de job (`JobMeta`/`JobData<T>`, DEC-164) e o wrapper `runJob` (abre contexto + `TenantTransaction`), a política padrão de filas (DEC-163: tentativas, backoff `cf-exponential-jitter`, `removeOnComplete`), o mecanismo de *dead-letter*, os *Job Schedulers* únicos para as filas agendadas e o Bull Board somente leitura restrito a `PLATFORM_QUEUE_ADMIN` + MFA.

## Contexto
- US-082 entrega o relay do outbox e o fan-out por `routingKey`, mas depende de um worker de verdade processando as filas; sem este card, `domain-events`, `notifications`, `email`, `document-render`, `file-scan` e as filas agendadas não têm quem as consuma.
- DEC-052 isola o worker da API para escalar independentemente (ex.: picos de renderização de PDF não afetam a latência de requisições); DEC-163/DEC-164 fixam a política padrão e o contrato de job que evitam cada fila reinventar retries/contexto.
- Jobs são assíncronos e *at-least-once* por natureza — a falha "silenciosa" (job perdido sem log nem fila de inspeção) é o risco central que o *dead-letter* e os alertas de scheduler atacam.
- [queues.md](../architecture/queues.md) é a fonte de operação (política, classificação de erros, schedulers, Bull Board); esta story implementa exatamente o que ali está especificado para o MVP 1.

## Objetivo
100% dos jobs das filas do MVP 1 processam com o contrato comum de contexto (DEC-164); nenhum job é perdido silenciosamente — toda falha final vira uma cópia rastreável em `dead-letter`; schedulers nunca produzem mais de uma execução simultânea entre réplicas; o Bull Board permite inspeção operacional sem permitir mutação fora da CLI auditada.

## Persona
- **Principal:** Pessoa desenvolvedora backend do ContrataFlow (implementa handlers de fila dentro do contrato comum).
- **Secundárias:** Operador de plataforma (`PLATFORM_QUEUE_ADMIN`, inspeciona e reprocessa via Bull Board/CLI); pessoa desenvolvedora de observabilidade (consome métricas de fila — US-085).

## Pré-condições
- US-082 concluída: `outbox_events`, `OutboxWriter` e fan-out por `routingKey` disponíveis.
- US-078 disponível: Redis de filas (lógico, separado do Redis de sessões — DEC-131) rodando localmente com `maxmemory-policy noeviction`.
- US-080 disponível: `AsyncLocalStorage`/`RequestContext` e propagação de `traceparent` (OpenTelemetry).

## Fluxo principal
1. `apps/worker` inicializa como processo Node/NestJS standalone (DEC-052), conecta ao Redis de filas (ioredis, `maxRetriesPerRequest: null`, prefixo `cf:{env}:q`) e registra as filas do MVP 1: `domain-events`, `notifications`, `email`, `document-render`, `file-scan`, `deadlines`, `audit-seal`, `maintenance`, `dead-letter`.
2. Cada fila usa `defaultJobOptions` de DEC-163 (`attempts: 5`, `backoff: { type: 'cf-exponential-jitter', delay: 5_000 }`, `removeOnComplete: { age: 86_400 }`, `removeOnFail: { age: 604_800 }`) salvo sobrescrita documentada (ex.: `file-scan` com concorrência limitada por tenant).
3. Toda produção de job usa `enqueue(queue, name, payload, opts)`: lê o contexto ativo (`AsyncLocalStorage`), injeta `traceparent`/`tracestate` (W3C) e monta `meta: JobMeta` (`tenantId`, `actor`, `correlationId`, `causationId`, `queue`, `jobId`) + `payload` (≤ 16 KB, só IDs/metadados) — nunca preenchido manualmente pelo chamador.
4. No consumo, o wrapper `runJob` valida `meta` (job sem `tenantId` só é aceito na lista fechada de jobs de plataforma — `tick`s de `deadlines`/`audit-seal`/`maintenance`, `dead-letter`), abre o `AsyncLocalStorage` e a `TenantTransaction` (`set_config('app.tenant_id', …)` — US-081) antes de chamar o handler, e cria o logger filho (pino) com `queue`, `jobName`, `jobId`, `attempt`, `tenantId`, `correlationId`, `traceId`.
5. Erros são classificados (transitório, dependência fora/*breaker*, permanente, permanente de segurança, duplicidade esperada); transitórios usam o backoff `cf-exponential-jitter` (`backoffStrategy`); permanentes lançam `UnrecoverableError` para falha final imediata.
6. Na falha final (permanente ou tentativas esgotadas), o wrapper grava uma cópia em `dead-letter` com `jobId = <fila>.<jobId>` **antes** de relançar o erro (idempotente a quedas no meio) — só então o BullMQ marca o job original como `failed`.
7. Jobs agendados usam BullMQ Job Schedulers (`upsertJobScheduler`, idempotente no bootstrap de toda réplica): `deadlines-tick` (`*/15 * * * *` UTC), `audit-seal-tick` (`5 * * * *` UTC), `maintenance-daily` (`0 3 * * *` America/Sao_Paulo) — cada um com *advisory lock* próprio para nunca sobrepor execuções entre réplicas.
8. Bull Board (`@bull-board/api`) é montado em porta interna (`WORKER_ADMIN_PORT`), nunca exposta à internet; login OIDC exige `User.isPlatformOperator` com `PLATFORM_QUEUE_ADMIN` e MFA; adaptadores em `readOnlyMode: true` — mutações (retry, descarte, limpeza) só pela CLI auditada.

## Fluxos alternativos
- **FA-01 — Dependência externa fora (ClamAV/Gotenberg/SMTP):** o *circuit breaker* pausa a fila correspondente **sem consumir tentativa**; retoma automaticamente quando a dependência volta.
- **FA-02 — Job *stalled* (derruba o worker):** `stalledInterval` 30 s, `maxStalledCount` 1 — um job que derruba o worker duas vezes falha definitivamente (proteção contra *poison job*), indo para `dead-letter`.
- **FA-03 — Réplica sem a trava do scheduler:** a execução que não obtém o *advisory lock* conclui como `skipped` (`cf_scheduled_job_skipped_total`), sem reprocessar o que a líder já está fazendo.
- **FA-04 — Reprocessamento manual:** CLI do worker (`PLATFORM_QUEUE_ADMIN` + MFA) republica um job de `dead-letter` ou um intervalo do outbox; auditoria `outbox.republish`/`queue_dashboard.access` com `actorType = PLATFORM_OPERATOR`.
- **FA-05 — Iteração de scheduler perdida (worker fora do ar):** sem *catch-up*; por isso os handlers agendados são baseados em estado (todos os prazos vencidos, todos os períodos sem selo), não em janela de tempo — nada fica "esquecido" por uma iteração perdida.

## Regras de negócio
- **RN-FND-61** — `apps/worker` roda como processo standalone, independente da API (DEC-052), reutilizando os módulos de domínio/aplicação; escala por réplicas, sem rota HTTP pública de negócio (só Bull Board interno e `/health`/`/metrics`).
- **RN-FND-62** — Toda fila do MVP 1 usa a política padrão de DEC-163 (5 tentativas, backoff `cf-exponential-jitter` base 5 s/teto 15 min, `removeOnComplete` 24 h, `removeOnFail` 7 dias) salvo sobrescrita documentada por fila.
- **RN-FND-63** — Todo job carrega `meta` (`tenantId`, `actor`, `correlationId`, `causationId`, `queue`, `jobId`, `traceparent`) + `payload` (DEC-164); o produtor injeta `meta` a partir do contexto ativo, nunca manualmente pelo chamador.
- **RN-FND-64** — O wrapper `runJob` valida `meta` e abre `AsyncLocalStorage` + `TenantTransaction` antes do handler; job sem `tenantId` só é aceito na lista fechada de jobs de plataforma (DEC-164).
- **RN-FND-65** — Payload de job tem no máximo 16 KB e contém somente IDs/metadados — nunca dados pessoais, conteúdo de documento, valores sigilosos ou segredos; o handler relê o estado necessário no contexto do tenant.
- **RN-FND-66** — A classificação do erro decide o tratamento: transitório → retry com backoff; dependência fora → pausa da fila sem consumir tentativa; permanente → `UnrecoverableError` (falha final imediata); duplicidade esperada (ex.: `23505` de idempotência) → sucesso silencioso.
- **RN-FND-67** — Na falha final, o worker grava cópia em `dead-letter` com `jobId = <fila>.<jobId>` **antes** de relançar o erro (idempotente a quedas no meio do processo).
- **RN-FND-68** — Jobs agendados usam BullMQ Job Schedulers (`upsertJobScheduler`, idempotente no bootstrap de toda réplica), garantindo um único job por iteração mesmo com N réplicas; execução em andamento bloqueia a próxima, que conclui como `skipped`.
- **RN-FND-69** — Bull Board é montado em porta interna, nunca exposta à internet; exige `PLATFORM_QUEUE_ADMIN` + MFA; roda em `readOnlyMode: true` — mutações só pela CLI auditada.
- **RN-FND-70** — Métricas mínimas por fila (`cf_jobs_processed_total`, `cf_job_retries_total`, `cf_dead_letter_jobs`, `cf_scheduler_last_success_timestamp_seconds`) são expostas em `/metrics`; qualquer novo job em `dead-letter` gera alerta.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| — | — | — | — | Não aplicável: story de infraestrutura, sem formulário de negócio. | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `meta` presente e `tenantId` válido (ou job na lista fechada de plataforma) | `runJob` (worker) | Não aplicável (interno) | — |
| V-02 | `payload` ≤ 16 KB e restrito a IDs/metadados | Revisão de código + schema Zod por fila | — | rejeição no enfileiramento |
| V-03 | Nome de job registrado na fila correspondente | CI (checagem estática do registro de jobs) | — | falha de build |
| V-04 | Scheduler único por ambiente (sem duplicar `upsertJobScheduler` com padrões diferentes) | Bootstrap do worker + teste de integração | — | — |

## Permissões
- **Permissão:** `PLATFORM_QUEUE_ADMIN` — acesso ao Bull Board e à CLI de reprocessamento/*dead-letter* (permissions.md §8).
- **Políticas:** exige `User.isPlatformOperator` além da permissão; mutações (retry, descarte, limpeza, replay) só pela CLI auditada — o Bull Board em si é `readOnlyMode: true`.
- **MFA:** exigido sempre (ação de risco `HIGH`, afeta todos os tenants) — queues.md §15.1.
- **Sem permissão:** acesso ao Bull Board/CLI sem `PLATFORM_QUEUE_ADMIN` é negado; tentativa registrada em auditoria de plataforma (`queue_dashboard.access`, `actorType = PLATFORM_OPERATOR`).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Não aplicável: este card consome e opera filas; não introduz um evento de domínio próprio no catálogo de [events.md](../mvp-01/events.md). |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Não aplicável: este card executa os consumidores (`EmailSender`, `NotificationDispatcher`); o conteúdo/destinatário de cada notificação é definido pela story de negócio que a origina. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Worker com filas, retries e dead letter

  Background:
    Given que o worker "apps/worker" está em execução, isolado da API
    And as filas do MVP 1 estão configuradas com a política padrão de retries (DEC-163)

  Scenario: [Sucesso] Job processado com contexto de tenant
    Given que um job da fila "notifications" carrega "meta.tenantId" da "Prefeitura A"
    When o "runJob" abrir o contexto e a "TenantTransaction"
    Then o handler deve processar com o contexto de banco da "Prefeitura A"
    And a métrica "cf_jobs_processed_total" deve ser incrementada com "outcome=completed"

  Scenario: [Validação] Job sem tenantId fora da lista de plataforma falha definitivamente
    Given que um job chega sem "tenantId" e não está na lista fechada de jobs de plataforma
    When o "runJob" validar o "meta"
    Then o job deve lançar um erro não recuperável
    And deve ser copiado para a fila "dead-letter" com "jobId" igual a "<fila>.<jobId>"

  Scenario: [Permissão] Bull Board exige PLATFORM_QUEUE_ADMIN e MFA
    Given que um operador sem a permissão "PLATFORM_QUEUE_ADMIN" tenta acessar o Bull Board
    Then o acesso deve ser negado
    When um operador com "PLATFORM_QUEUE_ADMIN" e MFA acessar
    Then o Bull Board deve abrir em modo somente leitura

  Scenario: [Tenant incorreto] Job de um tenant não acessa dados de outro
    Given que um job da fila "deadlines" processa o tenant "Prefeitura A"
    When o handler abrir a "TenantTransaction" da "Prefeitura A"
    Then nenhuma linha do tenant "Prefeitura B" deve ser lida, mesmo que o payload contenha um id de "Prefeitura B" por engano
    And a operação deve terminar sem efeito, pois a política de isolamento falha fechada

  Scenario: [Duplicidade] Reentrega at-least-once é absorvida pela idempotência do handler
    Given que o job "email" da notificação "N1" já foi concluído ("emailStatus = SENT")
    When o BullMQ reentregar o mesmo job após uma falha de rede no ack
    Then o handler deve verificar o status antes de agir e não reenviar o e-mail
    And deve concluir como sucesso sem efeito duplicado

  Scenario: [Concorrência] Scheduler não sobrepõe execuções entre réplicas
    Given que a execução anterior do scheduler "maintenance-daily" ainda está em andamento
    When o scheduler disparar a nova iteração em outra réplica
    Then a nova execução não deve obter a trava (advisory lock)
    And deve concluir como "skipped", incrementando "cf_scheduled_job_skipped_total"

  Scenario: [Falha de banco] PostgreSQL indisponível durante o handler
    Given que o PostgreSQL fica indisponível durante o processamento de um job
    When o handler tentar abrir a "TenantTransaction"
    Then o erro deve ser classificado como transitório
    And o job deve ser reagendado com backoff, sem consumir tentativa adicional quando a dependência for identificada como fora pelo circuit breaker

  Scenario: [Falha de integração] Dependência externa indisponível pausa a fila sem consumir tentativa
    Given que o Gotenberg está indisponível
    When um job da fila "document-render" for processado
    Then a fila deve pausar automaticamente (circuit breaker aberto) sem consumir tentativa
    And deve retomar o processamento quando a dependência voltar, sem perder jobs
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento |
|---|---|---|---|---|
| Acesso ao Bull Board sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para acessar o painel de filas." | Redireciona/bloqueia; auditoria `queue_dashboard.access` com resultado negado |
| Acesso ao Bull Board sem MFA | 403 | `MFA_REQUIRED` | "Esta ação exige verificação adicional." | Dispara *step-up* de MFA |
| Job permanente (payload/entidade inválida) | — (assíncrono) | — | — | `UnrecoverableError`; cópia em `dead-letter`; alerta |
| Dependência externa fora (breaker aberto) | — (assíncrono) | — | — | Fila pausada sem consumir tentativa; alerta de breaker |
| Scheduler sem sucesso além do limite | — (assíncrono) | — | — | Alerta (`deadlines` > 45 min, `audit-seal` > 3 h, `maintenance` > 26 h) |
| Redis de filas indisponível | 503 (via API que depende do outbox) | `DEPENDENCY_UNAVAILABLE` | "Não foi possível completar a operação agora. Tente novamente em instantes." | Jobs ficam pendentes; API segue respondendo pelo outbox (US-082) |

## Dependências
- **Stories:** US-082 (relay e fan-out produzem os jobs que este worker consome); US-081 (`TenantTransaction`, papel `cf_worker`); US-080 (`AsyncLocalStorage`, propagação de `traceparent`); US-085 (consome as métricas/alertas aqui expostos).
- **Decisões/ADRs:** DEC-052, DEC-055, DEC-085, DEC-105, DEC-134, DEC-160 a DEC-164; [ADR-004](../adr/adr-004-outbox-events.md).
- **Configurações:** nenhuma chave de `TenantSetting`; variável de ambiente `WORKER_ADMIN_PORT` (porta interna do Bull Board).
- **Lacunas nas fontes canônicas:** nenhuma — queues.md especifica política padrão, contrato de job, classificação de erros, *dead-letter*, schedulers e Bull Board com detalhe suficiente para este card.

## Impacto técnico
- Estabelece o **processo de execução assíncrona** de toda a plataforma; qualquer fila nova (ex.: `webhooks` no MVP 3) herda o contrato comum de job e a política padrão sem retrabalho.
- `dead-letter` é o único ponto de inspeção de falhas finais — sem alertas conectados a ele (US-085), falhas passam despercebidas.
- Schedulers com `upsertJobScheduler` dependem de BullMQ ≥ 5.16; qualquer downgrade de versão exige revalidar o comportamento de *Job Schedulers*.
- *Noisy neighbor* entre tenants (ex.: um tenant com muitos uploads) é mitigado por semáforos por tenant e fila (`cf:{env}:t:{tenantId}:sem:{fila}`) e prioridades — estabelecido aqui, ajustado por fila conforme necessidade observada.

## Backend
- **Módulo(s):** `platform` (dono do processo `apps/worker`, contrato de job, *dead-letter*, schedulers, Bull Board).
- **Casos de uso:** não introduz comando/consulta de negócio; hospeda os handlers de fila de outros módulos (ex.: `ScanFileHandler` do módulo `files`, `DeadlineScanner` do módulo `process`).
- **Domínio:** não aplicável diretamente (infraestrutura de execução); os handlers de cada fila reutilizam o domínio do módulo dono.
- **Integrações internas:** `enqueue`/`runJob` chamados por todos os módulos que produzem/consomem jobs; Bull Board consome a API do BullMQ somente leitura.
- **Transação:** cada execução de handler abre uma `TenantTransaction` própria (US-081); a gravação em `dead-letter` ocorre antes de relançar o erro, fora da transação do handler que falhou.

## Frontend
- **Tela(s):** não aplicável — o Bull Board é uma ferramenta operacional interna (não é tela do produto, não usa `packages/ui`/Next.js).
- **Componentes:** não aplicável.
- **Estados:** não aplicável.
- **Acessibilidade e responsividade:** não aplicável (ferramenta operacional de acesso restrito, fora do público-alvo de acessibilidade do produto).

## Banco de dados
- **Tabelas:** não cria tabela de negócio; jobs agendados escrevem em tabelas de outros módulos através dos respectivos repositórios (ex.: `ProcessStage` pelo `DeadlineScanner`, `audit_seals` pelo `AuditSealer`).
- **Migrações:** nenhuma própria desta story.
- **Índices/constraints relevantes:** nenhum novo; reaproveita os das tabelas que cada handler already acessa.

## API
Não aplicável como *endpoints de negócio* — nenhum ID do catálogo de `api.md` §3 é criado por esta story. O único ponto de acesso HTTP é o Bull Board (`WORKER_ADMIN_PORT`, rede interna), que não segue o contrato de `api.md` (não é `/api/v1`, não emite envelope RFC 9457) por ser ferramenta operacional, não produto.

## Logs
- `info` `worker.job_completed` — `queue`, `jobName`, `jobId`, `attempt`, `durationMs`, `tenantId`, `correlationId`.
- `warn` `worker.job_retried` — `queue`, `jobName`, `attempt`, `errorClass`, `nextAttemptAt`.
- `error` `worker.job_dead_lettered` — `queue`, `jobName`, `jobId`, `attempts`, `errorClass`.
- `warn` `worker.scheduler_skipped` — `scheduler`, motivo `lock_held`.
- `error` `worker.scheduler_missed_sla` — `scheduler`, `lastSuccessAgeSeconds`.
- **Nunca logar:** conteúdo do `payload` do job além de IDs/metadados; tokens/segredos; corpo de e-mail/documento.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `queue_dashboard.access` | `ACCESS` | Login no Bull Board | `actorType = PLATFORM_OPERATOR`, resultado (concedido/negado) |
| `outbox.republish` | `SYSTEM` | Reprocessamento manual via CLI | `actorType = PLATFORM_OPERATOR`, intervalo/eventos afetados, `correlationId` |
| `attachment.scan_result` / `audit.seal` (exemplos de efeito gravado pelo worker) | `DATA_CHANGE` / `SYSTEM` | Handlers de fila concluem | `actorType = SYSTEM`; `metadata.requestedBy` preserva o ator original de `meta.actor` |

## Testes necessários
- **Unitários:** `backoffStrategy` (jitter); classificação de erro (transitório/permanente/duplicidade esperada); montagem de `JobMeta`.
- **Integração (Testcontainers PostgreSQL + Redis):** `runJob` abre `TenantTransaction` corretamente; job sem `tenantId` fora da lista de plataforma é rejeitado; gravação em `dead-letter` idempotente a quedas no meio do processo.
- **Concorrência:** duas réplicas disputando o *advisory lock* de um scheduler; apenas uma executa, a outra conclui `skipped`.
- **API/contrato:** não aplicável (sem endpoint de negócio); Bull Board testado por verificação de acesso (permissão + MFA) e `readOnlyMode`.
- **RBAC e multi-tenant:** acesso ao Bull Board sem `PLATFORM_QUEUE_ADMIN`/MFA negado; suíte "tenant leak" aplicada a um handler de fila (ex.: `deadlines`).
- **E2E (Playwright):** não aplicável ao worker em si; cobertura indireta via jornadas que dependem de jobs (ex.: e-mail de convite).
- **Acessibilidade/performance:** k6 simulando carga nas filas críticas (`document-render`, `file-scan`) para validar SLO de espera; sem requisito de acessibilidade (ferramenta interna).

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (integração) e passando no CI
- [ ] `PLATFORM_QUEUE_ADMIN` + MFA aplicados ao Bull Board; `readOnlyMode: true` verificado
- [ ] Contrato comum de job (`JobMeta`/`JobData<T>`) adotado por todas as filas do MVP 1
- [ ] *Dead-letter* e alertas de scheduler verificados em teste de falha induzida
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak" para ao menos um handler de fila
- [ ] Logs sem dados sensíveis; métricas `cf_jobs_processed_total`, `cf_job_retries_total`, `cf_dead_letter_jobs`, `cf_scheduler_last_success_timestamp_seconds` presentes
- [ ] Revisão de código e de segurança aprovadas
- [ ] Operação (Bull Board, CLI de reprocessamento) documentada para o time de suporte

## Estimativa
**M** — a política e o contrato já estão detalhados em queues.md; o trabalho é principalmente implementação disciplinada (wrapper, schedulers, *dead-letter*, Bull Board) sem desenho novo de arquitetura.

## Prioridade
**P0** — sem o worker operando as filas, o relay do outbox (US-082) não tem consumidor e nenhuma notificação, e-mail, renderização ou job agendado do MVP 1 funciona.
