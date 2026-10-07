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
| Back-end | `prisma` · `@prisma/client` · `@prisma/adapter-pg` · `pg` | 7.10.0 · 7.10.0 · 7.10.0 · 8.23.1 | reservado — US-081 (depende do _spike_ RT-02, DEC-064) |
| Back-end | `bullmq` · `ioredis` | 5.81.5 · 5.11.1 | reservado — filas (DEC-163) |
| Back-end | `@opentelemetry/sdk-node` | 0.222.0 | reservado — US-084 (SDK 2.x) |
| Back-end | `pino` · `nestjs-pino` · `pino-http` | 10.4.0 · 4.6.1 · 11.0.0 | reservado — US-080/US-084 |
| Contratos | `zod` · `@asteasolutions/zod-to-openapi` | 4.6.5 · 8.5.0 | `packages/validation`; OpenAPI 3.1 (DEC-063) |
| Front-end | `next` | 16.3.8 | web (App Router, Turbopack) |
| Front-end | `tailwindcss` · `@tailwindcss/postcss` | 4.3.3 | ui e web |
| Front-end | `@tanstack/react-query` · `@tanstack/react-table` | 5.104.1 · 8.21.3 | reservado — US-086 |
| Front-end | `react-hook-form` · `next-intl` | 7.89.0 · 4.14.9 | reservado — US-086 |
| Front-end | `@tiptap/core` · `@tiptap/pm` · `@tiptap/starter-kit` | 3.31.4 | reservado — editor rico (DEC-056) |
| Testes | `vitest` · `@vitest/coverage-v8` · `vite` | 4.1.11 · 4.1.11 · 7.3.6 | todos os pacotes (`vite` é _peer_ obrigatório) |
| Testes | `unplugin-swc` | 2.0.0 | Vitest na api e no worker |
| Testes | `@playwright/test` · `axe-core` | 1.63.0 · 4.13.0 | reservado — E2E (US-079) |
| Testes | `testcontainers` · `supertest` · `@types/supertest` | 11.14.0 · 7.3.1 · 7.2.1 | reservado — integração (US-078/US-079) |

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
| `ignoredBuiltDependencies` | `unrs-resolver` | revisado: o binário chega por `optionalDependencies`; o script é dispensável |

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
