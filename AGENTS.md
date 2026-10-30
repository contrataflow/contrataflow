<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# ContrataFlow — regras de Git para workers e tripulantes (DEC-190)

O código vai direto para a `main` do GitHub: não existe mais PR por lote nem espera por aprovação.
Os cards rodam em sequência nesta pasta, sobre a `main` local, e o piloto publica. Para isso
funcionar:

- Trabalhe na branch em uso (a `main` local). Não troque de branch, não reescreva histórico
  (`rebase`, `reset`, `commit --amend`) e nunca use `--no-verify`.
- **Não faça push.** Quem publica na `main` do GitHub é o piloto, depois de conferir o card. Um
  push seu pode levar para o GitHub trabalho de outro card ainda pela metade.
- Ao terminar o card, com a verificação verde, faça **um commit** só com os arquivos do card:
  Conventional Commits com escopo, corpo curto em pt-BR e rodapé `Refs: US-NNN` (o commitlint do
  hook valida). Sem trailer de coautoria (`Co-Authored-By`) nem assinatura gerada por ferramenta.
- Se o commit falhar no hook, corrija a causa e tente de novo; não deixe o card terminar sem commit.

# ContrataFlow — verificação por card (DoD enxuta, 2026-10-15)

A DoD da story continua valendo: todo cenário Gherkin (8 categorias) precisa de teste automatizado,
e testes novos de isolamento entram na suíte `test/tenant-leak`. O que muda é **onde** as suítes
pesadas rodam (`test:integration`, `test:tenant-leak`, `test:e2e`): no endurecimento, em card
próprio, não dentro do card da story. Com a entrega direta na `main` (DEC-190) não há mais CI de PR
por lote, então uma suíte pesada que ninguém mandar rodar não roda — é o piloto que agenda.

No card, rode só o necessário:

- Testes do(s) módulo(s) tocado(s):
  `pnpm --filter @contrataflow/api exec vitest run src/modules/<modulo>` e, para integração,
  `pnpm --filter @contrataflow/api exec vitest run --config vitest.integration.config.ts test/<modulo>`
  (no web: `pnpm --filter @contrataflow/web exec vitest run <caminho>`).
- Teste de tenant leak novo: rode só o arquivo que você criou ou alterou.
- `pnpm turbo run lint typecheck test` **uma vez**, ao final (o cache do Turborepo cobre o resto).

Não faça no card:

- `test:integration`, `test:tenant-leak` ou `test:e2e` completos, nem benchmarks de p95. Metas de
  performance ficam escritas como teste da suíte de performance e são medidas no endurecimento.
- Push, PR ou qualquer operação contra o GitHub.
- Verificação em dobro (ex.: worktree separado) ou repetir o que já passou; depois de uma correção,
  rode de novo só o que ela afeta.
- Ler documentos canônicos inteiros: leia a story e busque (grep) só os trechos que ela cita.

Nota final do card: no máximo ~30 linhas (entregue, decisões, pendências).
