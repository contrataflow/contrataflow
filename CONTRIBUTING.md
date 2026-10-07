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
3. [Estrutura do monorepo](#estrutura-do-monorepo)
4. [Scripts](#scripts)
5. [Branches e PRs](#branches-e-prs)
6. [Commits](#commits)
7. [Definition of Done](#definition-of-done)
8. [Dependências](#dependências)
9. [Segurança](#segurança)
10. [Fronteiras de dependência](#fronteiras-de-dependência)
11. [Testes](#testes)
12. [Geradores](#geradores)
13. [Decisões e ADRs](#decisões-e-adrs)

## Ambiente

| Ferramenta | Versão                               | Como obter                                                |
| ---------- | ------------------------------------ | --------------------------------------------------------- |
| Node.js    | 24.x LTS (`>=24.11.0 <25`, `.nvmrc`) | `fnm use` ou `nvm use` na raiz                            |
| pnpm       | o do campo `packageManager` (10.x)   | `corepack enable` (o Corepack baixa a versão fixada)      |
| Docker     | opcional nesta etapa                 | necessário para `test:integration` e `verify:fresh-clone` |

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
pnpm dev                          # web :3000, api :4000 e worker
```

`pnpm install` só executa scripts de instalação dos pacotes em `onlyBuiltDependencies`
(`pnpm-workspace.yaml`). O aviso `ignored build scripts` indica um pacote novo com script:
adicione-o à lista **somente após revisão de segurança** (CODEOWNERS).

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

| Comando                   | O que faz                                                                |
| ------------------------- | ------------------------------------------------------------------------ |
| `pnpm build`              | Build de todos os pacotes (Turborepo, cache local)                       |
| `pnpm dev`                | Apps em modo de desenvolvimento                                          |
| `pnpm lint`               | Prettier + ESLint da raiz e ESLint de cada pacote                        |
| `pnpm typecheck`          | `tsc --noEmit` em todos os pacotes                                       |
| `pnpm test`               | Testes unitários (Vitest) — não exigem banco nem Docker                  |
| `pnpm test:integration`   | Integração com Testcontainers (exige Docker — US-078/US-079)             |
| `pnpm depcruise`          | Fronteiras de dependência (dependency-cruiser)                           |
| `pnpm check:versions`     | Versões exatas pelo catálogo e majors duplicadas                         |
| `pnpm format`             | Formata o repositório com Prettier                                       |
| `pnpm smoke:hello`        | Sobe os apps já construídos e confere o estado _hello_                   |
| `pnpm verify:fresh-clone` | Clone limpo em contêiner `node:24-bookworm-slim` (install → test, smoke) |
| `pnpm secrets:scan`       | Varredura de segredos com gitleaks (Docker)                              |

O CI (US-079) roda `pnpm turbo run lint typecheck test` e os demais gates. Os hooks locais
(husky) são conveniência, não controle: `--no-verify` é permitido localmente, mas o CI bloqueia
o _merge_ (FA-04).

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

## Testes

- **Unitários:** Vitest, ao lado do código (`*.test.ts` nos pacotes; `*.spec.ts` na API e no
  worker, com SWC para os metadados de decorators). Não dependem de banco.
- **Integração:** `apps/api/test/**` com Testcontainers — `pnpm test:integration` (Docker).
- **Regras de engenharia:** `tools/test/**` cobre o `check:versions`, o commitlint, as _fixtures_
  de lint e de fronteiras, o CODEOWNERS, o grafo do Turborepo e o lockfile.

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
