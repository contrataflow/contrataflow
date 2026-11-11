---
id: FT-070
title: "Vínculo e reconciliação"
epic: EP-023
mvp: 2
priority: P1
stories: [US-142, US-143]
status: Especificada
---

# FT-070 — Vínculo e reconciliação

## Título
Vínculo e reconciliação

## Épico
EP-023 — PCA

## Descrição
Liga o DFD e o processo a um item do plano aprovado do exercício por chave estrangeira (`pcaItemId`, FK composta com o tenant). A pessoa escolhe o item num seletor (`/pca-items/lookup`) ao registrar o DFD ou o processo; o vínculo do DFD é propagado ao processo, e `pcaYear` e `pcaItemCode` são copiados do item, mantendo o histórico textual (US-142).

Os processos e DFDs do MVP 1 só têm a referência textual (`pcaYear` + `pcaItemCode`). Depois do cadastro ou da importação do plano, e quando ele é aprovado ou revisado, o job de reconciliação tenta resolver cada referência para um item do plano aprovado. O resultado vira o relatório de reconciliação (`LINKED`, `UNRESOLVED`, `AMBIGUOUS`, `SKIPPED`), e o planejamento concilia manualmente, com candidatos sugeridos, o que ficou pendente (US-143). A situação do vínculo aparece em `pcaLinkStatus`.

## Valor para o usuário e para o órgão
- Cada demanda aponta para o item exato do plano, sem digitar código nem ano à mão.
- O legado do MVP 1 é aproveitado: o órgão não perde as referências já registradas.
- O relatório mostra, item a item, o que foi ligado e o que exige decisão humana.

## Personas
- Área requisitante (`REQUISITANTE`) — escolhe o item no DFD e no processo.
- Planejamento (`PLANEJAMENTO`) — dispara a reconciliação e concilia manualmente.
- Auditor (`AUDITOR`) — consulta o relatório de reconciliação.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-142 | Vincular DFD e processo a item do PCA | P1 | M | US-005, US-014, US-140 |
| US-143 | Reconciliar as referências textuais ao PCA e conciliar manualmente | P1 | L | US-083, US-142 |

## Escopo
- Seletor `/pca-items/lookup` (código, objeto e secretaria dos itens do plano aprovado do órgão do processo).
- Escolha do item no DFD e no processo; propagação DFD para processo; `pcaStatus = PLANNED`, cópia de `pcaYear` e `pcaItemCode` e `pcaLinkStatus = LINKED`.
- Situação do vínculo em `Process` e `Dfd` (`NOT_APPLICABLE`, `PENDING`, `LINKED`, `UNRESOLVED`, `AMBIGUOUS`).
- Job de reconciliação por plano aprovado, com gatilhos `PCA_APPROVED`, `MANUAL` e `REVISION` e execução única por plano por vez.
- Relatório (`PcaReconciliationRun` e `PcaReconciliationEntry`) com filtros por resultado, candidatos e totais.
- Conciliação manual assistida: escolher o item, ou marcar sem item; registro de quem e quando.
- Reapontamento por `code` na revisão do plano; item sem correspondente mantém o vínculo e entra como `UNRESOLVED`.
- Opção `pca.requireLinkForPlanned`: DFD `PLANNED` só conclui com `pcaItemId` quando houver plano aprovado do exercício.

## Fora de escopo
- Elaboração, aprovação e revisão do plano (FT-068, FT-069).
- Acompanhamento da execução e exportação (FT-071).
- Reconciliação por similaridade totalmente automática: o sistema sugere candidatos, a decisão é humana.
- Vínculo de um processo a mais de um item do plano.

