---
id: FT-071
title: "Acompanhamento e divulgação"
epic: EP-023
mvp: 2
priority: P1
stories: [US-144, US-145]
status: Especificada
---

# FT-071 — Acompanhamento e divulgação

## Título
Acompanhamento e divulgação

## Épico
EP-023 — PCA

## Descrição
Mostra a execução do plano: para cada item, secretaria e categoria, o valor previsto contra os processos vinculados e a situação do item (`PLANNED`, `IN_PROGRESS`, `CONTRACTED`, `POSTPONED`, `CANCELED`). A situação avança sozinha por eventos de processo (primeiro processo vinculado aberto, processo concluído) e pode ser ajustada manualmente, com motivo, em adiamento e cancelamento (US-144).

A feature também exporta o plano aprovado para divulgação em sítio oficial (art. 12, § 1º), em formato aberto (CSV e XLSX), até a publicação automática do MVP 3. Cada exportação é auditada e registra a data da última divulgação (US-145).

## Valor para o usuário e para o órgão
- O gestor vê, por secretaria e categoria, quanto do plano já virou processo.
- O órgão cumpre a divulgação do plano sem montar planilha manual.
- A execução do plano alimenta os indicadores do EP-028.

## Personas
- Gestor de contratações (`GESTOR_CONTRATACOES`) — acompanha a execução na sua carteira.
- Planejamento (`PLANEJAMENTO`) — ajusta a situação dos itens e exporta.
- Controle interno e auditor (`CONTROLE_INTERNO`, `AUDITOR`) — exportam e conferem.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-144 | Acompanhar a execução do PCA | P1 | M | US-142 |
| US-145 | Exportar o PCA para divulgação | P1 | S | US-083, US-140 |

## Escopo
- Visão de execução por item, secretaria e categoria: valor previsto, processos vinculados (`linkedProcessesCount`), situação e saldo previsto não vinculado.
- Transições automáticas idempotentes por eventos (`process.created`, `process.status_changed.*`): `PLANNED` para `IN_PROGRESS`; `IN_PROGRESS` para `CONTRACTED` (processo `COMPLETED` na versão 2, ou manual).
- Ajuste manual de situação com motivo (`POSTPONED`, `CANCELED`, retorno `POSTPONED` para `PLANNED`), mesmo em plano aprovado.
- Lista dos processos vinculados a cada item, filtrada pela visibilidade de quem consulta.
- Exportação CSV e XLSX do plano aprovado em formato aberto, assíncrona, com anexo `targetType = PCA`; registro de `exportedAt`.

## Fora de escopo
- Publicação automática em sítio oficial ou no PNCP (MVP 3; PEND-16).
- Painéis e tendências de execução do PCA (EP-028).
- Execução financeira do contrato e empenho.
- Comparativo entre exercícios.

## Regras de negócio da feature
- RN-PCA-22 — A execução compara o `plannedValue` do item com os processos vinculados; `linkedProcessesCount` é mantido por consumidor de eventos, idempotente, nunca por soma na leitura (DEC-197).
- RN-PCA-23 — Em plano `APPROVED` ou `SUPERSEDED` só `status`, `statusReason` e `linkedProcessesCount` do item mudam; `POSTPONED` e `CANCELED` exigem motivo (DEC-197).
- RN-PCA-24 — Valores de processo com orçamento sigiloso entram na visão de execução só para quem tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`; os demais veem a contagem sem o valor (POL-09; DEC-030).
- RN-PCA-25 — A lista de processos vinculados respeita a visibilidade do processo (DEC-024); a contagem total do item não revela processos fora do escopo.
- RN-PCA-26 — Só o plano `APPROVED` é exportado para divulgação; exige `PCA_EXPORT`, é auditada (`pca.export`) e atualiza `exportedAt` (DEC-197).

## Telas
- SCR-018 — PCA: aba de execução e ação de exportar (`/pca/[pcaId]`).
- SCR-006 — Detalhe do processo: item do plano vinculado.

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `GET /pca/{id}/execution` — execução por item, secretaria e categoria.
- `GET /pca-items/{itemId}/processes` — processos vinculados ao item.
- `PATCH /pca-items/{itemId}/status` — ajustar a situação do item com motivo.
- `POST /pca/{id}/exports` — solicitar a exportação para divulgação (assíncrono).
- `GET /pca/{id}/exports/{exportId}` — acompanhar e baixar a exportação.

## Entidades
- `PcaItem` — `status`, `statusReason`, `linkedProcessesCount`.
- `Pca` — `exportedAt`.
- `Attachment` (`targetType = PCA`) — arquivo exportado.
- `Process` — origem dos eventos de execução (leitura).

## Eventos
- `PcaItemChanged` (`STATUS_CHANGED`) — mudança automática ou manual de situação.
- Exportação: sem evento de domínio; gera a auditoria `pca.export`.
- Consumidos: `ProcessCreated` e `ProcessStatusChanged` — avançam a situação do item.

## Permissões
- `PCA_VIEW` — consultar a execução (recortada pelo escopo).
- `PCA_MANAGE` — ajustar a situação do item no acompanhamento.
- `PCA_EXPORT` — exportar.
- `PROCESS_VIEW_CONFIDENTIAL_BUDGET` — ver valores sigilosos.

## Dependências
- FT-070 (vínculo) e FT-069 (plano aprovado).
- EP-015 — fila para a exportação; EP-011 — anexos.
- Eventos de processo do MVP 1 e da versão 2 do workflow (`COMPLETED` como fase preparatória concluída).

## Critérios de aceite da feature
```gherkin
Feature: Acompanhamento e divulgação do PCA
  Scenario: Acompanhar a execução e divulgar o plano
    Given que o plano "PCA 2027" está "APPROVED" e o item "PCA-017" tem 2 processos vinculados
    When o primeiro processo vinculado for aberto
    Then o item "PCA-017" deve passar para "IN_PROGRESS"
    And a execução da secretaria deve mostrar o valor previsto e a quantidade de processos vinculados
    When "Helena" adiar o item "PCA-021" informando o motivo
    Then o item deve ficar "POSTPONED" com o motivo registrado
    When "Roberto", com "PCA_EXPORT", exportar o plano para divulgação
    Then o arquivo CSV deve conter os itens do plano aprovado
    And a exportação deve constar na auditoria e a data da última divulgação deve ser atualizada
```

## Métricas de sucesso
- Visão de execução abre em ≤ 2 s (p95) para plano de 500 itens.
- Exportação de 500 itens p95 ≤ 30 s.
- 100% dos itens com processo vinculado em `IN_PROGRESS` ou `CONTRACTED`.

## Riscos
- Contagem divergente por evento duplicado ou perdido — consumidor idempotente e rotina de recontagem por plano.
- Exposição de valor sigiloso na exportação ou na execução — filtro por processo (POL-09) antes de agregar e testes de sigilo.
- Divulgação de plano ainda não aprovado — só `APPROVED` é exportável.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
