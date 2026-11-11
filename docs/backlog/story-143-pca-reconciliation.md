---
id: US-143
title: "Reconciliar as referências textuais ao PCA e conciliar manualmente"
epic: EP-023
feature: FT-070
mvp: 2
priority: P1
estimate: L
status: Especificada
depends_on: [US-083, US-142]
modules: [pca, process, dfd, document, access, organization, timeline, notification, audit, platform]
screens: [SCR-018]
endpoints: [PCA-48, PCA-49, PCA-50, PCA-51, PCA-52, PCA-53, PCA-54, PCA-55, PCA-56, PCA-57]
permissions: [PCA_RECONCILE, PCA_VIEW, PCA_EXPORT]
events: [PcaReconciliationCompleted, PcaReferenceConciliated, ProcessPcaItemLinked, DfdPcaItemLinked, PcaStatusChanged]
---

# US-143 — Reconciliar as referências textuais ao PCA e conciliar manualmente

## Título
Reconciliar as referências textuais do MVP 1 com os itens do plano aprovado e conciliar manualmente o que sobrar

## Descrição
**Como** servidor do planejamento (`PLANEJAMENTO`) que recebe o PCA aprovado de um órgão que já tem processos e DFDs do MVP 1, **quero** que o sistema resolva sozinho as referências textuais (`pcaYear` + `pcaItemCode`) para os itens do plano e me entregue um relatório do que não foi resolvido, com sugestões, **para** vincular o legado ao plano sem redigitação, decidir o que é ambíguo ou inexistente com justificativa e ter o rastro de quem decidiu o quê.

A story entrega o job assíncrono `pca-reconcile` (idempotente, em lotes, um alvo por transação), disparado quando o plano é aprovado (`PCA_APPROVED`), quando uma revisão é aprovada (`REVISION`) e sob demanda (`MANUAL`); o resumo de cada execução (`PcaReconciliationRun`); o **relatório de pendências** (consulta paginada, filtros, exportação CSV); a **conciliação manual assistida** (sugestões por similaridade de código e objeto, confirmar item, marcar "sem item no PCA" com justificativa, em lote); a auditoria por registro, os eventos, a notificação e as métricas. Alcança processos e DFDs **de qualquer situação**, inclusive concluídos e cancelados, e grava apenas o vínculo: não reabre, não move e não altera nada além de `pcaItemId` e `pcaLinkStatus`.

## Contexto
- DEC-197 e DEC-029: o MVP 1 guarda a referência só como texto; o job de reconciliação resolve `pcaYear` + `pcaItemCode` para o `PcaItem` do plano aprovado; o que não resolve mantém o texto e entra no relatório com conciliação manual assistida. Os campos textuais **nunca** são apagados.
- Entidades (entities.md §4.1): `PcaReconciliationRun` (uma `RUNNING` por plano; `trigger` `PCA_APPROVED`/`MANUAL`/`REVISION`; contadores) e `PcaReconciliationEntry` (um registro por alvo examinado, com `outcome`, `resolvedItemId`, `candidateItemIds`, `resolvedById`, `resolvedAt`); enums `PcaReconciliationOutcome`, `PcaReconciliationRunStatus`, `PcaLinkStatus`. entities.md §9 descreve o algoritmo (normalizar; um item ⇒ `LINKED`; nenhum ⇒ `UNRESOLVED` com sugestões; vários ⇒ `AMBIGUOUS`; uma transação por alvo) e §6.1 o reapontamento na revisão.
- Execução: padrão B de queues.md (a execução `RUNNING` é o registro durável; enfileiramento depois do commit; o reconciliador reenfileira órfãos); consumidor `PcaReconciliationScheduler` na fila `maintenance`, assinando `pca.status_changed.approved` (events.md §3); política de retentativas da DEC-163.
- Permissões: `PCA_RECONCILE` (`GESTOR_CONTRATACOES`, `PLANEJAMENTO`), `PCA_VIEW`, `PCA_EXPORT`, POL-22, POL-09, DEC-024 e RN-PCA-20 (a conciliação humana respeita a visibilidade). `CONSULTOR_EXTERNO` não acessa o PCA (L-07).
- Extensão da US-142: o vínculo do job/conciliação usa as mesmas colunas, auditoria e eventos (`via` `RECONCILIATION`/`MANUAL`), mas **preserva o texto** (RN-PCA-265) e **não** passa pelas regras de edição (estado, custódia, saldo).
- KPIs do épico: ≥ 85% resolvidas automaticamente no primeiro plano aprovado; pendentes conciliados ou justificados em até 30 dias.

## Objetivo
Resolver automaticamente, sem intervenção, pelo menos 85% das referências textuais com código existente no plano aprovado; entregar 100% das demais num relatório com motivo, candidatos e idade; permitir conciliá-las uma a uma ou em lote com autoria e justificativa; e garantir que nenhuma reexecução duplique vínculo, evento ou auditoria, que nenhuma falha de um registro derrube o lote e que nenhum processo ou documento mude de situação por causa da reconciliação.

