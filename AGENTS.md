<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# ContrataFlow — regras de Git para workers e tripulantes (DEC-068)

A `main` do GitHub só aceita PR. Os cards rodam em sequência nesta pasta e entram no GitHub por
lote, num PR aberto pelo piloto. Para isso funcionar:

- Trabalhe na branch em uso (a `main` local). Não troque de branch, não faça push, não reescreva
  histórico (`rebase`, `reset`, `commit --amend`) e nunca use `--no-verify`.
- Ao terminar o card, com a verificação verde, faça **um commit** só com os arquivos do card:
  Conventional Commits com escopo, corpo curto em pt-BR e rodapé `Refs: US-NNN` (o commitlint do
  hook valida). Sem trailer de coautoria (`Co-Authored-By`) nem assinatura gerada por ferramenta.
- Se o commit falhar no hook, corrija a causa e tente de novo; não deixe o card terminar sem commit.
