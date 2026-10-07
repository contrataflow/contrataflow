---
id: US-080
title: "Esqueleto da API modular"
epic: EP-015
feature: FT-048
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-077]
modules: [platform]
screens: []
endpoints: []
permissions: []
events: []
---

# US-080 — Esqueleto da API modular

## Título
Esqueleto da API modular

## Descrição
**Como** time de engenharia do ContrataFlow, **quero** a API NestJS organizada nos módulos de DEC-040 com as quatro camadas de DEC-041, mais os mecanismos transversais que toda rota de negócio vai usar — configuração validada, filtro de erro RFC 9457, guards de autenticação/tenant/vínculo, contexto de requisição por `AsyncLocalStorage`, *throttling*, idempotência, paginação e geração de OpenAPI —, **para** que cada story de negócio seguinte só precise adicionar domínio e caso de uso, sem reinventar como a API autentica, erra, limita ou documenta.

Esta story não implementa nenhuma regra de negócio: cria os módulos vazios (ou com *stubs*) na forma definitiva, conecta os mecanismos transversais ao pipeline de requisição do NestJS e garante, por teste, que uma rota de exemplo responde exatamente como `api.md` descreve — erro, cabeçalhos, paginação e envelope — antes que exista qualquer tabela real (Prisma é da US-081).

## Contexto
- A US-077 deixou `apps/api` com um `AppModule` vazio só para provar que o processo sobe e encerra limpo; nenhuma convenção de erro, autenticação ou contrato está implementada ainda.
- `api.md` (DEC-100 a DEC-108) já fixa o contrato que toda rota deve seguir: envelope `{ data }`/`{ data, meta }`, cabeçalhos (`X-Correlation-Id`, `Idempotency-Key`, `If-Match`/`ETag`…), erros RFC 9457 com `code` estável e `errors[]`/`violations[]`, paginação por página ou cursor, *rate limit* por classe.
- DEC-132 define o contexto de requisição (`tenantId`, `userId`, `membershipId`, `correlationId`, IP, *user-agent*) propagado por `AsyncLocalStorage`; DEC-134 define RBAC com escopo; nenhum dos dois tem onde "morar" até esta story criar os guards e o módulo de contexto.
- Esta é a fundação sobre a qual **todas** as stories de negócio (a partir de US-001) serão construídas; por isso ela precisa existir **antes** da persistência real (US-081) — os guards que dependem de dados (usuário, vínculo) usam, por ora, um adaptador em memória, substituído pela implementação Prisma na US-081 sem mudar a interface pública do módulo `access`/`identity`.
- A US-001 (primeira story de negócio) já pressupõe explicitamente esse alicerce ("Esta é a primeira story de negócio implementada sobre a fundação; ela estabelece os padrões de comando transacional que as demais stories seguirão") — ou seja, esta story entrega a parte *anterior* a esse alicerce transacional: o esqueleto HTTP.

## Objetivo
Entregar uma API que sobe com todos os módulos de DEC-040 registrados nas camadas de DEC-041, na qual uma rota de exemplo demonstra, com teste automatizado, 100% dos mecanismos transversais (erro RFC 9457, guards, `AsyncLocalStorage`, idempotência, *throttling*, paginação, OpenAPI) funcionando conforme `api.md`, pronta para a US-081 ligar a persistência real.

## Persona
- **Principal:** Pessoa desenvolvedora backend do ContrataFlow (usa o esqueleto para construir cada módulo de negócio).
- **Secundárias:** Pessoa desenvolvedora frontend (consome o contrato de erro/paginação já estável); pipeline de CI (US-079, estágio Contrato valida o OpenAPI gerado aqui).

## Pré-condições
- US-077 concluída (`apps/api` com `AppModule` vazio, scripts, ESLint com as regras de fronteira de DEC-041).
- US-078 disponível para rodar testes de integração que dependam de Redis (throttler/idempotência); não é pré-requisito de build.

