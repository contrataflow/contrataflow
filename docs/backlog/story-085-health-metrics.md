---
id: US-085
title: "Health checks, métricas e dashboards técnicos"
epic: EP-015
feature: FT-049
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-080, US-083]
modules: [platform]
screens: []
endpoints: [HLT-01, HLT-02, HLT-03]
permissions: []
events: []
---

# US-085 — Health checks, métricas e dashboards técnicos

## Título
Health checks, métricas e dashboards técnicos

## Descrição
**Como** pessoa operadora/SRE do ContrataFlow, **quero** endpoints de saúde (`/health/live`, `/health/ready`) e de métricas (`/metrics`) em `api`, `worker` e `web`, mais os dashboards técnicos essenciais e os alertas de maior severidade, **para** saber em tempo real se cada instância está viva, pronta para receber tráfego e dentro do SLO, sem depender de inspecionar logs.

Esta story entrega o lado de **observação agregada** da plataforma (complementar aos logs/traces da US-084): health checks que o orquestrador usa para reiniciar/retirar instâncias, métricas RED e de runtime expostas em `/metrics`, e os primeiros dashboards/alertas como código.

## Contexto
- `observability.md` §5–§6 e §9–§10 são a fonte canônica: catálogo de métricas, convenções de label (nunca `tenantId`), matriz de dependências por health check (alinhada a CA-T-07 e DEC-131), dashboards como código e alertas com severidade/canal/runbook.
- A US-080 já define o comportamento de degradação por dependência (RN-FND-35/36, CA-T-07); esta story **expõe** esse estado via `/health/ready`, em vez de redefini-lo.
- A US-083 entrega o worker e as filas cujo atraso/falha os painéis D3 e os alertas A05–A10 monitoram; sem a US-083, não há o que observar nas filas.
- O catálogo do épico já reserva os endpoints técnicos: `HLT-01 GET /health/live`, `HLT-02 GET /health/ready`, `HLT-03 GET /metrics` (fora de `/api/v1`, rede interna/ALB).

## Objetivo
`api`, `worker` e `web` respondem corretamente a `/health/live` e `/health/ready` conforme a matriz de criticidade por dependência (`observability.md` §6.2), expõem `/metrics` em formato Prometheus sem nenhum label de tenant, e os dashboards D1 (API), D2 (Banco) e D3 (Filas/Outbox) existem como código, com ao menos os alertas críticos de disponibilidade e readiness (A01, A02, A04) configurados e testados em homologação.

## Persona
- **Principal:** Pessoa operadora/SRE (consome dashboards, recebe alertas, decide ação via runbook).
- **Secundárias:** Pessoa desenvolvedora backend (instrumenta métricas de negócio futuras sobre a base RED desta story); orquestrador/ALB (consome `/health/live` e `/health/ready` para decidir reinício/roteamento).

## Pré-condições
- US-080 concluída (pipeline HTTP, guards, degradação por dependência conforme CA-T-07).
- US-083 concluída (worker, filas, schedulers) para que D3 e os alertas de fila tenham o que medir.
- US-078 disponível (perfil `observability`: Prometheus, Grafana, Loki, Tempo em desenvolvimento).

## Fluxo principal
1. `api`, `worker` e `web` registram `/health/live` e `/health/ready` **fora** de `/api/v1`, acessíveis apenas pela rede interna e pelo health check do ALB (no `web`, regra de listener/WAF bloqueia `/health/*` vindo da internet).
2. `/health/live` responde `pass` enquanto o processo responde e o *event loop* não está travado (atraso < 2 s), **sem** checar nenhuma dependência; falha provoca reinício do contêiner.
3. `/health/ready` executa os *checks* da matriz de dependências por aplicação (`observability.md` §6.2: PostgreSQL crítico em `api`/`worker`; Redis de sessões crítico em `web`; Redis de filas/cache crítico só em `worker`, degradável em `api`/`web`; S3, JWKS, Gotenberg, ClamAV, SMTP degradáveis), com *timeout* curto por *check* e resultado em cache de 5 s.
4. A resposta segue o formato `application/health+json` (`status: pass|warn|fail` → HTTP 200/200/503), com `output` nunca contendo host, *stack*, credenciais ou dado de tenant.
5. O OpenTelemetry Metrics SDK expõe `/metrics` em formato Prometheus, **só em porta interna**, coletado pelo Collector/Prometheus a cada 15 s; `/health/*` e `/metrics` continuam fora do log automático e da instrumentação HTTP (já definido na US-084, FA-05).
6. Dashboards D1–D3 são provisionados como código (`infra/observability/grafana/dashboards/*.json`) em todos os ambientes, com anotações de deploy; os alertas A01, A02 e A04 (queima de SLO e readiness) são configurados com severidade, canal e runbook (RB-06, a criar como *placeholder* documentado).