## Persona
- **Principal:** Planejamento (`PLANEJAMENTO`, perfil com `PCA_RECONCILE`) — dispara, acompanha e concilia.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`, também com `PCA_RECONCILE`); Administrador do órgão (`ADMIN_ORGAO`, consulta com `PCA_VIEW`); Auditor (`AUDITOR`) e Controle Interno (`CONTROLE_INTERNO`) — leem o relatório e exportam (`PCA_VIEW` + `PCA_EXPORT`); Sistema — executa o job.
- **Sem acesso:** `CONSULTOR_EXTERNO`.

## Pré-condições
- Plano do órgão e exercício em `APPROVED` (US-140; para `REVISION`, a nova versão aprovada e a anterior `SUPERSEDED`).
- Processos e DFDs com `pcaStatus = PLANNED`, `pcaYear` igual ao ano do plano e `pcaLinkStatus` `PENDING`, `UNRESOLVED` ou `AMBIGUOUS` (colunas e M2-12 da US-142/migração).
- Worker, Redis e fila `maintenance` em operação (US-083); sem Redis o job fica pendente (RN-PCA-284).
- Disparo manual e conciliação: `PCA_RECONCILE` com escopo que cubra o plano (RN-PCA-276).

## Fluxo principal
1. A autoridade aprova o PCA 2026 (US-140). O `PcaStatusChanged` (`pca.status_changed.approved`) chega ao `PcaReconciliationScheduler`, que, em transação, insere a `PcaReconciliationRun` `RUNNING` (`trigger = PCA_APPROVED`, ou `REVISION` quando `versionNumber > 1`) com `ON CONFLICT` na unicidade de execução `RUNNING` por plano, e enfileira o job `pca-reconcile` na fila `maintenance` depois do commit (`jobId` = id da execução).
2. O worker abre o contexto do tenant (`runJob`), confirma que a execução está `RUNNING` e o plano `APPROVED`, e carrega os itens do plano em memória, indexados pelo `code` normalizado.
3. Percorre os alvos em páginas de 200 por chave (`id`), primeiro os processos e depois os DFDs, lidos pela porta `PcaLinkTarget` (RN-PCA-263). Cada alvo é decidido fora da transação (RN-PCA-264 a RN-PCA-267).
4. Para cada alvo, abre **uma transação**: trava o alvo (`FOR UPDATE` pela porta), reconfere que ainda é elegível, grava o resultado (vínculo, se `LINKED`), insere a `PcaReconciliationEntry`, a auditoria e o evento no outbox. Falha de um alvo desfaz só aquele alvo (RN-PCA-269).
5. A cada página, atualiza os contadores da execução e a marca de vida (`updatedAt`); a UI da SCR-018 acompanha o progresso.
6. Ao fim, grava `status = COMPLETED`, `finishedAt`, os totais finais, a auditoria `pca.reconcile` (fase `FINISH`) e publica `PcaReconciliationCompleted`. Havendo `unresolvedCount + ambiguousCount > 0`, notifica quem tem `PCA_RECONCILE` no órgão (`PCA_RECONCILIATION_PENDING`).
7. A planejadora abre SCR-018 › aba "Reconciliação": vê o resumo da execução e a lista de pendências vigentes (`UNRESOLVED` e `AMBIGUOUS`), filtra por tipo, resultado, motivo, secretaria, situação do processo e idade.
8. Ao abrir uma pendência, o painel lateral mostra a referência textual original, o alvo (código, título, situação, secretaria, objeto) e até 5 candidatos com a pontuação de similaridade; ela escolhe o item (ou busca outro) e **Confirma**, ou marca **"Sem item no PCA"** com justificativa.
9. A API, em uma transação: confere permissão e visibilidade, trava o alvo e a entrada, reconfere o estado, grava o vínculo pela porta (`via = MANUAL`) ou o marcador "sem item", atualiza a entrada (`MANUAL`/`SKIPPED`, `resolvedById`, `resolvedAt`), audita (`pca.conciliate` e `process.pca_link`/`dfd.pca_link`) e publica `PcaReferenceConciliated` e `ProcessPcaItemLinked`/`DfdPcaItemLinked`.
10. Para muitas pendências com o mesmo destino (ex.: dezenas de processos com o código "PCA-XYZ"), ela seleciona as linhas e usa **"Conciliar em lote"** (PCA-57), com o mesmo item ou a mesma justificativa; o resultado volta por linha.
11. Para o acompanhamento do prazo de 30 dias, a lista mostra a idade da pendência e o filtro "mais de 30 dias"; o CSV (PCA-53) leva o mesmo recorte.

## Fluxos alternativos
- **FA-01 — Disparo manual (`MANUAL`):** "Executar reconciliação" (PCA-48) com o plano `APPROVED`: responde 202 com a execução `RUNNING`. Já havendo uma `RUNNING` no plano, 409 `PCA_RECONCILIATION_IN_PROGRESS` com `meta.runId` (a UI passa a acompanhar essa).
- **FA-02 — Revisão aprovada (`REVISION`):** além do universo normal, o job percorre os alvos `LINKED` a itens da versão `SUPERSEDED` e os reaponta para o item de mesmo `code` da nova versão (`via = RECONCILIATION`, `previousPcaItemId`); sem correspondente utilizável, mantém o vínculo e registra `UNRESOLVED` na entrada (RN-PCA-266).
- **FA-03 — Código ausente:** `pcaItemCode` nulo ⇒ `UNRESOLVED` com motivo `NO_CODE` e sugestões só por objeto.
- **FA-04 — Item cancelado:** o código existe, mas o item está `CANCELED` ⇒ `UNRESOLVED` com motivo `ITEM_CANCELED` (a planejadora decide).
- **FA-05 — Ambiguidade (defensiva):** mais de um item candidato ao mesmo código ⇒ `AMBIGUOUS` com `candidateItemIds` preenchido; resolve-se escolhendo um deles.
- **FA-06 — Sem item no PCA:** a planejadora declara que a referência não corresponde a nenhum item do plano (justificativa ≥ 20 caracteres). A entrada vira `SKIPPED` e o alvo `NOT_APPLICABLE` (texto preservado); o alvo sai das próximas execuções (RN-PCA-275).
- **FA-07 — Alvo mudou durante a reconciliação:** vinculado por outra via (US-142), passou a `NOT_PLANNED` ou foi descartado entre a leitura e a gravação: o job registra `SKIPPED` (`TARGET_CHANGED`) sem gravar vínculo; a conciliação manual responde 409 `PCA_TARGET_CHANGED`.
- **FA-08 — Falha em um alvo:** rollback só daquele alvo; após 3 tentativas curtas, entrada `SKIPPED` (`PROCESSING_ERROR`) em transação separada; a execução continua (RN-PCA-269).
- **FA-09 — Plano deixou de estar vigente durante a execução:** a revisão foi aprovada no meio do job; a execução termina `FAILED` (`PLAN_SUPERSEDED`) sem tocar mais alvos, e a execução `REVISION` do novo plano assume (RN-PCA-284).
- **FA-10 — Redis ou worker indisponível no disparo:** a execução fica `RUNNING` no banco e o reconciliador `maintenance-reconcile` a reenfileira (RN-PCA-284).
- **FA-11 — Exercício sem plano aprovado:** referências de exercícios sem plano `APPROVED` permanecem `PENDING` e fora do relatório; a UI avisa "Há {n} referências do exercício {ano} aguardando um plano aprovado" (contagem agregada, sem identificar processos).

## Regras de negócio
- **RN-PCA-260** — Gatilhos e execução assíncrona. `PCA_APPROVED` (plano de versão 1 aprovado) e `REVISION` (versão > 1 aprovada) nascem do consumidor `PcaReconciliationScheduler`; `MANUAL`, de PCA-48. Em todos, a `PcaReconciliationRun` `RUNNING` é gravada primeiro e o job `pca-reconcile` é enfileirado **depois do commit** com `jobId` = `runId` (padrão B); o payload tem só `runId` (+ `meta` do contrato de job, DEC-164). O processamento nunca ocorre dentro da requisição HTTP.
- **RN-PCA-261** — Uma execução por plano. A unicidade `(tenant_id, pca_id) WHERE status = 'RUNNING'` vale para os três gatilhos: o disparo `MANUAL` com execução em curso responde 409 `PCA_RECONCILIATION_IN_PROGRESS` (`meta.runId`); o gatilho automático em conflito é *no-op* silencioso (a execução em curso já cobre o plano aprovado).
- **RN-PCA-262** — Plano elegível. O disparo exige plano `APPROVED` do órgão (senão 409 `PCA_NOT_APPROVED`). O job reconfere o plano a cada página: plano `SUPERSEDED`, não `APPROVED` ou excluído ⇒ execução `FAILED` com `errorMessage` (`PLAN_SUPERSEDED`/`PLAN_NOT_APPROVED`), sem novos alvos.
- **RN-PCA-263** — Universo de alvos. Processos e DFDs do `organizationId` do plano, com `pcaStatus = PLANNED`, `pcaYear` = ano do plano e `pcaLinkStatus IN (PENDING, UNRESOLVED, AMBIGUOUS)`, **em qualquer situação** (`DRAFT`, `IN_PROGRESS`, `AWAITING_APPROVAL`, `RETURNED`, `SUSPENDED`, `COMPLETED`, `CANCELED`, `PUBLISHED`; DFD em qualquer estado do documento), exceto registros descartados (excluídos logicamente). Na execução `REVISION` entram também os alvos `LINKED` a itens de versões `SUPERSEDED` do mesmo órgão e exercício. A leitura é feita pela porta `PcaLinkTarget` (visão `v_pca_link_targets`), em páginas de 200 ordenadas por `id`.
- **RN-PCA-264** — Normalização e resolução automática. O código é normalizado como o do item (`trim` + maiúsculas; espaços internos preservados). Exatamente **um** item não excluído do plano com o mesmo `code` e `status ≠ CANCELED` ⇒ `LINKED`. Nenhum ⇒ `UNRESOLVED` (`reasonCode` `NO_MATCH`; `NO_CODE` se o código é nulo). Item único porém `CANCELED` ⇒ `UNRESOLVED` (`ITEM_CANCELED`). Mais de um ⇒ `AMBIGUOUS` (`MULTIPLE_MATCH`). Não há *match* aproximado automático: aproximação só gera sugestão.
- **RN-PCA-265** — Efeito do `LINKED` (job e conciliação). Grava `pcaItemId` e `pcaLinkStatus = LINKED` e incrementa `version`/`updatedAt` — **nada mais**. `pcaYear`, `pcaItemCode` e `pcaJustification` ficam como estavam (histórico textual, DEC-029), inclusive quando o texto difere do `code` do item; o `pcaYear` coincide sempre com o ano do plano. **Não reabre nada:** não muda `Process.status`, etapa, responsável, prazos, `Document.status`, `documentVersion`, nem cria versão de documento; não revalida estado editável, custódia, saldo ou avisos da US-142; não envia notificação do processo. Vale para processos concluídos, cancelados e publicados e para DFD finalizado ou aprovado. O vínculo gravado pela reconciliação só é desfeito por edição normal (US-142) ou nova conciliação.
- **RN-PCA-266** — Revisão (`REVISION`). Alvo `LINKED` a item `i_old` de versão `SUPERSEDED`: procura em plano vigente o item de mesmo `code`. Existindo e `status ≠ CANCELED` ⇒ reaponta (`via = RECONCILIATION`, `previousPcaItemId = i_old`, entrada `LINKED`). Inexistente ou `CANCELED` ⇒ o vínculo antigo é **mantido** (o alvo continua `LINKED`) e a entrada registra `UNRESOLVED` (`NO_COUNTERPART` ou `ITEM_CANCELED`), que passa a figurar entre as pendências até a conciliação (que troca o item).
- **RN-PCA-267** — Sugestões (alvos `UNRESOLVED`; em `AMBIGUOUS`, os próprios candidatos). Até 5 itens do plano vigente, `status ≠ CANCELED`, ordenados por pontuação decrescente e depois por `code`, com pontuação mínima 0,30, gravados em `candidateItemIds`. Pontuação = `min(1, max(codeScore, objectScore) + bônus)`, em que `codeScore` e `objectScore` são o coeficiente de Dice sobre trigramas de caracteres (código: sem pontuação e sem zeros à esquerda — `PCA-017` ≡ `pca17`; texto: minúsculas, sem acentos e sem palavras vazias), `objectScore` compara o objeto do alvo com o objeto do item, e `bônus` = 0,10 se a secretaria do item está na subárvore da secretaria solicitante. A pontuação **não é persistida** (recalculada na leitura, PCA-54). A sugestão nunca é aplicada sozinha.
- **RN-PCA-268** — Semântica de `SKIPPED`: examinado e deliberadamente não vinculado. Origens: (a) conciliação "sem item no PCA" (`MARKED_WITHOUT_ITEM`); (b) alvo que deixou de ser elegível durante a execução (`TARGET_CHANGED`); (c) alvo cuja transação falhou após as tentativas (`PROCESSING_ERROR`). `skippedCount` totaliza (b) e (c) no job. `MANUAL` = conciliado por pessoa com item escolhido.
- **RN-PCA-269** — Isolamento por registro. Cada alvo roda em transação própria que reúne vínculo, entrada, auditoria e outbox (tudo ou nada). Erro transitório ⇒ até 3 tentativas curtas (200 ms, 1 s, 5 s) dentro do job; persistindo, o alvo é registrado `SKIPPED` (`PROCESSING_ERROR`) em transação separada (se também falhar, só log e métrica) e o lote segue. Erro de infraestrutura geral (banco ou Redis fora) ⇒ o job é reprogramado pela política de retentativas sem consumir o alvo; esgotadas as tentativas, a execução termina `FAILED` e o job vai à fila `dead-letter` com alerta.
- **RN-PCA-270** — Lotes e limites. Páginas de 200 alvos; no máximo 50.000 alvos por execução (excedente: `COMPLETED` com `errorMessage = TARGET_LIMIT_REACHED` e notificação; nova execução continua dos que sobraram); no máximo 5.000 itens em memória por plano (acima, sugestões só por código). Conciliação em lote: 100 entradas por requisição (RN-PCA-279). Relatório e execuções: `pageSize` ≤ 100.
- **RN-PCA-271** — Idempotência. `LINKED` sai do universo; reexecutar logo depois resolve 0 e não duplica vínculo, evento nem auditoria. Alvos `UNRESOLVED`/`AMBIGUOUS` ganham nova entrada na nova execução (as anteriores permanecem como histórico; vale a mais recente — RN-PCA-273). Retentativa do mesmo job pula alvos que já têm entrada na execução (`UNIQUE (tenant_id, run_id, target_type, target_id)` com `ON CONFLICT DO NOTHING`); os contadores finais são recontados das entradas.
- **RN-PCA-272** — Resumo, evento e notificação. Os contadores `linkedCount`, `unresolvedCount`, `ambiguousCount` e `skippedCount` da execução são os **achados do job** e não mudam depois de `COMPLETED`. `PcaReconciliationCompleted` (`pcaId`, `runId`, `trigger`, contadores) é publicado uma vez, só em `COMPLETED`. `PCA_RECONCILIATION_PENDING` (in-app) vai aos vínculos com `PCA_RECONCILE` no órgão (máx. 50, exceto o ator) quando `unresolvedCount + ambiguousCount > 0`.
- **RN-PCA-273** — Pendência vigente. É a **entrada mais recente do alvo** (entre as execuções de planos do mesmo órgão e exercício) com `outcome IN (UNRESOLVED, AMBIGUOUS)` **e** o alvo ainda não casado: `pcaStatus = PLANNED` e (`pcaLinkStatus IN (UNRESOLVED, AMBIGUOUS)` ou `LINKED` a item de plano `SUPERSEDED`). Entradas fechadas por conciliação (`MANUAL`/`SKIPPED`), por vínculo ou edição posterior ou por mudança da situação no PCA saem da lista sem ação adicional. A consulta lê a visão `v_pca_link_targets` publicada pelos donos (`process`, `dfd`), sem junção direta nas tabelas deles.
- **RN-PCA-274** — Conciliação manual `LINK`. Exige `PCA_RECONCILE`, entrada vigente e item **elegível** para o alvo pelas regras da US-142 (RN-PCA-231: plano `APPROVED` vigente do órgão e do exercício, `status ≠ CANCELED`), sem as regras de edição, custódia, saldo e aviso. Grava `pcaItemId`/`pcaLinkStatus = LINKED` pela porta (`via = MANUAL`, texto preservado — RN-PCA-265), atualiza a entrada (`outcome = MANUAL`, `resolvedItemId`, `resolvedById`, `resolvedAt`, nota opcional ≤ 500) e, para entradas de `REVISION`, troca o item antigo pelo novo. Escolher item fora dos candidatos é permitido (busca PCA-55); item de outro órgão ou tenant ⇒ 422 `REFERENCE_NOT_FOUND`.
- **RN-PCA-275** — Conciliação `NO_ITEM` ("sem item no PCA"). Exige `justification` de 20 a 500 caracteres. A entrada vira `SKIPPED` (`reasonCode = MARKED_WITHOUT_ITEM`, `resolvedById`, `resolvedAt`, `resolutionNote` com a justificativa); o alvo recebe `pcaLinkStatus = NOT_APPLICABLE` mantendo `pcaStatus = PLANNED` e o texto — sentido: "conferido, não há item correspondente". Fica fora das próximas execuções até que `pcaYear`/`pcaItemCode`/`pcaStatus` mudem (volta a `PENDING` — RN-PCA-230). Para alvo `LINKED` (caso `REVISION`), `NO_ITEM` não se aplica (usar `LINK` ou a remoção da US-142).
- **RN-PCA-276** — Escopo e visibilidade. Disparar `MANUAL` exige `PCA_RECONCILE` com escopo `ORGANIZATION`/`TENANT` que cubra o órgão do plano. Listar o relatório exige `PCA_VIEW`; conciliar, `PCA_RECONCILE`. Com escopo de unidade, só se conciliam itens cujo `departmentId` está no escopo (permissions.md §5.1). Em **toda** leitura e escrita de entrada, o processo do alvo (`processId`) precisa estar **visível** à pessoa (DEC-024); fora disso a entrada não aparece e a ação responde 404 `PCA_RECONCILIATION_ENTRY_NOT_FOUND`. O job, por ser `SYSTEM`, não depende de visibilidade (RN-PCA-20).
- **RN-PCA-277** — Estado do alvo. Qualquer status de processo e estado de documento aceita a conciliação (inclusive `CANCELED`, `COMPLETED`, `PUBLISHED` e DFD aprovado). A escrita se limita às colunas do vínculo, `version` e `updatedAt`, pela porta `PcaLinkTarget` — contornando deliberadamente POL-01/POL-02, porque nada do conteúdo muda.
- **RN-PCA-278** — Concorrência. Ordem de travas fixa em job e API para evitar *deadlock*: **alvo primeiro, depois a entrada**. Segunda conciliação sobre entrada já resolvida ⇒ 409 `PCA_ENTRY_ALREADY_RESOLVED` (`meta.outcome`, `meta.resolvedAt`); alvo que deixou de casar com a pendência ⇒ 409 `PCA_TARGET_CHANGED`. Reconciliação automática e manual sobre o mesmo alvo: vence quem travar primeiro; o outro enxerga o novo estado e se encerra (`SKIPPED` no job; 409 na API).
- **RN-PCA-279** — Lote manual (PCA-57). Mesma decisão (`LINK` com o mesmo item, ou `NO_ITEM` com a mesma justificativa) para 1 a 100 entradas; cada entrada em transação própria; resultado por entrada (`DONE` ou `FAILED` com código); falha de uma não desfaz as demais. Requisição inválida por inteiro (item inelegível, lista vazia ou > 100) ⇒ 422 sem efeito. `Idempotency-Key` reproduz o mesmo resultado.
- **RN-PCA-280** — Exportação (PCA-53). CSV das pendências vigentes com os mesmos filtros e a mesma visibilidade da lista; exige `PCA_EXPORT` e cobertura de `PCA_VIEW`; até 10.000 linhas (acima, 422 `EXPORT_TOO_LARGE`); campos de texto protegidos contra injeção de fórmula (prefixo `'`, como PRC-34); uma exportação do mesmo usuário por vez (trava de 2 minutos); auditoria `pca.export` (`metadata.report = RECONCILIATION_PENDING`). Nunca inclui valores monetários.
- **RN-PCA-281** — Métricas e meta. Contadores sem rótulo de tenant: alvos por `trigger` e `outcome`, execuções por `status`, conciliações por ação, duração. Meta: ≥ 85% de `LINKED` sobre os alvos com código não nulo na primeira execução do órgão; 10.000 alvos em até 10 minutos, com transação por alvo de p95 ≤ 150 ms (suíte de performance, medida no endurecimento).
- **RN-PCA-282** — Contadores e escopo reduzido. Quem tem `PCA_VIEW` com escopo de unidade recebe os totais recontados sobre as entradas que vê (`meta.scopeLimited = true`); os totais do órgão só aparecem com escopo `ORGANIZATION`/`TENANT` (permissions.md §5.1, RN-PCA-25).
- **RN-PCA-283** — Dados exibidos. O relatório e o painel mostram código, título, situação, secretaria e objeto do processo, o texto original de PCA, os candidatos (código, objeto, secretaria, situação) e a autoria; **nunca** `estimatedValue`, `plannedValue` ou saldo. Processos com orçamento sigiloso aparecem normalmente (nenhum valor é exibido). `CONSULTOR_EXTERNO` recebe 403 em todas as rotas da story.
- **RN-PCA-284** — Falha, recuperação e órfãos. Execução `FAILED` não gera `PcaReconciliationCompleted`, aciona alerta e permite novo disparo `MANUAL`. O reconciliador (`maintenance-reconcile`, a cada 15 minutos) reenfileira execuções `RUNNING` cujo `updatedAt` tem mais de 10 minutos e sem job ativo. Execuções `RUNNING` há mais de 6 horas sem progresso são encerradas `FAILED` (`STALLED`). Redis indisponível no disparo: a execução permanece `RUNNING` e a API responde 202 (RN-PCA-260).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Plano | `pcaId` (path) | uuid | Sim | `APPROVED` para disparar | Plano aberto em SCR-018 |
| Origem da execução | `PcaReconciliationRun.trigger` | `PCA_APPROVED` \| `MANUAL` \| `REVISION` | Sim (sistema) | RN-PCA-260 | Sistema |
| Situação da execução | `status` | `PcaReconciliationRunStatus` | Sim (sistema) | `RUNNING` → `COMPLETED`/`FAILED` | `RUNNING` |
| Totais | `linkedCount`, `unresolvedCount`, `ambiguousCount`, `skippedCount` | inteiros | Sim (sistema) | RN-PCA-272 | 0 |
| Tipo do alvo | `targetType` | `PROCESS` \| `DFD` | Sim (sistema) | Filtro e coluna | — |
| Referência original | `pcaYear`, `pcaItemCode` | int, texto (≤ 60) | Sim / Não | Texto do MVP 1, somente leitura | Alvo |
| Resultado | `outcome` | `PcaReconciliationOutcome` | Sim (sistema) | Filtro; padrão `UNRESOLVED`,`AMBIGUOUS` | — |
| Motivo | `reasonCode` | texto (≤ 40) | Não (sistema) | `NO_MATCH`, `NO_CODE`, `ITEM_CANCELED`, `MULTIPLE_MATCH`, `NO_COUNTERPART`, `MARKED_WITHOUT_ITEM`, `TARGET_CHANGED`, `PROCESSING_ERROR` | — |
| Candidatos | `candidateItemIds` | uuid[] (≤ 5) | Não (sistema) | RN-PCA-267 | — |
| Item escolhido | `pcaItemId` (corpo do PCA-56/57) | uuid | Condicional (`LINK`) | Elegível (RN-PCA-274) | Candidato selecionado |
| Ação | `action` | `LINK` \| `NO_ITEM` | Sim | RN-PCA-274/105 | — |
| Justificativa ("sem item") | `justification` | texto longo | Condicional (`NO_ITEM`) | 20–500 | — |
| Nota da conciliação | `note` | texto | Não | ≤ 500 | — |
| Entradas do lote | `entryIds` | uuid[] | Sim (PCA-57) | 1–100, sem repetição | Seleção da lista |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Plano de outro tenant, inexistente ou fora do escopo | API | "Plano não encontrado." | `NOT_FOUND` (`PCA_NOT_FOUND`) |
| V-02 | Disparo com plano que não está `APPROVED` | API | "Só é possível reconciliar um plano aprovado." | `PCA_NOT_APPROVED` |
| V-03 | Já existe execução em andamento no plano | API | "Já há uma reconciliação em andamento para este plano." | `PCA_RECONCILIATION_IN_PROGRESS` |
| V-04 | `action` fora de `LINK`/`NO_ITEM` ou campos incoerentes (`LINK` sem item; `NO_ITEM` com item) | Front + API (Zod) | "Escolha um item ou marque que não há item no PCA." | `VALIDATION_ERROR` |
| V-05 | Justificativa de `NO_ITEM` ausente ou com menos de 20 caracteres (ou > 500) | Front + API | "Explique por que não há item no PCA (mín. 20 caracteres)." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`/`TOO_SHORT`/`TOO_LONG`) |
| V-06 | Item inexistente, de outro tenant ou de outro órgão | API | "Selecione um item válido do PCA." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-07 | Item do órgão porém inelegível (plano não vigente, item cancelado, exercício diferente do alvo) | API | "Este item não pode ser vinculado a esta demanda." | `PCA_ITEM_NOT_ELIGIBLE` (`meta.reason`) |
| V-08 | Entrada inexistente, de outro tenant ou de processo invisível | API | "Pendência não encontrada." | `PCA_RECONCILIATION_ENTRY_NOT_FOUND` |
| V-09 | Entrada já conciliada | API | "Esta pendência já foi tratada por outra pessoa." | `PCA_ENTRY_ALREADY_RESOLVED` |
| V-10 | Alvo mudou e não casa mais com a pendência | API | "O processo ou DFD foi alterado. Atualize a lista." | `PCA_TARGET_CHANGED` |
| V-11 | Lote vazio, com mais de 100 entradas ou com repetição | Front + API | "Selecione de 1 a 100 pendências." | `VALIDATION_ERROR` |
| V-12 | `NO_ITEM` sobre alvo já vinculado (caso de revisão) | API | "Esta demanda já tem item; escolha um item ou remova o vínculo." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-13 | Exportação acima de 10.000 linhas | API | "A exportação tem mais de 10.000 linhas. Refine os filtros." | `EXPORT_TOO_LARGE` |

## Permissões
- **Permissão:** `PCA_RECONCILE` para disparar (PCA-48; escopo `ORGANIZATION`/`TENANT` cobrindo o órgão do plano) e conciliar (PCA-56/57; escopo que cubra o plano e, em unidade, os itens escolhidos). `PCA_VIEW` para PCA-49 a PCA-52, PCA-54 e PCA-55 (PCA-54/55 também exigem `PCA_RECONCILE`, pois mostram o painel de decisão). `PCA_EXPORT` + `PCA_VIEW` para PCA-53.
- **Políticas:** POL-22 (administração do PCA), DEC-024 (visibilidade do processo de cada entrada), POL-09 (nenhum valor é exposto), RN-PCA-20 (o job é `SYSTEM`; a conciliação humana respeita a visibilidade).
- **MFA:** não exigido (nenhuma das permissões é de risco `H`).
- **Sem permissão:** a UI oculta "Executar reconciliação", "Conciliar" e "Exportar"; na API, 403 `PERMISSION_DENIED` com `access.denied` (`reasonCode`). Plano de outro tenant: 404. `CONSULTOR_EXTERNO`: 403 em todas as rotas e aba invisível.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `PcaReconciliationCompleted` | `pca.reconciliation_completed` | Fim da execução em `COMPLETED` | `pcaId`, `runId`, `trigger`, `linkedCount`, `unresolvedCount`, `ambiguousCount` + `skippedCount` (**campo aditivo novo**); consumidor N (`PCA_RECONCILIATION_PENDING`) |
| `PcaReferenceConciliated` | `pca.reference_conciliated` | Cada conciliação manual (`LINK` ou `NO_ITEM`) | `runId`, `entryId`, `targetType`, `targetId`, `pcaItemId?` (ausente em `NO_ITEM`) + `action` (**campo novo**); sem cons. |
| `ProcessPcaItemLinked` | `process.pca_item_linked` | Alvo `PROCESS` vinculado pelo job (`via = RECONCILIATION`) ou pela conciliação (`via = MANUAL`) | `previousPcaItemId?` no reapontamento; consumidores T P R (timeline `PCA_ITEM_LINKED`) |
| `DfdPcaItemLinked` | `dfd.pca_item_linked` | Alvo `DFD` vinculado | Novo (US-142); payload com `via` (**campo novo**) |
| `PcaStatusChanged` (`approved`) | `pca.status_changed.approved` | Aprovação do plano (US-140) | **Consumido** pelo `PcaReconciliationScheduler` (X); não é produzido aqui |

Um alvo `LINKED` gera um evento próprio no outbox (execuções grandes publicam milhares; o relay trabalha por agregado, ordem preservada — queues.md §5). Os contadores nunca carregam identificação de processos. Resultado `UNRESOLVED`/`AMBIGUOUS`/`SKIPPED` não gera evento por alvo.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `PCA_RECONCILIATION_PENDING` | Vínculos com `PCA_RECONCILE` no órgão do plano (máx. 50), exceto o ator | in-app (e-mail conforme preferência) | `PcaReconciliationCompleted` com `unresolvedCount + ambiguousCount > 0` |
| *(feedback na tela)* | Quem disparou `MANUAL` | toast / indicador da SCR-018 | Término ou falha da execução, por *polling* da própria tela |

Não há notificação por processo reconciliado (a reconciliação não reabre nem move nada).

## Critérios de aceite em Gherkin
```gherkin
Feature: Reconciliar as referências textuais ao PCA e conciliar manualmente

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o plano "PCA 2026" do órgão "Prefeitura Municipal de A" foi aprovado (versão 1) com os itens "PCA-017", "PCA-021" e "PCA-030" (cancelado)
    And o processo "0045/2026" (em andamento) tem "pcaStatus" "PLANNED", "pcaYear" 2026 e "pcaItemCode" " pca-017 " apenas em texto, com "pcaLinkStatus" "PENDING"
    And o processo "0051/2026" tem o código "PCA-XYZ", o processo "0030/2026" (concluído) tem "PCA-021" e o processo "0033/2026" (cancelado) tem "PCA-030"
    And o DFD do processo "0045/2026" tem o mesmo código em texto e "pcaLinkStatus" "PENDING"
    And a usuária "Helena" (PLANEJAMENTO, escopo do órgão) tem "PCA_RECONCILE" e "PCA_VIEW"

  Scenario: [Sucesso] A aprovação do plano dispara a reconciliação automática
    When o plano "PCA 2026" for aprovado
    Then deve existir uma execução "PCA_APPROVED" que termina "COMPLETED"
    And o processo "0045/2026", o seu DFD e o processo concluído "0030/2026" devem ficar "LINKED" aos itens "PCA-017" e "PCA-021"
    And o texto " pca-017 " e o ano 2026 devem permanecer inalterados
    And o status, a etapa, o responsável e os prazos dos processos não devem mudar
    And o processo "0051/2026" deve aparecer na pendência como "UNRESOLVED" com motivo "NO_MATCH" e candidatos sugeridos
    And o processo cancelado "0033/2026" deve aparecer como "UNRESOLVED" com motivo "ITEM_CANCELED"
    And deve gerar registro de auditoria "process.pca_link" e "dfd.pca_link" com ator "SYSTEM" para cada vínculo
    And deve gerar o evento "PcaReconciliationCompleted" com "linkedCount" 3, "unresolvedCount" 2 e "ambiguousCount" 0
    And "Helena" deve receber a notificação "PCA_RECONCILIATION_PENDING"

  Scenario: [Sucesso] Revisão aprovada reaponta os vínculos para a nova versão
    Given que o processo "0045/2026" está "LINKED" ao item "PCA-017" da versão 1
    When a revisão (versão 2) do plano for aprovada com o item "PCA-017" mantido e o item "PCA-021" removido da versão
    Then a execução "REVISION" deve apontar o processo "0045/2026" para o item "PCA-017" da versão 2 com "previousPcaItemId" da versão 1
    And o processo "0030/2026" deve continuar "LINKED" ao item antigo e constar nas pendências como "UNRESOLVED" com motivo "NO_COUNTERPART"

  Scenario: [Sucesso] Conciliar manualmente escolhendo um item sugerido
    When "Helena" abrir a pendência do processo "0051/2026"
    Then o painel deve mostrar o código original "PCA-XYZ", os candidatos com a pontuação e o objeto do processo
    When "Helena" confirmar o item "PCA-021"
    Then o processo "0051/2026" deve ficar "LINKED" ao item "PCA-021" com o texto "PCA-XYZ" preservado
    And a entrada deve ficar "MANUAL" com "resolvedById" de "Helena" e a data
    And deve gerar registro de auditoria "pca.conciliate" e "process.pca_link"
    And deve gerar os eventos "PcaReferenceConciliated" e "ProcessPcaItemLinked" com "via" "MANUAL"
    And a pendência não deve mais aparecer na lista

  Scenario: [Sucesso] Marcar como "sem item no PCA" com justificativa
    When "Helena" marcar a pendência do processo "0033/2026" como "sem item no PCA" com a justificativa de 45 caracteres
    Then a entrada deve ficar "SKIPPED" com motivo "MARKED_WITHOUT_ITEM"
    And o processo deve ficar com "pcaLinkStatus" "NOT_APPLICABLE" e o texto preservado
    And uma nova execução "MANUAL" não deve incluir esse processo

  Scenario: [Sucesso] Conciliar em lote várias pendências com o mesmo destino
    Given que 40 processos têm o código "PCA-XYZ" como pendência
    When "Helena" selecionar as 40 pendências e conciliar em lote com o item "PCA-021"
    Then o resultado deve trazer 40 linhas "DONE"
    And deve haver 40 registros de auditoria "pca.conciliate"

  Scenario: [Sucesso] Exportar as pendências
    When "Helena", com "PCA_EXPORT", exportar as pendências com o filtro "UNRESOLVED"
    Then deve ser baixado um CSV com tipo, código, título, situação, secretaria, código informado, motivo, candidatos e dias pendente
    And o CSV não deve conter nenhum valor monetário
    And deve gerar registro de auditoria "pca.export" com "report" "RECONCILIATION_PENDING"

  Scenario: [Validação] Disparo em plano não aprovado, justificativa curta e lote inválido
    Given que o plano "PCA 2027" está em "DRAFT"
    When "Helena" disparar a reconciliação do plano "PCA 2027"
    Then a API deve responder 409 com código "PCA_NOT_APPROVED"
    When "Helena" marcar "sem item no PCA" com a justificativa "não existe"
    Then a API deve responder 422 com "VALIDATION_ERROR" e "TOO_SHORT" em "justification"
    When "Helena" enviar um lote de 101 pendências
    Then a API deve responder 422 com código "VALIDATION_ERROR" e nenhuma pendência deve ser alterada
    When "Helena" confirmar um item cancelado
    Then a API deve responder 422 com código "PCA_ITEM_NOT_ELIGIBLE"

  Scenario: [Permissão] Sem PCA_RECONCILE, consultor externo e processo invisível
    Given que "Bruno" tem "PCA_VIEW" e não tem "PCA_RECONCILE"
    When "Bruno" tentar disparar a reconciliação ou conciliar uma pendência
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    Given que "Carla" é "CONSULTOR_EXTERNO"
    When "Carla" consultar o relatório de pendências
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    Given que o processo "0051/2026" não está visível para "Rita" (PLANEJAMENTO com escopo de unidade)
    When "Rita" listar as pendências e tentar conciliar a pendência desse processo pelo identificador
    Then a lista não deve conter a pendência
    And a conciliação deve responder 404 com código "PCA_RECONCILIATION_ENTRY_NOT_FOUND"

  Scenario: [Tenant incorreto] Plano e pendência de outro tenant
    Given que existe o plano "PCA 2026" e a pendência "e-77" no tenant "Prefeitura B"
    When "Helena", no tenant "Prefeitura A", consultar ou conciliar a pendência "e-77"
    Then a API deve responder 404 com código "PCA_RECONCILIATION_ENTRY_NOT_FOUND"
    When "Helena" disparar a reconciliação do plano do tenant "Prefeitura B"
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum processo, código ou item da "Prefeitura B" deve ser revelado
    When "Helena" conciliar com um item do tenant "Prefeitura B"
    Then a API deve responder 422 com "REFERENCE_NOT_FOUND"
    And o job executado no tenant "Prefeitura A" nunca deve alterar registros do tenant "Prefeitura B"

  Scenario: [Duplicidade] Reexecução idempotente, disparo repetido e reenvio
    Given que a reconciliação do plano "PCA 2026" foi concluída
    When "Helena" disparar uma nova execução "MANUAL"
    Then a nova execução deve ter "linkedCount" 0
    And não deve haver vínculo, evento "ProcessPcaItemLinked" nem auditoria "process.pca_link" duplicados
    Given que há uma execução "RUNNING" no plano
    When "Helena" disparar a reconciliação de novo sem "Idempotency-Key"
    Then a API deve responder 409 com código "PCA_RECONCILIATION_IN_PROGRESS" e "meta.runId" da execução em curso
    When "Helena" enviar o disparo duas vezes com a mesma "Idempotency-Key"
    Then a segunda resposta deve trazer "Idempotent-Replayed" verdadeiro e haver uma única execução
    Given que o job é reprocessado após a queda do worker no meio de uma página
    Then os alvos que já tinham entrada na execução não devem ser processados de novo

  Scenario: [Concorrência] Dois conciliadores na mesma pendência
    Given que "Helena" e "Marcos" abriram a pendência do processo "0051/2026"
    When os dois confirmarem itens diferentes ao mesmo tempo
    Then uma conciliação deve responder 200 e a outra 409 com código "PCA_ENTRY_ALREADY_RESOLVED"
    And o processo deve ficar vinculado ao item da conciliação aceita, com um único evento "ProcessPcaItemLinked"

  Scenario: [Concorrência] Alvo editado durante a reconciliação
    Given que o responsável vincula o processo "0045/2026" ao item "PCA-018" pela edição normal enquanto o job o examina
    When o job tentar gravar o vínculo
    Then o job deve reconferir o alvo travado e registrar "SKIPPED" com motivo "TARGET_CHANGED"
    And o vínculo "PCA-018" não deve ser sobrescrito

  Scenario: [Falha de banco] Falha ao gravar um alvo não derruba o lote
    Given que o banco falha ao gravar a auditoria do processo "0045/2026" durante a execução
    When o job processar o lote de 200 alvos
    Then a transação do processo "0045/2026" deve ser desfeita sem vínculo, auditoria nem evento
    And o alvo deve receber a entrada "SKIPPED" com motivo "PROCESSING_ERROR" após as tentativas
    And os demais 199 alvos devem ser processados e a execução deve terminar "COMPLETED" com "skippedCount" 1

  Scenario: [Falha de banco] Banco indisponível no disparo manual
    Given que o banco de dados está indisponível
    When "Helena" disparar a reconciliação
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma execução "RUNNING" deve ficar registrada

  Scenario: [Falha de integração] Redis indisponível no disparo e na notificação
    Given que o Redis das filas está indisponível
    When "Helena" disparar a reconciliação
    Then a API deve responder 202 com a execução "RUNNING"
    And quando o Redis voltar o reconciliador deve reenfileirar o job sem criar segunda execução
    Given que o envio da notificação "PCA_RECONCILIATION_PENDING" falha
    When a execução terminar
    Then o evento "PcaReconciliationCompleted" deve ser publicado
    And a notificação deve ser reenviada pela política de retentativas sem duplicidade
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Plano inexistente, de outro tenant ou fora do escopo | 404 | `NOT_FOUND` | "Plano não encontrado." | Volta à lista de planos |
| Plano não aprovado | 409 | `PCA_NOT_APPROVED` | "Só é possível reconciliar um plano aprovado." | Desabilita "Executar reconciliação" com o motivo |
| Execução em andamento | 409 | `PCA_RECONCILIATION_IN_PROGRESS` | "Já há uma reconciliação em andamento para este plano." | Passa a acompanhar a execução (`meta.runId`) |
| Pendência inexistente, de outro tenant ou invisível | 404 | `PCA_RECONCILIATION_ENTRY_NOT_FOUND` | "Pendência não encontrada." | Recarrega a lista |
| Pendência já tratada | 409 | `PCA_ENTRY_ALREADY_RESOLVED` | "Esta pendência já foi tratada por outra pessoa." | Fecha o painel e atualiza a lista |
| Alvo mudou | 409 | `PCA_TARGET_CHANGED` | "O processo ou DFD foi alterado. Atualize a lista." | Atualiza a linha |
| Item inelegível | 422 | `PCA_ITEM_NOT_ELIGIBLE` | "Este item não pode ser vinculado a esta demanda." | Mantém o painel; destaca o item |
| Item inexistente, de outro tenant ou órgão | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Selecione um item válido do PCA." | Destaca o campo |
| Exportação grande | 422 | `EXPORT_TOO_LARGE` | "A exportação tem mais de 10.000 linhas. Refine os filtros." | Mostra o total e sugere filtros |
| Justificativa curta/ausente, ação incoerente, lote inválido | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Mensagens por campo |
| Sem permissão / consultor externo | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta a ação |
| Exportação em andamento / limite | 429 | `RATE_LIMITED` | "Aguarde alguns instantes e tente novamente." | Aplica `Retry-After` |
| Banco ou fila indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-083 (worker, filas, retentativas e `dead-letter`), US-142 (colunas do vínculo, elegibilidade do item, auditoria e eventos de vínculo). Indiretas: US-140 e US-141 (aprovação e revisão do plano que disparam o job), US-138 (itens), US-073 (gravação de auditoria), US-144 (consome os eventos de vínculo), US-002/US-004 (visibilidade do processo), US-014/US-065 (DFD e documento).
- **Decisões/ADRs:** DEC-197, DEC-029, DEC-163 e DEC-164 (política e contrato de job), DEC-024, DEC-030, DEC-108, DEC-161 (outbox), DEC-190 (publicação direta; sem CI de PR).
- **Configurações:** nenhuma chave nova. Constantes de plataforma: 200 alvos por página, 50.000 por execução, 100 por lote manual, 5 candidatos.
- **Lacunas nas fontes canônicas:**
  1. **Endpoints novos (PCA-48..PCA-59):** PCA-48 `POST /pcas/{pcaId}/reconciliations`, PCA-49 `GET /pcas/{pcaId}/reconciliations`, PCA-50 `GET /pcas/{pcaId}/reconciliations/{runId}`, PCA-51 `GET /pcas/{pcaId}/reconciliations/{runId}/entries`, PCA-52 `GET /pcas/{pcaId}/reconciliation-pending`, PCA-53 `GET /pcas/{pcaId}/reconciliation-pending/export`, PCA-54 `GET /pca-reconciliation-entries/{entryId}`, PCA-55 `GET /pca-reconciliation-entries/{entryId}/candidates`, PCA-56 `POST /pca-reconciliation-entries/{entryId}/conciliate`, PCA-57 `POST /pcas/{pcaId}/reconciliation-pending/conciliate` (PCA-58/59 reservados). A feature indica só as rotas de PCA-48, 49, 51 e 56 (como "indicativas").
  2. **Campos novos em `PcaReconciliationEntry`:** `reasonCode` (varchar(40), nulo) e `resolutionNote` (varchar(500), nulo): a entidade não guarda o motivo nem a justificativa do "sem item".
  3. **Semântica de valores existentes:** `SKIPPED` (RN-PCA-268) e `NOT_APPLICABLE` em `PLANNED` como "sem item no PCA" (RN-PCA-275). A feature prevê "marcar sem item", mas `PcaLinkStatus` não tem valor próprio e o check exige `resolved_item_id` em `MANUAL`; alternativa: novo valor de enum (ex.: `WAIVED`).
  4. **Visão `v_pca_link_targets`** (publicada por `process` e `dfd`, lida pelo `pca`) e métodos da porta `PcaLinkTarget` (`listTargets`, `lockForUpdate`, `applyLink`, `markWithoutItem`); domains.md §12.3 só diz "listar e gravar".
  5. **Job `pca-reconcile`** na fila `maintenance` (queues.md §4.8 só lista jobs diários) e regra nova do reconciliador (execução `RUNNING` sem progresso há 10 min é reenfileirada; há 6 h, `FAILED` `STALLED`).
  6. **Códigos novos:** `PCA_NOT_APPROVED`, `PCA_RECONCILIATION_IN_PROGRESS`, `PCA_ENTRY_ALREADY_RESOLVED`, `PCA_TARGET_CHANGED` (409), `PCA_RECONCILIATION_ENTRY_NOT_FOUND` (404); reutiliza `PCA_ITEM_NOT_ELIGIBLE` (US-142). **Payloads aditivos:** `PcaReconciliationCompleted.skippedCount`, `PcaReferenceConciliated.action` (e `pcaItemId` opcional), `DfdPcaItemLinked.via`. **Índices novos:** `pca_reconciliation_entries (tenant_id, target_type, target_id, created_at DESC)` e `(tenant_id, run_id, outcome)`.
  7. **Sobreposição com a US-141:** o reapontamento na revisão está aqui (entities.md §6.1 o atribui ao job `REVISION`); a US-141 cria a revisão e dispara o evento.
  8. **Produto:** (a) "sem item" como `NOT_APPLICABLE` × novo enum; (b) referências de exercícios sem plano aprovado ficam `PENDING` e fora do relatório (FA-11); (c) `AMBIGUOUS` é defensivo (unicidade de `code` por plano e de plano `APPROVED` por órgão/exercício); (d) limites de 50.000 alvos por execução e 100 por lote são propostas; (e) PCA-48 exige escopo `ORGANIZATION`/`TENANT` e PCA-54/55 exigem `PCA_RECONCILE` (permissions.md não detalha).

