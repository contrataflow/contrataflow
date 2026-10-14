# Guia de contribuição — ContrataFlow

Este guia vale para todo o monorepo. As regras citadas (`RN-FND-NN`) estão na
[US-077](docs/backlog/story-077-monorepo-setup.md); decisões de arquitetura (`DEC-NNN`) em
[`docs/architecture/decisions.md`](docs/architecture/decisions.md).

> **Fonte da verdade:** a especificação em `docs/`. Mudou uma regra durante a implementação?
> Atualize primeiro a fonte canônica em `docs/` (e `decisions.md`, se for decisão) e só depois o
> código.

## Sumário

1. [Ambiente](#ambiente)
2. [Primeiros passos](#primeiros-passos)
3. [Ambiente local (Docker Compose)](#ambiente-local-docker-compose)
4. [Estrutura do monorepo](#estrutura-do-monorepo)
5. [Scripts](#scripts)
6. [Branches e PRs](#branches-e-prs)
7. [Pipeline de CI](#pipeline-de-ci)
8. [Commits](#commits)
9. [Definition of Done](#definition-of-done)
10. [Dependências](#dependências)
11. [Segurança](#segurança)
12. [Fronteiras de dependência](#fronteiras-de-dependência)
13. [API: pipeline de requisição](#api-pipeline-de-requisição)
14. [Web: shell, BFF e design system](#web-shell-bff-e-design-system)
15. [Testes](#testes)
16. [Geradores](#geradores)
17. [Decisões e ADRs](#decisões-e-adrs)

## Ambiente

| Ferramenta    | Versão                               | Como obter                                                                     |
| ------------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| Node.js       | 24.x LTS (`>=24.11.0 <25`, `.nvmrc`) | `fnm use` ou `nvm use` na raiz                                                 |
| pnpm          | o do campo `packageManager` (10.x)   | `corepack enable` (o Corepack baixa a versão fixada)                           |
| Docker Engine | com Docker Compose v2                | Linux nativo, macOS ou Windows com WSL 2; ≥ 6 GB de RAM livres para o ambiente |

- **Node fora da versão (FA-01):** com `engine-strict=true`, o `pnpm install` falha com
  `ERR_PNPM_UNSUPPORTED_ENGINE` — use o Node.js 24 LTS (veja `.nvmrc`).
- **Windows (FA-05):** o repositório funciona nativamente (fins de linha LF forçados pelo
  `.gitattributes`; scripts em TypeScript, nunca em bash). Para Docker, use o Docker Desktop com
  WSL 2 e, com bind mounts, prefira clonar dentro do WSL.
- **Telemetria:** desligue a do Turborepo e a do Next.js na sua estação, se preferir:
  `pnpm exec turbo telemetry disable` e `pnpm --filter @contrataflow/web exec next telemetry disable`.

## Primeiros passos

```bash
corepack enable
pnpm install --frozen-lockfile   # valida engines, instala pelo lockfile e instala os hooks
pnpm build                        # types → validation → editor/ui → apps (cache do Turborepo)
cp .env.example .env              # valores de desenvolvimento; funcionam sem edição
pnpm env:up && pnpm env:seed      # infraestrutura local + tenants "Prefeitura A" e "Prefeitura B"
pnpm dev                          # web :3000, api :4000 e worker
```

`pnpm install` só executa scripts de instalação dos pacotes em `onlyBuiltDependencies`
(`pnpm-workspace.yaml`). O aviso `ignored build scripts` indica um pacote novo com script:
adicione-o à lista **somente após revisão de segurança** (CODEOWNERS).

`pnpm dev` confere antes a infraestrutura local (`pnpm env:check`) e não sobe api/worker contra um
ambiente fora do ar (`ENV_NOT_READY`). Para trabalhar só na interface sem Docker, use
`pnpm --filter @contrataflow/web dev`.

## Ambiente local (Docker Compose)

Todas as dependências de infraestrutura sobem com um comando (US-078 · DEC-065). Os arquivos ficam
em `infra/` (`docker-compose.yml` + `compose/observability.yml` e `compose/full.yml`) e os scripts
em `tools/env/`. A primeira subida baixa as imagens e leva até ~10 min; depois, segundos.

```bash
cp .env.example .env     # uma vez; nada a editar (FA-03 abaixo se uma porta estiver ocupada)
pnpm env:up              # sobe e espera todos os serviços ficarem healthy
pnpm env:seed            # idempotente: tenants, unidades, 15 perfis, catálogos, workflows, usuários
pnpm dev                 # web/api/worker no host, com hot-reload, usando os serviços abaixo
docker compose stop      # fim do dia: para tudo e preserva os volumes
pnpm env:reset           # recomeça do zero: down -v + env:up + env:seed
```

| Comando                               | O que faz                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm env:up`                         | Valida o `.env`, checa portas, `docker compose up -d` e espera os healthchecks e blueprints                   |
| `pnpm env:up --profile observability` | Idem + Prometheus, Grafana, Loki, Tempo e coletor OTel (FA-02)                                                |
| `pnpm env:up:full`                    | Idem + api, web e worker em contêiner (perfil `full`, FA-01) — não rode junto com `pnpm dev`                  |
| `pnpm env:seed`                       | Povoa "Prefeitura A" e "Prefeitura B" (`ENV_NOT_READY` se o ambiente não estiver de pé)                       |
| `pnpm env:reset`                      | `down -v` (apaga bancos, buckets, IdP e base do ClamAV) + `env:up` + `env:seed`                               |
| `pnpm env:check`                      | Confere se a infraestrutura padrão está saudável (usado por `pnpm dev`)                                       |
| `pnpm env:smoke`                      | Smoke test do ambiente: bancos, Redis, buckets, login OIDC, e-mail, PDF, antivírus, isolamento e idempotência |
| `pnpm env:blueprint`                  | Regenera o blueprint de usuários do Authentik a partir do dataset do seed                                     |

Com o `.env` copiado, `docker compose ps|logs <serviço>|stop` funcionam direto na raiz
(`COMPOSE_FILE`). Perfis opcionais também podem ficar fixos em `COMPOSE_PROFILES` no `.env`.

### Serviços e portas

Todas as portas são publicadas só em `127.0.0.1`.

| Serviço                                 | Porta no host (variável)                                | Acesso / uso                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres` (PostgreSQL 17 + pgvector)   | 5432 (`POSTGRES_PORT`)                                  | bancos `contrataflow` (extensões `vector`, `pg_trgm`, `unaccent`, `citext`) e `authentik`; usuário `postgres`                          |
| `redis-session`                         | 6379 (`REDIS_SESSION_PORT`)                             | sessões do BFF (DEC-131)                                                                                                               |
| `redis-cache`                           | 6380 (`REDIS_CACHE_PORT`)                               | cache, idempotência, rate limit e filas (`noeviction`)                                                                                 |
| `minio` + `minio-bootstrap`             | 9000 · 9001 (`MINIO_PORT` · `MINIO_CONSOLE_PORT`)       | API S3 e console (`MINIO_ROOT_USER`); buckets `contrataflow-dev-{quarantine,documents,renditions}`; a aplicação usa `S3_ACCESS_KEY_ID` |
| `authentik-server` + `authentik-worker` | 9080 · 9443 (`AUTHENTIK_PORT` · `AUTHENTIK_HTTPS_PORT`) | IdP OIDC; admin `akadmin` / `AUTHENTIK_BOOTSTRAP_PASSWORD`; issuer `http://localhost:9080/application/o/contrataflow/`                 |
| `mailpit`                               | 1025 · 8025 (`MAILPIT_SMTP_PORT` · `MAILPIT_UI_PORT`)   | SMTP e caixa de e-mails em http://localhost:8025                                                                                       |
| `gotenberg`                             | 3030 (`GOTENBERG_PORT`)                                 | HTML → PDF                                                                                                                             |
| `clamav`                                | 3310 (`CLAMAV_PORT`)                                    | `clamd` (INSTREAM); 1º start baixa as assinaturas (1–3 min)                                                                            |
| perfil `observability`                  | 3001 · 9090 · 3100 · 3200 · 4317/4318                   | Grafana (sem login), Prometheus, Loki, Tempo, coletor OTel                                                                             |
| perfil `full`                           | 3000 · 4000 (`WEB_PORT` · `API_PORT`)                   | web e api em contêiner                                                                                                                 |

### Usuários semeados

O seed cria um usuário por persona de DEC-035 em cada tenant, todos com a senha
`CF_DEV_USER_PASSWORD` do `.env` (padrão `devpassword`). O login é `<perfil>.<a|b>`, com o perfil em
minúsculas e `-` no lugar de `_` — por exemplo `requisitante.a` (Ana Ribeiro, só na Prefeitura A),
`admin-orgao.b`, `autoridade-competente.a`. O e-mail é `<login>@prefeitura-<a|b>.test`. Os grupos
do Authentik são só informativos: perfis e vínculos por tenant ficam no banco (o Authentik
autentica, o ContrataFlow autoriza).

Até a US-081 criar o schema real, os dados do seed ficam no schema provisório `dev_seed` do banco
`contrataflow` (DEC-065), com RLS e o papel `dev_seed_reader` para testar isolamento:

```sql
BEGIN;
SET LOCAL ROLE dev_seed_reader;
SELECT set_config('app.tenant_id', (SELECT id::text FROM dev_seed.tenants WHERE slug = 'prefeitura-a'), true);
SELECT name FROM dev_seed.organizations;   -- só a Prefeitura A
ROLLBACK;
```

### Solução de problemas

- **`ENV_FILE_MISSING` / `ENV_VAR_MISSING` (V-01/V-02):** rode `cp .env.example .env` ou defina a
  variável indicada. A checagem acontece antes de qualquer chamada ao Docker.
- **Porta ocupada (FA-03 · `PORT_IN_USE`):** `pnpm env:up` diz qual variável ajustar
  (ex.: "Porta 5432 ocupada. Ajuste POSTGRES_PORT no .env."). Mude só a porta publicada no `.env` —
  a interna não muda — e a URL correspondente na seção "Aplicações" (ex.: `DATABASE_URL`).
- **`SERVICE_UNHEALTHY` (V-04):** o serviço não ficou saudável no tempo limite (padrão 600 s;
  `ENV_UP_TIMEOUT_SECONDS` no `.env` muda). Veja `docker compose logs <serviço>`; os serviços já
  saudáveis continuam no ar. Rode `pnpm env:up` de novo depois de corrigir.
- **`BOOTSTRAP_FAILED` (`env.bootstrap_failed`):** o `minio-bootstrap` terminou com erro ou um
  blueprint do Authentik ficou com status `error` (V-06) — `docker compose logs minio-bootstrap` ou
  `docker compose logs authentik-worker`. Blueprints alterados são reaplicados automaticamente no
  próximo start (FA-04); não é preciso recriar o volume.
- **`ENV_NOT_READY` (V-05):** `pnpm env:seed`/`pnpm dev` com o ambiente fora do ar — rode `pnpm env:up`.
- **Dois `pnpm env:up` ao mesmo tempo:** o segundo espera o primeiro terminar; o bootstrap do MinIO
  e os blueprints são idempotentes.
- **Sem internet:** com as imagens já no cache local do Docker, `pnpm env:up` funciona offline
  (FA-06); a atualização das assinaturas do ClamAV só acontece com rede.
- **Windows:** use o Docker Desktop com WSL 2. Os scripts são TypeScript e rodam no PowerShell ou
  no Git Bash.

## Estrutura do monorepo

```
apps/web        Next.js (App Router) — UI + BFF                      @contrataflow/web
apps/api        NestJS 11 — REST /api/v1, módulos de DEC-040          @contrataflow/api
apps/worker     NestJS standalone — filas, schedulers, relay          @contrataflow/worker
packages/types        constantes e tipos puros (permissões, eventos, erros, filas)
packages/validation   schemas Zod de contrato (DEC-054)
packages/editor       schema do editor rico (DEC-056)
packages/ui           design system (Tailwind CSS 4)
packages/eslint-config, packages/tsconfig   padrões compartilhados
tools/          scripts de engenharia, fixtures de regras e geradores  @contrataflow/tools
```

Pacotes internos se chamam `@contrataflow/<nome>`, são `"private": true` e nunca são publicados
(RN-FND-04). Na API e no worker, use os _subpath imports_ `#config/*`, `#shared/*` e
`#modules/*` (sempre com extensão `.js`); no web, o alias `@/*` aponta para `src/*`.

## Scripts

| Comando                   | O que faz                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm build`              | Build de todos os pacotes (Turborepo, cache local)                                        |
| `pnpm dev`                | Apps em modo de desenvolvimento (antes confere o ambiente: `env:check`)                   |
| `pnpm lint`               | Prettier + ESLint da raiz e ESLint de cada pacote                                         |
| `pnpm typecheck`          | `tsc --noEmit` em todos os pacotes                                                        |
| `pnpm test`               | Testes unitários (Vitest) — não exigem banco nem Docker                                   |
| `pnpm test:integration`   | Integração com Testcontainers (exige Docker — US-078/US-079)                              |
| `pnpm depcruise`          | Fronteiras de dependência (dependency-cruiser)                                            |
| `pnpm check:versions`     | Versões exatas pelo catálogo e majors duplicadas                                          |
| `pnpm format`             | Formata o repositório com Prettier                                                        |
| `pnpm smoke:hello`        | Sobe os apps já construídos e confere o estado _hello_                                    |
| `pnpm verify:fresh-clone` | Clone limpo em contêiner `node:24-bookworm-slim` (install → test, smoke)                  |
| `pnpm secrets:scan`       | Varredura de segredos com gitleaks (Docker); `-- --git <base>..HEAD` varre commits        |
| `pnpm ci:*`               | Gates do CI rodando localmente — veja [Pipeline de CI](#pipeline-de-ci)                   |
| `pnpm env:*`              | Ambiente local com Docker Compose — veja [Ambiente local](#ambiente-local-docker-compose) |

O CI (US-079) repete esses comandos e os demais gates — veja [Pipeline de CI](#pipeline-de-ci).
Os hooks locais (husky) são conveniência, não controle: `--no-verify` é permitido localmente, mas o
CI bloqueia o _merge_ (FA-04).

## Branches e PRs

- Modelo _trunk-based_ (RN-FND-08): branches curtas `feat|fix|refactor|test|docs|ci|chore/US-NNN-slug`
  a partir da `main`, sempre implantável.
- _Squash merge_: o **título do PR** vira a mensagem do commit e segue o padrão de commits.
- Use o modelo `.github/pull_request_template.md` (card, checklist de DoD, impacto em fontes
  canônicas, justificativa de dependência nova).
- O `.github/CODEOWNERS` pede os revisores obrigatórios. Áreas sensíveis — `apps/api/src/shared/`,
  módulos `access`, `identity`, `tenancy`, `audit` e `platform`, `apps/api/prisma/`,
  `apps/web/src/bff/`, `.github/`, `pnpm-workspace.yaml`, `.npmrc`, `renovate.json5`,
  `.dependency-cruiser.cjs` e `packages/eslint-config/` — exigem **Tech Lead + segurança/plataforma**;
  `packages/ui/` exige front-end + design; `docs/architecture/` e `docs/mvp-01/`, Tech Lead + PO.
- Hooks: `pre-commit` roda o lint-staged (ESLint `--fix` e Prettier nos arquivos _staged_);
  `commit-msg` roda o commitlint; `pre-push` roda o typecheck dos pacotes afetados desde
  `origin/main`.

## Pipeline de CI

GitHub Actions (DEC-061 · DEC-066). Todo PR contra a `main` roda `.github/workflows/ci.yml`; um
push novo no mesmo PR cancela a execução anterior. Os checks abaixo são os _required checks_ da
_ruleset_ da `main` — o merge (só _squash_) exige todos verdes, sem exceção para administradores.
Enquanto o projeto tiver um único mantenedor (DEC-067), a _ruleset_ não exige aprovação humana,
porque o GitHub não deixa ninguém aprovar o próprio PR. Quando entrar a segunda pessoa, religue a
aprovação dos donos de cada caminho no CODEOWNERS como manda a DEC-067.

| Check                  | O que roda                                                                                                                                          | Rodar localmente                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `1. Higiene`           | `pnpm install --frozen-lockfile`, título do PR (commitlint), gitleaks nos commits do PR, licenças de runtime, `check:versions`                      | `pnpm secrets:scan`, `pnpm ci:licenses`, `pnpm check:versions`                            |
| `2. Estático`          | `turbo run lint typecheck` (erros viram anotação no arquivo e na linha), `depcruise`, actionlint, Semgrep (`.semgrep/rules/`, com `semgrep --test`) | `pnpm turbo run lint typecheck`, `pnpm depcruise`                                         |
| `2. Estático (CodeQL)` | CodeQL `security-extended`; achado alto ou crítico bloqueia pela regra `code_scanning`                                                              | —                                                                                         |
| `3. Contrato`          | `turbo run openapi:generate` + diff com o `apps/api/openapi/api.v1.json` da base; incompatível na v1 → `OPENAPI_BREAKING_CHANGE`                    | `pnpm ci:contract --base origin/main`                                                     |
| `4. Testes`            | unitários (com cobertura) → cobertura do código novo → integração (Testcontainers) → `test:tenant-leak` → `test:authz`                              | `pnpm turbo run test`, `pnpm ci:coverage`, `pnpm turbo run test:tenant-leak`              |
| `5. Migrações`         | lint expand/contract, migração publicada imutável, aplicação do zero e sobre o _snapshot_ da última tag `v*`, checagens de RLS e FK composta        | `pnpm ci:migrations --base origin/main`                                                   |
| `6. Imagens`           | `infra/docker/prod.Dockerfile` por app, SBOM (Syft), Trivy + gate de CVE, assinatura cosign                                                         | `docker build -f infra/docker/prod.Dockerfile --build-arg APP=api --target runtime-api .` |
| `7. E2E`               | Compose da US-078 num projeto próprio, `env:seed`, Playwright + axe-core (`apps/web/test/e2e`)                                                      | `pnpm env:up && pnpm env:seed && pnpm turbo run test:e2e`                                 |

- **Só `docs/**`:** os estágios 4–7 são pulados (aparecem como _skipped_, que conta como aprovado).
- **Falhas:** o PR recebe um comentário com os estágios que falharam (PR do próprio repositório);
  cada job registra `ci.stage_completed` ou `ci.stage_failed` no log e no resumo.
- **Infraestrutura instável** (registry, base do Trivy, download do Chromium): retry com _backoff_
  (`tools/ci/retry.ts`) e tempo limite por tentativa e por job.
- **Pós-merge** (`deploy-staging.yml`, ligado pela variável `CF_STAGING_ENABLED=true`): imagens no
  ECR assinadas _keyless_, deploy em staging (assinatura verificada antes), estágio `8. Pós-deploy`
  (ZAP baseline, k6 _smoke_, traces). Falha alerta `#cf-ci` e bloqueia a promoção para produção,
  que exige aprovação do Tech Lead no ambiente `production`.

**Política (`.github/ci-policy.yml`, donos: Tech Lead + segurança):** `ci.coverageThreshold` (80) e
`ci.coverageGateEnabled` (desligar só com decisão registrada), licenças permitidas e exceções, e
exceções de CVE **sem** correção disponível, com prazo (`reviewBy`). CVE crítica ou alta com
correção sempre bloqueia — atualize o pacote ou a imagem base.

**Configuração do repositório** (por quem administra; repetir quando o arquivo mudar):
`GH_TOKEN=<token de admin> pnpm ci:github-settings --apply --repo <dono>/<repo>` aplica
`.github/repository-settings.json` (ruleset da `main`, merge só por _squash_, permissões do Actions,
ambientes `staging` e `production`). Sem `--apply`, mostra o que seria enviado. Com mantenedor
único (DEC-067), só o time `tech-lead` precisa existir: é ele que aprova o ambiente `production`.
Com o GitHub CLI logado como administrador, o token sai do próprio `gh`, sem copiá-lo. No
PowerShell: `$env:GH_TOKEN = gh auth token; pnpm ci:github-settings --apply --repo <dono>/<repo>`.

| Onde                               | Nome                                                                                  | Uso                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------- |
| Variável do repositório            | `CF_STAGING_ENABLED`                                                                  | `true` liga o pós-merge                       |
| Segredo do repositório (opcional)  | `SEMGREP_APP_TOKEN`                                                                   | regras gerenciadas do Semgrep além das locais |
| Ambientes `staging` e `production` | `AWS_OIDC_ROLE_ARN`, `AWS_REGION`, `ECR_REGISTRY`                                     | OIDC da AWS e registry (sem chave estática)   |
| Ambientes `staging` e `production` | `ECS_CLUSTER`, `ECS_SERVICE_PREFIX`, `ECS_MIGRATOR_FAMILY`, `ECS_MIGRATOR_NETWORK`    | deploy no ECS (`tools/ci/deploy-ecs.ts`)      |
| Ambiente `staging`                 | `STAGING_URL`, `STAGING_API_URL`, `TRACES_QUERY_URL` e o segredo `TRACES_QUERY_TOKEN` | ZAP, k6 e verificação de traces               |
| Ambiente `staging`                 | segredo `SLACK_CI_WEBHOOK_URL`                                                        | alerta do pós-deploy em `#cf-ci`              |

## Commits

[Conventional Commits 1.0](https://www.conventionalcommits.org/pt-br/v1.0.0/) (RN-FND-07),
validado pelo commitlint (`commitlint.config.mjs`):

```
tipo(escopo): assunto no imperativo, em minúsculas, até 100 caracteres

Corpo opcional explicando o porquê.

Refs: US-080
```

- **Tipos:** `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`, `revert`.
- **Escopo obrigatório**, da lista fechada: apps (`web`, `api`, `worker`), pacotes (`ui`, `types`,
  `validation`, `editor`, `eslint-config`, `tsconfig`, `tools`), módulos de DEC-040 (gerados de
  `tools/module-levels.json`, ex.: `process`, `price-research`), `infra`, `deps`, `docs` e `repo`
  (configuração da raiz).
- **Rodapé `Refs: US-NNN`** obrigatório (exceto `chore(deps)` do Renovate e `revert`).
- **`BREAKING CHANGE:`** precisa citar a decisão que o autoriza (`DEC-NNN` ou `ADR-NNN`).
- Exemplo válido: `feat(api): adiciona filtro RFC 9457` com `Refs: US-080`. Inválido:
  `ajustes diversos` (`type-empty`, `scope-empty`).

## Definition of Done

Toda story só fecha com:

- cenários Gherkin da story (8 categorias) automatizados e verdes;
- DoD da story cumprida;
- isolamento por tenant e autorização em toda rota (suíte _tenant leak_ e matriz de autorização);
- cobertura ≥ 80% do código novo em `domain`/`application` e 100% em cálculo e políticas;
- `pnpm turbo run lint typecheck test` verde, sem violações em `pnpm depcruise` e
  `pnpm check:versions`.

## Dependências

- **Versões exatas pelo catálogo (RN-FND-01).** Toda versão externa fica no catálogo de
  `pnpm-workspace.yaml` (`catalog:` ou `catalogs.react`) com versão exata; o `package.json` do
  pacote referencia `"catalog:"` (ou `"catalog:react"`). Pacotes internos usam `"workspace:*"`.
  Faixas `^`, `~`, `*` e `latest` são proibidas — `pnpm check:versions` falha com
  `VERSION_NOT_PINNED`. Duas majors de `react`, `zod`, `@prisma/client`, `@nestjs/core` ou
  `bullmq` no lockfile falham com `DUPLICATE_MAJOR`.
- **Lockfile:** `pnpm-lock.yaml` é versionado; o CI instala só com `--frozen-lockfile`. Conflito
  de lockfile entre PRs (`ERR_PNPM_OUTDATED_LOCKFILE`): faça rebase na `main`, rode `pnpm install`
  e versione o lockfile regenerado (a geração é determinística).
- **Dependência nova (FA-02 · RN-FND-11):** adicione a versão exata ao catálogo, referencie com
  `catalog:` e preencha no PR: finalidade, alternativas avaliadas (inclusive "não adicionar"),
  última versão publicada há menos de 12 meses, licença, tamanho/impacto no bundle (web) e scripts
  de instalação. Aprovação dos donos de `pnpm-workspace.yaml` (Tech Lead + segurança).
- **Licenças (RN-FND-10):** em runtime só MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD,
  BlueOak-1.0.0 e MPL-2.0 (nível de arquivo). GPL, AGPL, SSPL, BUSL e desconhecidas são proibidas
  (verificado no CI — US-079).
- **Maturidade:** o pnpm recusa versões publicadas há menos de 3 dias (`minimumReleaseAge`).
- **Atualizações (RN-FND-09):** o Renovate abre PRs agrupados às segundas antes das 06:00;
  _majors_ só após aprovação no _Dependency Dashboard_. Mudança de _major_ de Node.js ou
  TypeScript exige atualizar DEC-050 (FA-06). Versões e motivos:
  [`docs/engineering/versions.md`](docs/engineering/versions.md).

## Segurança

Proibições verificadas pelo ESLint como **erro** (RN-FND-06), com _fixtures_ de violação em
`tools/fixtures/lint/**`:

| Proibido                                                            | Use em vez disso                                                         | Regra                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------- |
| `$queryRawUnsafe` / `$executeRawUnsafe`                             | `$queryRaw`/`$executeRaw` parametrizado (tagged template) no repositório | `contrataflow/no-unsafe-raw-query`              |
| `dangerouslySetInnerHTML`                                           | o componente `sanitized-html-preview.tsx`                                | `contrataflow/no-dangerous-html`                |
| `console.*`                                                         | o logger (Logger do NestJS / pino, com redação — DEC-138)                | `contrataflow/no-console`                       |
| `process.env` fora de `src/config/**`                               | a configuração validada e injetada (US-080)                              | `contrataflow/no-process-env`                   |
| `eval`, `new Function`, timers com string                           | código estático                                                          | `contrataflow/no-dynamic-code`                  |
| `ioredis`/`redis` fora de `shared/cache/**` e `modules/platform/**` | o `TenantCache`, que isola as chaves por tenant (RM-03)                  | `contrataflow/no-direct-redis`                  |
| `@prisma/client` fora de `infrastructure/**` e `shared/database/**` | o repositório do módulo                                                  | `contrataflow/no-prisma-outside-infrastructure` |
| arquivo de `apps/web/src/bff/**` sem `import 'server-only'`         | `import 'server-only';` na primeira linha                                | `contrataflow/require-server-only`              |
| `any` explícito, `@ts-ignore`, `@ts-nocheck`                        | tipos corretos; `@ts-expect-error` com descrição de 10+ caracteres       | `@typescript-eslint/*`                          |

- **Segredos (DEC-137):** nunca no repositório. `.env` só local (ignorado pelo Git); use
  `pnpm secrets:scan` antes de abrir o PR. Logs nunca contêm tokens, cookies, senhas, CPF,
  conteúdo de documentos nem variáveis de ambiente completas.
- Alterar uma regra de segurança ou suas liberações exige revisão do Tech Lead + segurança.

## Fronteiras de dependência

`pnpm depcruise` aplica `.dependency-cruiser.cjs` (RN-FND-05 · DEC-041 · architecture.md §4.3),
com uma _fixture_ de violação por regra em `tools/fixtures/depcruise/**`:

- `packages/types` não importa nada interno; `validation` só importa `types`; `editor`, `types` e
  `validation`; `ui`, só `types`.
- `apps/web` nunca importa `apps/api`/`apps/worker` (só HTTP, via BFF); a API não importa `ui`,
  `web` nem `worker`.
- O worker só importa `domain`, `application`, `infrastructure`, `*.module.ts` e `src/shared` da
  API — nunca `presentation`.
- `modules/<m>/domain/**` é puro: sem NestJS, Prisma, Redis, BullMQ, SDKs de nuvem nem outras
  camadas.
- Outro módulo só é acessado por `application/<m>.facade.ts`, `application/dto/**` ou
  `<m>.module.ts`, e só de **nível inferior** (`tools/module-levels.json`; no sentido contrário,
  eventos ou portas).
- O shared kernel não importa módulos; o cliente de plataforma (`system-prisma.service.ts`) só é
  usado no provisionamento de tenants, no relay do outbox e nos schedulers; sem ciclos.

## API: pipeline de requisição

Toda rota da API herda o pipeline da US-080 (`apps/api/src/app.module.ts`): contexto (`X-Correlation-Id`
e `AsyncLocalStorage`) → corpo JSON → autenticação → tenant → vínculo → MFA → rate limit → `If-Match`
→ idempotência → `ZodValidationPipe` → handler → envelope `{ data }`/`{ data, meta }`; qualquer
exceção vira `application/problem+json` (api.md §2). Numa rota nova:

- valide entrada só com `@ZodBody`/`@ZodQuery`/`@ZodParams(schema de packages/validation)` e
  documente com `@ApiOperation({ operationId, summary, responses })`; depois rode
  `pnpm turbo run openapi:generate` e versione `apps/api/openapi/api.v1.json`;
- devolva o recurso, um `PageResult`/`CursorResult` (helpers de `#shared/http/pagination.js`) ou nada
  (204) — nunca monte o envelope à mão; erros são `ApiError` com o código de api.md;
- marque `@Idempotent()` nas rotas "Idem." do catálogo, `@RequireIfMatch()` nas mutações de recurso
  versionado e `@RateLimit('autosave' | 'export' | 'upload')` quando a classe não for leitura/escrita;
- `@WithoutTenant()` só nas rotas que o catálogo define sem tenant; rotas públicas ficam na
  _allowlist_ `PUBLIC_ROUTE_PREFIXES` (`/health/*`, `/metrics`).

**`AsyncLocalStorage`:** o `RequestContext` (`requireRequestContext()`) acompanha a cadeia
assíncrona da requisição (inclusive `await` e timers criados dentro dela). Callbacks registrados
fora dela — _listeners_ de _event emitters_ criados no bootstrap, clientes/pools com callbacks
próprios, filas consumidas depois — rodam sem contexto ou com o de quem os registrou, e trabalho
_fire-and-forget_ que sobrevive à resposta carrega o contexto de uma requisição encerrada: capture
os valores antes (`const { tenantId } = requireRequestContext()`) e passe-os explicitamente, ou abra
um contexto próprio com `runWithRequestContext`. Jobs do worker abrem o contexto a partir do
envelope (DEC-164).

**Ambiente:** `pnpm dev` carrega o `.env` da raiz (`--env-file-if-exists`). Até a US-087 os tokens
são verificados pelo `FakeJwksProvider` (HS256 com `OIDC_FAKE_SIGNING_KEY`; sem a chave, nenhum
token é aceito) e usuários/vínculos/tenants vêm de adaptadores em memória até a US-081.

## Web: shell, BFF e design system

O `apps/web` (US-086) já entrega a casca de toda tela: route groups `(auth)` (sem shell),
`(app)` (shell autenticado — o `layout.tsx` resolve sessão e instituição no servidor) e
`(app)/admin`; BFF em `src/bff/**` (`server-only`): `/api/auth/*`, proxy `/api/v1/[...path]` e
cabeçalhos de segurança/CSP com nonce aplicados no `src/proxy.ts`. Numa tela nova:

- crie a feature em `src/features/<nome>/` (componentes de domínio ficam aqui, nunca em
  `packages/ui`); o Server Component faz o _prefetch_ com `apiServerClient.get` e entrega
  `HydrationBoundary`; `'use client'` só nas folhas interativas;
- toda _query key_ nasce de `tenantKey(tenantId, …)` (`['t', tenantId, …]`); só `['me']` e
  `['me', 'memberships']` ficam fora do tenant;
- leituras e mutações do cliente usam `apiRequest` (`/api/v1/*` via proxy — nunca _Server
  Actions_); mutação com `useIdempotentMutation` (uma `Idempotency-Key` por intenção) e `If-Match`
  com o `meta.etag` da leitura; erros seguem a política única de `src/lib/api/error-policy.ts`;
- formulários: React Hook Form + `zodResolver` com o schema de `packages/validation`; mensagens
  pt-BR (`messages/pt-BR/<namespace>.json`, next-intl) e Zod em `pt-BR`;
- ações por permissão com `<Can permission="…">` (oculta sem permissão; desabilita com motivo
  quando `allowedActions` não traz a ação).

**Ambiente:** `pnpm dev` carrega o `.env` da raiz. Com `OIDC_FAKE_SIGNING_KEY`, o BFF usa o
provedor de identidade fake (FA-06) até o OIDC da US-087: entre por
`http://localhost:3000/api/auth/login?as=ana` (pessoas `ana`, `bruno`, `davi`, `gil`, espelhando o
diretório em memória da API). A página `/exemplo` exercita sessão, cache, permissões e erros.

**Design system:** componente novo em `packages/ui/src/components/` exige `<nome>.stories.tsx`;
`src/stories.a11y.test.tsx` audita toda história com axe (V-05). `pnpm --filter @contrataflow/ui
storybook` abre o Storybook com o painel de acessibilidade.

## Testes

- **Unitários:** Vitest, ao lado do código (`*.test.ts` nos pacotes; `*.spec.ts` na API e no
  worker, com SWC para os metadados de decorators). Não dependem de banco.
- **Integração:** `apps/api/test/**` com Testcontainers — `pnpm test:integration` (Docker). Na API,
  `pnpm test` gera `coverage/lcov.info`, que alimenta o gate de cobertura do CI.
- **Tenant leak e autorização:** tarefas `test:tenant-leak` e `test:authz` do Turborepo (estágio
  Testes do CI); a suíte de banco fica em `tools/ci/tenant-leak.ts` (Docker).
- **Web:** Vitest com jsdom e Testing Library (`// @vitest-environment jsdom` no arquivo) e axe
  nos testes de componente; BFF testado em `apps/web/test/bff/**` com a API simulada.
- **E2E:** Playwright + axe-core em `apps/web/test/e2e` (`pnpm turbo run test:e2e`, com o Compose de
  pé); toda página nova chama `expectNoSeriousA11yViolations`. O shell (`shell.spec.ts`) roda contra
  a API simulada `test/e2e/support/mock-api.mjs` e o provedor fake, sem Authentik.
- **Regras de engenharia:** `tools/test/**` cobre o `check:versions`, o commitlint, as _fixtures_
  de lint e de fronteiras, o CODEOWNERS, o grafo do Turborepo, o lockfile e o pipeline de CI
  (cenários da US-079 em `ci-pipeline.test.ts`); `tools/test/integration/**` exige Docker
  (`pnpm --filter @contrataflow/tools test:integration`).

## Geradores

```bash
pnpm turbo gen package      # packages/<nome> com tsconfig, ESLint, Vitest e package.json padrão
pnpm turbo gen api-module   # apps/api/src/modules/<módulo> com as camadas de DEC-041
```

Os geradores ficam em `tools/turbo/generators/`. O `api-module` só aceita módulos declarados em
`tools/module-levels.json` (lista de DEC-040).

## Decisões e ADRs

- Decisão nova ou mudança de decisão: nova entrada em `docs/architecture/decisions.md`
  (`Substitui: DEC-NNN`), atualização dos documentos afetados e, se estrutural, ADR em `docs/adr/`.
- Mudança de stack (ex.: TypeScript 6/7, Node.js 26, NestJS 12) exige nova entrada em
  `decisions.md` antes do PR de atualização.
