---
id: FT-011
title: "Elaboração do ETP"
epic: EP-003
mvp: 1
priority: P0
stories: [US-019, US-020]
status: Especificada
---

# FT-011 — Elaboração do ETP

## Título
Elaboração do ETP

## Épico
EP-003 — Estudo Técnico Preliminar (ETP)

## Descrição
Cobre a criação do ETP a partir do template vigente — com importação opcional dos dados já levantados no DFD — e a edição incremental de suas seções, com autosave e a possibilidade de marcar seções como "não se aplica" com justificativa. É a porta de entrada do épico: estabelece o documento, os itens herdados e a estrutura de navegação por seção sobre a qual as demais features (alternativas, estimativas, validação) atuam.

## Valor para o usuário e para o órgão
- Elimina o retrabalho de redigitar objeto/justificativa, itens e situação no PCA já levantados no DFD.
- Garante que os elementos do art. 18, §1º, da Lei 14.133/2021 estejam sempre presentes na estrutura do documento, com a obrigatoriedade de cada um definida por configuração.
- Evita perda de conteúdo com autosave e indicação clara do que falta preencher.

## Personas
- Redator do ETP (`REQUISITANTE`/`PLANEJAMENTO`) — cria e edita o documento.
- Gestor de contratações (`GESTOR_CONTRATACOES`) — acompanha e pode editar.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-019 | Criar ETP a partir de template com importação do DFD | P0 | M | US-014, US-065, US-110 |
| US-020 | Editar seções do ETP com autosave e "não se aplica" justificado | P0 | L | US-015, US-019 |

## Escopo
- Criação do `Etp` (documento `STRUCTURED`) a partir do template vigente, com ou sem importação do DFD.
- Importação: necessidade/justificativa → `NEED_DESCRIPTION`; situação no PCA → `PCA_ALIGNMENT`; itens do DFD → `DocumentItem` do ETP (mesmo `processItemId`).
- Edição de seções de texto com autosave (debounce 1,5 s), concorrência por revisão de seção e "não se aplica" com justificativa ≥ 20 caracteres.
- Navegação lateral com indicação de completude por seção.

## Fora de escopo
- Conteúdo das seções com `render` estruturado (alternativas, itens/estimativas, riscos) — tratado em FT-012/FT-013 e na story de riscos.
- Validação de completude para concluir o ETP e a própria conclusão — FT-014.
- Aprovação formal do ETP — EP-008 (tramitação e aprovação).

## Regras de negócio da feature
- RN-ETP-01 a RN-ETP-09 (criação, importação do DFD, transação única) — US-019.
- RN-ETP-10 a RN-ETP-17 (autosave, "não se aplica", seções estruturadas somente leitura nesta tela, auditoria coalescida) — US-020.

## Telas
- SCR-008 — ETP (editor por seções) (`/processos/[id]/etp/[etpId]`)

## Endpoints
- ETP-01 `GET /processes/{id}/etps` — listar ETPs do processo
- ETP-02 `POST /processes/{id}/etps` — criar ETP (com importação opcional)
- ETP-03 `GET /etps/{id}` — detalhe do ETP
- DOC-01 `GET /processes/{id}/documents` — listar documentos do processo
- DOC-03 `GET /documents/{id}` — detalhe do documento
- DOC-05 `PUT /documents/{id}/sections/{sectionKey}` — salvar seção (autosave)
- DOC-08 `GET /documents/{id}/validation` — pendências (leitura informativa nesta feature)

## Entidades
- `Etp` — cabeçalho tipado (dono desta feature)
- `Document`/`DocumentVersion` — ciclo de vida e versionamento (EP-011)
- `DocumentItem` — itens herdados do DFD (preenchidos em FT-013)

## Eventos
- `ETPCreated` (`DocumentCreated` do tipo ETP) — na criação (US-019)

## Permissões
- `ETP_CREATE` — criar o ETP
- `ETP_UPDATE` — editar seções

## Dependências
- Stories: US-014 (DFD — fonte da importação), US-065 (ciclo de vida do documento), US-110 (templates semeados), US-015 (padrão de autosave estabelecido no DFD).
- Decisões: DEC-016, DEC-017, DEC-018, DEC-019, DEC-056, DEC-182.

## Critérios de aceite da feature
```gherkin
Feature: Elaboração do ETP
  Scenario: Criar o ETP importando o DFD e editar uma seção
    Given que o processo tem um DFD "FINALIZED" com itens e situação no PCA definida
    When o usuário criar o ETP com "importFromDfd: true"
    Then o ETP deve nascer com "NEED_DESCRIPTION" e "PCA_ALIGNMENT" preenchidas e os itens do DFD replicados
    When o usuário editar a seção "REQUIREMENTS" e aguardar o autosave
    Then a seção deve ficar "FILLED" com a indicação "Salvo às HH:mm"
```

## Métricas de sucesso
- 100% dos ETPs criados a partir de um DFD finalizado reaproveitam necessidade, PCA e itens sem reentrada manual.
- Nenhuma perda de conteúdo reportada por falha de autosave em produção.

## Riscos
- Template do tipo ETP mal configurado (seções ausentes) — mitigado pela biblioteca padrão semeada (US-110).
- Conflito de edição simultânea em uma seção — mitigado pela revisão por seção e diálogo de resolução (DEC-182).

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