## Impacto técnico
- **Escala e desempenho:** planos de até 5.000 itens ficam em memória (dicionário por `code` e trigramas pré-computados); 10.000 alvos × 5.000 itens para as sugestões é viável em segundos, mas só é calculado para os `UNRESOLVED`. Transação por alvo evita bloqueios longos; páginas de 200 por chave com *cursor*.
- **Carga de eventos:** a primeira execução em órgão com milhares de processos publica milhares de `ProcessPcaItemLinked`/`DfdPcaItemLinked`; o relay é por agregado e a fila `domain-events` absorve (alerta de *lag* do outbox cobre o excesso). A projeção de timeline `PCA_ITEM_LINKED` é síncrona **por transação de alvo** (sem pico fora do alvo).
- **Segurança e módulos:** o `pca` (N2) nunca importa `process`/`dfd`; lê pela visão e escreve pela porta `PcaLinkTarget` (D1); a escrita passa por *guardas* mínimas — só colunas do vínculo — e mantém RLS (job `SYSTEM` sempre dentro do contexto do tenant, nunca `cf_platform`).
- **Dados legados:** texto livre digitado no MVP 1 é sujo (hífens, zeros, espaços). A estratégia é deliberadamente conservadora: igualdade pós-normalização é automática; tudo o mais é sugestão. A meta de 85% depende do piloto (roadmap §4.10).
- **Consistência:** a lista de pendências deriva de entradas + visão, então edições manuais (US-142) fecham pendências sem consumidor adicional; o custo é a junção com `v_pca_link_targets` (índices parciais em `pca_link_status` já previstos).
- **Reversão:** vínculos gravados pelo job só se desfazem por edição normal ou conciliação (o texto continua lá). Não há "desfazer execução".
- **Observabilidade:** execução e entradas formam o relatório de auditoria do piloto ("migração executada, com relatório de reconciliação" — critério de saída do MVP 2).

