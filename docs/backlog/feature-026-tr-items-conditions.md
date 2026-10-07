---
id: FT-026
title: "Itens e condições"
epic: EP-006
mvp: 1
priority: P0
stories: [US-038]
status: Especificada
---

# FT-026 — Itens e condições

## Título
Itens e condições

## Épico
EP-006 — Termo de Referência

## Descrição
Permite selecionar os itens da contratação para o TR — com quantidade, especificação e critérios de aceitação — e preencher as condições contratuais tipadas exigidas pela Lei 14.133/2021: vigência, prazo de execução/entrega, local de entrega, prazo de pagamento, garantias (do objeto e contratual), subcontratação, critério de julgamento e tipo de adjudicação.

## Valor para o usuário e para o órgão
- Reúne, de forma estruturada e validável, os elementos contratuais que hoje ficam dispersos em texto livre.
- Impede, na própria API, condições fora dos limites legais (garantia contratual acima de 10%, prazos fora de faixa).
- Reaproveita o catálogo de itens do processo, evitando redigitar descrição e unidade.

## Personas
- Planejamento (`PLANEJAMENTO`), Compras (`COMPRAS`) — especificam itens e condições.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-038 | Especificar itens e condições contratuais do TR | P0 | M | US-006, US-036 |

## Escopo
- Inclusão/remoção de itens do processo no TR, com quantidade, especificação e critérios de aceitação em rich text.
- Reordenação dos itens (afeta exibição e impressão).
- Formulário de condições contratuais tipadas do cabeçalho do TR.

## Fora de escopo
- Cadastro e exclusão dos itens do processo — tratados em US-006 (EP-001).
- Importação de quantidades a partir do ETP — tratada em FT-025 (esta feature cobre o ajuste manual, antes ou depois da importação).
- Validação de completude e conclusão do TR — tratadas em FT-027.

## Regras de negócio da feature
- Os itens do TR espelham o catálogo de itens do processo; incluir/remover no TR não altera o item do processo (RN-TR-25).
- Quantidade obrigatória (> 0) por item incluído; especificação e critérios de aceitação em rich text (RN-TR-26).
- Vigência do contrato entre 1 e 120 meses; prazo de pagamento entre 1 e 90 dias (RN-TR-28/RN-TR-30).
- Prazo de execução/entrega exige o tipo de contagem (dias úteis ou corridos) em conjunto (RN-TR-29).
- Garantia do objeto entre 0 e 120 meses; garantia contratual entre 0 e 10% (Lei 14.133, arts. 96–98) (RN-TR-31).
- Critério de julgamento (catálogo `JUDGMENT_CRITERION`, art. 33) e tipo de adjudicação (`BY_ITEM`/`BY_LOT`/`GLOBAL`) (RN-TR-32).
- Alterar itens ou condições é ajuste de rascunho: não cria nova versão do documento (RN-TR-33).

## Telas
- SCR-012 — TR (editor), painéis "Itens" e "Condições contratuais" (`/processos/[id]/tr/[termId]`)

## Endpoints
- `TRM-04` `PATCH /terms/{id}` — condições contratuais tipadas.
- `DOC-06` `GET /documents/{id}/items` — lista os itens já incluídos no TR.
- `DOC-07` `PUT /documents/{id}/items` — substitui a coleção de itens do TR.
- `PRC-13` `GET /processes/{id}/items` — itens ativos do processo (origem da seleção).
- `CAT-01` `GET /catalogs/{catalogType}/items` — opções do catálogo `JUDGMENT_CRITERION`.

## Entidades
- `TermOfReference` — condições contratuais tipadas (dono).
- `DocumentItem` — linha de item no TR (dono — coleção).
- `ProcessItem` — identidade do item no processo (consumida, US-006).
- `CatalogItem` (`JUDGMENT_CRITERION`) — consumida.

## Eventos
- Nenhum evento de domínio; alterações são registradas por auditoria (`document.items_update`, `document.draft_update`).

## Permissões
- `TERM_UPDATE` — editar itens e condições contratuais (POL-02).

## Dependências
- **Stories:** US-006 (itens do processo), US-036 (cria o TR). Indireta: US-104 (catálogo `JUDGMENT_CRITERION`).
- **Decisões/ADRs:** DEC-001, DEC-017, DEC-019, DEC-056, DEC-104; ADR-006.
- **Features:** depende de FT-024; pode seguir FT-025 (ajustando quantidades importadas); habilita FT-027.

## Critérios de aceite da feature
```gherkin
Feature: Itens e condições
  Scenario: Incluir itens e definir as condições contratuais do TR
    Given que o processo tem itens ativos e um TR em "DRAFT"
    When "Carla" incluir os itens com quantidade e especificação
    And "Carla" informar vigência, prazos, garantias, critério de julgamento e tipo de adjudicação
    Then o TR deve salvar os itens e as condições informadas
    And deve gerar registro de auditoria "document.items_update" e "document.draft_update"
```

## Métricas de sucesso
- 100% dos TRs concluídos com ao menos um item com quantidade e especificação.
- 0 condições contratuais gravadas fora dos limites legais (garantia, prazos) — bloqueado na API.

## Riscos
- Garantia contratual informada acima do limite legal — mitigado por validação de faixa na API, não só na interface.
- Confusão entre "item do processo" e "item do TR" — mitigado pela mesma nomenclatura e indicador visual de "incluído no TR".

## Definition of Done da feature
- [ ] US-038 concluída e aceita (critérios de aceite Gherkin passando)
- [ ] Jornada E2E "incluir itens → especificar → definir condições" automatizada
- [ ] Documentação (este card e story-038) atualizada
