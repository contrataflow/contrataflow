---
id: US-078
title: "Ambiente local com Docker Compose"
epic: EP-015
feature: FT-047
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-077]
modules: [platform]
screens: []
endpoints: []
permissions: []
events: []
---

# US-078 — Ambiente local com Docker Compose

## Título
Ambiente local com Docker Compose

## Descrição
**Como** pessoa desenvolvedora do ContrataFlow, **quero** subir todas as dependências de infraestrutura do produto com um único comando, **para** codificar e testar localmente sem depender de serviços gerenciados e com dados de dois tenants já semeados para validar isolamento multi-tenant desde o primeiro dia.

Um `docker compose up` (orquestrado por um script `pnpm env:*`) sobe PostgreSQL com pgvector, dois Redis lógicos, MinIO com buckets prontos, Authentik (servidor e worker) já configurado por blueprint, Mailpit, Gotenberg e ClamAV — todos com *healthcheck* — e, em seguida, um script de seed idempotente povoa dois tenants completos ("Prefeitura A" e "Prefeitura B") para que qualquer story de negócio tenha, desde o início, dados realistas e um segundo tenant para testar isolamento.

## Contexto
- A US-077 entrega o monorepo, os scripts (`pnpm build/dev/lint/test`) e deixa `apps/api`/`apps/worker` com `AppModule` vazio — mas nenhuma dependência de infraestrutura sobe ainda; `pnpm test:integration` já é citado ali como dependente desta story.
- Da Sprint 0 em diante, toda story de negócio (criação de processo, DFD, aprovações…) precisa de Postgres com RLS real, sessão/cache em Redis, upload em S3-compatível, autenticação OIDC e geração de PDF — reproduzir cada um manualmente é lento e inconsistente entre máquinas.
- Decisões de produto já fixam a stack: PostgreSQL 17 + `pgvector`/`pg_trgm`/`unaccent`/`citext` (DEC-050), dois Redis lógicos separados para sessão e para cache/filas por criticidade distinta (DEC-131), MinIO em dev para a API S3 (DEC-050, storage.md), Authentik via OIDC Authorization Code + PKCE (DEC-130), Gotenberg para PDF (DEC-060) e ClamAV na varredura de upload (DEC-136). Esta story é a primeira a materializar essas peças como contêineres.
- O ambiente também é a base do estágio "E2E" do pipeline de CI (US-079, arquitetura §4.5): o mesmo arquivo de Compose é reutilizado em um ambiente efêmero.

## Objetivo
Permitir que qualquer pessoa da engenharia, em uma estação limpa com Docker instalado, rode `pnpm env:up && pnpm env:seed && pnpm dev` e tenha, em até 10 minutos (primeira vez; ≤ 3 min com imagens em cache), a aplicação completa no ar com dois tenants de teste, sem editar nenhum arquivo de configuração.

## Persona
- **Principal:** Pessoa desenvolvedora do ContrataFlow (perfil operador do ambiente local).
- **Secundárias:** Pessoa de QA/automação (usa o mesmo ambiente para testes E2E); pipeline de CI (US-079), que reutiliza a definição de Compose em modo efêmero.

## Pré-condições
- US-077 concluída (monorepo, Node 24, pnpm 10, scripts `pnpm dev/build/test`).
- Docker Engine + Docker Compose v2 instalados (Linux nativo, macOS ou Windows com WSL 2 — RN-FND-12 da US-077); ao menos 6 GB de RAM livres para os contêineres.
- Portas padrão (5432, 6379/6380, 9000/9001, 9080/9443, 8025, 3000/4000, …) livres na máquina.