## Fluxo principal
1. A pessoa desenvolvedora roda `pnpm turbo gen package` → gerador `api-module` (US-077) para cada módulo de DEC-040, criando as pastas `domain/`, `application/`, `infrastructure/`, `presentation/` e `<modulo>.module.ts` (vazios, com um `README.md` de uma linha indicando a responsabilidade — entities.md §4).
2. `AppModule` registra: `ConfigModule` (global, validação Zod do `.env` no *bootstrap*), `RequestContextModule` (middleware que abre o `AsyncLocalStorage` por requisição), os *guards* globais (autenticação → tenant → vínculo, nesta ordem), o filtro global de exceções (RFC 9457), o interceptor de paginação/envelope, o interceptor de idempotência e o `ThrottlerModule` com armazenamento Redis — e, por fim, todos os módulos de DEC-040 (vazios nesta story).
3. Uma rota de exemplo (`GET /api/v1/_internal/ping` e `POST /api/v1/_internal/echo`, interna e não documentada publicamente) exercita o pipeline completo: autenticação, tenant, paginação (no `GET` de uma lista fictícia), idempotência e erro de validação Zod.
4. No *bootstrap*, `openapi:generate` lê os metadados dos *controllers* e schemas Zod (DEC-054) e escreve o OpenAPI 3.1 versionado em `openapi/api.v1.json`, consumido pelo estágio "Contrato" da US-079.
5. Qualquer requisição que chegue à API passa, nesta ordem: *middleware* de contexto (lê/gera `X-Correlation-Id`, abre o `AsyncLocalStorage`) → *guard* de autenticação (valida o JWT contra o *provider* de JWKS — real na US-087, *fake* determinístico até então) → *guard* de tenant (resolve `X-Tenant-Id`, DEC-132) → *guard* de vínculo ativo → *throttler* (classe pela rota) → `ZodValidationPipe` do *schema* do *endpoint* → *handler* → interceptor de paginação/envelope → resposta.
6. Qualquer exceção lançada em qualquer camada é capturada pelo filtro global e convertida para `application/problem+json` conforme `api.md` §2, com `correlationId` do contexto atual.

## Fluxos alternativos
- **FA-01 — Módulo sem rotas ainda:** módulos de DEC-040 sem nenhum *controller* (todos, nesta story) ainda aparecem no `AppModule` e são verificados pelo `dependency-cruiser`; não geram nenhuma rota.
- **FA-02 — Ambiente sem Authentik real:** o *guard* de autenticação usa um `FakeJwksProvider` (chave simétrica de teste) enquanto a US-087 não entrega o provedor real — a interface (`TokenVerifierPort`) já é a definitiva.
- **FA-03 — Ambiente sem Prisma real:** o *guard* de vínculo e a resolução de usuário usam um `InMemoryMembershipRepository` (dados fixos de teste) atrás da mesma porta que a US-081 vai implementar com Prisma — nenhum código de guard muda quando isso acontecer.
- **FA-04 — Redis indisponível:** *throttler* e idempotência degradam (falha aberta/sem idempotência) conforme CA-T-07 (`mvp-01/acceptance-criteria.md`); a requisição não falha por esse motivo isolado.
- **FA-05 — Cliente sem `X-Correlation-Id`:** a API gera um novo e o devolve em toda resposta, inclusive erro.
- **FA-06 — Rota pública (sem X-Tenant-Id aplicável):** uma *allowlist* explícita de rotas (ex.: `/health/*`, reservada à US-085) pula o *guard* de tenant; nenhuma rota de negócio entra nessa lista por padrão.