## Backend
- **Módulo(s):** `pca` (dono de `PcaReconciliationRun`/`Entry`, do job, do relatório e da conciliação), `process` e `dfd` (implementam `PcaLinkTarget` e publicam a visão), `access` (`ProcessAccessPort` — visibilidade), `timeline`, `notification`, `audit`, `platform` (fila, outbox, exportação).
- **Casos de uso:** `StartPcaReconciliationCommand` (PCA-48 e consumidor `PcaReconciliationScheduler`), `PcaReconcileJob`/`PcaReconciliationEngine` (resolução, reapontamento, sugestões), `ListPcaReconciliationsQuery`, `GetPcaReconciliationQuery`, `ListPcaReconciliationEntriesQuery`, `ListPcaPendingReferencesQuery`, `ExportPcaPendingReferencesQuery`, `GetPcaReconciliationEntryQuery`, `SearchPcaCandidatesQuery`, `ConciliatePcaEntryCommand`, `ConciliatePcaEntriesBatchCommand`.
- **Domínio:** `PcaReferenceMatcher` (normalização e igualdade), `PcaSuggestionScorer` (Dice por trigramas), `PcaReconciliationRun` (máquina `RUNNING → COMPLETED|FAILED`), `PcaReconciliationEntry` (resultados e fechamento manual), `PendingReferencePolicy` (RN-PCA-273).
- **Integrações internas:** porta `PcaLinkTarget` (`listTargets`, `lockForUpdate`, `applyLink`, `markWithoutItem`) implementada por `process` e `dfd`; visão `v_pca_link_targets`; `PcaFacade` (itens); `ProcessAccessPort`; `OutboxWriter`; `AuditService`; `TimelineProjector`; `NotificationDispatcher`; `runJob` (DEC-164).
- **Transação:** uma por alvo no job (trava do alvo → reconferência → vínculo → entrada → auditoria → outbox → timeline); uma por entrada na conciliação (alvo → entrada → vínculo → auditoria → outbox); criação da execução e enfileiramento pós-*commit* (padrão B).