## Fluxo principal
1. A pessoa desenvolvedora clona o repositório (ou atualiza) e copia `.env.example` para `.env` (`cp .env.example .env`); os valores padrão já funcionam sem edição.
2. Executa `pnpm env:up` (wrapper de `docker compose up -d`). O Compose sobe, na ordem de dependência: `postgres` (cria os bancos `contrataflow` e `authentik` e habilita `pgvector`/`pg_trgm`/`unaccent`/`citext` via script de init) → `redis-session` e `redis-cache` → `minio` + job `minio-bootstrap` (cria os buckets lógicos e sai) → `authentik-server`/`authentik-worker` (aplicam o blueprint declarativo) → `mailpit`, `gotenberg`, `clamav`.
3. Cada serviço expõe `healthcheck`; `pnpm env:up` só retorna sucesso quando todos estiverem `healthy` (ou o bootstrap tiver concluído com `exit 0`).
4. A pessoa executa `pnpm env:seed` (idempotente): popula os tenants "Prefeitura A" e "Prefeitura B" (organização, estrutura mínima, os 15 perfis de DEC-035, catálogos semeados, workflow padrão publicado) e cria no Authentik um usuário por persona de cada tenant, com senha de desenvolvimento conhecida documentada no `CONTRIBUTING.md`.
5. A pessoa executa `pnpm dev` (US-077): `web` (3000), `api` (4000) e `worker` passam a usar os serviços acima via `.env`.
6. A pessoa acessa `localhost:3000`, autentica com um usuário semeado (fluxo OIDC real contra o Authentik local) e chega à aplicação; usa `localhost:8025` (Mailpit) para ver e-mails e o console do MinIO para inspecionar objetos.
7. Ao final do dia, `docker compose stop` preserva os volumes; para recomeçar do zero, `pnpm env:reset` executa `down -v` seguido de `env:up` e `env:seed` em um único comando.

## Fluxos alternativos
- **FA-01 — Subir só a infraestrutura:** `pnpm env:up` não inclui `api`/`web`/`worker` (esses sobem por `pnpm dev`, fora do Compose, para hot-reload); quem quiser tudo em contêiner usa `pnpm env:up:full` (perfil `full`).
- **FA-02 — Observabilidade opcional:** `pnpm env:up --profile observability` adiciona Prometheus, Grafana, Loki, Tempo e um coletor OTel (US-085 configura dashboards; aqui eles já sobem prontos para receber dados).
- **FA-03 — Porta ocupada:** o Compose falha com a porta em conflito; `CONTRIBUTING.md` documenta como sobrescrever a porta publicada por variável de ambiente (`POSTGRES_PORT`, …) sem alterar a porta interna.
- **FA-04 — Reaplicar o blueprint do Authentik:** se o blueprint mudar, `authentik-server` reaplica automaticamente no próximo start (blueprints são idempotentes por `id`); não é necessário recriar o volume.
- **FA-05 — Rodar sem o profile `observability`:** padrão; nenhum serviço de observabilidade sobe, e a ausência não impede nenhuma outra funcionalidade.
- **FA-06 — Primeira vez sem internet após imagens já baixadas:** `pnpm env:up` funciona offline se as imagens já estiverem no cache local do Docker.