## Regras de negócio
- **RN-FND-29** — Todo módulo de DEC-040 existe em `apps/api/src/modules/<modulo>/` com as quatro camadas de DEC-041 (mesmo vazias) e é registrado no `AppModule`; `domain/` não importa NestJS, Prisma ou qualquer infraestrutura (verificado pelo `dependency-cruiser` da US-077).
- **RN-FND-30** — `ConfigModule` é global e valida **100%** das variáveis de ambiente lidas pela aplicação contra um *schema* Zod único no *bootstrap*; variável ausente/inválida impede o processo de subir, com mensagem apontando a chave; nenhum acesso a `process.env` fora de `src/config/**` (regra já prevista no ESLint da US-077).
- **RN-FND-31** — O filtro global de exceções converte toda saída em `application/problem+json` (`api.md` §2): `code` estável, `correlationId` do contexto, `errors[]` (§2.1.1) para falhas de *schema* Zod, `violations[]` (§2.1.2) para regras de negócio; qualquer exceção não mapeada responde **500** `INTERNAL_ERROR` sem detalhe interno no corpo (*stack* só em log `debug`).
- **RN-FND-32** — Todo *endpoint* valida corpo/*query*/parâmetros com `ZodValidationPipe` a partir de um *schema* de `packages/validation` (DEC-054); nenhuma regra de formato é duplicada manualmente no *controller*.
- **RN-FND-33** — *Guards* globais executam nesta ordem fixa: autenticação (JWT via *provider* de JWKS em cache; `401 UNAUTHENTICATED`/`SESSION_EXPIRED`) → tenant (`X-Tenant-Id`, tenant `ACTIVE`; `403 TENANT_SUSPENDED`) → vínculo (`TenantMembership` `ACTIVE` e não expirado; `403 MEMBERSHIP_INACTIVE`) → MFA quando a rota exigir (`403 MFA_REQUIRED`, ponto de extensão para quando a política existir). Rotas na *allowlist* de públicas pulam os guards de tenant/vínculo.
- **RN-FND-34** — O contexto de requisição (`RequestContext`: `tenantId`, `userId`, `membershipId`, `correlationId`, IP, *user-agent*) é aberto por um *middleware* via `AsyncLocalStorage` antes de qualquer *guard* e fica disponível a qualquer camada sem parâmetros explícitos; `correlationId` vem de `X-Correlation-Id` ou é gerado, e é devolvido em toda resposta (sucesso ou erro); o contexto nunca atravessa para outra requisição concorrente (verificado por teste de carga com IDs únicos).
- **RN-FND-35** — Interceptor `@Idempotent()` com armazenamento Redis (24h, chave `tenant + usuário + método + rota` — DEC-105): mesma chave e corpo devolve a mesma resposta (`Idempotent-Replayed: true`); corpo diferente → **422** `IDEMPOTENCY_KEY_REUSED`; requisição original ainda em processamento → **409** `IDEMPOTENCY_IN_PROGRESS`; Redis indisponível → segue sem idempotência com log `warn` (nunca derruba a requisição por esse motivo).
- **RN-FND-36** — *Throttler* com armazenamento Redis por classe de rota (`api.md` §1.6: leitura, escrita/comandos, autosave de seção, exportação/renderização, upload, global por tenant); excedente responde **429** `RATE_LIMITED` com `RateLimit-Limit`/`RateLimit-Remaining`/`RateLimit-Reset`/`Retry-After`; Redis principal indisponível → falha **aberta** (disponibilidade acima de precisão de contagem, CA-T-07).
- **RN-FND-37** — Dois *helpers*/DTOs de paginação cobrem 100% das rotas de lista: página (`?page&pageSize`, máx. 100) → `meta: { page, pageSize, totalItems, totalPages }`; cursor (`?cursor&limit`, máx. 100) → `meta: { nextCursor, hasMore }` (DEC-106); nenhuma rota de lista usa formato ad-hoc.
- **RN-FND-38** — `openapi:generate` produz um OpenAPI 3.1 a partir dos *schemas* Zod e metadados de *controller*, versionado em `openapi/api.v1.json`; é o mesmo artefato comparado pelo estágio "Contrato" da US-079 — gerar localmente e no CI deve produzir bytes idênticos (determinístico).

## Campos
| Campo (variável de ambiente / config) | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|
| `PORT` | porta | Não | 1–65535 | `4000` |
| `NODE_ENV` | enum | Sim | `development`\|`test`\|`production` | `development` |
| `REDIS_CACHE_URL` | URL | Sim | `redis://…` válido | US-078 (`redis-cache`) |
| `OIDC_ISSUER_URL` | URL | Sim | URL válida | US-078 (Authentik) / `FakeJwksProvider` em teste |
| `OIDC_AUDIENCE` | texto | Sim | não vazio | `contrataflow-api` |
| `CORRELATION_HEADER_NAME` | texto | Não | fixo por contrato | `X-Correlation-Id` |
| `PAGINATION_MAX_PAGE_SIZE` | número | Não | 1–100 | `100` (DEC-106) |
| `RATE_LIMIT_READ_PER_MIN` | número | Não | > 0 | `600` (api.md §1.6) |
| `RATE_LIMIT_WRITE_PER_MIN` | número | Não | > 0 | `120` |
| `IDEMPOTENCY_TTL_HOURS` | número | Não | > 0 | `24` (DEC-105) |

