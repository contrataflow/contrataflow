<!--
Título do PR = mensagem do commit de squash: `tipo(escopo): assunto` (Conventional Commits).
Ex.: `feat(process): adiciona filtro por unidade` — o título também é validado pelo commitlint.
-->

## Card

- Story: US-NNN — <!-- link para docs/backlog/story-NNN-*.md -->
- Branch: `feat|fix|refactor|test|docs|ci|chore/US-NNN-slug`

## O que muda

<!-- Resumo objetivo da mudança e do motivo. -->

## Checklist de pronto (DoD)

- [ ] Cenários Gherkin da story (8 categorias) automatizados e verdes
- [ ] Definition of Done da story cumprida
- [ ] Isolamento por tenant e autorização em toda rota nova (suíte _tenant leak_ e matriz de autorização)
- [ ] Cobertura ≥ 80% do código novo em domain/application; 100% em cálculo e políticas
- [ ] `pnpm turbo run lint typecheck test` verde; `pnpm depcruise` e `pnpm check:versions` sem violações
- [ ] Sem segredos, tokens ou dados pessoais em código, logs ou fixtures
- [ ] Mensagens de UI e de erro em pt-BR

## Impacto em fontes canônicas

- [ ] Nenhum
- [ ] Atualizei antes do código: <!-- decisions.md / entities.md / permissions.md / events.md / api.md / ADR -->

## Dependência nova (RN-FND-11)

<!-- Apague se não houver. Preencha para cada pacote novo no catálogo. -->

| Item                                               | Resposta |
| -------------------------------------------------- | -------- |
| Pacote e versão exata                              |          |
| Finalidade                                         |          |
| Alternativas avaliadas (inclusive "não adicionar") |          |
| Última versão publicada há < 12 meses?             |          |
| Licença (RN-FND-10)                                |          |
| Tamanho / impacto no bundle (web)                  |          |
| Scripts de instalação (`onlyBuiltDependencies`)?   |          |

## Como testar

<!-- Passos, dados de teste e evidências (prints, logs sem dados sensíveis). -->
