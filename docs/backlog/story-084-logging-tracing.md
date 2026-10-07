---
id: US-084
title: "Logs estruturados, correlationId e tracing"
epic: EP-015
feature: FT-049
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-080]
modules: [platform]
screens: []
endpoints: []
permissions: []
events: []
---

# US-084 — Logs estruturados, correlationId e tracing

## Título
Logs estruturados, correlationId e tracing

## Descrição
**Como** time de engenharia do ContrataFlow, **quero** que toda a API, o worker e o BFF emitam logs estruturados em JSON, propaguem um `correlationId` por toda a cadeia de uma operação (HTTP, outbox, filas, e-mail, Gotenberg) e produzam traces distribuídos via OpenTelemetry, **para** que qualquer incidente possa ser diagnosticado por um operador a partir de um único identificador, sem acesso a dado sensível de tenant.

Esta story conecta pino (logs), o gerador/propagador de `correlationId` e o SDK do OpenTelemetry (traces) ao pipeline de requisição já criado pela US-080 e ao contexto de job da US-082/US-083, sem introduzir nenhuma rota ou regra de negócio nova.

## Contexto
- A US-080 abriu o `RequestContext` por `AsyncLocalStorage` e já gera/devolve `X-Correlation-Id`, mas ainda não grava logs estruturados nem abre spans — o contexto existe, mas não é observável.
- `observability.md` §2–§4 é a fonte canônica: formato pino (JSON, campos obrigatórios §2.2), níveis (§2.3), redação (DEC-138, §2.4), identificadores de rastreio (§3) e tracing distribuído com OpenTelemetry (§4).
- A US-082 (outbox) e a US-083 (worker) já carregam `correlationId`/`traceparent` no envelope do evento e no `JobMeta` (DEC-164) — esta story entrega o lado de **emissão e propagação** (logger, SDK, instrumentações) que esses contratos de dados pressupõem.
- Sem esta story, nenhum log tem formato consistente entre `web`/`api`/`worker`, e não existe trace correlacionando uma requisição HTTP ao job assíncrono que ela disparou — diagnóstico de incidentes (RB-01 a RB-05) fica inviável.

## Objetivo
Toda requisição HTTP, todo job de fila e toda chamada de integração emitem log estruturado com os campos obrigatórios de `observability.md` §2.2, propagam `correlationId` e `traceparent` ponta a ponta, e geram spans correlacionáveis no backend de tracing — demonstrado pela rota de exemplo da US-080 e por um job de teste, com teste automatizado de não vazamento de dado proibido (DEC-138) e de não mistura de contexto entre requisições concorrentes.

## Persona
- **Principal:** Pessoa desenvolvedora backend do ContrataFlow (instrumenta cada módulo com logs e spans de negócio).
- **Secundárias:** Pessoa operadora/SRE (usa logs e traces para diagnosticar incidentes pelo `correlationId`); pipeline de CI (US-079, valida ausência de campos proibidos em novos DTOs).

## Pré-condições
- US-080 concluída (`RequestContext` por `AsyncLocalStorage`, `X-Correlation-Id` gerado/devolvido pelo pipeline HTTP).
- US-078 disponível para rodar o Collector/Grafana/Loki/Tempo do perfil `observability` em desenvolvimento.

## Fluxo principal
1. No bootstrap de `apps/api` e `apps/worker`, `otel.mjs`/`instrumentation.ts` (Next.js) carrega o OpenTelemetry Node SDK **antes** do código da aplicação, com atributos de recurso (`service.name`, `service.version`, `deployment.environment.name`, `service.instance.id`) e as instrumentações de `observability.md` §4.1 (HTTP, fetch/undici, NestJS, Prisma, pg, ioredis, AWS SDK, pino, BullMQ).
2. `nestjs-pino` (API, worker) e pino nos *route handlers* do BFF substituem o logger padrão do Nest/Next; `customProps` lê `requestContext.logFields()` (US-080) para injetar `correlationId`/`tenantId`/`userId`/`membershipId` em toda linha; o `redact` cobre a lista de DEC-138.
3. O `instrumentation-pino` injeta `traceId`/`spanId` em cada log quando há span ativo, ligando logs e traces sem esforço manual.
4. A cada requisição, o BFF valida (ou gera) o `correlationId` e injeta `traceparent` na chamada à API (`fetch` instrumentado); a API propaga ambos para o envelope do outbox (US-082) e para o `JobMeta` de cada job (US-083); o worker os recebe e os usa nos seus próprios logs/spans.
5. Operações de negócio caras ou centrais (ex.: `process.forward`, `numbering.next`, `document.render`) abrem um span manual com os atributos permitidos de `observability.md` §4.3 — nesta story, aplicado apenas à rota de exemplo da US-080, como padrão de referência para as stories seguintes.
6. O Collector (perfil `observability` da US-078) recebe logs (stdout → *log driver*), traces (OTLP) e aplica *tail sampling* (100% erro/lento/`cf.critical`, 10% do resto em produção).

