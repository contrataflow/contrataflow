---
id: FT-078
title: "Minuta do edital e do contrato"
epic: EP-027
mvp: 2
priority: P0
stories: [US-163, US-164, US-165, US-166, US-167, US-168]
status: Especificada
---

# FT-078 — Minuta do edital e do contrato

## Título
Minuta do edital e do contrato

## Épico
EP-027 — Edital

## Descrição
`Tender` com cabeçalho tipado, importação do TR, lotes, matriz de riscos (art. 22), minuta do contrato e conclusão (DEC-201). A pessoa de Licitações cria a minuta dentro do processo: o sistema cria o `Tender` (1:1 com o processo) e o documento `EDITAL` a partir do template do órgão, já com modalidade, critério de julgamento, modo de disputa, regime de execução, adjudicação, benefício a pequenas empresas, forma eletrônica, prazos, garantia e exigências de habilitação.

A importação traz do TR itens, critérios e condições (`importMappings`, como o TR importa do ETP) e registra a versão de origem. Os lotes agrupam `ProcessItem` e, com adjudicação por lote, devem cobrir todos os itens. A matriz de alocação de riscos nasce do mapa de riscos quando é exigida (art. 22, § 3º). A `MINUTA_CONTRATO` é um segundo documento do `Tender`. Concluir a minuta valida a completude e finaliza os dois documentos, deixando-os prontos para o Jurídico; a aprovação é a etapa `AUTORIZACAO_LICITACAO`.

**Só a minuta:** número do edital, publicação e `PUBLISHED` ficam para o MVP 3.

## Valor para o usuário e para o órgão
- O edital nasce coerente com o TR, sem redigitar itens, critérios e condições.
- O cabeçalho tipado impede minuta incompleta (critério, modalidade, lotes e matriz).
- Menos devoluções do Jurídico por divergência entre edital, TR e mapa de riscos.

## Personas
- Licitações (`LICITACOES`) — elabora e conclui.
- Planejamento (`PLANEJAMENTO`) e Compras (`COMPRAS`) — conferem a fidelidade ao TR.
- Consultoria externa (`CONSULTOR_EXTERNO`) — edita quando participante (`TENDER_UPDATE`).
- Jurídico (`JURIDICO`) e autoridade (`AUTORIDADE_COMPETENTE`) — leem as versões concluídas.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-163 ⏳ | Criar a minuta do edital com cabeçalho tipado | P0 | M | US-039, US-065, US-110 |
| US-164 ⏳ | Importar itens, critérios e condições do TR para o edital | P0 | M | US-037, US-038, US-163 |
| US-165 ⏳ | Organizar os lotes do edital | P0 | M | US-006, US-163 |
| US-166 ⏳ | Matriz de alocação de riscos do edital | P1 | M | US-035, US-163 |
| US-167 ⏳ | Elaborar a minuta do contrato | P0 | M | US-038, US-163 |
| US-168 ⏳ | Concluir a minuta do edital | P0 | M | US-129, US-164, US-165, US-167 |

## Escopo
- Criar o `Tender` e o documento `EDITAL` com os defaults do processo (modalidade, registro de preços, sigilo do orçamento) e cabeçalho tipado.
- Importar do TR (itens, critérios, condições) por seção, com aviso quando o TR ganha versão nova e reimportação seletiva.
- Lotes (`TenderLot`, `TenderLotItem`): criar a partir de `ProcessItem.lotNumber`/`lotName`, mover itens, regras de cobertura.
- Matriz de alocação de riscos: vincular riscos do mapa ou riscos próprios, alocação, justificativa, mitigação e reflexo no equilíbrio econômico-financeiro.
- Minuta do contrato (`MINUTA_CONTRATO`), com template e importação de vigência, garantia e obrigações do TR.
- Conclusão: completude, finalização dos documentos e eventos; edição restrita ao ciclo de vida do documento (POL-02).
- Aba SCR-021 no processo.

## Fora de escopo
- Rascunho por IA (FT-079).
- Número do edital, publicação, impugnações e sessão pública (MVP 3 em diante).
- Parecer jurídico sobre a minuta (EP-025) e a aprovação do edital (etapa `AUTORIZACAO_LICITACAO`).
- Assinatura eletrônica (MVP 3).