## Fluxos alternativos
- **FA-01 — Dependência degradável indisponível:** `/health/ready` responde `warn` (200), mantendo a instância no balanceador — ex.: S3 fora não impede consultar/tramitar processos (texto de `observability.md` §6.2).
- **FA-02 — Dependência crítica indisponível:** `/health/ready` responde `fail` (503); a instância é retirada do balanceador (`api`/`web`) ou gera alerta (`worker`, que não tem balanceador).
- **FA-03 — Rajada de chamadas a `/health/ready`:** o resultado em cache de 5 s evita sobrecarregar as dependências verificadas.
- **FA-04 — `JWKS` do Authentik com cache expirado:** crítico apenas no *startup*; depois, degrada enquanto o cache valer, reportado como `warn` com `cacheAge` (RB-04).
- **FA-05 — Dashboards D4–D7:** dependem de módulos ainda não construídos (`document`, autenticação real, módulos de negócio) — ficam fora do escopo desta story e são estendidos pelas stories que introduzirem cada domínio (registrado em "Dependências").

## Regras de negócio
- **RN-FND-79** — `/health/live` (HLT-01) e `/health/ready` (HLT-02) existem fora de `/api/v1`, em `api`, `worker` e `web`, acessíveis apenas pela rede interna/ALB; `live` nunca verifica dependência externa (só processo + *event loop* < 2 s); `ready` verifica as dependências da matriz de criticidade de `observability.md` §6.2, retornando `warn` para degradáveis e `fail` para críticas indisponíveis.
- **RN-FND-80** — Resposta no formato `application/health+json`: `status` (`pass`/`warn`/`fail`) → HTTP (200/200/503); cada *check* traz `status`, `observedValue`/`observedUnit` quando aplicável; `output` nunca contém nome de host, *stack trace*, credencial ou dado de tenant; resultado cacheado por 5 s por processo.
- **RN-FND-81** — A matriz de criticidade por aplicação é a mesma tabela de `observability.md` §6.2 (PostgreSQL crítico em `api`/`worker`; Redis de sessões crítico em `web`; Redis de filas/cache crítico em `worker` e degradável em `api`/`web`; S3/JWKS/Gotenberg/ClamAV/SMTP degradáveis) e é consistente com o comportamento de degradação já contratado por CA-T-07 (`mvp-01/acceptance-criteria.md`) — esta story não redefine a degradação, só a expõe.
- **RN-FND-82** — `/metrics` (HLT-03) expõe o OpenTelemetry Metrics SDK em formato Prometheus, **somente em porta interna** (nunca atrás do ALB público), coletado a cada 15 s; nenhum label de `tenantId`, `userId`, `processId`, `eventId`, e-mail ou caminho bruto — apenas conjuntos fechados (rota-template, método, status, fila, job, resultado, classe de erro, dependência, provedor, permissão, tipo de documento de sistema).
- **RN-FND-83** — O catálogo mínimo desta story cobre: métricas RED de HTTP (`http_server_request_duration_seconds` com *labels* de `observability.md` §5.2), *recording rules* de SLO por classe (`cf:slo_latency_p95`), runtime Node (USE), pool de conexão do banco, e as métricas de filas/outbox já emitidas pela US-083 (`queues.md` §5.7/§15.2) — demais grupos (render, upload, auth, negócio) são adicionados pelas stories que introduzirem cada domínio.
- **RN-FND-84** — Dashboards são código versionado (`infra/observability/grafana/dashboards/*.json`), provisionados em todos os ambientes, com anotações de deploy; esta story entrega **D1 (Visão geral da API)**, **D2 (Banco de dados)** e **D3 (Filas e Outbox)**; D4–D7 ficam reservados para quando os respectivos domínios existirem (gap registrado em "Dependências").
- **RN-FND-85** — Investigação por tenant nunca usa label de métrica: é feita por `LogQL` sobre logs (`observability.md` §5.3, ex.: `sum by (tenantId) (...)`) ou por busca de traces pelo atributo `cf.tenant.id` — qualquer painel "por tenant" (D7, fora do escopo desta story) consulta Loki/Tempo, nunca Prometheus.
- **RN-FND-86** — Os alertas A01 (queima rápida do SLO), A02 (queima lenta) e A04 (readiness < 50% das tarefas por 3 min) são configurados com severidade, canal e runbook (`observability.md` §10), testados em homologação; todo alerta tem dono e as regras de inibição evitam cascata (ex.: PostgreSQL fora inibe alertas de fila).