## Validações
| # | Validação | Camada | Mensagem/efeito | Código de erro |
|---|---|---|---|---|
| V-01 | Variável de ambiente ausente/inválida | `ConfigModule` (bootstrap) | Processo não sobe; log aponta a chave | — (falha de *bootstrap*) |
| V-02 | Corpo/*query* fora do *schema* Zod | `ZodValidationPipe` | "Revise os campos destacados." | `VALIDATION_ERROR` (`errors[]`, §2.1.1) |
| V-03 | JSON malformado | *body parser* | — | `MALFORMED_REQUEST` (400) |
| V-04 | Token ausente/inválido/expirado | Guard de autenticação | — | `UNAUTHENTICATED` / `SESSION_EXPIRED` (401) |
| V-05 | Tenant não `ACTIVE` | Guard de tenant | — | `TENANT_SUSPENDED` (403) |
| V-06 | Vínculo inativo/expirado ou sem acesso ao tenant do header | Guard de vínculo | — | `MEMBERSHIP_INACTIVE` (403) |
| V-07 | `Idempotency-Key` reutilizada com corpo diferente | Interceptor de idempotência | — | `IDEMPOTENCY_KEY_REUSED` (422) |
| V-08 | Mesma chave em processamento | Interceptor de idempotência | — | `IDEMPOTENCY_IN_PROGRESS` (409) |
| V-09 | Limite de requisições excedido | Throttler | — | `RATE_LIMITED` (429) com `Retry-After` |
| V-10 | `If-Match` ausente em rota que exige | Guard/*pipe* de concorrência (infraestrutura pronta; sem recurso versionado real nesta story) | — | `PRECONDITION_REQUIRED` (428) |
| V-11 | Exceção não mapeada | Filtro global | "Ocorreu um erro inesperado. Código: {correlationId}." | `INTERNAL_ERROR` (500) |

## Permissões
- **Permissão:** esta story não introduz nenhuma permissão `RESOURCE_ACTION` de negócio — ela constrói o **mecanismo** (*guards*) que toda permissão futura vai usar. A rota de exemplo exige apenas autenticação + tenant + vínculo (sem checagem de RBAC granular, que é por recurso e vem com cada módulo de negócio).
- **Políticas:** ordem fixa dos *guards* (RN-FND-33) é a política transversal desta story; políticas contextuais específicas (custódia, segregação…) continuam em cada módulo de negócio (DEC-134).
- **MFA:** ponto de extensão criado (`403 MFA_REQUIRED` mapeado no filtro de erro); nenhuma rota desta story o exige — ativado por módulo quando a permissão tiver `riskLevel = HIGH` e a política do tenant pedir.
- **Sem permissão:** qualquer falha dos *guards* de autenticação/tenant/vínculo responde com o código correspondente (RN-FND-33) e gera log `warn` (a auditoria `access.denied` de negócio continua a cargo do módulo `access`, em story própria).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Não aplicável: eventos de domínio nascem com o primeiro agregado de negócio (US-001) e o outbox (US-082); esta story não produz nenhum. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Não aplicável nesta story. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Esqueleto da API modular

  Background:
    Given que a API sobe com o "AppModule" registrando todos os módulos de DEC-040
    And existe uma rota interna de exemplo protegida pelos guards padrão
    And o ambiente local da US-078 está disponível para o Redis do throttler/idempotência

  Scenario: [Sucesso] Requisição completa passa pelo pipeline padrão
    Given um token válido do "FakeJwksProvider" para o usuário "Ana" no tenant "Prefeitura A"
    When "Ana" chamar a rota de exemplo com "X-Tenant-Id" da "Prefeitura A" e sem "X-Correlation-Id"
    Then a API deve responder 200 com o corpo no formato "{ data: ... }"
    And a resposta deve conter um "X-Correlation-Id" gerado pela API

  Scenario: [Validação] Corpo fora do schema Zod
    When for enviado um corpo inválido para a rota de exemplo que aceita escrita
    Then a API deve responder 422 com "code" igual a "VALIDATION_ERROR"
    And o corpo deve conter "errors[]" com ao menos um item com "field" e "code"

  Scenario: [Permissão] Requisição sem token
    When uma requisição for enviada sem o cabeçalho "Authorization"
    Then a API deve responder 401 com "code" igual a "UNAUTHENTICATED"

  Scenario: [Tenant incorreto] Cabeçalho de tenant sem vínculo ativo
    Given que "Ana" tem vínculo ativo apenas na "Prefeitura A"
    When "Ana" enviar "X-Tenant-Id" da "Prefeitura B"
    Then a API deve responder 403 com "code" igual a "MEMBERSHIP_INACTIVE"
    And a resposta não deve indicar se a "Prefeitura B" existe

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que uma requisição de escrita foi enviada com "Idempotency-Key" "K1" e respondeu 201
    When a mesma requisição for reenviada com a chave "K1" e o mesmo corpo
    Then a API deve responder com o mesmo resultado anterior
    And o cabeçalho "Idempotent-Replayed" deve ser "true"

  Scenario: [Concorrência] Duas requisições simultâneas com a mesma chave de idempotência
    Given que nenhuma resposta para a chave "K2" foi registrada ainda
    When duas requisições idênticas com "Idempotency-Key" "K2" forem enviadas ao mesmo tempo
    Then uma delas deve ser processada normalmente
    And a outra deve receber 409 com "code" igual a "IDEMPOTENCY_IN_PROGRESS"

  Scenario: [Falha de banco] Dependência crítica de apoio fica indisponível
    Given que o Redis usado pelo throttler está indisponível
    When uma requisição de leitura dentro do limite normal for enviada
    Then a API não deve responder 500 por causa exclusiva da indisponibilidade do Redis
    And deve ser registrado log "warn" indicando o throttler degradado

  Scenario: [Falha de integração] Limite de requisições excedido
    Given que o limite da classe "leitura" já foi atingido para o usuário no minuto corrente
    When uma nova requisição de leitura for enviada
    Then a API deve responder 429 com "code" igual a "RATE_LIMITED"
    And a resposta deve conter o cabeçalho "Retry-After"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento |
|---|---|---|---|---|
| JSON malformado | 400 | `MALFORMED_REQUEST` | "A requisição não pôde ser interpretada." | Filtro global; sem detalhe interno |
| Token ausente/inválido | 401 | `UNAUTHENTICATED` | "Autenticação necessária." | Guard de autenticação |
| Sessão/token expirado | 401 | `SESSION_EXPIRED` | "Sua sessão expirou." | Guard de autenticação |
| Tenant não ativo | 403 | `TENANT_SUSPENDED` | "Este órgão não está ativo." | Guard de tenant |
| Vínculo inativo/expirado | 403 | `MEMBERSHIP_INACTIVE` | "Seu acesso a este órgão não está ativo." | Guard de vínculo |
| Corpo/parâmetros inválidos | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | `ZodValidationPipe` + filtro |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta solicitação já foi enviada com outros dados." | Interceptor de idempotência |
| Idempotência em processamento | 409 | `IDEMPOTENCY_IN_PROGRESS` | "Estamos concluindo a solicitação. Aguarde." | Interceptor de idempotência |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Envie o cabeçalho If-Match." | Infraestrutura pronta (sem recurso real ainda) |
| Limite de requisições excedido | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Throttler; respeita `Retry-After` |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Filtro global; log com *stack* em `debug` |
| Dependência crítica indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Serviço temporariamente indisponível." | Reservado para quando houver dependência crítica real (US-081+) |

## Dependências
- **Stories:** US-077 (scripts, lockfile, gerador `api-module`, regras de fronteira — pré-requisito direto). Habilita diretamente US-081 (persistência substitui os adaptadores em memória), US-082, US-083, US-084 (logging/tracing plugam no mesmo pipeline de requisição) e, por transitividade, toda story de negócio a partir de US-001.
- **Decisões/ADRs:** DEC-040, DEC-041, DEC-054, DEC-100 a DEC-108, DEC-105, DEC-106, DEC-130, DEC-132, DEC-134; ADR-001, ADR-010.
- **Configurações:** variáveis da tabela "Campos"; nenhuma `TenantSetting` (são configuração de plataforma, não de tenant).
- **Lacunas nas fontes canônicas:** os nomes de classe dos mecanismos transversais não são fixados em nenhuma fonte canônica (apenas o comportamento, via DEC-103/104/105/106/132/134 e `api.md`) — propostas desta story: `ProblemDetailsExceptionFilter` (filtro RFC 9457), `RedisThrottlerStorage` (armazenamento do `@nestjs/throttler`), `PageQueryDto`/`CursorQueryDto` (helpers de paginação DEC-106), `FakeJwksProvider`/`InMemoryMembershipRepository` (adaptadores temporários até US-087/US-081). `RequestContext` já é nome canônico (citado literalmente em `multi-tenancy.md`), não é lacuna.

## Impacto técnico
- Define o **pipeline de requisição padrão** que toda rota de negócio vai herdar; qualquer mudança futura nele (ex.: nova classe de *throttle*, novo cabeçalho) é mudança transversal de alto impacto, revisada como as demais regras de fronteira (CODEOWNERS da US-077).
- Guards e repositórios de apoio (usuário, vínculo) são escritos contra **portas** (`UserPort`, `MembershipPort`) com adaptador em memória nesta story — a US-081 troca só o adaptador (Prisma), sem tocar nos *guards* (Dependency Inversion, consistente com DEC-041).
- `openapi:generate` precisa ser **determinístico** (RN-FND-38): mesma entrada produz o mesmo arquivo, byte a byte, para o *diff* do estágio "Contrato" (US-079) não gerar falsos positivos.
- `AsyncLocalStorage` tem custo de performance desprezível mas exige disciplina: qualquer código que crie uma `Promise` fora da cadeia do Nest (ex.: `setTimeout`, fila *fire-and-forget*) precisa propagar o contexto explicitamente ou perdê-lo — documentar no `CONTRIBUTING.md`.
- Esta story não cria nenhuma tabela nem conexão real de banco; "Dependência crítica indisponível" (503) fica como contrato pronto, exercitado de fato a partir da US-081.

## Backend
- **Módulo(s):** `platform` (dono dos mecanismos transversais: `config`, `request-context`, `http` — filtro/*guards*/interceptors, `throttler`, `idempotency`, `pagination`, `openapi`); demais módulos de DEC-040 criados como *esqueleto* (sem lógica).
- **Casos de uso:** não aplicável (sem comandos/queries de negócio); a rota de exemplo não é um caso de uso de produto.
- **Domínio:** não aplicável a esta story — `domain/` de cada módulo nasce vazio, pronto para a primeira regra de negócio que o módulo receber.
- **Integrações internas:** `platform` expõe `RequestContext` (leitura em qualquer camada), `TokenVerifierPort`, `UserPort`, `MembershipPort` (adaptadores em memória nesta story) e o decorator `@Idempotent()`.
- **Transação:** não aplicável (sem persistência ainda); o filtro de erro e os *guards* são *stateless* por requisição.