## Regras de negócio da feature
- RN-PCA-15 — O vínculo é `Process.pcaItemId` e `Dfd.pcaItemId` (FK composta com o tenant); os campos textuais continuam como histórico (DEC-029, DEC-197).
- RN-PCA-16 — A seleção exige plano `APPROVED` do órgão do processo e do exercício; com o plano em elaboração o DFD guarda só a referência textual e `pcaLinkStatus = PENDING` (DEC-197).
- RN-PCA-17 — Quando `pcaItemId` está preenchido, `pcaStatus` é `PLANNED` e `pcaLinkStatus` é `LINKED`; o inverso também vale (DEC-029).
- RN-PCA-18 — O seletor devolve só código, objeto e secretaria dos itens do plano aprovado do órgão do processo a quem pode editar o DFD ou o processo, sem exigir `PCA_VIEW`; não devolve valores (DEC-197).
- RN-PCA-19 — A reconciliação resolve `pcaYear` + `pcaItemCode` para o item de mesmo `code` no plano aprovado do exercício; resolve com um candidato: `LINKED`; com vários: `AMBIGUOUS`; sem nenhum: `UNRESOLVED` (DEC-197).
- RN-PCA-20 — Só uma execução `RUNNING` por plano; o job é idempotente e reentrante, e não altera processos fora do escopo de visibilidade de quem concilia manualmente (DEC-197).
- RN-PCA-21 — A conciliação manual exige `PCA_RECONCILE`, registra `resolvedById` e `resolvedAt` e atualiza o `pcaLinkStatus` do alvo; a referência textual original é preservada (DEC-197).

## Telas
- SCR-018 — PCA: aba de reconciliação (`/pca/[pcaId]`).
- SCR-005 — Novo processo e SCR-007 — DFD: seletor do item.
- SCR-006 — Detalhe do processo: item vinculado e situação do vínculo.

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `GET /pca-items/lookup` — seletor de itens do plano aprovado (rota já citada no modelo).
- `PATCH /dfds/{id}` e `PATCH /processes/{id}` — estendidos com `pcaItemId` (DFD-04 e PRC-05 do MVP 1).
- `POST /pca/{id}/reconciliations` — disparar a reconciliação manual.
- `GET /pca/{id}/reconciliations` — listar execuções.
- `GET /pca/{id}/reconciliations/{runId}/entries` — relatório com filtro por resultado.
- `POST /pca-reconciliation-entries/{entryId}/conciliate` — conciliar manualmente.

## Entidades
- `Process` e `Dfd` — `pcaItemId`, `pcaLinkStatus`.
- `PcaItem` — alvo do vínculo.
- `PcaReconciliationRun` e `PcaReconciliationEntry` — execução e relatório.

## Eventos
- `PcaReconciliationCompleted` — término da execução, com `linkedCount`, `unresolvedCount` e `ambiguousCount` (notifica o planejamento).
- `PcaReferenceConciliated` — conciliação manual.
- `ProcessUpdated` e atualização do DFD — quando o vínculo é definido ou alterado.

## Permissões
- `DFD_UPDATE` e `PROCESS_UPDATE` — escolher o item (seletor implícito).
- `PCA_RECONCILE` — disparar e conciliar manualmente.
- `PCA_VIEW` — ler o relatório de reconciliação.

## Dependências
- FT-069 (plano aprovado) e a porta `PcaLinkTarget` nos módulos `process` e `dfd`.
- US-005 e US-014 (edição de processo e DFD) e US-083 (processamento assíncrono).
- DEC-029 (campos textuais do MVP 1).

## Critérios de aceite da feature
```gherkin
Feature: Vínculo e reconciliação do PCA
  Scenario: Reconciliar as referências do MVP 1 e conciliar o que sobrou
    Given que o processo "0045/2026" tem "pcaYear" 2026 e "pcaItemCode" "PCA-017" apenas em texto
    And o processo "0051/2026" tem "pcaItemCode" "PCA-XYZ" sem item correspondente
    When o plano "PCA 2026" for aprovado
    Then o processo "0045/2026" deve ficar "LINKED" ao item "PCA-017"
    And o processo "0051/2026" deve aparecer no relatório de reconciliação como "UNRESOLVED"
    When "Helena", com "PCA_RECONCILE", conciliar o processo "0051/2026" com o item "PCA-021"
    Then o processo "0051/2026" deve ficar "LINKED" ao item "PCA-021" com a referência textual original preservada
    And a conciliação deve constar na auditoria com autor e data
```

## Métricas de sucesso
- ≥ 85% das referências textuais resolvidas automaticamente no primeiro plano aprovado.
- 100% dos pendentes conciliados ou justificados em até 30 dias.
- ≥ 90% dos novos DFDs planejados já nascem vinculados.

## Riscos
- Códigos textuais inconsistentes no legado — relatório, candidatos por similaridade e conciliação manual (roadmap §4.10).
- Reconciliação tocando muitos processos de uma vez — execução em lotes, idempotente, com a unicidade de execução por plano.
- Vínculo com item de plano de outro órgão — FK composta com o tenant e verificação do órgão do processo.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