## Campos
| Campo (variável de ambiente / config) | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|
| `HEALTH_CACHE_TTL_MS` | número | Não | > 0 | `5000` (`observability.md` §6.3) |
| `HEALTH_CHECK_TIMEOUT_MS` | número | Não | > 0 | `1000` (PostgreSQL), `500` (Redis) |
| `METRICS_PORT` | porta | Não | 1–65535, interna | porta de administração separada da pública |
| `METRICS_SCRAPE_INTERVAL_SECONDS` | número | Não | > 0 | `15` |

## Validações
| # | Validação | Camada | Mensagem/efeito | Código de erro |
|---|---|---|---|---|
| V-01 | Resposta de `/health/*` contém campo fora da *allowlist* (host, stack, credencial) | Teste automatizado de contrato | Falha de build | — |
| V-02 | Métrica nova com label de cardinalidade aberta (ex.: `tenantId`, e-mail) | *Lint*/revisão de código (regra documentada) | Rejeitado na revisão | — |
| V-03 | `/metrics` exposto na porta pública | Teste de integração de infraestrutura | Falha de build/deploy | — |
| V-04 | Dependência crítica indisponível | `/health/ready` | `fail` → 503 | `DEPENDENCY_UNAVAILABLE` (nas rotas de negócio reais, via US-080) |

## Permissões
- **Permissão:** esta story não introduz permissão `RESOURCE_ACTION` de negócio — `/health/*` e `/metrics` são "público (rede interna/ALB)" e "rede interna" no catálogo do épico (sem checagem de RBAC de tenant); o controle de acesso é de rede (security group/listener/WAF), não de aplicação.
- **Políticas:** acesso a dashboards (Grafana) e ao *backend* de métricas é infraestrutura operacional; reaproveita `PLATFORM_QUEUE_ADMIN` (US-083) apenas para o Bull Board, não para `/metrics`.
- **MFA:** não aplicável.
- **Sem permissão:** requisição a `/health/*`/`/metrics` vinda de fora da rede interna é bloqueada na camada de rede (não chega à aplicação); não há resposta de negação de aplicação a documentar aqui.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Não aplicável: health checks e métricas são consultados por *pull* (scrape/probe); não emitem evento de domínio. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Os alertas técnicos (A01/A02/A04) notificam o plantão via o canal de *on-call* definido em `observability.md` §10 — não são `Notification` de domínio (DEC-083/entities.md), ficam fora do módulo `notification`. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Health checks, métricas e dashboards técnicos

  Background:
    Given que "api", "worker" e "web" expõem "/health/live", "/health/ready" e "/metrics"
    And o Prometheus local coleta "/metrics" a cada 15 segundos (US-078)

  Scenario: [Sucesso] Instância saudável responde pronta para tráfego
    Given que todas as dependências críticas da "api" estão disponíveis
    When for feita uma requisição "GET /health/ready"
    Then a resposta deve ser 200 com "status" igual a "pass"

  Scenario: [Validação] Formato da resposta nunca expõe dado sensível
    Given que uma dependência degradável está indisponível
    When for feita uma requisição "GET /health/ready"
    Then a resposta deve ser 200 com "status" igual a "warn"
    And o campo "output" não deve conter nome de host, stack ou credencial

  Scenario: [Permissão] Métricas não são acessíveis pela rede pública
    When "/metrics" for chamado a partir de fora da rede interna
    Then a requisição não deve alcançar a aplicação

  Scenario: [Tenant incorreto] Nenhuma métrica expõe o tenant
    Given o catálogo de métricas exposto em "/metrics"
    When um operador inspecionar os labels de qualquer série
    Then nenhuma série deve conter o label "tenantId"
    And a investigação por tenant deve ser feita por logs ou traces, nunca por métrica

  Scenario: [Duplicidade] Chamadas repetidas a /health/ready usam cache
    Given que o resultado de "/health/ready" foi calculado há 2 segundos
    When uma nova requisição "GET /health/ready" for feita
    Then a resposta deve vir do cache de 5 segundos
    And as dependências não devem ser verificadas novamente

  Scenario: [Concorrência] Requisições simultâneas não disparam verificações duplicadas
    Given que nenhum resultado está em cache
    When duas requisições "GET /health/ready" chegarem ao mesmo tempo
    Then as dependências devem ser verificadas uma única vez
    And ambas as respostas devem refletir o mesmo resultado

  Scenario: [Falha de banco] PostgreSQL indisponível reflete-se no health da api
    Given que o PostgreSQL está indisponível
    When for feita uma requisição "GET /health/ready" na "api"
    Then a resposta deve ser 503 com "status" igual a "fail"
    And o check "postgresql" deve aparecer como "fail"

  Scenario: [Falha de integração] Dependência degradável não derruba a readiness
    Given que o Redis de filas/cache está indisponível
    When for feita uma requisição "GET /health/ready" na "api"
    Then a resposta deve permanecer 200 com "status" igual a "warn"
    And o check correspondente deve aparecer como "warn", não "fail"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento |
|---|---|---|---|---|
| Dependência crítica indisponível | 503 | — (`status: fail` no corpo `health+json`, não `problem+json`) | — | Retirada do balanceador (`api`/`web`) ou alerta (`worker`) |
| Dependência degradável indisponível | 200 | — (`status: warn`) | — | Instância continua recebendo tráfego |
| `/metrics` ou `/health/*` fora da rede interna | — | — | — | Bloqueado na camada de rede (listener/WAF/security group), sem resposta de aplicação |

## Dependências
- **Stories:** US-080 (pipeline e degradação por dependência — CA-T-07, pré-requisito direto); US-083 (worker e filas, para D3 e alertas de fila); US-084 (SDK de métricas/tracing compartilhado). Habilita observação de toda story de negócio a partir de US-001 (cada módulo novo soma métricas/paineis aos grupos já existentes).
- **Decisões/ADRs:** DEC-131, DEC-164; `observability.md` §5, §6, §9, §10; CA-T-07 (`mvp-01/acceptance-criteria.md`).
- **Configurações:** variáveis da tabela "Campos".
- **Lacunas nas fontes canônicas:** (1) os *runbooks* RB-06/RB-07/RB-08/RB-09 referenciados pelos alertas A01/A02/A04/A21/A22/A23 estão marcados "(a criar)" em `observability.md` §10 — esta story cria apenas o *runbook* mínimo dos alertas que configura (A01/A02/A04), os demais ficam para a story que introduzir o respectivo domínio; (2) o limite de duração que caracteriza "HTTP lento" para o *tail sampling* (> 2 s, §4.4) é da US-084, reaproveitado aqui sem alteração; (3) dashboards D4–D7 dependem de domínios ainda não implementados (documento, autenticação real, módulos de negócio) — escopo desta story fica em D1–D3, registrado como decisão de recorte, não como lacuna de fonte.

## Impacto técnico
- Define a **base RED/USE** sobre a qual toda métrica de negócio futura é empilhada; convenção de nomes (`cf_` + sufixo de unidade) e de labels (conjunto fechado, nunca `tenantId`) é regra de fronteira revisada como as demais (CODEOWNERS).
- `/health/ready` com *checks* síncronos por requisição tem custo; o cache de 5 s (RN-FND-80) é obrigatório para não amplificar carga sobre PostgreSQL/Redis em caso de *health check* agressivo do orquestrador.
- Dashboards como código entram no mesmo fluxo de revisão/CI que o restante do monorepo (US-079); divergência entre o dashboard versionado e o publicado no Grafana é tratada como *drift* de configuração.
- Esta story não cria tabela nem rota de negócio; é inteiramente observação sobre o que a US-080/US-083 já executam.

