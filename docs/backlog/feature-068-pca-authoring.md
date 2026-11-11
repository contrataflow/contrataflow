---
id: FT-068
title: "Elaboração do PCA"
epic: EP-023
mvp: 2
priority: P1
stories: [US-138, US-139]
status: Especificada
---

# FT-068 — Elaboração do PCA

## Título
Elaboração do PCA

## Épico
EP-023 — PCA

## Descrição
Cria o plano de contratações anual do órgão por exercício e mantém os seus itens: secretaria demandante, objeto, categoria, valor previsto, mês previsto, responsável e situação (US-138). Os totais do plano (valor previsto e quantidade de itens) são recalculados a cada alteração.

A pessoa pode digitar os itens ou importá-los de uma planilha CSV/XLSX (US-139). A importação é assíncrona, valida linha por linha, cria ou atualiza itens pelo código estável (`code`) e devolve um relatório com as linhas rejeitadas e o motivo. O plano nasce em `DRAFT`; só um plano por órgão e exercício fica em elaboração por vez. O envio para aprovação é da FT-069.

## Valor para o usuário e para o órgão
- O plano do exercício sai da planilha para a plataforma sem redigitação e com erros apontados por linha.
- Cada item tem código estável, o que permite ligar o plano aos DFDs e às revisões seguintes.
- O planejamento enxerga o total previsto por secretaria e categoria ainda na elaboração.

## Personas
- Planejamento (`PLANEJAMENTO`) — cria o plano, mantém os itens e importa a planilha.
- Gestor de contratações (`GESTOR_CONTRATACOES`) — consulta o plano em elaboração dentro do seu escopo.
- Administrador do órgão (`ADMIN_ORGAO`) — configura o calendário do plano.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-138 | Criar o plano anual e manter os itens do PCA | P1 | L | US-097, US-102, US-104 |
| US-139 | Importar itens do PCA por planilha | P1 | M | US-068, US-083, US-138 |

## Escopo
- Criar o plano (órgão, exercício, título); um plano em elaboração por exercício.
- CRUD de itens com validação (valor previsto >= 0, mês de 1 a 12, categoria ativa do catálogo `PCA_CATEGORY`, secretaria do órgão).
- Totais desnormalizados (`totalPlannedValue`, `itemsCount`) recalculados na mesma transação.
- Importação CSV/XLSX: modelo baixável, validação por linha, criação e atualização por `code`, relatório de rejeições e notificação de término.
- Filtros e busca por secretaria, categoria, mês e situação na SCR-018.
- Exclusão lógica de item em plano `DRAFT`, com bloqueio quando o item está em uso.
- Alerta de prazo do calendário `pca.elaborationDeadline`.

## Fora de escopo
- Envio para aprovação e decisão (FT-069) e revisão do plano aprovado (US-141).
- Vínculo com DFD e processo (FT-070); acompanhamento e exportação (FT-071).
- Importação de PCA publicado no PNCP ou de outros sistemas.
- Acesso de `CONSULTOR_EXTERNO` ao plano (L-07).

## Regras de negócio da feature
- RN-PCA-01 — O plano é do órgão e do exercício; `organizationId`, `year` e `versionNumber` são imutáveis. Há no máximo um plano em `DRAFT` ou `AWAITING_APPROVAL` por órgão e exercício (DEC-197).
- RN-PCA-02 — O `code` do item é único no plano, normalizado (sem espaços nas pontas, maiúsculas) e estável entre versões (DEC-197).
- RN-PCA-03 — Item exige secretaria, objeto (10 a 2.000 caracteres), categoria ativa, valor previsto >= 0 e mês de 1 a 12; classe de catálogo (CATMAT/CATSER) exige o sistema de catálogo informado (DEC-197).
- RN-PCA-04 — `PCA_MANAGE` com escopo de unidade edita só itens da própria secretaria; criar o plano e importar exigem escopo `ORGANIZATION` ou `TENANT` (DEC-197).
- RN-PCA-05 — A importação valida cada linha de forma independente: linhas válidas entram, as inválidas vão ao relatório com a linha de origem; reimportar o mesmo `code` atualiza o item em vez de duplicar (DEC-197).
- RN-PCA-06 — Plano e itens de tenant são isolados por `tenant_id`; item vinculado a DFD ou processo não é excluído (`PCA_ITEM_IN_USE`) (DEC-197).
- RN-PCA-07 — `PcaItem.plannedValue` de item vinculado a processo com orçamento sigiloso é mascarado na visão por processo para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (DEC-030).
- RN-PCA-08 — `CONSULTOR_EXTERNO` não acessa o plano nem os itens (DEC-197, L-07).