## Frontend
Não aplicável — story de infraestrutura de backend, sem interface própria. O contrato de erro/paginação/cabeçalhos estabelecido aqui é consumido pelo cliente de API da US-086 (shell web), mas esta story não altera `apps/web`.

## Banco de dados
Não aplicável — nenhuma tabela, migração ou conexão real de banco nesta story (ver US-081). Os adaptadores de apoio (`UserPort`, `MembershipPort`) usam dados em memória fixados em código/teste.

## API
Não aplicável como *endpoints de negócio* — nenhum ID do catálogo de `api.md` §3 é criado por esta story. O que ela entrega são os **mecanismos transversais** usados por todo endpoint futuro: cabeçalhos (`api.md` §1.1), paginação (§1.2/DEC-106), concorrência/idempotência (§1.3/DEC-104/105), limites (§1.6) e o formato de erro (§2), ilustrados pela rota interna de exemplo (não documentada no OpenAPI público).

Exemplo de erro gerado pelo filtro (mesmo formato de `api.md` §2, aqui para `VALIDATION_ERROR`):
```json
{
  "type": "https://docs.contrataflow.com.br/errors/validation-error",
  "title": "Dados inválidos",
  "status": 422,
  "detail": "Revise os campos destacados.",
  "instance": "/api/v1/_internal/echo",
  "code": "VALIDATION_ERROR",
  "correlationId": "c-7f3a2b",
  "errors": [{ "field": "name", "code": "REQUIRED", "message": "Informe o nome." }]
}
```