## Fluxos alternativos
- **FA-01 — Cliente envia `X-Correlation-Id` fora do padrão:** o BFF descarta o valor (não casa `^[A-Za-z0-9._:-]{8,64}$`) e gera um novo UUIDv7, evitando *log injection*.
- **FA-02 — Span ativo ausente:** logs emitidos fora de uma requisição/job (ex.: *bootstrap*) saem sem `traceId`/`spanId`, sem erro.
- **FA-03 — Debug temporário:** ativação de nível `debug` por `correlationId` ou `tenantId` via flag operacional (TTL ≤ 1 h) é uma **proposta** (`observability.md` §2.5) registrada como lacuna; nesta story só o nível por `LOG_LEVEL` de ambiente é obrigatório.
- **FA-04 — Exportador de traces indisponível:** o SDK falha ao exportar para o Collector sem lançar exceção na requisição (log `warn` local); a resposta ao cliente não é afetada.
- **FA-05 — Rota de health/metrics:** `/health/*` e `/metrics` são explicitamente excluídas do log automático (`autoLogging.ignore`) e da instrumentação HTTP, para não gerar ruído (reservado à US-085).

## Regras de negócio
- **RN-FND-71** — Todo processo Node (`api`, `worker`, `web`) usa pino para logs em **JSON para stdout**, com os campos obrigatórios de `observability.md` §2.2 (`time`, `level`, `msg`, `event`, `service`, `env`, `version`; `correlationId`/`requestId`/`traceId`/`spanId` quando houver contexto; `tenantId`/`userId`/`membershipId` quando autenticado); `event` é um nome estável em `snake.case`/`dot.case`, nunca texto livre.
- **RN-FND-72** — Níveis seguem `observability.md` §2.3: `fatal` só para falha irrecuperável de *bootstrap*; `error` para 5xx/falha final/violação de invariante; `warn` para degradação recuperável; `info` para fatos operacionais (inclusive 4xx de validação e 401/403/404, com `reason`); `debug`/`trace` nunca habilitados em produção por padrão.
- **RN-FND-73** — Redação automática (`redact` do pino) cobre 100% da lista proibida de DEC-138 (tokens, cookies, `Authorization`, senha, CPF, `draftContent`/conteúdo de documento, corpo de requisição/upload, URL pré-assinada, nome de arquivo, segredo de integração); e-mails saem mascarados (`j***@dominio.gov.br`); serializers de requisição/resposta usam **allowlist** (nunca corpo); todo campo sensível novo em DTO ganha teste de redação antes do merge.
- **RN-FND-74** — `correlationId`: o BFF valida o header recebido do browser contra `^[A-Za-z0-9._:-]{8,64}$` e gera um novo UUIDv7 quando ausente ou inválido; a API sempre devolve o `correlationId` vigente no header `X-Correlation-Id` e no corpo `problem+json` (DEC-103) de toda resposta, sucesso ou erro; o valor é propagado para o envelope do evento (DEC-160), `JobMeta` (DEC-164), e-mails (header técnico) e `Gotenberg-Trace`.
- **RN-FND-75** — O OpenTelemetry Node SDK é carregado antes de qualquer código de aplicação em `api` e `worker` (`--import ./otel.mjs`) e via `instrumentation.ts` no `web`, com as instrumentações de `observability.md` §4.1; `/health/*` e `/metrics` são ignoradas pela instrumentação HTTP; nenhuma instrumentação captura corpo, *headers* sensíveis ou parâmetros de consulta (o `ioredis` registra somente o nome do comando).
- **RN-FND-76** — Propagação por **W3C Trace Context** (`traceparent`/`tracestate`, sem *baggage*) em toda chamada nova: browser→BFF (span raiz aberto no BFF), BFF→API (via `fetch` instrumentado), API→outbox→filas (via `metadata.traceparent` e `JobMeta`), worker→dependências externas (S3, Gotenberg, ClamAV, SMTP/SES).
- **RN-FND-77** — Amostragem: SDK com `ParentBased(AlwaysOn)` (todo span chega ao Collector); *tail sampling* no gateway retém 100% dos traces com erro, duração acima do limite da classe (HTTP > 2 s) ou `cf.critical = true`, e 10% dos demais em produção (100% em dev/homologação).
- **RN-FND-78** — Spans de negócio manuais (`observability.md` §4.3) usam apenas atributos da *allowlist* (`cf.*` com UUIDs, códigos, enums, contagens, durações); proibidos nomes, e-mails, CPF, IP, conteúdo, valores monetários, nomes de arquivo, URLs pré-assinadas, tokens e parâmetros SQL — mesma política de dados proibidos dos logs (DEC-138), aplicada a traces.

