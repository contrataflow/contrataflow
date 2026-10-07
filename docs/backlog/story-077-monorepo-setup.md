---
id: US-077
title: "Configurar monorepo e padrões de código"
epic: EP-015
feature: FT-047
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: []
modules: [platform]
screens: []
endpoints: []
permissions: []
events: []
---

# US-077 — Configurar monorepo e padrões de código

## Título
Configurar monorepo e padrões de código

## Descrição
**Como** time de engenharia do ContrataFlow, **quero** um monorepo pnpm + Turborepo com versões fixadas, TypeScript estrito, lint e formatação, convenções de commit, fronteiras de dependência verificáveis e guia de contribuição, **para** que todas as stories seguintes comecem sobre uma base reprodutível, segura e homogênea.

A story entrega o esqueleto do repositório descrito em DEC-051 e detalhado em [architecture.md §4](../architecture/architecture.md#4-monorepo): `apps/web` (Next.js App Router), `apps/api` (NestJS 11) e `apps/worker` (NestJS standalone) em estado *hello*; `packages/ui`, `types`, `validation`, `editor`, `eslint-config` e `tsconfig`; scripts de raiz orquestrados pelo Turborepo; ESLint *flat config* com as proibições de segurança, Prettier, Conventional Commits (commitlint), husky e lint-staged; configuração do `dependency-cruiser` com as regras de DEC-041 (executadas como *gate* pela US-079); Renovate, CODEOWNERS, modelo de PR, `CONTRIBUTING.md` e a **política de versões fixadas** exigida por DEC-050 ("versões exatas são fixadas no card de setup do monorepo"). Nenhum código de negócio é escrito aqui.

## Contexto
- DEC-050 fixa a stack (Node.js LTS 24.x, TypeScript 5.x `strict`, Next.js, NestJS, Prisma, Zod, BullMQ…) e delega a esta story a fixação das versões exatas; DEC-051 fixa o layout do monorepo (inclui `packages/editor`); DEC-041 exige verificação das camadas por `dependency-cruiser`; DEC-054 torna `packages/validation` a fonte única de contratos; DEC-137 proíbe segredos no repositório.
- Riscos tratados: RT-09 (*breaking changes* de versões recentes — Renovate com janela), RS-11 (cadeia de suprimentos), RS-09 (vazamento de segredos), RM-03 (cliente Redis usado sem o wrapper de tenant) — [risks-and-decisions.md](../mvp-01/risks-and-decisions.md).
- O CI (GitHub Actions, DEC-061) é a US-079; o ambiente local com Docker Compose é a US-078. Esta é a primeira story do caminho crítico (delivery-plan.md §4).

## Objetivo
Em um clone limpo, `pnpm install --frozen-lockfile && pnpm build && pnpm lint && pnpm typecheck && pnpm test` termina sem erros em ≤ 10 min (máquina de referência: 8 vCPU, 16 GB, SSD) e em ≤ 2 min com cache do Turborepo; 100% das dependências declaradas com versão exata via catálogo do pnpm; 100% das regras de fronteira e de segurança ativas e cobertas por *fixtures* de violação.

## Persona
- **Principal:** time de engenharia (desenvolvedores back-end, front-end e de plataforma; Tech Lead).
- **Secundárias:** QA/SDET (scripts de teste padronizados), segurança (revisão de dependências e regras de lint), operação (versões reprodutíveis nas imagens).

## Pré-condições
- Repositório no GitHub criado na Sprint 0, com a organização e os times definidos (nomes usados no CODEOWNERS).
- CI/CD decidido: GitHub Actions (DEC-061); proteção de branch é configurada na US-079.
- Estações com Node.js 24 (Corepack habilitado); Docker **não** é necessário nesta story.

## Fluxo principal
1. O desenvolvedor clona o repositório e executa `corepack enable`; o pnpm usado é o declarado em `packageManager`.
2. `pnpm install --frozen-lockfile` valida `engines` (Node 24), instala pelo `pnpm-lock.yaml`, executa scripts de instalação **somente** dos pacotes listados em `onlyBuiltDependencies` e instala os hooks do husky (`prepare`).
3. `pnpm build` executa `turbo run build`: pacotes (`types` → `validation` → `editor`, `ui`) antes dos apps, com cache local por hash de entradas.
4. `pnpm dev` sobe `web` (porta 3000, página inicial estática "ContrataFlow"), `api` (porta 4000, NestJS com `AppModule` vazio, encerramento limpo em `SIGTERM`) e `worker` (contexto standalone que registra `worker.started` e encerra limpo em `SIGTERM`).
5. O desenvolvedor cria a branch `feat/US-0NN-slug`, altera código e faz commit: o `pre-commit` roda `lint-staged` (ESLint `--fix` e Prettier nos arquivos *staged*); o `commit-msg` valida Conventional Commits com commitlint.
6. No `pre-push`, `turbo run typecheck --filter=...[origin/main]` verifica apenas os pacotes afetados.
7. O PR usa o modelo `.github/pull_request_template.md` (card, checklist de DoD, impacto em fontes canônicas); o CODEOWNERS solicita os revisores obrigatórios; o CI da US-079 repete todas as verificações (hooks locais são conveniência, não controle).
8. Semanalmente o Renovate abre PRs agrupados de atualização, que seguem a política de versões (RN-FND-09).

## Fluxos alternativos
- **FA-01 — Node fora da versão:** com `engine-strict=true`, o `pnpm install` falha com `ERR_PNPM_UNSUPPORTED_ENGINE`; o `CONTRIBUTING.md` orienta `fnm use`/`nvm use` (arquivo `.nvmrc`).
- **FA-02 — Dependência nova:** declarada com `catalog:` no `package.json` do pacote e com versão exata no catálogo de `pnpm-workspace.yaml`; o PR preenche a justificativa da RN-FND-11; sem isso, `pnpm check:versions` falha.
- **FA-03 — Novo pacote ou módulo:** `pnpm turbo gen package` (geradores em `tools/turbo/generators/`) cria a estrutura com `tsconfig`, ESLint, Vitest e `package.json` corretos; módulos da API seguem o gerador `api-module` (pastas de DEC-041).
- **FA-04 — Hooks ignorados (`--no-verify`):** permitido localmente; o CI bloqueia o *merge* com as mesmas verificações.
- **FA-05 — Estação Windows:** `.gitattributes` força LF; scripts de pacote são escritos em TypeScript (`tsx`) e nunca dependem de bash; Docker (US-078) recomendado via WSL 2.
- **FA-06 — Atualização *major*:** o Renovate não abre o PR até aprovação no *Dependency Dashboard*; mudança de stack (ex.: TypeScript 6/7, Node 26) exige nova entrada em `decisions.md`.

## Regras de negócio
- **RN-FND-01** — Toda dependência tem versão **exata**: o catálogo de `pnpm-workspace.yaml` (`catalog:`/`catalogs:`) é a fonte única de versões; `package.json` dos pacotes referencia `catalog:` (dependências externas) ou `workspace:*` (internas); faixas `^`/`~`/`*`/`latest` são proibidas; `pnpm-lock.yaml` é versionado e o CI instala só com `--frozen-lockfile`.
- **RN-FND-02** — Runtime fixo: Node.js 24.x LTS (`.nvmrc` = `24`; `engines.node` = `>=24.11.0 <25`); pnpm 10.x via `packageManager`; TypeScript 5.9.x (DEC-050). Mudança de *major* de Node ou TypeScript exige atualização de DEC-050.
- **RN-FND-03** — Base TypeScript estrita para todos os pacotes: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables`, `verbatimModuleSyntax`, `isolatedModules`, `skipLibCheck: false` em `packages/*`; `any` explícito, `@ts-ignore` e `@ts-nocheck` proibidos (`@ts-expect-error` só com descrição ≥ 10 caracteres).
- **RN-FND-04** — Pacotes internos nomeados `@contrataflow/<nome>`, `"private": true`, sem publicação em registry.
- **RN-FND-05** — Direção de dependências conforme architecture.md §4.3 (ex.: `packages/types` não importa nada interno; `ui` só importa `types`; `apps/web` nunca importa `apps/api`/`apps/worker`; o worker só importa `domain`, `application`, `infrastructure`, `*.module.ts` e `shared` da API) e regras de DEC-041 (domínio puro; outro módulo só via `application/<m>.facade.ts`; sem ciclos), declaradas em `.dependency-cruiser.cjs`.
- **RN-FND-06** — Regras de segurança no ESLint (erro): `$queryRawUnsafe`/`$executeRawUnsafe`; `dangerouslySetInnerHTML` fora do componente de pré-visualização sanitizada; `console.*` (usar logger); `process.env` fora de `src/config/**`; `eval`/`new Function`; import de `ioredis`/cliente Redis fora de `shared/cache/**` e `modules/platform/**` (RM-03); import de `@prisma/client` fora de `infrastructure/**` e `shared/database/**`; `import 'server-only'` obrigatório em `apps/web/src/bff/**`.
- **RN-FND-07** — Commits seguem Conventional Commits 1.0: tipos `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`, `revert`; escopo obrigatório da lista fechada (apps, pacotes do workspace — inclusive `tools` —, módulos de DEC-040, `infra`, `deps`, `docs` e `repo` para a configuração da raiz); assunto ≤ 100 caracteres, imperativo, minúsculo; rodapé `Refs: US-NNN` obrigatório (exceto `chore(deps)` do Renovate e `revert`); `BREAKING CHANGE:` exige referência a DEC/ADR.
- **RN-FND-08** — Modelo *trunk-based*: branches curtas `feat|fix|refactor|test|docs|ci|chore/US-NNN-slug`, *squash merge* em `main` (o título do PR vira o commit e também é validado pelo commitlint); `main` sempre implantável.
- **RN-FND-09** — Política de atualização (Renovate): janela semanal (segunda-feira antes das 06:00, `America/Sao_Paulo`); `minimumReleaseAge` de 3 dias (patch/minor) e 14 dias (major); grupos por ecossistema (NestJS, Next.js + React, Prisma, OpenTelemetry, TanStack, Radix/shadcn, TipTap, Storybook, Vitest, lint, imagens Docker, GitHub Actions); *automerge* apenas de patch/minor de `devDependencies` e *digests* de Actions com CI verde; *majors* só após aprovação no *Dependency Dashboard*; alertas de segurança fora da janela; Node restrito a `24.x`; imagens Docker e Actions fixadas por *digest*; `lockFileMaintenance` mensal.
- **RN-FND-10** — Licenças permitidas em dependências de runtime: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, BlueOak-1.0.0, MPL-2.0 (nível de arquivo); proibidas GPL, AGPL, SSPL, BUSL e licenças desconhecidas (verificação executada no CI — US-079).
- **RN-FND-11** — Dependência nova exige, no PR: finalidade, alternativas avaliadas (inclusive "não adicionar"), última versão publicada há < 12 meses, licença, tamanho/impacto no bundle (web) e aprovação dos donos de `pnpm-workspace.yaml` (Tech Lead + segurança).
- **RN-FND-12** — Portabilidade: fins de linha LF, scripts em Node/TypeScript, caminhos sem dependência de sistema operacional; o repositório funciona em Linux, macOS e Windows (WSL 2 para Docker).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Versão do Node | `.nvmrc`, `engines.node`, `packageManager` | arquivos de configuração | Sim | RN-FND-02 | `24`; `>=24.11.0 <25`; `pnpm@10.x.y` |
| Catálogo de versões | `pnpm-workspace.yaml` → `catalog`, `catalogs.react`, `onlyBuiltDependencies` | YAML | Sim | RN-FND-01; allowlist de scripts de instalação (ex.: `@swc/core`, `esbuild`, `sharp`, `@parcel/watcher`) | — |
| Opções do pnpm | `.npmrc` | INI | Sim | `engine-strict=true`, `save-exact=true`, `auto-install-peers=false`, `strict-peer-dependencies=true`, `resolution-mode=highest` | — |
| Bases TypeScript | `packages/tsconfig/{base,node,next,library}.json` | JSON | Sim | RN-FND-03; `node.json`: `module`/`moduleResolution` `NodeNext`, `target` `ES2024`; `next.json`: `moduleResolution` `Bundler`, `jsx` `preserve` | — |
| Aliases | `apps/web/tsconfig.json` (`paths` `@/*` → `src/*`); `apps/{api,worker}/package.json` (`imports` `#shared/*`, `#modules/*`, `#config/*`) | JSON | Sim | Pacotes internos sempre por nome (`@contrataflow/types`); *subpath imports* do Node na API/worker (resolvidos nativamente, sem `tsconfig-paths`) | — |
| ESLint | `packages/eslint-config/{base,node,nest,next,react,storybook}.js` + `eslint.config.mjs` por pacote | *flat config* | Sim | `typescript-eslint` *type-checked*, `eslint-plugin-import-x`, `jsx-a11y` (web/ui), regras RN-FND-06 | — |
| Prettier | `.prettierrc.json`, `.prettierignore` | JSON | Sim | `printWidth` 100, `singleQuote`, `trailingComma` `all`, plugin de ordenação de classes Tailwind | — |
| Commits | `commitlint.config.mjs` | ESM | Sim | RN-FND-07 (`scope-enum` gerado da lista de módulos de DEC-040) | — |
| Hooks | `.husky/pre-commit`, `.husky/commit-msg`, `.husky/pre-push`, `lint-staged.config.mjs` | scripts | Sim | Fluxo principal 5–6 | — |
| Orquestração | `turbo.json` | JSON | Sim | Tarefas `build`, `dev`, `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`, `depcruise`, `db:generate`, `openapi:generate` (architecture.md §4.5) | — |
| Fronteiras | `.dependency-cruiser.cjs`, `tools/module-levels.json` | JS/JSON | Sim | RN-FND-05; níveis de módulo de architecture.md §3.3 | — |
| Atualizações | `renovate.json5` | JSON5 | Sim | RN-FND-09 | — |
| Revisão | `.github/CODEOWNERS`, `.github/pull_request_template.md` | texto | Sim | Áreas sensíveis da tabela de Permissões | — |
| Guia | `CONTRIBUTING.md`, `docs/engineering/versions.md`¹ | Markdown | Sim | Setup, branches, commits, PR, DoD, dependências, ADR | — |
| Editor | `.editorconfig`, `.gitattributes`, `.vscode/{extensions,settings}.json` | texto | Sim | LF, UTF-8, *format on save* | — |

¹ Arquivo novo de engenharia previsto nesta story; registrado como lacuna de documentação.

**Versões-alvo** (linha fixada no catálogo no 1º dia da Sprint 1; o patch exato fica no catálogo e no `docs/engineering/versions.md`):

| Componente | Linha | Observação |
|---|---|---|
| Node.js | 24.x LTS | DEC-050; imagens `node:24-bookworm-slim` (US-079) |
| pnpm · Turborepo | 10.x · 2.x | Corepack; cache local + `actions/cache` no CI (sem cache remoto de terceiros no MVP 1) |
| TypeScript | 5.9.x | DEC-050 (5.x) |
| Next.js · React | 16.x · 19.2.x | App Router; `src/proxy.ts` para cabeçalhos/CSP (US-086) |
| NestJS | 11.x (`@nestjs/platform-express`, Express 5) | Compatibilidade com Terminus, throttler, pino-http e instrumentação OTel |
| Prisma ORM | 7.x com `@prisma/adapter-pg` + `pg` 8.x | Validado no *spike* RT-02 da Sprint 0; *fallback* registrado: Prisma 6.x |
| Zod · gerador OpenAPI | 4.x · `@asteasolutions/zod-to-openapi` 8.x (OpenAPI 3.1) | DEC-054 |
| BullMQ · ioredis | 5.x (≥ 5.16, *job schedulers*) · 5.x | DEC-163 |
| OpenTelemetry JS | SDK 2.x (`@opentelemetry/sdk-node`) | US-084 |
| pino · nestjs-pino | major estável suportada pelo nestjs-pino 4.x | US-084 |
| UI | Tailwind CSS 4.x, Radix UI, componentes shadcn/ui versionados em `packages/ui`, TanStack Query 5.x, TanStack Table 8.x, React Hook Form 7.x, next-intl 4.x, TipTap 3.x | US-086 |
| Testes | Vitest 4.x (+ `unplugin-swc` na API/worker), Playwright 1.6x (1.63 na fixação), Testcontainers 11.x, Supertest 7.x, axe-core 4.x | US-079 |
| Qualidade | ESLint 9.x (*flat*), typescript-eslint 8.x, Prettier 3.x, commitlint 19+, husky 9.x, lint-staged 16.x, dependency-cruiser 17.x | — |
| Build de API/worker | SWC (`@swc/cli`, `decoratorMetadata: true`) para build/dev; `tsc --noEmit` para typecheck | esbuild não emite metadados de decorators exigidos pela injeção do NestJS |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Node diferente de 24.x | `pnpm install` | "Use o Node.js 24 LTS (veja `.nvmrc`)." | `ERR_PNPM_UNSUPPORTED_ENGINE` |
| V-02 | Dependência com faixa de versão ou fora do catálogo | `pnpm check:versions` (`tools/check-versions.ts`) | "A dependência {nome} deve usar `catalog:` com versão exata." | `VERSION_NOT_PINNED` (código do script) |
| V-03 | Lockfile desatualizado | `pnpm install --frozen-lockfile` | "Execute `pnpm install` e versione o `pnpm-lock.yaml`." | `ERR_PNPM_OUTDATED_LOCKFILE` |
| V-04 | Mensagem de commit fora do padrão | commitlint (`commit-msg`) | "Use `tipo(escopo): assunto` — ex.: `feat(api): adiciona filtro RFC 9457`." | `type-enum` / `scope-enum` / `subject-empty` |
| V-05 | Lint ou formatação inválidos | lint-staged / CI | Saída do ESLint/Prettier com arquivo e linha | regra do ESLint |
| V-06 | Violação de fronteira de módulo ou camada | `pnpm depcruise` | "{origem} não pode importar {destino} (regra {nome})." | `no-circular`, `domain-is-pure`, `cross-module-only-via-facade`… |
| V-07 | API proibida (RN-FND-06) | ESLint | "Uso proibido: {api}. Veja CONTRIBUTING.md §Segurança." | regras do plugin local `contrataflow/*` (`no-unsafe-raw-query`, `no-dangerous-html`, `no-console`, `no-process-env`, `no-dynamic-code`, `no-direct-redis`, `no-prisma-outside-infrastructure`, `require-server-only`) — uma regra por proibição, para que a liberação por caminho de cada uma seja independente |
| V-08 | Mais de uma *major* da mesma biblioteca crítica (`react`, `zod`, `@prisma/client`, `@nestjs/core`, `bullmq`) no lockfile | `pnpm check:versions` | "Versões duplicadas de {pacote}: {lista}." | `DUPLICATE_MAJOR` |
| V-09 | Licença fora da allowlist | CI (US-079) | "Licença {licença} de {pacote} não é permitida." | `LICENSE_NOT_ALLOWED` |

## Permissões
- **Permissão:** não se aplica ao RBAC do produto (nenhuma rota ou dado de tenant). O controle é de repositório.
- **Políticas de repositório:** CODEOWNERS com revisão obrigatória — `apps/api/src/shared/**`, `apps/api/src/modules/{access,identity,tenancy,audit,platform}/**`, `apps/api/prisma/**`, `apps/web/src/bff/**`, `.github/**`, `pnpm-workspace.yaml`, `.npmrc`, `renovate.json5`, `.dependency-cruiser.cjs`, `packages/eslint-config/**` → Tech Lead + segurança/plataforma; `packages/ui/**` → front-end + design; `docs/architecture/**`, `docs/mvp-01/**` → Tech Lead + PO.
- **Acesso administrativo ao repositório:** somente Tech Lead e plataforma; app do Renovate com permissões mínimas (conteúdo e PRs).
- **Sem permissão:** PR que toca área com dono não pode ser mesclado sem a aprovação correspondente (proteção de branch — US-079).

## Eventos gerados
Não se aplica — story de engenharia, sem eventos de domínio.

## Notificações
Não se aplica — avisos são do próprio GitHub (revisão solicitada pelo CODEOWNERS, PRs e *Dependency Dashboard* do Renovate).

## Critérios de aceite em Gherkin
```gherkin
Feature: Monorepo e padrões de código

  Background:
    Given um clone limpo do repositório em uma estação com Node.js 24 e Corepack habilitado

  Scenario: [Sucesso] Construir e verificar o monorepo a partir do zero
    When o desenvolvedor executar "pnpm install --frozen-lockfile", "pnpm build", "pnpm lint", "pnpm typecheck" e "pnpm test"
    Then todos os comandos devem terminar com código 0 em até 10 minutos
    And os pacotes devem ser construídos na ordem "types", "validation", "editor", "ui" antes dos apps
    And uma segunda execução de "pnpm build" sem alterações deve ser servida pelo cache do Turborepo em até 2 minutos

  Scenario: [Sucesso] Aplicações em estado hello
    When o desenvolvedor executar "pnpm dev"
    Then a página inicial do web deve responder em "http://localhost:3000" com o título "ContrataFlow" e lang "pt-BR"
    And a API e o worker devem inicializar sem erros e encerrar com código 0 ao receber SIGTERM

  Scenario: [Validação] Mensagem de commit fora do padrão
    When o desenvolvedor tentar commitar com a mensagem "ajustes diversos"
    Then o hook "commit-msg" deve rejeitar o commit apontando as regras "type-empty" e "scope-empty"
    And um commit "feat(api): adiciona filtro de erros" com rodapé "Refs: US-080" deve ser aceito

  Scenario: [Validação] Dependência sem versão exata
    Given que um pacote declara "lodash" com a faixa "^4.17.21"
    When "pnpm check:versions" for executado
    Then deve falhar com "VERSION_NOT_PINNED" indicando o pacote e a dependência

  Scenario: [Permissão] Alteração em área sensível exige revisão do dono
    Given que um PR altera "apps/api/src/modules/access/" e "pnpm-workspace.yaml"
    When o PR for aberto
    Then o CODEOWNERS deve solicitar revisão do Tech Lead e do time de segurança
    And o merge deve permanecer bloqueado até essas aprovações

  Scenario: [Tenant incorreto] Código que contorna o contexto de tenant é barrado
    Given um arquivo em "apps/api/src/modules/process/application/" que importa "ioredis" diretamente
    And um arquivo de domínio que importa "@prisma/client"
    And uma consulta com "$queryRawUnsafe"
    When "pnpm lint" e "pnpm depcruise" forem executados
    Then os três arquivos devem ser reportados como erro com as regras correspondentes
    And a mensagem deve orientar o uso de "TenantCache", do repositório e de "$queryRaw" parametrizado

  Scenario: [Duplicidade] Duas majors da mesma biblioteca crítica
    Given que um pacote resolve "zod" 3.x enquanto o catálogo fixa "zod" 4.x
    When "pnpm check:versions" for executado
    Then deve falhar com "DUPLICATE_MAJOR" listando as versões encontradas

  Scenario: [Concorrência] Dois PRs alteram o lockfile em paralelo
    Given que o PR "A" atualizou "pnpm-lock.yaml" e foi mesclado
    When o PR "B", criado antes, for verificado sem rebase
    Then a instalação com "--frozen-lockfile" deve falhar com "ERR_PNPM_OUTDATED_LOCKFILE" ou a branch deve exigir atualização
    And após rebase e "pnpm install" o lockfile deve ser regenerado de forma determinística

  Scenario: [Falha de banco] Build e testes unitários sem PostgreSQL
    Given que nenhum PostgreSQL está acessível na estação
    When "pnpm build", "pnpm typecheck" e "pnpm test" forem executados
    Then todos devem passar, pois não dependem de banco de dados
    And somente "pnpm test:integration" deve exigir Docker (US-078/US-079)

  Scenario: [Falha de integração] Registry de pacotes indisponível
    Given que o registry npm está inacessível e o store do pnpm já contém as dependências do lockfile
    When "pnpm install --frozen-lockfile --offline" for executado
    Then a instalação deve concluir a partir do store local
    And sem o store aquecido deve falhar com mensagem explícita de rede, sem instalar versões diferentes das do lockfile
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Node incompatível | — | `ERR_PNPM_UNSUPPORTED_ENGINE` | "Use o Node.js 24 LTS (veja `.nvmrc`)." | Terminal; `CONTRIBUTING.md` §Ambiente |
| Lockfile desatualizado | — | `ERR_PNPM_OUTDATED_LOCKFILE` | "Execute `pnpm install` e versione o lockfile." | Terminal/CI |
| Script de instalação não autorizado (pnpm 10) | — | aviso `ignored build scripts` | "Adicione o pacote a `onlyBuiltDependencies` somente após revisão de segurança." | Terminal |
| Commit fora do padrão | — | regra do commitlint | "Use `tipo(escopo): assunto`." | Commit rejeitado |
| Violação de fronteira | — | regra do dependency-cruiser | "{origem} não pode importar {destino}." | Lint local e CI |
| Versão não fixada / duplicada | — | `VERSION_NOT_PINNED` / `DUPLICATE_MAJOR` | Ver V-02/V-08 | CI vermelho |
| Licença proibida | — | `LICENSE_NOT_ALLOWED` | Ver V-09 | CI vermelho |

## Dependências
- **Stories:** nenhuma (primeira do caminho crítico). Habilita US-078, US-079, US-080 e US-086 e, por transitividade, todo o backlog.
- **Decisões/ADRs:** DEC-001, DEC-041, DEC-050, DEC-051, DEC-054, DEC-137, DEC-061; ADR-001, ADR-010.
- **Configurações:** nenhuma de tenant.
- **Lacunas nas fontes canônicas:** (1) escopo npm `@contrataflow/*` é proposta de architecture.md (†) — registrar em `decisions.md`; (2) organização/times do GitHub usados no CODEOWNERS não estão definidos; (3) escolha do adaptador HTTP do NestJS (Express 5) e do gerador OpenAPI (`@asteasolutions/zod-to-openapi`) não constam de `decisions.md` — registrar como complemento de DEC-050/DEC-054; (4) Prisma 7 com *driver adapter* depende do resultado do *spike* RT-02 (registrar em ADR); (5) `docs/engineering/versions.md` não está no mapa de documentos do README — incluir. **Registro (2026-10-07):** (1) DEC-062; (2) PEND-20, com times provisórios em DEC-062; (3) DEC-063; (4) DEC-064 (`Proposta`, ADR pendente do *spike*); (5) incluído em `docs/README.md` §1 e §3.

## Impacto técnico
- Define a base de todas as stories: qualquer desvio (ex.: versão não fixada, regra de fronteira ausente) se multiplica pelo backlog. Por isso as regras nascem com *fixtures* de violação testadas.
- **Formato de módulos:** API e worker em ESM (`"type": "module"`, `NodeNext`); Node 24 suporta `require(esm)` caso alguma dependência CommonJS exija. Confirmado no *spike* junto com Prisma 7.
- **pnpm 10** bloqueia scripts de instalação por padrão (defesa de cadeia de suprimentos — RS-11); toda inclusão em `onlyBuiltDependencies` passa por revisão.
- **Cache:** sem cache remoto de terceiros no MVP 1 (artefatos poderiam conter metadados internos); CI usa `actions/cache` do diretório `.turbo` (US-079).
- **Desempenho no Windows:** recomendação de clonar dentro do WSL 2 quando usar Docker (I/O de bind mounts).

## Backend
- **Módulo(s):** nenhum de negócio. `apps/api`: `src/main.ts`, `src/app.module.ts` (vazio), `src/config/` (reservado para US-080), `src/shared/` e `src/modules/` (vazios com README), `prisma/` (reservado para US-081), `test/`. `apps/worker`: `src/main.ts` (`NestFactory.createApplicationContext`), `src/worker.module.ts`.
- **Pacotes:** `packages/types` (`src/index.ts` com barris por domínio: `permissions.ts`, `events.ts`, `errors.ts`, `queues.ts` — vazios até as stories donas); `packages/validation` (Zod 4, `src/common/` com utilitários de schema); `packages/editor` (exporta `editorSchemaVersion` e extensões vazias — DEC-051/DEC-056).
- **Build e testes:** SWC para build/dev/test (`.swcrc` com `decoratorMetadata` e `legacyDecorator`), `tsc --noEmit` para typecheck, Vitest com `unplugin-swc`.

## Frontend
- **Tela(s):** nenhuma de produto; `apps/web/src/app/layout.tsx` (`<html lang="pt-BR">`) e `page.tsx` estáticos. Shell, design system e cliente de API são da US-086.
- **Componentes:** `packages/ui` com Tailwind 4 configurado (tokens vazios) e `transpilePackages` no `next.config.ts`.
- **Estados / acessibilidade:** `eslint-plugin-jsx-a11y` ativo desde o primeiro componente.

## Banco de dados
Não se aplica — schema Prisma, papéis e migrações são da US-081; esta story apenas reserva `apps/api/prisma/` e a tarefa `db:generate` no Turborepo.

## API
Não se aplica — nenhum endpoint de produto. O *scaffold* só inicializa o NestJS; esqueleto HTTP completo na US-080 e HLT-01..03 na US-085.

## Logs
- Scripts de `tools/` imprimem apenas mensagens de diagnóstico (nunca variáveis de ambiente completas).
- O *scaffold* usa o logger padrão do NestJS até a US-080/US-084 configurarem o pino.
- **Nunca logar:** conteúdo de `.env`, tokens do Renovate/GitHub, credenciais de registry.

## Auditoria
Não se aplica — sem ações de produto. A rastreabilidade de mudanças é o histórico Git, os PRs revisados e o *audit log* da organização no GitHub.

## Testes necessários
- **Unitários:** `tools/check-versions.ts` (faixas, ausência de `catalog:`, *majors* duplicadas); configuração do commitlint com mensagens válidas e inválidas; regras do ESLint executadas contra `tools/fixtures/lint/**` (um arquivo por proibição da RN-FND-06, cada um deve falhar).
- **Integração:** `pnpm verify:fresh-clone` em contêiner `node:24-bookworm-slim` (install → build → lint → typecheck → test) — reutilizado pelo CI (US-079); `tools/fixtures/depcruise/**` com uma violação por regra (cada uma deve falhar).
- **API/contrato:** não se aplica.
- **RBAC e multi-tenant:** cenário `[Tenant incorreto]` automatizado pelas *fixtures* de lint (RM-03).
- **Concorrência:** duas execuções paralelas de `turbo run build` produzem saídas com o mesmo hash.
- **E2E (Playwright):** não se aplica.
- **Acessibilidade/performance:** tempo de build frio e quente medido e registrado no `docs/engineering/versions.md`.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (scripts e *fixtures*) e passando localmente e no CI
- [ ] Catálogo de versões completo, sem faixas; versões-alvo registradas em `docs/engineering/versions.md`
- [ ] ESLint, Prettier, commitlint, husky, lint-staged e dependency-cruiser ativos, com *fixtures* de violação
- [ ] Renovate, CODEOWNERS, modelo de PR e `CONTRIBUTING.md` publicados e revisados pelo Tech Lead
- [ ] Apps em estado *hello* sobem e encerram limpo; build frio ≤ 10 min, quente ≤ 2 min
- [ ] Nenhum segredo versionado (gitleaks local limpo)
- [ ] Revisão de código e de segurança aprovadas
- [ ] Lacunas registradas em `decisions.md`/README (escopo npm, Express, gerador OpenAPI, resultado do *spike* do Prisma)

## Estimativa
**M** — configuração ampla porém conhecida (monorepo, lint, hooks, Renovate, geradores), com esforço extra nas regras de segurança/fronteira testadas por *fixtures* e na validação de compatibilidade Next 16 + NestJS 11 + Prisma 7 em ESM.

## Prioridade
**P0** — primeira story do caminho crítico; nenhuma outra pode começar sem o monorepo e seus padrões.