## Regras de negócio
- **RN-FND-13** — Serviços padrão do Compose: `postgres`, `redis-session`, `redis-cache`, `minio` + `minio-bootstrap`, `authentik-server` + `authentik-worker`, `mailpit`, `gotenberg`, `clamav`; perfil opcional `observability` adiciona `prometheus`, `grafana`, `loki`, `tempo`, `otel-collector`; perfil opcional `full` adiciona `api`, `web`, `worker` como contêineres (uso padrão é via `pnpm dev`, fora do Compose).
- **RN-FND-14** — Um único servidor PostgreSQL 17 hospeda dois bancos lógicos (`contrataflow`, `authentik`), criados por script de inicialização (`docker-entrypoint-initdb.d`); extensões `pgvector`, `pg_trgm`, `unaccent`, `citext` são habilitadas apenas no banco `contrataflow`.
- **RN-FND-15** — Sessão e cache/filas usam instâncias Redis **logicamente separadas** (dois serviços de contêiner, DEC-131) — nunca o mesmo serviço com índices de banco diferentes — para refletir em dev a mesma fronteira de criticidade de produção.
- **RN-FND-16** — O job `minio-bootstrap` cria os buckets lógicos (`quarantine`, `documents`, `renditions` — storage.md §3; ativos do tenant ficam em `documents`, sob `tenants/{tenantId}/assets/`, storage.md §4) e a política de acesso antes de `api`/`worker` ficarem elegíveis a receber tráfego (`depends_on: condition: service_completed_successfully`).
- **RN-FND-17** — O Authentik é provisionado por **blueprint declarativo versionado** no repositório (provider OIDC confidencial para o BFF — DEC-130, *flow* de login, grupos e um usuário por persona dos 15 perfis de DEC-035): a subida não exige nenhum passo manual pela UI do Authentik.
- **RN-FND-18** — `pnpm env:seed` é **idempotente**: reexecuções não duplicam tenants, usuários, catálogos ou buckets; cria exatamente os tenants "Prefeitura A" e "Prefeitura B" com dados suficientes para exercitar isolamento multi-tenant (DEC-080/081/082).
- **RN-FND-19** — Nenhum segredo real no repositório (DEC-137): `.env.example` traz placeholders/valores de desenvolvimento óbvios (ex.: `devpassword`); `gitleaks` (US-077) cobre o repositório; credenciais de bootstrap do Authentik não são usadas pela aplicação em runtime.

## Campos
| Campo (variável de ambiente) | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|
| `POSTGRES_PASSWORD` | texto | Sim | ≥ 8 caracteres | `devpassword` (`.env.example`) |
| `POSTGRES_PORT` | porta | Não | 1–65535 | `5432` |
| `REDIS_SESSION_PORT` | porta | Não | 1–65535 | `6379` |
| `REDIS_CACHE_PORT` | porta | Não | 1–65535 | `6380` |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | texto | Sim | senha ≥ 8 caracteres | `contrataflow` / `devpassword` |
| `MINIO_PORT` / `MINIO_CONSOLE_PORT` | porta | Não | 1–65535 | `9000` / `9001` |
| `AUTHENTIK_SECRET_KEY` | texto | Sim | ≥ 32 caracteres aleatórios | placeholder fixo em `.env.example`; nunca usado em produção |
| `AUTHENTIK_PORT` | porta | Não | 1–65535 | `9080` |
| `MAILPIT_SMTP_PORT` / `MAILPIT_UI_PORT` | porta | Não | 1–65535 | `1025` / `8025` |
| `GOTENBERG_PORT` | porta | Não | 1–65535 | `3030` |
| `CLAMAV_PORT` | porta | Não | 1–65535 | `3310` |
| `COMPOSE_PROFILES` | lista | Não | subconjunto de `observability,full` | vazio |

## Validações
| # | Validação | Camada | Mensagem ao desenvolvedor | Código/saída |
|---|---|---|---|---|
| V-01 | `.env` ausente | `pnpm env:up` | "Arquivo .env não encontrado. Rode: cp .env.example .env" | `ENV_FILE_MISSING` |
| V-02 | Variável obrigatória ausente/vazia | `pnpm env:up` (checagem prévia) | "Defina {variável} no .env." | `ENV_VAR_MISSING` |
| V-03 | Porta já em uso no host | Docker Compose | "Porta {porta} ocupada. Ajuste {VAR}_PORT no .env." | erro nativo do Docker (`port is already allocated`) |
| V-04 | Serviço não atinge `healthy` no tempo limite | `pnpm env:up` | "Serviço {nome} não ficou saudável em {N}s. Veja: docker compose logs {nome}." | `SERVICE_UNHEALTHY` |
| V-05 | `pnpm env:seed` sem o ambiente de pé | script de seed | "Suba o ambiente antes: pnpm env:up." | `ENV_NOT_READY` |
| V-06 | Blueprint do Authentik inválido | `authentik-server` (log) | — (log do contêiner aponta o campo do blueprint) | log `blueprint.invalid` |