## Logs
- `info` `http.request_completed` — método, rota, status, duração, `tenantId`/`userId` quando houver, `correlationId`.
- `warn` `guard.rejected` — *guard* e motivo (sem dados sensíveis do token).
- `warn` `idempotency.store_unavailable` / `throttler.store_unavailable` — degradação do Redis.
- `error` `http.unhandled_exception` — `correlationId`, `errorCode`, causa resumida (*stack* só em `debug`).
- **Nunca logar:** corpo de requisição/resposta completo, token/JWT, cabeçalho `Authorization`, segredos de configuração.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | — | Não aplicável: a escrita de `AuditLog` é implementada pelo módulo `audit` em sua própria story; esta story só garante que `correlationId`/`userId`/`tenantId` do `RequestContext` estarão disponíveis para ele. |

## Testes necessários
- **Unitários:** filtro de exceções (cada código de `api.md` §2.1/§2.1.1/§2.1.2 mapeado); `ZodValidationPipe` com *schemas* de teste; *guards* (autenticação/tenant/vínculo) com adaptadores em memória e seus casos de falha; *helpers* de paginação (página e cursor).
- **Integração (Testcontainers Redis):** *throttler* por classe (limite atingido e janela); idempotência (replay, corpo diferente, concorrência); degradação com Redis indisponível (CA-T-07).
- **API/contrato:** `openapi:generate` determinístico (duas execuções geram o mesmo arquivo); rota de exemplo documentada e validada contra o próprio OpenAPI gerado.
- **RBAC e multi-tenant:** matriz de combinações dos *guards* (sem token, token expirado, tenant suspenso, vínculo inativo, vínculo de outro tenant) — base da suíte "tenant leak" que as stories de negócio vão estender.
- **Concorrência:** `AsyncLocalStorage` não deve misturar contexto entre requisições concorrentes (teste de carga com *correlationId* único verificado end-to-end); duas requisições simultâneas com a mesma `Idempotency-Key`.
- **E2E (Playwright):** não aplicável diretamente (sem UI); cobertura de ponta a ponta vem das stories de negócio que usarem este esqueleto.
- **Acessibilidade/performance:** não aplicável (sem UI); meta de performance: *overhead* do pipeline (guards + context + throttler) < 10 ms p95 sobre uma rota vazia.