## Campos
| Campo (variável de ambiente / config) | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|
| `LOG_LEVEL` | enum | Não | `fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace` | `info` (nunca `debug`/`trace` em `production`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | URL | Sim | URL válida do Collector | US-078 (perfil `observability`) |
| `OTEL_SERVICE_NAME` | texto | Sim | `contrataflow-api`\|`contrataflow-worker`\|`contrataflow-web` | fixo por app |
| `APP_VERSION` | texto | Não | `<versão>+g<commit>` | injetado no build (US-079) |
| `OTEL_TRACES_SAMPLER_ARG` | número | Não | 0–1 | `1` (dev/homolog); `0.1` produção (tail sampling faz o corte real) |

## Validações
| # | Validação | Camada | Mensagem/efeito | Código de erro |
|---|---|---|---|---|
| V-01 | `X-Correlation-Id` do cliente fora do padrão `^[A-Za-z0-9._:-]{8,64}$` | BFF (geração de contexto) | Valor descartado; novo UUIDv7 gerado | — (sem erro ao cliente) |
| V-02 | Campo sensível novo sem teste de redação | CI (US-079, estágio de testes) | Build falha | — |
| V-03 | `LOG_LEVEL=debug`/`trace` em `NODE_ENV=production` | `ConfigModule` (bootstrap) | Processo não sobe | — (falha de *bootstrap*) |
| V-04 | Instrumentação captura campo fora da *allowlist* | Teste automatizado de serializers | Falha de teste, não de runtime | — |

## Permissões
- **Permissão:** esta story não introduz nenhuma permissão `RESOURCE_ACTION` — logs e traces são infraestrutura transversal, sem controle de acesso de negócio.
- **Políticas:** acesso ao backend de logs/traces (Grafana/Loki/Tempo) é infraestrutura operacional, fora do RBAC de tenant; investigação por tenant segue DEC-139 (vínculo de suporte temporário) quando feita por operador da plataforma.
- **MFA:** não aplicável.
- **Sem permissão:** não aplicável — não há rota própria desta story (herda os *guards* da US-080 na rota de exemplo usada para demonstrar logs/traces).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Não aplicável: esta story não emite evento de domínio; ela propaga `correlationId`/`traceparent` nos eventos que a US-082 já emite. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Não aplicável nesta story; alertas técnicos (ex.: exportador de traces fora) pertencem à US-085. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Logs estruturados, correlationId e tracing

  Background:
    Given que a API, o worker e o BFF inicializam com pino e o OpenTelemetry Node SDK configurados
    And existe uma rota interna de exemplo (US-080) e um job de teste instrumentados

  Scenario: [Sucesso] Requisição completa gera log e trace correlacionados
    When a rota de exemplo for chamada sem "X-Correlation-Id"
    Then o log de "http.request.completed" deve conter "correlationId", "traceId" e "spanId"
    And a resposta deve devolver o mesmo "correlationId" no cabeçalho "X-Correlation-Id"

  Scenario: [Validação] correlationId do cliente fora do padrão é descartado
    When a rota de exemplo for chamada com o cabeçalho "X-Correlation-Id" igual a "a b c"
    Then a API deve gerar um novo "correlationId" no formato UUIDv7
    And o valor recebido não deve aparecer em nenhum log

  Scenario: [Permissão] Ativação de debug temporário é restrita e auditada
    Given que a ativação de "debug" por correlationId é uma flag operacional (proposta)
    When um operador sem permissão de plataforma tentar ativá-la
    Then a ativação deve ser negada
    And nenhuma rota de negócio deve ser afetada

  Scenario: [Tenant incorreto] Contexto não vaza entre requisições concorrentes
    Given duas requisições simultâneas de tenants diferentes
    When ambas forem processadas pela rota de exemplo
    Then cada log deve conter apenas o "tenantId" da sua própria requisição
    And nenhum log deve misturar "correlationId" das duas requisições

  Scenario: [Duplicidade] Retentativa da mesma ação reaproveita o correlationId
    Given que uma ação do usuário gerou "correlationId" "c-001"
    When a mesma ação for reenviada automaticamente após falha de rede
    Then a nova tentativa deve usar o mesmo "correlationId" "c-001"
    And os logs das duas tentativas devem ser encontrados pela mesma busca

  Scenario: [Concorrência] traceId distintos não se cruzam
    Given duas chamadas concorrentes à rota de exemplo
    When os spans de cada chamada forem abertos
    Then cada chamada deve produzir um "traceId" diferente
    And nenhum span filho deve aparecer sob o "traceId" da outra chamada

  Scenario: [Falha de banco] Indisponibilidade do Collector não afeta a resposta
    Given que o endpoint OTLP do Collector está indisponível
    When a rota de exemplo for chamada
    Then a API deve responder normalmente ao cliente
    And deve ser registrado log "warn" indicando falha de exportação

  Scenario: [Falha de integração] traceparent se propaga até o job assíncrono
    Given que a rota de exemplo dispara um job de teste via outbox
    When o worker processar esse job
    Then o log do job deve conter o mesmo "correlationId" da requisição de origem
    And o span do job deve ser filho do "traceId" da requisição
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento |
|---|---|---|---|---|
| — | — | — | — | Não aplicável como erro de negócio: esta story não introduz novo código de `api.md`; falhas do próprio mecanismo (exportador indisponível) degradam em log `warn`, nunca em erro ao cliente (FA-04). |

## Dependências
- **Stories:** US-080 (pipeline de requisição e `RequestContext`, pré-requisito direto); US-078 (Collector/Grafana/Loki/Tempo do perfil `observability`). Habilita diretamente US-085 (métricas e health reaproveitam o mesmo SDK) e dá a toda story de negócio a partir de US-001 o padrão de log/trace a seguir.
- **Decisões/ADRs:** DEC-138, DEC-160, DEC-164; `observability.md` §2–§4.
- **Configurações:** variáveis da tabela "Campos".
- **Lacunas nas fontes canônicas:** (1) `observability.md` §2.5 marca a ativação de `debug` por `correlationId`/`tenantId` como **proposta**, sem mecanismo de flag definido — nesta story fica fora do escopo (FA-03), registrado para story futura de ferramentas operacionais; (2) o nome do módulo que agrega logger + SDK de tracing não é fixado em nenhuma fonte canônica — proposta desta story: `ObservabilityModule` em `apps/api/src/modules/platform/observability/` (mesmo diretório ilustrado em `observability.md` §2.4), reaproveitado pelo `apps/worker`.

## Impacto técnico
- Define o **padrão de observabilidade** que toda story de negócio herda a partir de agora: nome de evento de log estável, campos obrigatórios e proibidos, span manual para operação cara. Mudança futura nesse padrão é transversal e revisada como regra de fronteira (CODEOWNERS da US-077).
- Custo de performance: instrumentação OTel soma *overhead* por requisição (meta: incluída no orçamento de 10 ms p95 já reservado pela US-080 para o pipeline).
- Qualquer `Promise` fora da cadeia do Nest (já alertado na US-080 para o `AsyncLocalStorage`) também precisa propagar o contexto de trace explicitamente, ou o span fica órfão — documentar junto no `CONTRIBUTING.md`.
- Esta story não altera nenhuma tabela nem contrato de API pública; é inteiramente aditiva sobre o pipeline da US-080.

## Backend
- **Módulo(s):** `platform` (submódulo `observability`: configuração de pino, bootstrap do OTel SDK, *helpers* de span manual); instrumenta (sem alterar contrato) os módulos vazios de DEC-040.
- **Casos de uso:** não aplicável — mecanismo transversal, sem comando/query de negócio.
- **Domínio:** não aplicável.
- **Integrações internas:** expõe `Logger` (wrapper fino sobre `nestjs-pino`) e um *helper* `withSpan(name, attributes, fn)` para spans manuais, consumidos por qualquer módulo.
- **Transação:** não aplicável.

## Frontend
Não aplicável como tela própria — o BFF (Next.js) ganha logger pino e `instrumentation.ts` do OpenTelemetry nos seus próprios *route handlers*, mas nenhuma interface é criada ou alterada nesta story (a casca web é da US-086).

## Banco de dados
Não aplicável — nenhuma tabela, migração ou índice nesta story.

## API
Não aplicável como *endpoints de negócio* — esta story não cria nenhum ID do catálogo de `api.md` §3. O que ela garante é que toda resposta (sucesso ou erro) de qualquer rota, presente ou futura, carregue `X-Correlation-Id` (já contratado pela US-080) e que o log/trace correspondente exista no backend de observabilidade.

## Logs
- `info` `http.request.completed` / `job.completed` — campos obrigatórios de §2.2.
- `warn` `tracing.export_failed` — exportador OTLP indisponível (FA-04).
- `warn` `observability.debug_flag_denied` — tentativa de ativação de debug sem permissão (FA-03/proposta).
- `error` `http.unhandled_exception` (já previsto na US-080) agora correlacionado a `traceId`.
- **Nunca logar:** a lista de DEC-138 (RN-FND-73); nomes de arquivo; URLs pré-assinadas.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | — | Não aplicável: logs não são trilha de auditoria (`observability.md` §13, ADR-009); esta story não grava `AuditLog`. |

## Testes necessários
- **Unitários:** *redact* do pino cobre cada campo proibido de DEC-138; validação do regex de `correlationId`; *helper* `withSpan` com atributos permitidos/proibidos.
- **Integração (Testcontainers/Collector local):** log emitido chega ao Loki local com os campos obrigatórios; trace chega ao Tempo local com `traceId` único por requisição.
- **API/contrato:** resposta de sucesso e de erro da rota de exemplo sempre contém `X-Correlation-Id`.
- **RBAC e multi-tenant:** não aplicável diretamente (sem permissão nova); teste de não vazamento de `tenantId` entre logs concorrentes (cenário "Tenant incorreto").
- **Concorrência:** duas requisições simultâneas não compartilham `traceId`/`correlationId` (AsyncLocalStorage, já parcialmente coberto pela US-080, estendido aqui para logs/spans).
- **E2E (Playwright):** não aplicável (sem UI nesta story).
- **Acessibilidade/performance:** não aplicável à acessibilidade; performance: *overhead* de logging + tracing < 10 ms p95 adicionais sobre o orçamento da US-080.

## Definition of Done
- [ ] pino configurado em `api`, `worker` e `web` com os campos obrigatórios de `observability.md` §2.2
- [ ] Redação (DEC-138) testada para cada campo proibido; nenhum dado sensível em log de exemplo
- [ ] `correlationId` validado/gerado no BFF e devolvido em toda resposta (sucesso e erro)
- [ ] OpenTelemetry SDK carregado antes da aplicação em `api`/`worker`/`web`, com instrumentações de §4.1
- [ ] `traceparent` propagado até o outbox/job de teste (ponta a ponta demonstrado)
- [ ] *Helper* de span manual disponível e documentado para as próximas stories
- [ ] Teste de não vazamento de contexto entre requisições concorrentes passando
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — conecta bibliotecas e SDKs já escolhidos (DEC-050) a um pipeline que já existe (US-080); não cria contrato HTTP novo, mas exige rigor na redação de dados sensíveis e na propagação ponta a ponta.

## Prioridade
**P0** — sem logs/correlationId/tracing consistentes, nenhum incidente das ~100 stories seguintes é diagnosticável; a US-085 (métricas/health) depende do mesmo SDK.