## Regras de negócio da feature
- RN-TND-01 — Há um só `Tender` por processo, 1:1 com o documento `EDITAL`; o edital não admite múltiplos documentos por processo (DEC-201).
- RN-TND-02 — A criação herda do processo modalidade, registro de preços e sigilo do orçamento (`estimatedValueDisclosed = NOT isBudgetConfidential`) (DEC-201, art. 24).
- RN-TND-03 — `disputeMode` é obrigatório para pregão e concorrência e `executionRegime` para serviços e obras; forma não eletrônica exige justificativa (DEC-201).
- RN-TND-04 — A importação do TR é seletiva por seção, registra a versão do TR e a data (`importedFromTermVersionId`, `importedAt`) e nunca altera o TR (DEC-201).
- RN-TND-05 — Um item pertence a um só lote; com `awardType = BY_LOT` os lotes devem cobrir todos os itens do processo (DEC-201).
- RN-TND-06 — A matriz de riscos é obrigatória quando `riskMatrixRequired` (hipóteses do art. 22, § 3º ou valor acima de `tender.riskMatrixValueThreshold`) e deve estar completa para concluir (DEC-201).
- RN-TND-07 — A alocação de cada risco registra a parte que assume (`CONTRACTING_PARTY`, `CONTRACTOR`, `SHARED`) e a justificativa; riscos do mapa entram com o título congelado (DEC-201).
- RN-TND-08 — A `MINUTA_CONTRATO` é gerada a partir de template e importa do TR; o `Tender` aponta para ela (DEC-201).
- RN-TND-09 — Concluir exige critério de julgamento e modalidade preenchidos, cobertura de lotes e matriz completa quando exigida (`TypedDocumentModule.validateCompleteness`); a conclusão não aprova nada (DEC-201).
- RN-TND-10 — A edição segue o ciclo de vida do documento (DEC-018) e a POL-02 com `TENDER_UPDATE`, apenas em `DRAFT` ou `RETURNED` para o colaborador; valores seguem o sigilo do orçamento (DEC-030).

## Telas
- SCR-021 — Edital (minuta do edital e do contrato) (`/processos/[id]/edital/[tenderId]`).

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `POST /processes/{id}/tender` — criar a minuta (`Tender` + `EDITAL`).
- `GET /processes/{id}/tender` — ler a minuta vigente do processo.
- `PATCH /tenders/{id}` — editar o cabeçalho tipado.
- `POST /tenders/{id}/import-term` — importar do TR (seleção de seções).
- `PUT /tenders/{id}/lots` — gerenciar lotes e a distribuição dos itens.
- `PUT /tenders/{id}/risk-allocations` — gerenciar a matriz de alocação de riscos.
- `POST /tenders/{id}/contract-draft` — criar a `MINUTA_CONTRATO`.
- `POST /tenders/{id}/conclude` — concluir a minuta (finaliza os documentos).
- `POST /documents/{id}/ai-apply` (DOC-26, MVP 1) — aplicar seções geradas, quando a FT-079 estiver ativa.

## Entidades
- `Tender`, `TenderLot`, `TenderLotItem`, `TenderRiskAllocation` — dono `tender`.
- `Document` `EDITAL` e `MINUTA_CONTRATO` e `DocumentVersion` — consumidas.
- `ProcessItem`, `Risk` e a versão do TR — consumidas (leitura).
- `TenantSetting` `tender.riskMatrixValueThreshold` — configuração.

## Eventos
- `TenderCreated` — criação da minuta.
- `TenderUpdated` — cabeçalho editado.
- `TenderImportedFromTerm` — importação do TR.
- `TenderLotsChanged` — lotes alterados.
- `TenderRiskAllocationChanged` — matriz alterada.
- `DocumentFinalized` (`EDITAL`, especializado `TenderDraftCompleted`; e `MINUTA_CONTRATO`) — conclusão.

## Permissões
- `TENDER_CREATE` — criar a minuta e a `MINUTA_CONTRATO`.
- `TENDER_UPDATE` — cabeçalho, importação, lotes, matriz e seções (POL-02).
- `TENDER_SUBMIT` — concluir (finalizar os documentos).
- `PROCESS_VIEW` — leitura.

## Dependências
- US-039 (TR validado e concluído, origem da importação), US-037 e US-038 (TR: dados importados do ETP, itens e condições), US-065 e US-110 (ciclo de vida do documento e templates), US-006 (itens do processo), US-035 (mapa de riscos emitido), US-129 (`RuleContext` v2, que expõe `tender.*` à regra de saída da etapa).
- DEC-201; EP-021 (etapa `MINUTA_EDITAL` e `RuleContext` v2 com `tender.*`).

## Critérios de aceite da feature
```gherkin
Feature: Minuta do edital e do contrato
  Scenario: Da importação do TR à conclusão da minuta
    Given o processo "0012/2026" com TR aprovado e a etapa "MINUTA_EDITAL" ativa
    When "Lia" (Licitações) criar a minuta, importar itens, critérios e condições do TR e organizar os itens em dois lotes
    And preencher a matriz de alocação de riscos exigida e elaborar a minuta do contrato
    And concluir a minuta
    Then o edital e a minuta do contrato devem ficar finalizados e vinculados à versão do TR importada
    And a timeline deve registrar a criação, a importação e a conclusão
    And a regra de saída da etapa deve ser satisfeita

  Scenario: Minuta incompleta não conclui
    Given uma minuta com adjudicação por lote e um item sem lote
    When "Lia" tentar concluir
    Then o sistema deve recusar e indicar o item sem lote
```

## Métricas de sucesso
- Tempo de elaboração da minuta ≤ 4 dias úteis.
- ≥ 90% das minutas criadas com importação do TR.
- Devoluções do Jurídico por divergência entre edital e TR reduzidas em ≥ 40%.

## Riscos
- O TR muda depois da importação — a versão de origem fica registrada e há aviso com reimportação seletiva.
- Matriz de riscos tratada como formalidade — completude exigida quando `riskMatrixRequired`.
- Valor sigiloso exposto no edital — `estimatedValueDisclosed` conforme o art. 24 e POL-09.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
