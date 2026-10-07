---
id: FT-024
title: "Elaboração do TR"
epic: EP-006
mvp: 1
priority: P0
stories: [US-036]
status: Especificada
---

# FT-024 — Elaboração do TR

## Título
Elaboração do TR

## Épico
EP-006 — Termo de Referência

## Descrição
Permite criar o Termo de Referência (TR) a partir do template padrão do órgão e redigi-lo seção por seção, com salvamento automático, orientação legal por seção e indicador de completude. A criação gera, em uma única transação, o `Document` do tipo `TR` (numerado, em `DRAFT`, com a versão do template fixada) e o cabeçalho tipado `TermOfReference`. É a base documental sobre a qual as demais features do épico — importação do ETP, itens e condições, validação e conclusão — atuam.

## Valor para o usuário e para o órgão
- Elimina o documento em branco: todas as seções do art. 6º, XXIII, da Lei 14.133/2021 já vêm no template, com orientação de preenchimento.
- Salvamento automático por seção evita perda de trabalho e reduz o medo de "perder o que já foi digitado".
- Numeração e versionamento automáticos dão rastreabilidade desde o primeiro rascunho.

## Personas
- Planejamento (`PLANEJAMENTO`) — redator principal do TR.
- Compras (`COMPRAS`), Gestor de contratações (`GESTOR_CONTRATACOES`) — redigem em processos sob sua custódia ou escopo.
- Área requisitante (`REQUISITANTE`) — redige quando custodia o processo.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-036 | Criar TR e editar suas seções | P0 | L | US-015, US-065, US-110 |

## Escopo
- Criação do `Document` tipo `TR` a partir do template ativo (padrão do tipo ou informado).
- Editor por seções (navegação lateral, estado e obrigatoriedade de cada uma) com autosave (reaproveita US-015/DOC-05).
- Painel "Dados do TR": objeto (`objectDefinition`) e valor estimado (`estimatedTotalValue`, origem `PRICE_RESEARCH`/`MANUAL`).
- Indicador de completude das seções do template.

## Fora de escopo
- Condições contratuais tipadas (vigência, prazos, garantias, critério de julgamento, adjudicação) e itens — tratados em FT-026.
- Importação de dados do ETP — tratada em FT-025.
- Validação final de completude específica do TR e conclusão do documento — tratadas em FT-027.

## Regras de negócio da feature
- Um TR não cancelado por processo (`singletonKey`); nova criação com um já existente → 409 `DOCUMENT_ALREADY_EXISTS` (RN-TR-01).
- O documento fixa a versão publicada do template no momento da criação; versões posteriores não o alteram (RN-TR-03).
- O valor estimado nasce de `PriceResearch` finalizada/aprovada do processo, quando existir, ou é informado manualmente com justificativa; a importação do ETP (FT-025) é uma terceira origem (RN-TR-07/RN-TR-08).
- Autosave por seção com controle de revisão; conflito → 412 `SECTION_REVISION_CONFLICT` (RN-TR-11).
- Completude exibida usa o mesmo serviço da validação final (DOC-08), para nunca divergir entre tela e conclusão (RN-TR-13).

## Telas
- SCR-012 — TR (editor) (`/processos/[id]/tr/[termId]`)

## Endpoints
- `TRM-01` `GET /processes/{id}/terms` — lista o(s) TR do processo.
- `TRM-02` `POST /processes/{id}/terms` — cria o TR a partir do template.
- `TRM-03` `GET /terms/{id}` — detalha o TR (cabeçalho + seções).
- `DOC-05` `PUT /documents/{id}/sections/{sectionKey}` — autosave de seção.
- `DOC-08` `GET /documents/{id}/validation` — completude (reaproveitado por FT-027).
- `DOC-20` `POST /documents/{id}/preview` — pré-visualização em PDF.
- `TPL-01` `GET /templates` — lista templates ativos do tipo `TR`.

## Entidades
- `TermOfReference` — cabeçalho tipado do TR (dono desta feature).
- `Document` / `DocumentVersion` — ciclo de vida, numeração e versionamento (dono do módulo `document`).
- `DocumentTemplateVersion` — seções, `fieldConfig` e layout do template (consumida).

## Eventos
- `DocumentCreated` — na criação do TR.

## Permissões
- `TERM_CREATE` — criar o TR.
- `TERM_UPDATE` — editar seções e o painel "Dados do TR".
- `PROCESS_VIEW_CONFIDENTIAL_BUDGET` — ver o valor estimado quando o orçamento for sigiloso (POL-09).

## Dependências
- **Stories:** US-015 (editor por seções e autosave), US-065 (ciclo de vida do documento), US-110 (biblioteca de templates padrão), US-108 (padrão do tipo), US-032 (pesquisa de preços concluída).
- **Decisões/ADRs:** DEC-015, DEC-017, DEC-018, DEC-023, DEC-028, DEC-030, DEC-032, DEC-055, DEC-056, DEC-182; ADR-006.
- **Features:** habilita FT-025, FT-026 e FT-027.

## Critérios de aceite da feature
```gherkin
Feature: Elaboração do TR
  Scenario: Criar o TR e preencher as seções principais
    Given que o processo "0012/2026" não tem TR
    And existe um template publicado e padrão para o tipo "TR"
    When "Carla" criar o TR a partir do template padrão
    Then o TR deve nascer em "DRAFT", numerado e com a versão do template fixada
    When "Carla" preencher a seção "OBJECT" e aguardar o autosave
    Then a seção deve ficar marcada como "FILLED" e o indicador de completude deve ser atualizado
```

## Métricas de sucesso
- 100% dos TRs criados a partir de um template publicado, sem erro de seção ausente.
- Tempo médio até o primeiro salvamento de seção ≤ 1 minuto após a criação.

## Riscos
- Redator não entende qual seção preencher primeiro — mitigado por `helpText`/`legalBasis` por seção e indicador de completude sempre visível.
- Perda de trabalho por falha de rede — mitigado pelo rascunho local (IndexedDB) do autosave (DEC-182).

## Definition of Done da feature
- [ ] US-036 concluída e aceita (critérios de aceite Gherkin passando)
- [ ] Jornada E2E "criar TR → preencher seção → ver completude" automatizada
- [ ] Documentação (este card e story-036) atualizada