## Frontend
- **Tela(s):** SCR-018 (`/pca/[pcaId]`, aba "Reconciliação"); o link "Ver pendência" a partir do cartão do PCA em SCR-006 (US-142) leva à entrada, para quem tem `PCA_VIEW`.
- **Componentes:** `ReconciliationSummaryCard` (última execução: origem, situação, totais, duração, botão "Executar reconciliação" com confirmação), `ReconciliationRunsTable`, `PendingReferencesTable` (seleção múltipla, filtros em painel aberto, chips só dos extras, linha de contagem, ordenação), `ConciliationSidePanel` (referência original, alvo, candidatos com pontuação, busca de outro item, "Sem item no PCA"), `BatchConciliationDialog` (resultado por linha), `ExportButton`, `AgeBadge` (idade da pendência; destaca > 30 dias).
- **Estados:** loading (esqueletos); vazio ("Nenhuma pendência. Todas as referências foram tratadas."); execução em andamento (indicador indeterminado + "N alvos examinados", *polling* a cada 3 s com recuo); falha da execução (alerta com `errorMessage` e "Tentar novamente"); erro por linha no lote; sucesso (toast "Pendência conciliada").
- **Acessibilidade e responsividade:** tabela com cabeçalhos associados, seleção por teclado e `aria-live` para o progresso e o resultado do lote; situação (resultado/motivo) por texto e ícone; painel lateral com foco preso e retorno ao gatilho; em largura < 768 px a tabela vira lista de cartões e o painel ocupa a tela.