## Backend
- **Módulo(s):** `platform` (submódulo `observability`, compartilhado com a US-084: *health indicators* por dependência, registro de métricas).
- **Casos de uso:** não aplicável — sem comando/query de negócio.
- **Domínio:** não aplicável.
- **Integrações internas:** expõe *health indicators* reutilizáveis (`PostgresHealthIndicator`, `RedisHealthIndicator`, …) que cada módulo de infraestrutura registra; expõe `MetricsRegistry` para contadores/histogramas de negócio futuros.
- **Transação:** não aplicável.

## Frontend
Não aplicável como tela própria do usuário final — os dashboards técnicos (Grafana) não são parte de `apps/web`; a casca administrativa de negócio é da US-086 e das stories de produto.

## Banco de dados
Não aplicável — nenhuma tabela nova; `/health/ready` executa `SELECT 1` de verificação, sem leitura de dados de negócio.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| HLT-01 | GET | `/health/live` (fora de `/api/v1`) | — | `application/health+json` | 200 |
| HLT-02 | GET | `/health/ready` | — | `application/health+json` com `checks` por dependência | 200, 503 |
| HLT-03 | GET | `/metrics` | — | texto Prometheus | 200 |

## Logs
- `info` não aplicável — `/health/*` e `/metrics` são explicitamente excluídos do log automático (US-084, FA-05).
- `warn` `health.dependency_degraded` — dependência degradável indisponível (transição para `warn`).
- `error` `health.dependency_critical_down` — dependência crítica indisponível (transição para `fail`).
- **Nunca logar:** *host*, *stack*, credencial ou dado de tenant no corpo do `health+json` (RN-FND-80).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | — | Não aplicável: health checks e métricas são observação técnica, não ação de usuário — não geram `AuditLog`. |

## Testes necessários
- **Unitários:** cada *health indicator* (crítico/degradável) com dependência simulada *up*/*down*; cálculo de `status` agregado (`pass`/`warn`/`fail`).
- **Integração (Testcontainers):** `/health/ready` com PostgreSQL/Redis reais parados e no ar; cache de 5 s respeitado sob chamadas repetidas.
- **API/contrato:** `/metrics` produz texto Prometheus válido; nenhuma série contém label de `tenantId`/`userId`/e-mail (teste automatizado de regressão de cardinalidade).
- **RBAC e multi-tenant:** não aplicável a RBAC; teste de rede confirma bloqueio de `/metrics`/`/health/*` fora da rede interna (ambiente de homologação).
- **Concorrência:** requisições simultâneas a `/health/ready` resultam em uma única verificação efetiva por janela de cache.
- **E2E (Playwright):** não aplicável (sem UI).
- **Acessibilidade/performance:** não aplicável à acessibilidade; performance: `/health/live` responde em < 50 ms; `/health/ready` em < 300 ms mesmo verificando todas as dependências.

## Definition of Done
- [ ] `/health/live` e `/health/ready` implementados em `api`, `worker` e `web` conforme a matriz de criticidade
- [ ] `/metrics` exposto em porta interna, formato Prometheus, sem label de tenant (teste de cardinalidade)
- [ ] Dashboards D1, D2 e D3 provisionados como código em todos os ambientes
- [ ] Alertas A01, A02 e A04 configurados com severidade/canal/runbook e testados em homologação
- [ ] Bloqueio de rede de `/health/*`/`/metrics` a partir da internet verificado
- [ ] Logs de transição de estado (`warn`/`error`) sem dado sensível
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — reaproveita a degradação por dependência já contratada na US-080 (CA-T-07) e o SDK de métricas da US-084; o trabalho é expor, catalogar e empacotar como dashboards/alertas, sem nova regra de negócio.

## Prioridade
**P1** — importante para operar a plataforma com confiança, mas não bloqueia nenhuma story de negócio do MVP 1 (diferente da US-084, que é P0 por sustentar diagnóstico desde o primeiro incidente).
