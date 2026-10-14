# @contrataflow/tools

Scripts de engenharia do monorepo (US-077). Executados pela raiz:

| Script                                                                                                 | Arquivo                                            |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `pnpm check:versions`                                                                                  | `check-versions.ts` + `lib/versions.ts`            |
| `pnpm smoke:hello`                                                                                     | `smoke-hello.ts`                                   |
| `pnpm verify:fresh-clone`                                                                              | `verify-fresh-clone.ts` + `fresh-clone/`           |
| `pnpm secrets:scan`                                                                                    | `scan-secrets.ts`                                  |
| `pnpm env:up` · `env:up:full` · `env:seed` · `env:reset` · `env:check` · `env:smoke` · `env:blueprint` | `env/` (US-078: ambiente local com Docker Compose) |
| `pnpm ci:licenses` · `ci:contract` · `ci:coverage` · `ci:migrations` · `ci:github-settings`            | `ci/` (US-079: gates do pipeline de CI)            |
| `pnpm --filter @contrataflow/tools test:tenant-leak` · `test:integration`                              | `ci/tenant-leak.ts` · `test/integration/` (Docker) |
| `pnpm turbo gen …`                                                                                     | `turbo/generators/`                                |

- `module-levels.json` — níveis dos módulos de DEC-040; alimenta o `.dependency-cruiser.cjs`,
  os escopos do commitlint e o gerador `api-module`.
- `env/` — ambiente local (US-078): `lib/` (`.env`, Compose, portas, trava, API do Authentik, psql), `seed/` (dataset dos tenants semeados, SQL do schema provisório `dev_seed` e blueprint de usuários) e `smoke/` (login OIDC, Mailpit, Gotenberg, ClamAV, isolamento).
- `ci/` — gates do pipeline (US-079), um script por passo dos workflows de `.github/workflows/` e a lógica testável em `ci/lib/`: escopo da mudança, título do PR, licenças, diff de OpenAPI, cobertura do código novo, migrações e PostgreSQL efêmero, suíte _tenant leak_, gate de CVE, Semgrep, anotações no PR, retry com _backoff_, ruleset do GitHub, deploy no ECS e traces.
- `fixtures/` — violações intencionais (lint, fronteiras, _tenant bypass_, erro de tipo do CI). Ficam fora do
  typecheck e do lint do pacote e são verificadas pelos testes em `test/`.