## Permissões
- **Permissão (acesso a segredos/ambientes):** qualquer pessoa com acesso de leitura ao repositório pode rodar o ambiente local — não há segredo real nele (RN-FND-19); credenciais são só de desenvolvimento.
- **Políticas:** o usuário administrador de bootstrap do Authentik (`akadmin`) só existe no ambiente local/CI; produção não usa esse fluxo (provisionamento real é tratado fora desta story).
- **MFA:** não aplicável localmente (política `security.mfaPolicy = NONE` nos tenants semeados, para agilizar o desenvolvimento).
- **Sem permissão:** não se aplica — o ambiente local não segrega acesso entre desenvolvedores; o controle real está em quem tem acesso ao repositório/estação.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Não aplicável: story de infraestrutura, sem eventos de domínio. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma (e-mails disparados pela aplicação em dev são capturados pelo Mailpit, não enviados de fato). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Ambiente local com Docker Compose

  Background:
    Given que a US-077 está concluída (monorepo, Node 24, pnpm, Turborepo)
    And o Docker Engine e o Docker Compose v2 estão instalados na estação

  Scenario: [Sucesso] Subir o ambiente do zero
    Given um clone limpo do repositório com ".env" copiado de ".env.example"
    When a pessoa desenvolvedora executar "pnpm env:up" seguido de "pnpm env:seed"
    Then todos os serviços padrão devem reportar "healthy"
    And devem existir os bancos "contrataflow" e "authentik" no Postgres
    And devem existir os tenants "Prefeitura A" e "Prefeitura B" com usuários por persona
    And "pnpm dev" deve permitir login via Authentik em "localhost:3000" com um usuário semeado

  Scenario: [Validação] Variável de ambiente obrigatória ausente
    Given que a variável "MINIO_ROOT_PASSWORD" foi removida do ".env"
    When a pessoa executar "pnpm env:up"
    Then o comando deve falhar antes de chamar o Docker
    And deve exibir "Defina MINIO_ROOT_PASSWORD no .env."

  Scenario: [Permissão] Nenhum segredo real versionado
    When o "gitleaks" (US-077) for executado sobre o repositório
    Then nenhum segredo real deve ser encontrado em ".env.example" ou nos arquivos de blueprint do Authentik

  Scenario: [Tenant incorreto] Isolamento entre os tenants semeados
    Given que "Ana" (persona "REQUISITANTE") existe apenas na "Prefeitura A"
    When "Ana" autenticar e tentar acessar dados da "Prefeitura B"
    Then o sistema não deve exibir nenhum dado da "Prefeitura B"
    And o seletor de tenant de "Ana" deve listar somente "Prefeitura A"

  Scenario: [Duplicidade] Reexecução idempotente do seed
    Given que o ambiente já foi semeado uma vez
    When a pessoa executar "pnpm env:seed" novamente
    Then a quantidade de tenants, usuários e buckets deve permanecer a mesma
    And nenhum erro de duplicidade deve ser exibido

  Scenario: [Concorrência] Subida reentrante do Compose
    Given que "pnpm env:up" está em execução
    When um segundo "pnpm env:up" for disparado em paralelo
    Then o bootstrap do MinIO e o blueprint do Authentik não devem ser aplicados em duplicidade
    And ao final todos os serviços devem estar "healthy"

  Scenario: [Falha de banco] Postgres não inicia
    Given que a porta configurada para o Postgres já está em uso por outro processo
    When a pessoa executar "pnpm env:up"
    Then o comando deve falhar indicando a porta em conflito
    And "api" e "worker" não devem ser iniciados por "pnpm dev"

  Scenario: [Falha de integração] Authentik não fica saudável
    Given que o "authentik-server" não atinge o healthcheck no tempo limite
    When a pessoa executar "pnpm env:up"
    Then o comando deve reportar "authentik-server" como "SERVICE_UNHEALTHY"
    And deve orientar a consultar "docker compose logs authentik-server"
    And os demais serviços já saudáveis não devem ser derrubados