## Banco de dados
- **Tabelas:** `pca_reconciliation_runs`, `pca_reconciliation_entries`, `pcas`, `pca_items` (M2-11); `processes` e `dfds` (`pca_item_id`, `pca_link_status`, `version`, `updated_at` — escrita pela porta); visão `v_pca_link_targets` (leitura); `outbox_events`, `audit_logs`, `process_timeline_entries`, `notifications`.
- **Migrações:** M2-11 já cria as tabelas e M2-12 o `PENDING`; esta story acrescenta `reason_code`/`resolution_note` em `pca_reconciliation_entries`, os índices da Lacuna 8 e a visão `v_pca_link_targets` (todos aditivos, compatíveis N-1). Nenhum dado é migrado em massa: a reconciliação é o próprio job.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, pca_id) WHERE status = 'RUNNING'` (execução única); `UNIQUE (tenant_id, run_id, target_type, target_id)`; `CHECK outcome NOT IN ('LINKED','MANUAL') OR resolved_item_id IS NOT NULL`; `(tenant_id, outcome) WHERE outcome IN ('UNRESOLVED','AMBIGUOUS')`; `(tenant_id, process_id)`; novos `(tenant_id, target_type, target_id, created_at DESC)` e `(tenant_id, run_id, outcome)`. RLS `ENABLE` + `FORCE` em ambas as tabelas.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `PCA-48` | POST | `/pcas/{pcaId}/reconciliations` | `{}` + `Idempotency-Key`; `PCA_RECONCILE` | `202 { data: PcaReconciliationRun }` (`status RUNNING`, `trigger MANUAL`, contadores 0) + `Location` | 202, 403, 404, 409, 422, 429, 503 |
| `PCA-49` | GET | `/pcas/{pcaId}/reconciliations` | Query: `status?`, `trigger?`, `page`, `pageSize` (≤ 100), `sort=-startedAt` | `200 { data: Run[], meta: paginação }` | 200, 403, 404 |
| `PCA-50` | GET | `/pcas/{pcaId}/reconciliations/{runId}` | — | `200 { data: Run + durationMs, reasons: { NO_MATCH, … } }` | 200, 403, 404 |
| `PCA-51` | GET | `/pcas/{pcaId}/reconciliations/{runId}/entries` | Query: `outcome?`, `targetType?`, `reasonCode?`, `q?`, `page`, `pageSize` | `200 { data: Entry[], meta }` (entradas visíveis; resultado atual de cada uma) | 200, 403, 404, 422 |
| `PCA-52` | GET | `/pcas/{pcaId}/reconciliation-pending` | Query: `outcome?` (padrão `UNRESOLVED,AMBIGUOUS`), `targetType?`, `reasonCode?`, `secretariatId?`, `processStatus?`, `q?`, `olderThanDays?`, `sort`, `page`, `pageSize` | `200 { data: [{ entryId, runId, targetType, target{ id, processId, code, title, status, secretariat }, pcaYear, pcaItemCode, outcome, reasonCode, candidatesCount, topCandidate?{ id, code }, ageDays }], meta: { page, pageSize, totalItems, totalPages, totals{ unresolved, ambiguous, olderThan30Days }, scopeLimited, awaitingPlan? } }` | 200, 403, 404, 422 |
| `PCA-53` | GET | `/pcas/{pcaId}/reconciliation-pending/export` | Mesmos filtros de PCA-52; `PCA_EXPORT` | `200 text/csv` (`Content-Disposition: attachment; filename="pca-pendencias-AAAA-AAAAMMDD-HHmm.csv"`) | 200, 403, 404, 422, 429 |
| `PCA-54` | GET | `/pca-reconciliation-entries/{entryId}` | `PCA_RECONCILE` | `200 { data: Entry + target{ …, object }, candidates[{ item{ id, code, object, department, status }, score }], resolvedBy?, resolvedAt?, resolutionNote? }, meta.allowedActions` | 200, 403, 404 |
| `PCA-55` | GET | `/pca-reconciliation-entries/{entryId}/candidates` | Query: `q?` (≥ 2), `limit?` (1–50) | `200 { data: [{ id, code, object, department, category, status, suggested, score? }] }` — itens elegíveis do plano vigente, sem valores | 200, 403, 404, 422 |
| `PCA-56` | POST | `/pca-reconciliation-entries/{entryId}/conciliate` | `{ action: LINK\|NO_ITEM, pcaItemId?, justification?, note? }` + `Idempotency-Key` | `200 { data: Entry }` (`MANUAL`/`SKIPPED`) | 200, 403, 404, 409, 422, 429, 503 |
| `PCA-57` | POST | `/pcas/{pcaId}/reconciliation-pending/conciliate` | `{ entryIds[1..100], action, pcaItemId?, justification?, note? }` + `Idempotency-Key` | `200 { data: { requested, done, failed, results[{ entryId, status: DONE\|FAILED, code? }] } }` | 200, 403, 404, 422, 429, 503 |

Notas: `Run` = `{ id, pcaId, trigger, status, startedAt, finishedAt?, linkedCount, unresolvedCount, ambiguousCount, skippedCount, errorMessage? }`. Respostas com `Cache-Control: no-store`. Item de outro tenant/órgão no **corpo** ⇒ 422 `REFERENCE_NOT_FOUND`; plano ou entrada no **caminho** ⇒ 404. Disparo e conciliação sujeitos à classe de comandos (120/min).

## Logs
- `info` `pca.reconciliation_started` — `runId`, `pcaId`, `trigger`, `itemsInPlan`.
- `info` `pca.reconciliation_page` — `runId`, `page`, `targets`, `linked`, `unresolved`, `ambiguous`, `skipped`, `durationMs`.
- `info` `pca.reconciliation_completed` — `runId`, contadores, `durationMs`.
- `warn` `pca.reconciliation_target_skipped` — `runId`, `targetType`, `targetId`, `reasonCode`, tentativa.
- `error` `pca.reconciliation_failed` — `runId`, causa técnica (`PLAN_SUPERSEDED`, `STALLED`, erro de infraestrutura); `info` `pca.conciliated` — `entryId`, `action`, `batchSize?`.
- Métricas (sem rótulo de tenant): `cf_pca_reconciliation_targets_total{trigger,outcome}`, `cf_pca_reconciliation_runs_total{trigger,status}`, `cf_pca_reconciliation_duration_seconds{trigger}`, `cf_pca_conciliations_total{action,result}`.
- **Nunca logar:** código/ano informado pelo usuário, título e objeto do processo, justificativa, nomes, valores, conteúdo de documentos.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `pca.reconcile` | `DATA_CHANGE` | Início (`phase = START`) e fim (`phase = FINISH` ou `FAIL`) da execução; ator = usuário no `MANUAL`, `SYSTEM` nos demais | `metadata`: `runId`, `pcaId`, `trigger`, contadores (no fim), `durationMs`, `errorCode?` |
| `process.pca_link` | `DATA_CHANGE` | Alvo `PROCESS` vinculado pelo job (`actorType = SYSTEM`) ou pela conciliação (usuário) | `changes`: `pcaItemId`, `pcaLinkStatus` (antes/depois); `metadata`: `via` (`RECONCILIATION`/`MANUAL`), `runId`, `entryId`, `previousPcaItemId?`, `textPreserved` — sem texto livre nem valores |
| `dfd.pca_link` | `DATA_CHANGE` | Alvo `DFD` vinculado | idem, com `dfdId` |
| `pca.conciliate` | `DATA_CHANGE` | Cada conciliação manual (`LINK` ou `NO_ITEM`) | `changes`: `outcome` (antes/depois), `resolvedItemId`; `metadata`: `runId`, `entryId`, `targetType`, `targetId`, `action`, `batchId?`, `note`/`justification` (texto integral, ≤ 500) |
| `pca.export` | `EXPORT` | PCA-53 | `metadata`: `report = RECONCILIATION_PENDING`, filtros, `rows` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode` (`PCA_RECONCILE`/`PCA_VIEW`/`PCA_EXPORT`) |