## Definition of Done
- [ ] Todos os módulos de DEC-040 criados com as quatro camadas de DEC-041 e registrados no `AppModule`
- [ ] `dependency-cruiser` sem violação de fronteira entre módulos/camadas
- [ ] Filtro global de erro cobrindo todos os códigos genéricos de `api.md` §2.1, com `errors[]`/`violations[]` corretos
- [ ] Guards de autenticação/tenant/vínculo funcionando com adaptadores em memória e testados
- [ ] `RequestContext` por `AsyncLocalStorage` disponível em qualquer camada, com teste de não vazamento entre requisições
- [ ] Idempotência e throttler com Redis funcionando e degradando conforme CA-T-07
- [ ] Helpers de paginação (página e cursor) usados pela rota de exemplo
- [ ] `openapi:generate` determinístico e integrado ao estágio "Contrato" da US-079
- [ ] Logs sem dados sensíveis; `correlationId` presente em toda resposta
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**L** — toca contrato transversal (erro, autenticação, tenant, idempotência, throttling, paginação, OpenAPI) que todas as ~100 stories seguintes vão herdar; exige rigor mesmo sem persistência real ainda (adaptadores em memória com interface definitiva).

## Prioridade
**P0** — nenhuma rota de negócio pode ser construída de forma consistente sem este esqueleto; bloqueia toda a `feature` FT-048 e, por padrão, toda story de negócio do MVP 1.
