# Versões fixadas e política de atualização

> **Origem:** [US-077](../backlog/story-077-monorepo-setup.md) (RN-FND-01, RN-FND-02, RN-FND-09) — fixação exigida por [DEC-050](../architecture/decisions.md#dec-050--stack--aceita).
> **Fonte executável:** o catálogo de [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml). Este documento registra as linhas, os motivos e as medições; em caso de divergência de patch, vale o catálogo.
> **Fixado em:** 2026-10-07 (1º dia da Sprint 1). Versões escolhidas: o patch mais recente da linha-alvo publicado há pelo menos 3 dias.

## 1. Runtime e gerenciador de pacotes

| Componente | Versão | Onde está fixado | Observação |
|---|---|---|---|
| Node.js | 24.x LTS (`>=24.11.0 <25`) | `.nvmrc` (`24`), `engines.node`, `engine-strict=true` | Imagens `node:24-bookworm-slim` (US-079) |
| pnpm | 10.34.6 | `packageManager` (com hash SHA-512, via Corepack) | `engines.pnpm` `>=10.34.6 <11` |
| TypeScript | 5.9.3 | catálogo | Última da linha 5.x (DEC-050). TS 6/7 exigem nova decisão |
| Turborepo · `@turbo/gen` | 2.11.7 · 2.11.7 | catálogo | Cache local; sem cache remoto de terceiros no MVP 1 |

## 2. Catálogo (`catalog:`)

| Área | Pacote | Versão | Uso atual |
|---|---|---|---|
| Build | `@swc/core` · `@swc/cli` | 1.16.13 · 0.8.1 | build/dev de api e worker (`decoratorMetadata`) |
| Build | `tsx` · `concurrently` · `chokidar` | 4.23.15 · 10.0.5 · 5.0.0 | scripts de `tools/`; `dev` de api/worker |
| Build | `yaml` · `@types/node` | 2.9.1 · 24.19.1 | `tools/`; tipos do Node 24 |
| Qualidade | `eslint` · `@eslint/js` | 9.39.5 · 9.39.5 | _flat config_ |
| Qualidade | `typescript-eslint` | 8.71.0 | regras _type-checked_ |
| Qualidade | `eslint-plugin-import-x` · `eslint-import-resolver-typescript` | 4.17.1 · 4.4.5 | ordem e resolução de imports |
| Qualidade | `eslint-plugin-jsx-a11y` · `eslint-plugin-react-hooks` | 6.10.2 · 7.1.1 | web e ui |
| Qualidade | `@next/eslint-plugin-next` · `globals` | 16.3.8 · 17.13.0 | web |
| Qualidade | `prettier` · `prettier-plugin-tailwindcss` | 3.9.9 · 0.8.1 | formatação |
| Qualidade | `@commitlint/cli` · `config-conventional` · `lint` · `load` | 21.2.3 | RN-FND-07 |
| Qualidade | `husky` · `lint-staged` | 9.1.7 · 16.4.0 | hooks locais |
| Qualidade | `dependency-cruiser` | 17.4.3 | fronteiras (RN-FND-05) |
| Back-end | `@nestjs/common` · `core` · `platform-express` · `testing` | 11.2.7 | api e worker (Express 5) |
| Back-end | `reflect-metadata` · `rxjs` | 0.2.2 · 7.8.2 | peers do NestJS |
| Back-end | `prisma` · `@prisma/client` · `@prisma/adapter-pg` · `pg` | 7.10.0 · 7.10.0 · 7.10.0 · 8.23.1 | api — persistência e `TenantTransaction` (US-081, DEC-064); gerador `prisma-client` em ESM; `pg` e `@types/pg` 8.23.1 só nos testes de integração |
| Back-end | `decimal.js` | 10.6.0 | api — cálculos e mapeamento de colunas `Decimal` (DEC-003, US-081) |
| Back-end | `bullmq` · `ioredis` | 5.81.5 · 5.11.1 | `ioredis`: cache/idempotência/rate limit da api (US-080) e Redis de sessões do BFF (US-087); `bullmq` reservado — filas (DEC-163) |
| Back-end | `nodemailer` | 10.1.0 | worker — `MailProvider` SMTP do `EmailSender` (US-112 · DEC-050): Mailpit em dev e a interface SMTP do Amazon SES em produção; pool, STARTTLS/TLS, `Message-ID` e cabeçalhos próprios. Sem dependências, MIT-0, tipos embutidos; escolhido em vez de um cliente SMTP próprio sobre `node:net` |
| Back-end | `@aws-sdk/client-s3` · `@aws-sdk/s3-request-presigner` | 3.1150.0 · 3.1150.0 | api — adaptador S3/MinIO do `StorageService` (US-068 · storage.md §2.1, que já nomeia o SDK v3): URLs pré-assinadas (PUT da quarentena, GET de download), `HEAD`, leitura em stream, `CopyObject` com SHA-256 e `DeleteObject`. Apache-2.0, mantido pela AWS; escolhido em vez de assinar SigV4 à mão. Checksum automático desligado (`WHEN_REQUIRED`) porque o PUT é feito pelo navegador |
| Back-end | `json-logic-js` · `@types/json-logic-js` | 2.0.5 · 2.0.8 | api — avaliador das regras `CONDITION` do motor de workflow (US-041 · DEC-016 · ADR-008, que já nomeia a biblioteca). Sem dependências, MIT; a whitelist de operações (`inspectJsonLogic`) é conferida antes de toda avaliação, então `method`/`log` nunca executam. Escolhido em vez de um interpretador próprio para manter a semântica de JSON Logic idêntica à do editor (US-044) |
| Segurança | `jose` | 6.2.12 | api e web — verificação de JWT (RS256/ES256) com JWKS em cache próprio: access token na API e `id_token` no BFF (US-087, RN-IAM-04/05). Sem dependências, MIT; escolhido em vez de verificar assinatura à mão com `node:crypto` |
| Observabilidade | `@opentelemetry/api` · `sdk-node` · `sdk-trace` · `core` · `context-async-hooks` | 1.9.1 · 0.222.0 · 2.11.0 · 2.11.0 · 2.11.0 | `packages/observability` — SDK 2.x, sampler, propagador W3C e testes em memória (US-084) |
| Observabilidade | `@opentelemetry/exporter-trace-otlp-http` · `instrumentation` | 0.222.0 | exportador OTLP/HTTP e *hook* ESM (`hook.mjs`) da api e do worker (US-084) |
| Observabilidade | `@opentelemetry/instrumentation-http` · `-undici` · `-nestjs-core` · `-pg` · `-ioredis` · `@prisma/instrumentation` | 0.222.0 · 0.32.0 · 0.68.0 · 0.74.0 · 0.70.0 · 7.10.0 | instrumentações de observability.md §4.1, alinhadas ao `@opentelemetry/instrumentation` 0.222 (US-084) |
| Observabilidade | `@opentelemetry/sdk-metrics` · `exporter-prometheus` | 2.11.0 · 0.222.0 | `MeterProvider` e leitor *pull* de `/metrics` (HLT-03) em porta interna; já vinham no lockfile como dependências do `sdk-node` — nenhuma versão nova baixada (US-085) |
| Back-end | `pino` · `nestjs-pino` · `pino-http` | 10.4.0 · 4.6.1 · 11.0.0 | logs JSON de web, api e worker (US-084) |
| Contratos | `zod` · `@asteasolutions/zod-to-openapi` | 4.6.5 · 8.5.0 | `packages/validation`; OpenAPI 3.1 (DEC-063) |
| Front-end | `next` | 16.3.8 | web (App Router, Turbopack) |
| Front-end | `tailwindcss` · `@tailwindcss/postcss` | 4.3.3 | ui e web |
| Front-end | `@tanstack/react-query` · `@tanstack/react-table` | 5.104.1 · 8.21.3 | web — cache por tenant (US-086); Table reservado |
| Front-end | `react-hook-form` · `@hookform/resolvers` · `next-intl` | 7.89.0 · 5.9.1 · 4.14.9 | web — formulários com `zodResolver` e i18n pt-BR (US-086) |
| Front-end | `radix-ui` | 1.7.0 | ui — primitives acessíveis do shadcn/ui (pacote unificado; US-086) |
| Front-end | `server-only` | 0.0.1 | web — `src/bff/**` nunca vai ao bundle do cliente (RN-FND-88) |
| Front-end | `storybook` · `@storybook/react-vite` · `@storybook/addon-a11y` | 10.6.1 | ui — histórias por componente com axe (RN-FND-91) |
| Front-end | `@tiptap/core` · `@tiptap/pm` · `@tiptap/starter-kit` | 3.31.4 | reservado — editor rico (DEC-056) |
| Testes | `vitest` · `@vitest/coverage-v8` · `vite` | 4.1.11 · 4.1.11 · 7.3.6 | todos os pacotes (`vite` é _peer_ obrigatório) |
| Testes | `unplugin-swc` | 2.0.0 | Vitest na api e no worker |
| Testes | `@playwright/test` · `axe-core` | 1.63.0 · 4.13.0 | E2E (US-079); axe também nos testes de componente (US-086) |
| Testes | `jsdom` · `@testing-library/react` · `dom` · `user-event` | 29.1.1 · 16.3.3 · 10.4.2 · 14.6.7 | testes de componente de web e ui (US-086). `jsdom` 30 exige Node ≥ 24.15 — fica na 29 enquanto `engines` aceitar 24.11 |
| Testes | `testcontainers` · `supertest` · `@types/supertest` | 11.14.0 · 7.3.1 · 7.2.1 | reservado — integração (US-078/US-079) |
| Testes | `fast-check` | 3.23.2 | api — testes _property-based_ do validador de grafo de workflow (US-040). Mesma versão que já chega transitivamente (`effect` ← `prisma`/`@hookform/resolvers`): nenhum pacote novo no lockfile |

**Catálogo nomeado `react`** (uma única versão no lockfile): `react` 19.2.8 · `react-dom` 19.2.8 · `@types/react` 19.2.18 · `@types/react-dom` 19.2.7.

Entradas "reservado" já fixam a linha-alvo da US-077 para as stories seguintes; quem as usar pela primeira vez valida compatibilidade e _peers_ (com `strict-peer-dependencies=true`, um _peer_ ausente falha a instalação).

## 3. Opções do pnpm e cadeia de suprimentos

| Opção | Valor | Motivo |
|---|---|---|
| `engine-strict` · `save-exact` | `true` · `true` | RN-FND-01/02 |
| `auto-install-peers` · `strict-peer-dependencies` | `false` · `true` | _peers_ declarados explicitamente |
| `resolution-mode` | `highest` | resolução previsível |
| `minimumReleaseAge` | 4320 min (3 dias) | não instala versões recém-publicadas (RS-11) |
| `catalogMode` | `strict` | `pnpm add` só aceita versões do catálogo |
| `onlyBuiltDependencies` | `@swc/core`, `esbuild` | binários nativos verificados no `postinstall` |
| `ignoredBuiltDependencies` | `unrs-resolver`, `@parcel/watcher` (next-intl), `cpu-features`, `protobufjs`, `ssh2` | revisado: o binário chega por `optionalDependencies`; o script é dispensável |

## 4. Exceções de TypeScript

- `skipLibCheck: false` em todos os `packages/*` (RN-FND-03).
- `skipLibCheck: true` em `apps/web` (tipos do Next.js 16.3 referenciam `URLPatternInput`, ausente na lib DOM do TypeScript 5.9), `apps/api` e `apps/worker` (tipos do `unplugin`, usados pelo `vitest.config.ts`, importam bundlers não instalados) e `tools/`.
- Pacotes compartilhados compilam com `types: ["node"]`: as declarações do Zod 4 usam o global `URL`.

## 5. Medições

Estação de desenvolvimento (Windows 11, AMD Ryzen 7 7435HS — 8 núcleos/16 threads, 16 GB, SSD), 2026-10-07:

| Etapa | Tempo |
|---|---|
| `pnpm install` com store vazio | ~60 s |
| `pnpm build` frio (`--force`, sem cache) | 16 s |
| `pnpm build` quente (cache do Turborepo, `FULL TURBO`) | 1 s |
| `lint` + `typecheck` + `test` sem cache | 33 s |
| **Clone limpo (install → build → lint → typecheck → test)** | **~2 min** (limite: 10 min) |

`pnpm verify:fresh-clone` repete a medição em contêiner `node:24-bookworm-slim` (fixado por _digest_) e falha se o clone limpo passar de 10 min ou o build quente de 2 min, se o build quente não vier do cache, se um rebuild sem cache gerar saídas diferentes ou se a instalação offline não se comportar como esperado. Execução de 2026-10-07 (Docker Desktop/WSL 2 na mesma estação, Node.js 24.21.0 da imagem):

| Etapa (contêiner Linux) | Tempo | Resultado |
|---|---|---|
| `pnpm install --frozen-lockfile` (store vazio) | 46 s | ok |
| `pnpm build` frio · quente | 16 s · 1 s | quente com `FULL TURBO` |
| `pnpm lint` · `typecheck` · `test` | 30 s · 9 s · 7 s | ok |
| **Clone limpo (install → test)** | **108 s** | limite 600 s |
| `pnpm smoke:hello` | 2 s | web 200 com `<title>ContrataFlow</title>` e `lang="pt-BR"`; api e worker saem com código 0 em SIGTERM |
| Rebuild sem cache (`--force`) | 14 s | saídas de `packages/*/dist`, `apps/api/dist` e `apps/worker/dist` idênticas (SHA-256) |
| `install --offline` com store aquecido · com store vazio | 6 s · 2 s | ok · falha com `ERR_PNPM_NO_OFFLINE_TARBALL`, sem instalar nada |

## 6. Linhas atrás da última _major_ (decisão consciente)

As linhas-alvo da US-077 foram mantidas; as _majors_ abaixo já existem e só entram por PR do Renovate aprovado no _Dependency Dashboard_ (FA-06) e, quando mudam a stack, com nova entrada em `decisions.md`:

| Pacote | Fixado | _Major_ disponível | Observação |
|---|---|---|---|
| ESLint | 9.39.5 | 10.x | **A linha 9 está marcada como _deprecated_ no npm.** `eslint-plugin-jsx-a11y` 6.10.2 ainda não declara suporte ao ESLint 10 (_peer_ `^9`). Reavaliar na primeira janela do Renovate. |
| NestJS | 11.2.7 | 12.x | DEC-050 / US-077 fixam NestJS 11 |
| TypeScript | 5.9.3 | 7.x | DEC-050 (5.x) |
| Vitest | 4.1.11 | 5.x | — |
| BullMQ · ioredis | 5.81.5 · 5.11.1 | 6.x · 6.x | DEC-163 cita BullMQ 5 |
| dependency-cruiser · lint-staged | 17.4.3 · 16.4.0 | 18.x · 17.x | — |
| Testcontainers | 11.14.0 | 12.x | — |
| TanStack Table · zod-to-openapi · nestjs-pino | 8.21.3 · 8.5.0 · 4.6.1 | 9.x · 9.x · 5.x | — |

## 7. Política de atualização (RN-FND-09)

Configurada em [`renovate.json5`](../../renovate.json5): janela semanal (segunda-feira antes das 06:00, `America/Sao_Paulo`); maturidade mínima de 3 dias (patch/minor) e 14 dias (major); grupos por ecossistema; _automerge_ só de patch/minor de ferramentas de desenvolvimento e de _digests_ de Actions com CI verde; _majors_ só com aprovação no _Dependency Dashboard_; alertas de segurança fora da janela; Node.js restrito a 24.x, TypeScript a 5.x e pnpm a 10.x; imagens Docker e Actions fixadas por _digest_; `lockFileMaintenance` mensal.

## 8. Imagens de contêiner do ambiente local (US-078 · DEC-065)

Fixadas por _tag_ exata **e** _digest_ em [`infra/docker-compose.yml`](../../infra/docker-compose.yml) e [`infra/compose/`](../../infra/compose/) (o Renovate atualiza os dois com `docker:pinDigests`). Versão escolhida: a mais recente da linha-alvo publicada há pelo menos 3 dias em 2026-10-07.

| Serviço | Imagem | Tag | Observação |
|---|---|---|---|
| `postgres` | `pgvector/pgvector` | `0.8.7-pg17-bookworm` | PostgreSQL 17 + pgvector 0.8.7 (DEC-050); `pg_trgm`, `unaccent` e `citext` vêm do contrib |
| `redis-session` · `redis-cache` | `redis` | `7.4.11-alpine` | dois serviços (DEC-131 · RN-FND-15); cache com `noeviction` (BullMQ) |
| `minio` · `minio-bootstrap` | `pgsty/minio` · `pgsty/mc` | `RELEASE.2026-08-04T00-00-00Z` · `RELEASE.2026-09-16T00-00-00Z` | _build_ comunitário: a imagem oficial `minio/minio` deixou de ser distribuída (DEC-065) |
| `authentik-server` · `authentik-worker` | `ghcr.io/goauthentik/server` | `2026.8.3` | mesma imagem e _tag_ (comandos `server`/`worker`); desde 2025.10 o Authentik não usa Redis |
| `mailpit` | `axllent/mailpit` | `v1.31.4` | |
| `gotenberg` | `gotenberg/gotenberg` | `8.37.0` | DEC-060 |
| `clamav` | `clamav/clamav` | `1.5.4` | 1º start baixa a base de assinaturas (volume `clamav-db`) |
| `prometheus` _(perfil observability)_ | `prom/prometheus` | `v3.15.0` | |
| `grafana` _(observability)_ | `grafana/grafana` | `12.4.12` | |
| `loki` _(observability)_ | `grafana/loki` | `3.7.8` | |
| `tempo` _(observability)_ | `grafana/tempo` | `2.10.8` | |
| `otel-collector` _(observability)_ | `otel/opentelemetry-collector-contrib` | `0.162.0` | |
| `api` · `web` · `worker` _(perfil full)_ | `node` (base de `infra/docker/app.Dockerfile`) | `24-bookworm-slim` | mesmo _digest_ do `verify:fresh-clone` |

Medições na estação da §5 (imagens já baixadas): primeira subida com volumes vazios **~3 min 45 s** (dominada pelas migrações do Authentik no 1º start); `pnpm env:up` com o ambiente de pé **~6 s**; `pnpm env:seed` **~4 s**; `pnpm env:smoke` completo **~35 s**.

## 9. Pipeline de CI (US-079 · DEC-066)

Fixados em 2026-10-14 pela mesma regra (versão mais recente publicada há pelo menos 3 dias). Actions **por SHA do commit** (comentário com a tag ao lado — Renovate `helpers:pinGitHubActionDigests`); imagens de ferramentas **por tag + digest** nas variáveis `*_IMAGE` dos workflows (Renovate, gerenciador `regex`). O `cosign` é a versão padrão do `sigstore/cosign-installer` (verificada pelo próprio instalador).

| Action | Tag | Uso |
|---|---|---|
| `actions/checkout` | `v7.0.1` | todos os jobs (`persist-credentials: false`) |
| `actions/setup-node` | `v7.1.0` | Node.js do `.nvmrc` (`.github/actions/setup`) |
| `actions/cache` | `v6.1.0` | store do pnpm, cache do Turborepo e base do Trivy |
| `actions/upload-artifact` · `download-artifact` | `v7.0.2` · `v8.0.2` | SBOM, relatório do Trivy, digests, relatórios do Playwright/ZAP |
| `github/codeql-action` (`init`/`analyze`) | `v4.38.3` | SAST (estágio 2) |
| `docker/setup-buildx-action` · `build-push-action` | `v4.4.1` · `v7.4.0` | build multi-stage com cache `type=gha` |
| `sigstore/cosign-installer` | `v4.1.2` (cosign `v3.0.6`) | assinatura e verificação das imagens |
| `aws-actions/configure-aws-credentials` · `amazon-ecr-login` | `v6.3.0` · `v2.1.7` | OIDC da AWS e ECR (pós-merge) |

| Ferramenta (imagem) | Tag | Estágio |
|---|---|---|
| `zricethezav/gitleaks` | `v8.30.0` | 1 — mesma imagem de `pnpm secrets:scan` |
| `rhysd/actionlint` | `1.7.12` | 2 |
| `semgrep/semgrep` | `1.180.0` | 2 |
| `anchore/syft` | `v1.54.1` | 6 — SBOM CycloneDX |
| `aquasec/trivy` | `0.75.0` | 6 — o `0.76.0` saiu no dia da fixação |
| `registry` | `3.1.2` | 6 — registry local efêmero do PR |
| `zaproxy/zap-stable` | `2.17.0` | 8 |
| `grafana/k6` | `2.3.0` | 8 |
| `@playwright/test` · `axe-core` · `@vitest/coverage-v8` | catálogo (`1.63.0` · `4.13.0` · `4.1.11`) | 7 e 4 |

Imagens de produção (`infra/docker/prod.Dockerfile`, base `node:24-bookworm-slim` do mesmo digest): `api` e `worker` **~380 MB**, `web` **~800 MB** (Next.js com `@next/swc` e `sharp`; `output: 'standalone'` fica como otimização futura). Varredura em 2026-10-14: **0** CVE crítica/alta com correção disponível depois de remover npm/corepack/yarn do runtime e aplicar as atualizações de segurança do Debian; restam CVEs altas do Debian **sem** correção publicada (não bloqueiam; registrar com prazo em `.github/ci-policy.yml`).