## Telas
- SCR-018 — PCA: plano e itens (`/pca` e `/pca/[pcaId]`).
- SCR-041 — Configurações gerais: calendário do plano.

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `GET /pca` — listar planos do órgão por exercício e situação.
- `POST /pca` — criar o plano do exercício.
- `GET /pca/{id}` — detalhar o plano com totais.
- `PATCH /pca/{id}` — alterar o título do plano em `DRAFT`.
- `GET /pca/{id}/items` — listar itens com filtros.
- `POST /pca/{id}/items` — criar item.
- `PATCH /pca-items/{itemId}` — editar item.
- `DELETE /pca-items/{itemId}` — excluir item em plano `DRAFT`.
- `GET /pca/import-template` — baixar o modelo de planilha.
- `POST /pca/{id}/import` — importar planilha (assíncrono).
- `GET /pca/{id}/imports/{importId}` — acompanhar a importação e o relatório de rejeições.

## Entidades
- `Pca` — plano por órgão e exercício, com totais.
- `PcaItem` — item do plano.
- `Attachment` (`targetType = PCA`) — planilha importada.
- `CatalogItem` (`PCA_CATEGORY`, `CONTRACTING_TYPE`, `UNIT_OF_MEASURE`), `Department`, `User`.

## Eventos
- `PcaCreated` — criação do plano (versão 1).
- `PcaItemChanged` — criação, edição, situação e exclusão de item.
- `PcaImported` — término da importação, com `rowsRead`, `itemsCreated`, `itemsUpdated`, `rowsRejected` (notifica o autor: `PCA_IMPORT_FINISHED`).

## Permissões
- `PCA_VIEW` — listar e detalhar.
- `PCA_MANAGE` — criar plano, editar itens e importar (POL-22).

## Dependências
- EP-016 e EP-017 (permissões e configurações) e US-097, US-102 e US-104 do MVP 1.
- US-068 (anexos) e US-083 (fila e processamento assíncrono) para a importação.
- Catálogos `PCA_CATEGORY` semeados (DEC-197).

## Critérios de aceite da feature
```gherkin
Feature: Elaboração do PCA do exercício
  Scenario: Importar a planilha, corrigir as rejeições e fechar o rascunho
    Given que "Helena" tem "PCA_MANAGE" com escopo "ORGANIZATION" no órgão "Prefeitura Alfa"
    When "Helena" criar o plano do exercício 2027 e importar uma planilha com 120 linhas, 4 delas inválidas
    Then o plano "PCA 2027" deve estar em "DRAFT" com 116 itens e o valor previsto total recalculado
    And o relatório de importação deve listar as 4 linhas rejeitadas com número de linha e motivo
    When "Helena" corrigir os dados e reimportar a planilha
    Then os 4 itens devem ser criados e os 116 já existentes atualizados pelo código, sem duplicar
    And "Helena" deve receber a notificação de término da importação
```

## Métricas de sucesso
- ≥ 90% das linhas aceitas na primeira importação.
- Importação de 500 linhas com p95 ≤ 30 s.
- Plano de um órgão pequeno elaborado em até 2 dias de trabalho.

## Riscos
- Leiaute de planilha diferente do modelo — modelo baixável, mensagens por linha e colunas obrigatórias claras; mapeamento fixado no card de API.
- Reimportação sobrescrevendo edições manuais — atualização só dos campos presentes na planilha e auditoria do antes e depois por item.
- Duas pessoas editando o mesmo plano — bloqueio otimista por item e totais recalculados na transação.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