## Testes necessários
- **Unitários:** `PcaReferenceMatcher` (trim, maiúsculas, código nulo, item único/cancelado/múltiplo); `PcaSuggestionScorer` com casos de referência (`PCA-017` × `pca17`, zeros à esquerda, acentos, empate, limiar 0,30, bônus de secretaria); `PendingReferencePolicy` (casos de RN-PCA-273); máquina da execução; decisão de reapontamento da revisão; validação de lote (1–100, repetição).
- **Integração (Testcontainers PostgreSQL + Redis):** job completo sobre massa de processos e DFDs de todos os status (inclusive `COMPLETED`/`CANCELED`) com verificação de que só as colunas do vínculo, `version` e `updatedAt` mudam; texto preservado; reexecução idempotente (0 novos vínculos/eventos/auditorias); queda e retomada no meio da página; falha injetada num alvo (isolamento); `REVISION` com e sem correspondente; execução única por plano (concorrência de disparos); `FAILED` por plano substituído; reconciliador reenfileirando `RUNNING` órfã; relatório recalculado após edição normal (pendência fechada por outra via); outbox e timeline por alvo.
- **API/contrato:** PCA-48 a PCA-57 (paginação, filtros, ordenação, `meta.totals`, `scopeLimited`); CSV com proteção a fórmula e ausência de valores; resultados do lote por linha; códigos de erro novos; compatibilidade de `PcaReconciliationCompleted`/`PcaReferenceConciliated` com campos aditivos.
- **RBAC e multi-tenant:** `PCA_RECONCILE`/`PCA_VIEW`/`PCA_EXPORT` por escopo (organização × unidade); processo invisível ⇒ 404 e fora da lista/CSV; `CONSULTOR_EXTERNO` 403; plano, entrada e item de outro tenant ou outro órgão (suíte `test/tenant-leak`, arquivo novo `pca-reconciliation.tenant-leak.test.ts`, incluindo o job do tenant A sem tocar o tenant B); processo sigiloso sem vazamento de valores.
- **Concorrência:** dois conciliadores; conciliação × job no mesmo alvo (ordem de trava alvo → entrada, sem *deadlock*); edição US-142 × job; dois disparos `MANUAL`; lote concorrente com conciliação individual.
- **E2E (Playwright):** aprovar o plano e ver o resumo da execução e a lista; conciliar uma pendência por sugestão e outra por busca; marcar "sem item"; lote de 40; filtros e exportação; falha da execução e novo disparo. Fixtures com massa de legado de 500 processos.
- **Acessibilidade/performance:** axe na aba "Reconciliação", na tabela, no painel lateral e no diálogo de lote; teclado; suíte de performance: 10.000 alvos em ≤ 10 min, p95 por alvo ≤ 150 ms, lista de pendências p95 ≤ 500 ms com 20.000 entradas, PCA-48 p95 ≤ 300 ms (medidos no endurecimento).

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI atualizado e compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada
- [ ] Job idempotente e reentrante comprovado por teste (queda no meio, reexecução, falha por alvo)
- [ ] Prova de que a reconciliação altera só `pcaItemId`, `pcaLinkStatus`, `version` e `updatedAt` (processos e DFDs de qualquer situação)
- [ ] Relatório de reconciliação do piloto entregue (critério de saída do MVP 2)

## Estimativa
**L** — combina um job assíncrono idempotente em lotes com isolamento por registro, uma porta e uma visão entre três módulos, o motor de sugestões, o relatório paginado com visibilidade por processo, a conciliação individual e em lote com concorrência, a exportação e a observabilidade, além do reapontamento da revisão.

## Prioridade
**P1** — sem a reconciliação o legado do MVP 1 não se liga ao plano aprovado e o critério de saída do MVP 2 ("migração das referências textuais executada, com relatório de reconciliação") não é cumprido; não bloqueia o piloto do vínculo novo (US-142), por isso não é P0.