```

## Casos de erro
| Situação | Contexto | Código/saída | Mensagem | Comportamento |
|---|---|---|---|---|
| `.env` ausente | `pnpm env:up` | `ENV_FILE_MISSING` | "Arquivo .env não encontrado. Rode: cp .env.example .env" | Interrompe antes do Docker |
| Variável obrigatória ausente | `pnpm env:up` | `ENV_VAR_MISSING` | "Defina {variável} no .env." | Interrompe antes do Docker |
| Porta ocupada | Docker Compose | erro nativo | "Porta {porta} já alocada." | Sugere `{VAR}_PORT` alternativa |
| Serviço não saudável | `pnpm env:up` | `SERVICE_UNHEALTHY` | "Serviço {nome} não ficou saudável." | Indica comando de logs; não sobe os demais perfis dependentes |
| Seed sem ambiente de pé | `pnpm env:seed` | `ENV_NOT_READY` | "Suba o ambiente antes: pnpm env:up." | Interrompe sem alterar dados |
| Blueprint inválido | `authentik-server` | log `blueprint.invalid` | — | Serviço permanece no ar sem aplicar o blueprint; demais serviços não são afetados |

## Dependências
- **Stories:** US-077 (monorepo, scripts, Node/pnpm — pré-requisito direto). Relacionadas: US-079 (reaproveita este Compose no estágio E2E efêmero), US-081 (schema Prisma consome os bancos aqui criados), US-087 (login real passa a usar este Authentik), US-085 (configura dashboards sobre o perfil `observability` aqui criado).
- **Decisões/ADRs:** DEC-050, DEC-058, DEC-060, DEC-065, DEC-080, DEC-130, DEC-131, DEC-136, DEC-137; ADR-002, ADR-003, ADR-007.
- **Configurações:** variáveis de ambiente da tabela "Campos"; nenhuma `TenantSetting` (são dados semeados, não configuração de produto).
- **Lacunas nas fontes canônicas:** nenhuma (não há 4º bucket: os ativos do tenant usam o bucket `documents`, storage.md §3–§4).

## Impacto técnico
- Define as imagens e versões de infraestrutura para todo o backlog (análogo ao papel da US-077 para a stack de aplicação): `postgres:17-bookworm` com extensão `pgvector` (imagem `pgvector/pgvector:pg17`), `redis:7-alpine` (×2 serviços), `pgsty/minio` + `pgsty/mc` (bootstrap; *build* comunitário do MinIO — a imagem oficial `minio/minio` deixou de ser distribuída, DEC-065), `ghcr.io/goauthentik/server` + `.../worker` (mesma *tag* fixa para os dois), `axllent/mailpit`, `gotenberg/gotenberg:8`, `clamav/clamav`; perfil `observability`: `prom/prometheus`, `grafana/grafana`, `grafana/loki`, `grafana/tempo`, `otel/opentelemetry-collector-contrib`. Tags exatas fixadas no `docker-compose.yml` (sem `latest`).
- `minio-bootstrap` e a aplicação do blueprint do Authentik devem ser **idempotentes** (RN-FND-18) para suportar `env:reset` e reexecução em CI (US-079).
- Volumes nomeados por serviço (`pg-data`, `minio-data`, `authentik-data`) permitem `docker compose down` sem perda e `down -v` para reset total.
- `pnpm test:integration` (US-077) depende deste Compose subir `postgres`/`redis-cache`/`minio` via Testcontainers ou apontando para os serviços já de pé, a critério da suíte.

## Backend
- **Módulo(s):** `platform` (infraestrutura compartilhada; esta story não escreve código de aplicação, apenas a infraestrutura que ele consome).
- **Casos de uso:** não aplicável (sem comandos/queries; entregável é configuração de infraestrutura e scripts).
- **Domínio:** não aplicável.
- **Integrações internas:** nenhuma (API/worker ainda com `AppModule` vazio — US-080 começa a usá-los de fato).
- **Scripts:** `tools/env/up.ts`, `tools/env/seed.ts`, `tools/env/reset.ts` (Node/TypeScript, RN-FND-12 da US-077); `infra/docker-compose.yml` + `infra/compose/*.yml` (overrides por perfil); `infra/authentik/blueprints/*.yaml`; `infra/postgres/init/*.sql`.

## Frontend
Não aplicável — story de infraestrutura, sem interface própria. A aplicação web (US-086) passa a rodar **contra** este ambiente, mas não é alterada por esta story.

## Banco de dados
- **Bancos criados:** `contrataflow` (aplicação; extensões `pgvector`, `pg_trgm`, `unaccent`, `citext`) e `authentik` (schema próprio do Authentik) — mesmo servidor PostgreSQL 17, scripts de init em `infra/postgres/init/`.
- **Migrações:** nenhuma desta story (schema Prisma é da US-081); os bancos nascem vazios além das extensões.
- **Índices/constraints relevantes:** não aplicável nesta story.

## API
Não aplicável — nenhum endpoint REST é introduzido. Portas e URLs internas de cada serviço estão na tabela "Campos" e no Impacto técnico.

## Logs
- `info` `env.up.completed` — lista de serviços e tempo total de subida.
- `warn` `env.service_unhealthy` — serviço que excedeu o tempo de *healthcheck*.
- `warn` `env.seed.skipped_existing` — quando o seed detecta dados já existentes e não recria.
- `error` `env.bootstrap_failed` — falha do `minio-bootstrap` ou da aplicação do blueprint do Authentik.
- **Nunca logar:** valores de `.env` (mesmo sendo de desenvolvimento), payload de blueprint com segredos.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | — | Não aplicável: ambiente local não gera `AuditLog` de negócio. |

## Testes necessários
- **Unitários:** scripts `tools/env/*.ts` (detecção de variável ausente, idempotência do seed simulada com *mocks*).
- **Integração (Testcontainers):** não aplicável diretamente — esta story *é* a infraestrutura usada pelos testes de integração de outras stories.
- **Smoke test do ambiente:** pipeline dedicado (`pnpm env:smoke`) que sobe o Compose, roda o seed e verifica: bancos existentes, buckets criados, login OIDC de ponta a ponta com um usuário semeado, envio de e-mail capturado pelo Mailpit, PDF de teste gerado pelo Gotenberg, arquivo de teste varrido pelo ClamAV.
- **Isolamento multi-tenant:** cenário "tenant leak" básico (usuário da Prefeitura A não vê dados da B) incluído no smoke test.
- **E2E (Playwright):** reutiliza este ambiente (US-079 o sobe em modo efêmero no estágio E2E).

## Definition of Done
- [ ] `pnpm env:up && pnpm env:seed` funciona em uma estação limpa (Linux, macOS e Windows/WSL2) em ≤ 10 min na primeira vez
- [ ] Todos os serviços padrão com *healthcheck* configurado e verificado
- [ ] Dois bancos lógicos criados com as extensões corretas
- [ ] Dois tenants semeados com usuários por persona, catálogos e workflow padrão
- [ ] Blueprint do Authentik aplicado sem passos manuais
- [ ] `pnpm env:reset` comprovadamente idempotente (dobro de execução sem erro)
- [ ] Nenhum segredo real versionado (`gitleaks` limpo)
- [ ] `CONTRIBUTING.md` atualizado com o passo a passo e a tabela de portas
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — integra várias peças já decididas (stack DEC-050) sem inventar lógica de negócio; esforço concentrado em orquestração, *healthchecks*, blueprint do Authentik e idempotência do seed.

## Prioridade
**P0** — bloqueia toda story de negócio que precise de Postgres/Redis/Authentik/MinIO/Gotenberg/ClamAV reais, e é pré-requisito do estágio E2E da US-079.
