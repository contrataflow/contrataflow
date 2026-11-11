---
id: US-141
title: "Revisar o PCA aprovado com nova versão"
epic: EP-023
feature: FT-069
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-140]
modules: [pca, approval, process, dfd, notification, audit, platform]
screens: [SCR-018, SCR-014, SCR-015]
endpoints: [PCA-20, PCA-21, PCA-22, PCA-23, PCA-24, APV-02, APV-03]
permissions: [PCA_MANAGE, PCA_VIEW, APPROVAL_DECIDE]
events: [PcaRevisionCreated, PcaStatusChanged]
---

# US-141 — Revisar o PCA aprovado com nova versão

## Título
Revisar o PCA aprovado com nova versão

## Descrição
**Como** planejamento do órgão (perfil `PLANEJAMENTO`), **quero** criar uma revisão do PCA aprovado, que nasce como nova versão em elaboração com a cópia dos itens e um motivo obrigatório, compará-la com a vigente e enviá-la à autoridade competente, **para** alterar o plano durante o exercício sem editar o que foi aprovado, sem perder o histórico e sem soltar os DFDs e processos já vinculados aos itens.

Enquanto a revisão está em `DRAFT` ou `AWAITING_APPROVAL`, a versão `APPROVED` continua vigente: é ela que o seletor de itens, o acompanhamento da execução e a exportação usam. Quando a autoridade aprova a revisão (`Approval` de assunto `PCA`, US-140), a versão anterior passa a `SUPERSEDED` e a nova passa a vigente na mesma transação. Os vínculos `pcaItemId` de processos e DFDs migram para o item de mesmo `code` da nova versão pelo job de reconciliação com `trigger = REVISION` (US-143); esta story define a regra de migração e as travas que impedem que a revisão deixe vínculo ativo sem destino.

## Contexto
- DEC-197: revisão do plano aprovado gera nova versão (`SUPERSEDED` na anterior), com o histórico preservado; `Pca` guarda `versionNumber`, `previousVersionId`, `revisionReason`; `PcaItem` guarda `previousItemId` (mesmo `code` na versão anterior). `entities.md §6.1`: a versão `APPROVED` segue vigente até a revisão ser aprovada; há uma versão vigente e uma em elaboração por exercício.
- A US-140 entrega o envio, a retirada e a decisão do plano de assunto `PCA`; esta story estende o `ApprovalSubjectHandler` do módulo `pca` para o caso `versionNumber > 1` e acrescenta, ao envio, a verificação de vínculos ativos sem destino.
- Os itens da revisão são editados pelos casos de uso da US-138 (e da importação da US-139), pois a revisão é um plano em `DRAFT`; esta story só acrescenta as travas de vínculo (RN-PCA-205).
- O `code` do item é a chave estável entre versões e a ponte para a referência textual do MVP 1 (DEC-029). O vínculo `pcaItemId` é FK composta com o tenant (`Process`/`Dfd`); as escritas no vínculo pertencem a `process` e `dfd` (D1) e passam pela porta `PcaLinkTarget` (domains.md §12.3).
- Risco da feature FT-069: "aprovação de revisão desalinhando vínculos já feitos" — mitigado por reapontamento por `code` e pelas travas desta story.
- Valores do plano não são sigilosos por si; o sigilo (DEC-030, POL-09) aparece aqui apenas na visão de impacto, que lê valores estimados de processos vinculados.
- Lacuna L-07: `CONSULTOR_EXTERNO` não acessa o PCA.

## Objetivo
Garantir que 100% das mudanças em plano aprovado ocorram por revisão versionada; que a aprovação de uma revisão substitua a vigente de forma atômica (nunca duas vigentes, nunca nenhuma); que nenhum DFD ou processo em andamento fique vinculado a item inexistente na versão vigente; e que a comparação entre versões mostre, em até 2 s (p95) para planos de 500 itens, o que foi acrescentado, removido e alterado.

## Persona
- **Principal:** Planejamento (`PLANEJAMENTO`), que cria, edita, compara e envia a revisão.
- **Secundárias:** Autoridade competente (`AUTORIDADE_COMPETENTE`), que decide a revisão em SCR-014/SCR-015 e consulta a comparação; Auditor (`AUDITOR`) e Controle Interno (`CONTROLE_INTERNO`), que consultam versões e decisões; Gestor de contratações (`GESTOR_CONTRATACOES`), que acompanha qual versão está vigente; Administrador do órgão (`ADMIN_ORGAO`), que só consulta.

## Pré-condições
- Existe plano do órgão e do exercício em `APPROVED` (versão vigente), aprovado pela US-140.
- Usuário autenticado no tenant com `PCA_MANAGE` com escopo `ORGANIZATION` ou `TENANT` que cubra o órgão do plano (permissions.md §5.1) para criar e descartar revisão; `PCA_VIEW` para consultar versões, comparação e impacto.
- Não existe versão `DRAFT` nem `AWAITING_APPROVAL` do mesmo órgão e exercício.
- Migração M2-11 aplicada (`pcas`, `pca_items`, colunas `pca_item_id`).

## Fluxo principal
1. Em `/pca/[pcaId]` (SCR-018), aba "Versões", a pessoa do planejamento vê a versão vigente ("Versão 1 — aprovada em 12/03/2027") e o botão "Criar revisão" (visível só com `meta.allowedActions` contendo `CREATE_REVISION`).
2. O diálogo pede o **motivo da revisão** (mínimo de 20 caracteres) e informa "116 itens serão copiados; 38 itens têm DFD ou processo vinculado, que serão mantidos".
3. O front chama `PCA-20` com `If-Match` da versão vigente e `Idempotency-Key`.
4. A API autoriza (`PCA_MANAGE`, escopo de órgão), valida o estado da versão base, a inexistência de revisão aberta e o motivo.
5. Na mesma transação: cria o `Pca` da versão `n + 1` em `DRAFT` (`previousVersionId`, `revisionReason`); copia os itens por `INSERT … SELECT` com `previousItemId` apontando para o item base; recalcula `itemsCount` e `totalPlannedValue`; grava a auditoria `pca.revise` e publica `PcaRevisionCreated` no outbox.
6. Responde `201` com `Location` da nova versão; o front navega para `/pca/{novaId}` com o banner "Revisão da versão 1 em elaboração. A versão 1 continua vigente até a aprovação."
7. A pessoa do planejamento edita os itens (inclusão, alteração, exclusão, importação, mudança de situação) pelas telas e endpoints da US-138/US-139.
8. A qualquer momento consulta a **comparação** (`PCA-22`) e o **impacto** (`PCA-23`), que lista os itens com vínculo ativo, os que seriam bloqueantes e os alertas.
9. Envia a revisão pelo fluxo da US-140; o envio executa também a verificação `RevisionLinkGuard` (RN-PCA-209). Sem pendência, a `Approval` de assunto `PCA` é criada para a autoridade.
10. A autoridade abre a aprovação em SCR-015, vê o motivo e o resumo da comparação com a versão vigente e decide (`APV-03`). Em `APPROVE`, o `PcaApprovalSubjectHandler` executa a substituição atômica (RN-PCA-212): versão anterior `SUPERSEDED`, revisão `APPROVED`, eventos `PcaStatusChanged` (um para cada versão).
11. O consumidor `PcaReconciliationScheduler` (US-143) dispara a reconciliação com `trigger = REVISION`; os vínculos migram para os itens da nova versão. SCR-018 mostra "Atualizando vínculos com a nova versão…" enquanto a execução estiver `RUNNING`.
12. Quem enviou e os vínculos com `PCA_MANAGE` no órgão recebem a notificação `PCA_APPROVAL_DECIDED`.

## Fluxos alternativos
- **FA-01 — Revisão devolvida ou rejeitada:** em `RETURN` ou `REJECT`, a revisão volta a `DRAFT` com o comentário da autoridade (RN-PCA-11); a versão vigente não muda; a pessoa corrige e reenvia.
- **FA-02 — Retirada do envio:** `PCA_SUBMIT` retira a revisão da aprovação (US-140); volta a `DRAFT`, sem efeito sobre a vigente.
- **FA-03 — Já existe revisão aberta:** `PCA-20` responde `409 PCA_REVISION_ALREADY_OPEN` com `meta.draftPcaId`; o diálogo troca o botão por "Abrir revisão em elaboração".
- **FA-04 — Exclusão de item com vínculo ativo:** na revisão, excluir um item cuja contraparte na versão anterior tem DFD ou processo ativo responde `409 PCA_ITEM_IN_USE` com a contagem; a mensagem orienta a manter o item ou desvincular os processos antes (US-142).
- **FA-05 — Cancelamento de item com vínculo ativo:** mudar para `CANCELED`, na revisão, um item com vínculo ativo na versão anterior é recusado com `PCA_ITEM_IN_USE` (mesmo tratamento da FA-04). `POSTPONED` é permitido e gera o alerta `POSTPONED_WITH_ACTIVE_LINKS` na visão de impacto.
- **FA-06 — Envio da revisão com item órfão:** se, apesar das travas (corrida: novo vínculo ao item base depois da exclusão na revisão), restar item sem contraparte, o envio responde `422 PCA_REVISION_LINKED_ITEMS` com `meta.items[]`; o planejamento restaura o item ou desvincula o processo.
- **FA-07 — Item órfão detectado na aprovação:** a decisão `APPROVE` refaz a verificação dentro da transação; se encontrar órfão, responde `422 PCA_REVISION_LINKED_ITEMS`, a `Approval` continua `PENDING` e a autoridade pode devolver (`RETURN`) com comentário.
- **FA-08 — Vínculo só de processo encerrado:** item excluído da revisão cujos vínculos são apenas de processos `CANCELED`, `COMPLETED` ou `PUBLISHED` não bloqueia; na reconciliação o vínculo permanece no item da versão `SUPERSEDED` (histórico) e a entrada do relatório sai como `UNRESOLVED` (entities.md §6.1).
- **FA-09 — Descartar a revisão:** em `DRAFT` (versão ≥ 2), "Descartar revisão" (`PCA-24`) exclui logicamente a revisão e seus itens e libera nova revisão; em `AWAITING_APPROVAL` é preciso retirar o envio antes.
- **FA-10 — Versão base deixou de ser vigente:** se outra revisão foi aprovada entre a abertura do diálogo e o envio, `PCA-20` responde `409 INVALID_STATE` (ou `412 VERSION_CONFLICT`) e o front recarrega as versões.
- **FA-11 — Usuário com escopo de unidade:** vê as versões, os totais e a comparação restritos aos itens da sua secretaria e não vê a ação "Criar revisão".
- **FA-12 — Reconciliação ainda em andamento ou falhada:** a nova versão já é a vigente; a execução e as consultas por item resolvem o vínculo antigo para o novo pelo `previousItemId` (RN-PCA-208). Em `FAILED`, SCR-018 oferece "Tentar novamente" a quem tem `PCA_RECONCILE` (US-143).

## Regras de negócio
- **RN-PCA-200** — Criar revisão exige: versão base em `APPROVED` (a vigente do órgão e exercício), `PCA_MANAGE` com escopo `ORGANIZATION`/`TENANT` cobrindo o órgão do plano e nenhuma versão `DRAFT`/`AWAITING_APPROVAL` no mesmo (órgão, exercício). Base em outro estado: `409 INVALID_STATE`. Revisão aberta: `409 PCA_REVISION_ALREADY_OPEN` (índice único parcial de `pcas`, que também decide a corrida). Refina RN-PCA-13.
- **RN-PCA-201** — Motivo obrigatório: `revisionReason` com 20 a 2.000 caracteres após `trim`, sem controle de formatação. Gravado na criação, alterável apenas enquanto a revisão estiver em `DRAFT` (cabeçalho do plano, US-138), sempre respeitando o mínimo. O motivo aparece na comparação, na tela da aprovação e no histórico de versões.
- **RN-PCA-202** — Cópia dos itens: todos os itens não excluídos da versão base, inclusive `POSTPONED` e `CANCELED`, por `INSERT … SELECT` em uma instrução. Copiam-se `code`, `departmentId`, `object`, `categoryId`, `catalogSystem`, `catalogCode`, `contractingTypeId`, `plannedValue`, `plannedMonth`, `quantity`, `unitOfMeasureId`, `priority`, `responsibleId`, `status`, `statusReason` e `notes`. `previousItemId` recebe o id do item base. `linkedProcessesCount` nasce 0 (a contagem é refeita na aprovação, RN-PCA-212) e `importRowNumber` nasce nulo. No `Pca`: `versionNumber = base + 1`, `previousVersionId`, `title` copiado, `importAttachmentId` e `exportedAt` nulos, `itemsCount` e `totalPlannedValue` recalculados.
- **RN-PCA-203** — Identidade do item entre versões: `code` e `pcaId` são imutáveis; `previousItemId` é gravado só na cópia. Um item **novo** na revisão (sem `previousItemId`) pode reutilizar o `code` de um item excluído da base apenas se este não tinha vínculo ativo; nesse caso ele é um item distinto (não herda vínculos). A unicidade `(tenant_id, pca_id, code)` vale dentro da versão.
- **RN-PCA-204** — A versão vigente não muda durante a revisão: seletor `/pca-items/lookup`, acompanhamento (US-144), exportação (US-145) e reconciliação só enxergam a versão `APPROVED`. Itens de versão `DRAFT`/`AWAITING_APPROVAL` nunca são alvo de vínculo.
- **RN-PCA-205** — Travas de vínculo na edição da revisão (extensão dos casos de uso da US-138, registradas como `RevisionLinkGuard`): (a) excluir item cuja contraparte (`previousItemId`) tem vínculo ativo é recusado com `PCA_ITEM_IN_USE`; (b) mudar para `CANCELED` um item nessa condição é recusado com `PCA_ITEM_IN_USE`. Fora da revisão (versão 1), valem as regras da US-138.
- **RN-PCA-206** — **Vínculo ativo** é todo `Process.pcaItemId` ou `Dfd.pcaItemId` que aponta para o item da versão base e cujo processo está em `DRAFT`, `IN_PROGRESS`, `AWAITING_APPROVAL`, `RETURNED` ou `SUSPENDED`. Vínculos de processos `CANCELED`, `COMPLETED` e `PUBLISHED` são **históricos**: não bloqueiam, mas também migram (RN-PCA-207). A leitura passa pela porta de leitura de vínculos (lacuna 3) e não filtra por visibilidade do usuário (a trava é do sistema), sem expor ao usuário processos que ele não vê (RN-PCA-210).
- **RN-PCA-207** — **Regra de migração dos vínculos.** Ao aprovar a revisão, todo `Process.pcaItemId`/`Dfd.pcaItemId` que aponta para item da versão `SUPERSEDED` passa a apontar para o item da nova versão com o mesmo `code` (equivalente a `previousItemId = id antigo`), pelo job de reconciliação `trigger = REVISION` da US-143, por alvo, em uma transação por alvo, idempotente, via `PcaLinkTarget` (D1), com `via = RECONCILIATION` e `previousPcaItemId` em `ProcessPcaItemLinked`. Os campos textuais `pcaYear`/`pcaItemCode` não são tocados. Sem contraparte (somente possível em vínculo histórico, FA-08), o vínculo permanece no item da versão `SUPERSEDED` e a entrada do relatório recebe `outcome = UNRESOLVED`.
- **RN-PCA-208** — Janela de migração: entre a aprovação e o fim da reconciliação, o item de uma versão `SUPERSEDED` ainda pode ser o alvo de vínculos. As consultas por item da versão vigente (execução, lista de processos — US-144) tratam como vinculados ao item `X` os alvos cujo `pcaItemId` é `X.id` **ou** `X.previousItemId`, até a execução `REVISION` terminar. Nenhum vínculo é perdido nem contado duas vezes.
- **RN-PCA-209** — Verificação de órfãos (`RevisionLinkGuard.check`): executa no **envio** da revisão (extensão da US-140) e na **decisão `APPROVE`** (dentro da transação). Falha se existir vínculo ativo (RN-PCA-206) em item da versão base sem item de mesmo `code` não excluído na revisão, ou cujo item correspondente esteja `CANCELED`. Resposta `422 PCA_REVISION_LINKED_ITEMS` com `meta.items[]` (`code`, `reason` `REMOVED` ou `CANCELED`, `activeLinks`). Itens `POSTPONED` não falham.
- **RN-PCA-210** — Impacto (`PCA-23`): devolve `blocking[]` (RN-PCA-209) e `warnings[]`: `POSTPONED_WITH_ACTIVE_LINKS` e `OVER_COMMITTED` (`plannedValue` da revisão menor que a soma dos valores estimados dos processos vinculados). Para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`, `OVER_COMMITTED` considera só processos não sigilosos e nunca informa valor de processo sigiloso (POL-09). A lista nominal de processos de cada item respeita a visibilidade do processo (DEC-024); os demais entram apenas em contagem agregada ("e mais 3 fora do seu escopo").
- **RN-PCA-211** — Comparação (`PCA-22`): confronta duas versões do **mesmo órgão e exercício** por `code`. Classificação: `ADDED` (só em `to`), `REMOVED` (só em `from`), `CHANGED` (algum campo comparado difere) e `UNCHANGED`. Campos comparados: `departmentId`, `object`, `categoryId`, `catalogSystem`, `catalogCode`, `contractingTypeId`, `plannedValue`, `plannedMonth`, `quantity`, `unitOfMeasureId`, `priority`, `responsibleId`, `status`. Totais por versão = soma de `plannedValue` dos itens não `CANCELED` (mesma regra de `totalPlannedValue`), mais `delta`. Padrão: `to` = versão consultada e `from` = `previousVersionId`. Com escopo de unidade, só os itens das unidades do escopo e totais recalculados nesse recorte.
- **RN-PCA-212** — **Aprovação da revisão (substituição atômica).** No `APPROVE` de plano com `versionNumber > 1`, em uma transação: trava as duas versões em ordem fixa (menor `versionNumber` primeiro); reexecuta o `RevisionLinkGuard`; a anterior vai a `SUPERSEDED` com `supersededAt`; só então a revisão vai a `APPROVED` com `approvedAt`, `approvedById` e `approvalId` (a ordem é exigida pelo índice único da vigente); copia `linkedProcessesCount` do item anterior para o novo (pelo `previousItemId`) até a recontagem da US-144; publica `PcaStatusChanged` `superseded` e `approved` e `ApprovalCompleted`; grava `approval.decide`. Qualquer falha desfaz tudo e a `Approval` segue `PENDING`.
- **RN-PCA-213** — Devolução, rejeição ou retirada da revisão (RN-PCA-11): a revisão volta a `DRAFT`; a versão vigente permanece intacta; o comentário e o histórico de decisões ficam visíveis em SCR-018.
- **RN-PCA-214** — Histórico imutável: versões `SUPERSEDED` nunca são excluídas nem têm itens alterados, exceto `status`, `statusReason` e `linkedProcessesCount` (RN-PCA-23); `PCA-21` lista todas as versões do exercício, inclusive a em elaboração; revisões descartadas (exclusão lógica) não aparecem.
- **RN-PCA-215** — Descarte (`PCA-24`): somente revisão (`versionNumber > 1`) em `DRAFT`, por `PCA_MANAGE` com escopo de órgão, com `If-Match`; exclusão lógica do `Pca` e de seus itens; sem efeito sobre vínculos (nenhum vínculo aponta para item de versão não aprovada). O descarte da versão 1 é da US-138.
- **RN-PCA-216** — Segregação (POL-22): quem enviou a revisão (`submittedById`) não a aprova (`PCA_SELF_APPROVAL_FORBIDDEN`, 403); a autoridade resolve-se por designação na `Approval` de assunto `PCA` com cobertura do órgão do plano (POL-03).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Motivo da revisão | `reason` → `Pca.revisionReason` | texto longo | Sim | 20–2.000 caracteres após `trim` (RN-PCA-201) | — |
| Versão base | `{pcaId}` (rota) | uuid | Sim | `APPROVED` e vigente (RN-PCA-200) | versão exibida |
| Versão da revisão | `Pca.versionNumber` | inteiro | — | `base + 1`; imutável | gerado |
| Versão anterior | `Pca.previousVersionId` | uuid | — | FK `pcas`; obrigatório se versão > 1 | versão base |
| Título | `Pca.title` | texto (200) | — | copiado; editável em `DRAFT` (US-138) | `"PCA {ano}"` |
| Situação da versão | `Pca.status` | `PcaPlanStatus` | — | `DRAFT` na criação | `DRAFT` |
| Itens copiados | `meta.itemsCopied` | inteiro | — | resposta de `PCA-20` | cópia |
| Item da versão anterior | `PcaItem.previousItemId` | uuid | — | FK `pca_items`; mesmo `code` | item base |
| Substituída em | `Pca.supersededAt` | data/hora | — | preenchido na aprovação da revisão | sistema |
| Versão de origem da comparação | `from` | uuid | Não | versão do mesmo órgão e exercício | `previousVersionId` |
| Versão de destino da comparação | `to` | uuid | Não | idem | versão consultada |
| Filtro de mudança | `change` | lista de `ADDED`, `REMOVED`, `CHANGED`, `UNCHANGED` | Não | vírgula = OU | `ADDED,REMOVED,CHANGED` |
| Filtros da comparação | `departmentId`, `categoryId`, `q` | uuid / texto | Não | `q` ≥ 2 caracteres (código e objeto) | — |
| Paginação | `page`, `pageSize` | inteiros | Não | `pageSize` ≤ 100 | 1 / 50 |
| Motivo do descarte | `reason` | texto | Não | até 500 caracteres | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Motivo ausente ou com menos de 20 caracteres | Front + API (Zod) | "Explique o motivo da revisão com pelo menos 20 caracteres." | `VALIDATION_ERROR` (`TOO_SHORT`) |
| V-02 | Motivo com mais de 2.000 caracteres | Front + API | "O motivo pode ter até 2.000 caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-03 | Versão base fora de `APPROVED` ou já substituída | API | "Só é possível revisar o plano vigente, já aprovado." | `INVALID_STATE` |
| V-04 | Já existe revisão em elaboração ou em aprovação | API (+ índice único) | "Já existe uma revisão deste plano em andamento." | `PCA_REVISION_ALREADY_OPEN` |
| V-05 | Escopo sem cobertura do órgão do plano | API | "Você não tem permissão para revisar o plano do órgão." | `PERMISSION_DENIED` |
| V-06 | `If-Match` ausente em `PCA-20`/`PCA-24` | API | — | `PRECONDITION_REQUIRED` |
| V-07 | Versões de órgãos ou exercícios diferentes na comparação | API | "As versões escolhidas não pertencem ao mesmo plano." | `VALIDATION_ERROR` (`VERSIONS_NOT_COMPARABLE`) |
| V-08 | Exclusão de item com vínculo ativo na versão anterior | API | "O item {code} tem {n} DFD(s) ou processo(s) em andamento. Mantenha o item ou desvincule-os antes." | `PCA_ITEM_IN_USE` |
| V-09 | Cancelamento de item com vínculo ativo na versão anterior | API | idem | `PCA_ITEM_IN_USE` |
| V-10 | Envio ou aprovação com item órfão (RN-PCA-209) | API | "A revisão deixa {n} item(ns) com processo em andamento sem destino: {codes}." | `PCA_REVISION_LINKED_ITEMS` |
| V-11 | Descarte de versão 1, de plano fora de `DRAFT` ou aprovado | API | "Só é possível descartar uma revisão em elaboração." | `INVALID_STATE` |
| V-12 | Autoaprovação do plano revisado | API | "Quem enviou o plano não pode aprová-lo." | `PCA_SELF_APPROVAL_FORBIDDEN` |
| V-13 | `pageSize` > 100 ou `change` fora do enum | Front + API (Zod) | — | `VALIDATION_ERROR` |

## Permissões
- **Permissão:** `PCA_MANAGE` (risco `M`) com escopo `ORGANIZATION` ou `TENANT` cobrindo o órgão do plano para `PCA-20` e `PCA-24`; `PCA_VIEW` para `PCA-21`, `PCA-22` e `PCA-23` (recortado pelo escopo de unidade, §5.1); `APPROVAL_DECIDE` para a autoridade decidir a revisão (`APV-03`).
- **Políticas:** POL-22 (elaborar, revisar e aprovar o PCA; segregação de quem enviou), POL-03 (decisão por designação com cobertura do órgão do plano), POL-09 (valores estimados de processos sigilosos só na visão de impacto e mascarados).
- **MFA:** não exigido pelas permissões `M`; a decisão da autoridade segue o MVP 1 (POL-14).
- **Sem permissão:** a UI esconde "Criar revisão" e "Descartar revisão"; a API responde `403 PERMISSION_DENIED` com `access.denied` (`reasonCode` = permissão). Plano de outro tenant, inexistente ou fora do escopo de unidade: `404 NOT_FOUND`. `CONSULTOR_EXTERNO` recebe `404` em todo o PCA (L-07).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `PcaRevisionCreated` | `pca.revision_created` | Commit de `PCA-20` | `pcaId` (nova versão), `previousVersionId`, `versionNumber`, `itemsCopied`; consumidor `M` (marcos/leitura) |
| `PcaStatusChanged` | `pca.status_changed.superseded` | Commit da aprovação da revisão | `pcaId` (versão anterior), `organizationId`, `year`, `versionNumber`, `fromStatus: APPROVED`, `toStatus: SUPERSEDED`, `approvalId` |
| `PcaStatusChanged` (`PcaApproved`) | `pca.status_changed.approved` | Mesmo commit, publicado depois do anterior | `versionNumber > 1`; consumidores `N R X`; o `X` (`PcaReconciliationScheduler`) abre a reconciliação com `trigger = REVISION` quando `versionNumber > 1` |
| `ApprovalCompleted` | `approval.completed` | Mesmo commit | `subjectType = PCA`, `pcaId`, `processId` nulo (US-140/US-134) |

Descartar a revisão não gera evento de domínio (lacuna 5); o ato fica na auditoria.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `PCA_APPROVAL_DECIDED` | Quem enviou a revisão; vínculos com `PCA_MANAGE` no órgão (máx. 50) | in-app + e-mail (padrão ligado) | `PcaStatusChanged` aprovado, ou volta a `DRAFT` por decisão (devolução/rejeição) |
| `APPROVAL_REQUESTED` | Autoridade resolvida da `Approval` de assunto `PCA` | in-app (obrigatória) + e-mail | Envio da revisão (US-140) |
| `PCA_RECONCILIATION_PENDING` | Vínculos com `PCA_RECONCILE` no órgão | in-app + e-mail | Fim da reconciliação `REVISION` com pendências (US-143) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Revisar o PCA aprovado com nova versão

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o plano "PCA 2027" do órgão "Prefeitura A" está "APPROVED" na versão 1 com 116 itens
    And "Helena" tem "PCA_MANAGE" e "PCA_SUBMIT" com escopo "ORGANIZATION"
    And "Paulo" é a autoridade competente designada para aprovar o plano
    And o item "PCA-017" tem 2 processos "IN_PROGRESS" vinculados

  Scenario: [Sucesso] Criar a revisão copia os itens e mantém a versão 1 vigente
    When "Helena" criar a revisão informando o motivo "Reajuste do valor do item de TIC após nova cotação"
    Then deve existir a versão 2 do plano em "DRAFT" com "previousVersionId" igual à versão 1
    And a versão 2 deve ter 116 itens com "previousItemId" apontando para o item de mesmo código da versão 1
    And a versão 1 deve continuar "APPROVED"
    And o seletor "/pca-items/lookup" deve continuar devolvendo apenas itens da versão 1
    And deve gerar registro de auditoria "pca.revise" com "itemsCopied" 116
    And deve gerar o evento "PcaRevisionCreated"

  Scenario: [Sucesso] Aprovar a revisão substitui a vigente e migra os vínculos por código
    Given que "Helena" alterou o valor previsto do item "PCA-017" na versão 2 e a enviou
    When "Paulo" aprovar a solicitação
    Then a versão 2 deve estar "APPROVED" com "approvedAt" e "approvedById" de "Paulo"
    And a versão 1 deve estar "SUPERSEDED" com "supersededAt" preenchido
    And deve gerar os eventos "PcaStatusChanged" "superseded" e "approved" nessa ordem
    And a reconciliação com "trigger" "REVISION" deve apontar os 2 processos de "PCA-017" para o item "PCA-017" da versão 2
    And os campos textuais "pcaYear" e "pcaItemCode" dos processos devem permanecer inalterados
    And "Helena" deve receber a notificação "PCA_APPROVAL_DECIDED"

  Scenario: [Sucesso] Comparar versões mostra itens incluídos, removidos e alterados
    Given que a versão 2 tem 3 itens novos, 2 itens removidos e 5 itens com valor alterado
    When "Helena" consultar a comparação da versão 2 com a versão 1
    Then a resposta deve trazer "summary.added" 3, "summary.removed" 2 e "summary.changed" 5
    And cada item alterado deve listar o campo, o valor anterior e o novo
    And "summary.delta" deve ser a diferença entre os totais, sem os itens cancelados

  Scenario: [Validação] Motivo curto ou ausente
    When "Helena" tentar criar a revisão com o motivo "ajuste"
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "reason"
    And nenhuma versão deve ser criada

  Scenario: [Validação] Item com processo em andamento não pode ser excluído na revisão
    Given que existe a revisão em "DRAFT"
    When "Helena" excluir o item "PCA-017" da revisão
    Then a API deve responder 409 com código "PCA_ITEM_IN_USE" e "meta.activeLinks" 2
    And o item deve continuar na revisão

  Scenario: [Validação] Envio da revisão com item cancelado que tem processo em andamento
    Given que o item "PCA-017" está "CANCELED" na revisão por uma gravação anterior à trava
    When "Helena" enviar a revisão para aprovação
    Then a API deve responder 422 com código "PCA_REVISION_LINKED_ITEMS" listando "PCA-017" com motivo "CANCELED"
    And a revisão deve continuar "DRAFT" e nenhuma "Approval" deve ser criada

  Scenario: [Validação] Comparar versões de exercícios diferentes
    Given que existe o plano "PCA 2026" do mesmo órgão
    When "Helena" comparar a versão 2 do "PCA 2027" com o "PCA 2026"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e "VERSIONS_NOT_COMPARABLE"

  Scenario: [Permissão] Usuário sem PCA_MANAGE ou com escopo de unidade não cria revisão
    Given que "Bruno" tem "PCA_VIEW" mas não "PCA_MANAGE"
    And "Marta" tem "PCA_MANAGE" com escopo apenas da "Secretaria de Saúde"
    When "Bruno" e "Marta" tentarem criar a revisão
    Then a API deve responder 403 com código "PERMISSION_DENIED" para os dois
    And o botão "Criar revisão" não deve ser exibido para eles
    And deve gerar registro de auditoria "access.denied" para cada tentativa

  Scenario: [Permissão] Quem enviou a revisão não a aprova
    Given que "Paulo" enviou a revisão e também tem "APPROVAL_DECIDE"
    When "Paulo" tentar aprovar a solicitação
    Then a API deve responder 403 com código "PCA_SELF_APPROVAL_FORBIDDEN"
    And a revisão deve continuar "AWAITING_APPROVAL"

  Scenario: [Tenant incorreto] Revisar o plano de outro tenant
    Given que existe o plano "PCA 2027" no tenant "Prefeitura B"
    When "Helena", no tenant "Prefeitura A", tentar criar revisão desse plano
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Tenant incorreto] Comparar versão de outro tenant
    Given que "Helena" conhece o identificador de uma versão do tenant "Prefeitura B"
    When "Helena" consultar a comparação usando esse identificador em "from"
    Then a API deve responder 404 com código "NOT_FOUND"

  Scenario: [Duplicidade] Já existe uma revisão em andamento
    Given que "Helena" já criou a revisão e ela está em "DRAFT"
    When "Carlos", também do planejamento, tentar criar outra revisão
    Then a API deve responder 409 com código "PCA_REVISION_ALREADY_OPEN" e "meta.draftPcaId" da revisão existente
    And não deve existir uma terceira versão

  Scenario: [Duplicidade] Reenvio do pedido com a mesma chave de idempotência
    Given que "Helena" criou a revisão com a "Idempotency-Key" "k-141"
    When a mesma requisição for reenviada com o mesmo corpo
    Then a API deve responder com o cabeçalho "Idempotent-Replayed" verdadeiro e a mesma versão
    And deve existir uma única revisão e um único evento "PcaRevisionCreated"

  Scenario: [Concorrência] Duas pessoas criam a revisão ao mesmo tempo
    Given que "Helena" e "Carlos" enviam "PCA-20" ao mesmo tempo com a mesma versão base
    Then exatamente uma criação deve ter sucesso
    And a outra deve receber 409 "PCA_REVISION_ALREADY_OPEN"

  Scenario: [Concorrência] Novo vínculo ao item base chega depois da exclusão na revisão
    Given que o item "PCA-030" foi excluído da revisão e não tinha vínculo
    And um requisitante vincula um novo DFD ao item "PCA-030" da versão 1 antes do envio
    When "Helena" enviar a revisão
    Then a API deve responder 422 com código "PCA_REVISION_LINKED_ITEMS" listando "PCA-030" com motivo "REMOVED"

  Scenario: [Concorrência] A revisão é editada enquanto a autoridade aprova
    Given que a revisão está "AWAITING_APPROVAL"
    When "Helena" tentar alterar um item da revisão ao mesmo tempo em que "Paulo" aprova
    Then a alteração deve receber 409 "PCA_NOT_EDITABLE"
    And a aprovação deve concluir com a versão 2 "APPROVED"

  Scenario: [Falha de banco] A cópia dos itens falha no meio da criação
    Given que o banco de dados falha durante a cópia dos itens
    When "Helena" criar a revisão
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma versão, item, auditoria "pca.revise" ou evento "PcaRevisionCreated" deve ser gravado
    And a versão 1 deve continuar "APPROVED"

  Scenario: [Falha de banco] A substituição falha ao gravar a versão anterior
    Given que o banco de dados falha ao marcar a versão 1 como "SUPERSEDED"
    When "Paulo" aprovar a revisão
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a "Approval" deve continuar "PENDING", a versão 2 "AWAITING_APPROVAL" e a versão 1 "APPROVED"
    And nenhum evento "PcaStatusChanged" deve ser publicado

  Scenario: [Falha de integração] Redis e relay do outbox indisponíveis na aprovação
    Given que o Redis das filas está indisponível
    When "Paulo" aprovar a revisão
    Then a API deve responder 200 e a versão 2 deve estar "APPROVED"
    And os eventos "PcaStatusChanged" devem ficar "PENDING" no outbox até o relay voltar
    And enquanto a reconciliação não rodar, a execução da versão 2 deve contar os vínculos do item anterior pelo "previousItemId"
    And depois do relay a reconciliação deve rodar uma única vez e as notificações devem sair sem duplicidade

  Scenario: [Falha de integração] A reconciliação da revisão falha
    Given que a execução com "trigger" "REVISION" terminou "FAILED"
    When "Helena" abrir a aba "Versões"
    Then deve ser exibido o aviso "A atualização dos vínculos não terminou" com a ação "Tentar novamente" para quem tem "PCA_RECONCILE"
    And os DFDs e processos devem continuar visíveis no item correspondente da versão 2
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Motivo inválido | 422 | `VALIDATION_ERROR` | "Explique o motivo da revisão com pelo menos 20 caracteres." | Erro no campo; mantém o texto |
| Versão base não vigente | 409 | `INVALID_STATE` | "Só é possível revisar o plano vigente, já aprovado." | Recarrega as versões |
| Revisão já aberta | 409 | `PCA_REVISION_ALREADY_OPEN` | "Já existe uma revisão deste plano em andamento." | Oferece "Abrir revisão em elaboração" |
| Plano alterado por outra pessoa | 412 | `VERSION_CONFLICT` | "Outra pessoa alterou este plano. Recarregue e tente de novo." | Recarrega e mantém o motivo |
| Sem `If-Match` | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página e tente de novo." | Recarrega |
| Item com vínculo ativo (exclusão/cancelamento) | 409 | `PCA_ITEM_IN_USE` | "O item {code} tem {n} DFD(s) ou processo(s) em andamento. Mantenha o item ou desvincule-os antes." | Abre o painel de impacto do item |
| Revisão deixa vínculo ativo sem destino | 422 | `PCA_REVISION_LINKED_ITEMS` | "A revisão deixa {n} item(ns) com processo em andamento sem destino: {codes}." | Abre o painel de impacto; bloqueia envio e aprovação |
| Plano em estado que não aceita edição | 409 | `PCA_NOT_EDITABLE` | "Este plano não pode ser alterado agora." | Recarrega |
| Autoaprovação | 403 | `PCA_SELF_APPROVAL_FORBIDDEN` | "Quem enviou o plano não pode aprová-lo." | Oculta a decisão |
| Versões incomparáveis | 422 | `VALIDATION_ERROR` | "As versões escolhidas não pertencem ao mesmo plano." | Restaura a seleção anterior |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para revisar o plano do órgão." | Oculta a ação |
| Plano ou versão de outro tenant/escopo | 404 | `NOT_FOUND` | "Plano não encontrado." | Volta à lista de planos |
| Chave de idempotência reutilizada com corpo diferente | 422 | `IDEMPOTENCY_KEY_REUSED` | "Não foi possível repetir esta ação com os mesmos dados." | Recarrega as versões |
| Requisição original em processamento | 409 | `IDEMPOTENCY_IN_PROGRESS` | "A criação da revisão já está em andamento." | Aguarda e recarrega |
| Banco ou fila indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Botão "Tentar novamente"; mantém o formulário |

## Dependências
- **Stories:** US-140 (envio, retirada e decisão do plano de assunto `PCA`; o `PcaApprovalSubjectHandler` e o ponto de extensão do envio). Indiretas: US-138 e US-139 (edição e importação dos itens da revisão), US-051/US-052 (aprovação do MVP 1). Esta story é habilitadora da US-142 (seletor só de versão vigente), da US-143 (reconciliação `REVISION`), da US-144 e da US-145. Os efeitos sobre vínculos são testados com a porta de leitura: sem a US-142 entregue, a porta devolve zero vínculos e as travas ficam inertes; a migração real é verificada na US-143.
- **Decisões/ADRs:** DEC-197, DEC-029, DEC-030, DEC-022, DEC-024, DEC-105, DEC-104, DEC-193 (aprovação de assunto `PCA` com a mecânica de linhas), DEC-040; domains.md §12.3 (portas).
- **Configurações:** nenhuma nova. Mínimo de 20 caracteres e teto de 2.000 do motivo fixados em código (RN-PCA-201).
- **Lacunas nas fontes canônicas:**
  1. Códigos de erro novos: `PCA_REVISION_ALREADY_OPEN` (409) e `PCA_REVISION_LINKED_ITEMS` (422), a registrar em api.md §2 (padrão de `WORKFLOW_DRAFT_EXISTS`). Reutilizados: `INVALID_STATE`, `PCA_ITEM_IN_USE`, `PCA_NOT_EDITABLE`, `PCA_SELF_APPROVAL_FORBIDDEN`, `VALIDATION_ERROR` (com `VERSIONS_NOT_COMPARABLE`).
  2. Endpoints `PCA-20` a `PCA-24` (IDs provisórios; a feature só os indica como `POST /pca/{id}/revisions`, `GET /pca/{id}/versions` e `GET /pca/{id}/versions/compare`). `PCA-23` (impacto) e `PCA-24` (descartar revisão) não existem nas fontes. As rotas usam o prefixo `/pcas/{pcaId}` (inglês, plural) no lugar do `/pca/{id}` indicativo.
  3. Operações de **leitura** de vínculos na porta `PcaLinkTarget` (hoje só "listar referências pendentes e gravar"): `findActiveLinks(itemIds)` (processos e DFDs com status do processo, em lote, sem filtro de visibilidade) e a leitura por item da US-144 (`activeLinkState`, `summarizeLinks`, lacuna 2 daquela story). Sem elas o módulo `pca` (N2) não consegue verificar vínculos sem chamar `process`/`dfd`. Implementada por `process` e `dfd`.
  4. Exceção ao "sem `DELETE` para a aplicação" de `Pca` (entities.md §4.1): exclusão lógica de **revisão** em `DRAFT` (versão ≥ 2) pelo descarte (`PCA-24`), com a auditoria nova `pca.discard_revision` (`DATA_CHANGE`). Sem ela, uma revisão criada por engano bloquearia o exercício indefinidamente.
  5. Descarte sem evento de domínio e sem notificação; se o consumo do `analytics` precisar saber, acrescentar `PcaStatusChanged` ou evento novo.
  6. Regra de migração de vínculos fixada aqui com **exceção** ao texto de entities.md §6.1 ("item sem correspondente mantém o vínculo antigo e entra no relatório como `UNRESOLVED`"): para vínculo **ativo** a revisão é bloqueada (RN-PCA-205/69); a regra do texto original vale só para vínculo histórico (FA-08). Confirmar com produto.
  7. O check `(pca_item_id IS NOT NULL) = (pca_link_status = 'LINKED')` de `Process`/`Dfd` (entities.md §5) impede que o vínculo mantido em item `SUPERSEDED` seja marcado `UNRESOLVED`; adotado: o vínculo histórico permanece `LINKED` e o `UNRESOLVED` fica só na entrada do relatório.
  8. Ponto de extensão do envio do plano (`PcaSubmitPolicy`, nome interno) e do `PcaApprovalSubjectHandler`: nomes provisórios, a alinhar com a US-140.
  9. Janela de migração: a leitura por `previousItemId` (RN-PCA-208) é regra nova; o `PcaExecutionTracker` e as consultas de US-144 a implementam.

## Impacto técnico
- **Concorrência e unicidade:** os índices únicos parciais de `pcas` (uma versão em elaboração e uma vigente por órgão e exercício) decidem as corridas; a ordem "anterior `SUPERSEDED` antes de nova `APPROVED`" é obrigatória porque o índice único não é diferido. Travar as duas linhas em ordem fixa evita *deadlock* com a edição e com outra decisão.
- **Cópia em lote:** um `INSERT … SELECT` para até 2.000 itens roda em poucos centésimos de segundo; sem laço por item na aplicação. Eventos por item não são emitidos na cópia (`PcaRevisionCreated.itemsCopied` resume).
- **Migração assíncrona:** a reconciliação `REVISION` pode demorar a rodar; a leitura por `previousItemId` evita janela de dados inconsistentes e a recontagem final é idempotente.
- **Segurança:** a trava de vínculo é do sistema e não depende da visibilidade do usuário, mas a resposta só nomeia processos que ele pode ver (DEC-024); valores de processos sigilosos nunca saem para quem não tem POL-09; mensagens de erro não revelam existência de dados de outro tenant.
- **Compatibilidade:** nenhuma alteração em endpoints do MVP 1; `APV-02`/`APV-03` já aceitam assunto `PCA` (US-140). Sem migração de dados nova; índices de apoio listados em "Banco de dados".
- **Performance:** comparação por junção de `pca_items` por `code` das duas versões, paginada; p95 ≤ 2 s para 500 itens (medido na suíte de performance, no endurecimento).

## Backend
- **Módulo(s):** `pca` (dono de `Pca`, `PcaItem`, comparação, impacto, travas), `approval` (decisão do assunto `PCA` — o `ApprovalSubjectHandler` é implementado por `pca`), `process` e `dfd` (implementam a leitura da porta `PcaLinkTarget`), `notification`, `audit`, `platform` (outbox).
- **Casos de uso:** `CreatePcaRevisionCommand` (`PCA-20`), `DiscardPcaRevisionCommand` (`PCA-24`), `ListPcaVersionsQuery` (`PCA-21`), `ComparePcaVersionsQuery` (`PCA-22`), `GetRevisionImpactQuery` (`PCA-23`), `RevisionLinkGuard` (usado por exclusão/mudança de situação de item, pelo envio e pela decisão), extensão `PcaApprovalSubjectHandler.onApprove` para `versionNumber > 1`.
- **Domínio:** `Pca.revise(reason)` (invariantes: base `APPROVED`, motivo, versão `n + 1`); `PcaItem.copyForRevision()`; `PcaVersionDiff` (por `code`, campos comparados fixos); `Pca.supersede()`; política de vínculo ativo (conjunto de `ProcessStatus`).
- **Integrações internas:** `PcaLinkTarget` (leitura de vínculos — lacuna 3), `ApprovalFacade` (assunto `PCA`), `OrganizationFacade` (nomes de secretaria na comparação), `CatalogFacade` (categoria), `OutboxWriter`, `AuditService`.
- **Transação:** `PCA-20`: contexto de tenant → validações → lock da base → criação do `Pca` → cópia dos itens → totais → auditoria → outbox. Decisão: lock ordenado das duas versões → guarda → `SUPERSEDED` → `APPROVED` → contagens → auditoria → outbox, tudo na transação da decisão da `Approval`.

## Frontend
- **Tela(s):** SCR-018 (`/pca/[pcaId]`, aba "Versões" e modo de revisão), SCR-014 e SCR-015 (decisão com resumo da comparação).
- **Componentes:** `PcaVersionTimeline` (versões com situação, motivo, aprovador e data), `CreateRevisionDialog` (motivo com contador de caracteres), `RevisionBanner` ("Revisão da versão N em elaboração"), `VersionCompareTable` (filtros por tipo de mudança, secretaria e categoria; diff campo a campo), `RevisionImpactPanel` (bloqueios, alertas e processos com link para `/processos/[id]`), `ReconciliationStatusBadge`.
- **Estados:** loading (skeleton da linha do tempo e da tabela), vazio ("Nenhuma diferença entre as versões"), erro (mensagem e "Tentar novamente"), sucesso (toast "Revisão criada. A versão 1 continua vigente.").
- **Acessibilidade e responsividade:** mudança identificada por texto e ícone ("Incluído", "Removido", "Alterado"), não só por cor; diálogo com foco gerenciado e `aria-describedby` para o contador; tabela de comparação vira cartões em largura abaixo de 768 px; erros de envio anunciados por `aria-live`.

## Banco de dados
- **Tabelas:** `pcas` (colunas de versão, `revision_reason`, `superseded_at`), `pca_items` (`previous_item_id`), `approvals` (`pca_id`), `outbox_events`, `audit_logs`; leitura de `processes` e `dfds` pela porta.
- **Migrações:** nenhuma nova (M2-11 já cria as tabelas). Índices de apoio, se faltarem: `pcas (tenant_id, organization_id, year, version_number DESC)`.
- **Índices/constraints relevantes:** únicos parciais de `pcas` (um `DRAFT`/`AWAITING_APPROVAL` e um `APPROVED` por órgão e exercício); check `version_number = 1 OR (previous_version_id IS NOT NULL AND revision_reason IS NOT NULL)`; `(tenant_id, previous_item_id)` em `pca_items`; trigger de imutabilidade de `pca_id`/`code`; trigger de itens em plano `APPROVED`/`SUPERSEDED`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `PCA-20` | POST | `/pcas/{pcaId}/revisions` | `{ reason }` · `If-Match` da versão base · `Idempotency-Key` | `201 { data: Pca (nova versão, DRAFT), meta: { itemsCopied, linkedItemsCount } }` · `Location` · `ETag` | 201, 403, 404, 409, 412, 422, 428, 503 |
| `PCA-21` | GET | `/pcas/{pcaId}/versions` | — | `200 { data: [ { id, versionNumber, status, title, revisionReason, previousVersionId, submittedAt, approvedAt, approvedBy, supersededAt, itemsCount, totalPlannedValue, approvalId } ], meta: { currentVersionId, openRevisionId, allowedActions[], reconciliation: { runId, status } } }` | 200, 403, 404 |
| `PCA-22` | GET | `/pcas/{pcaId}/versions/compare?from=&to=&change=&departmentId=&categoryId=&q=&page=&pageSize=` | filtros e paginação | `200 { data: { from, to, summary { added, removed, changed, unchanged, totalFrom, totalTo, delta }, items: [ { code, change, fromItem, toItem, fields: [ { name, from, to } ] } ] }, meta }` | 200, 403, 404, 422 |
| `PCA-23` | GET | `/pcas/{pcaId}/revision-impact` | — | `200 { data: { blocking: [ { code, reason, activeLinks, processes: [ { id, code, status } ], hiddenLinks } ], warnings: [ { code, kind, details } ] } }` | 200, 403, 404, 409 |
| `PCA-24` | POST | `/pcas/{pcaId}/discard` | `{ reason? }` · `If-Match` | `200 { data: { id, discardedAt } }` | 200, 403, 404, 409, 412, 428, 503 |
| `APV-02` | GET | `/approvals/{id}` | — | detalhe com `subjectType = PCA`, `pcaId` e resumo da revisão (US-140) | 200, 403, 404 |
| `APV-03` | POST | `/approvals/{id}/decide` | decisão (US-140) | em `APPROVE` de revisão executa a substituição (RN-PCA-212); pode responder `422 PCA_REVISION_LINKED_ITEMS` | 200, 403, 404, 409, 412, 422, 503 |

## Logs
- `info` `pca.revision_created` — `pcaId`, `previousVersionId`, `versionNumber`, `itemsCopied`, `durationMs`.
- `info` `pca.revision_superseded` — `pcaId`, `supersededPcaId`, `approvalId`, `linkedItemsCount`.
- `warn` `pca.revision_rejected` — `reason` (`ALREADY_OPEN`, `LINKED_ITEMS`, `BASE_NOT_CURRENT`), `itemsBlocking`.
- `warn` `pca.revision_discarded` — `pcaId`, `versionNumber`.
- `error` `pca.revision_failed` — `step` (`COPY`, `SUPERSEDE`), causa técnica sem dados de negócio.
- **Nunca logar:** o motivo da revisão, objeto dos itens, valores previstos, nomes de pessoas, comentários da autoridade e valores de processos sigilosos.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `pca.revise` | `DATA_CHANGE` | Commit de `PCA-20` | `metadata`: `pcaId`, `previousVersionId`, `versionNumber`, `itemsCopied`, `reasonLength` (sem o texto) |
| `pca.update` | `DATA_CHANGE` | Aprovação da revisão (versão anterior) | `changes`: `status` `APPROVED` → `SUPERSEDED`, `supersededAt`; `metadata`: `supersededByPcaId`, `approvalId` |
| `pca.discard_revision` | `DATA_CHANGE` | Commit de `PCA-24` | `metadata`: `pcaId`, `versionNumber`, `itemsDiscarded` (ação nova — lacuna 4) |
| `approval.decide` | `WORKFLOW` | Decisão da autoridade (US-140) | como no MVP 1, com `subjectType = PCA` e `pcaId` |
| `access.denied` | `ACCESS` | Tentativa sem permissão ou escopo | `reasonCode` da permissão |

## Testes necessários
- **Unitários:** `Pca.revise` (estados, motivo, número da versão); cópia de item (campos copiados, zerados e nulos); `PcaVersionDiff` (adicionado, removido, alterado, sem mudança; totais sem cancelados); política de vínculo ativo por `ProcessStatus`; `RevisionLinkGuard` (removido, cancelado, adiado, vínculo histórico); ordem de substituição.
- **Integração (Testcontainers PostgreSQL + Redis):** criação atômica com cópia de 500 itens; rollback total por falha na cópia e na substituição; índices únicos sob corrida; aprovação de revisão com `Approval` real; eventos na ordem `superseded` → `approved`; janela de migração (leitura por `previousItemId`); idempotência por `Idempotency-Key`; descarte.
- **API/contrato:** `PCA-20` a `PCA-24` com `ETag`/`If-Match`; códigos novos; compatibilidade de `APV-02`/`APV-03` com o assunto `PCA`.
- **RBAC e multi-tenant:** `PCA_MANAGE` com escopo de órgão versus de unidade; `PCA_VIEW` recortado por unidade; `CONSULTOR_EXTERNO` sem acesso; versão, item ou `from`/`to` de outro tenant → 404 (suíte `test/tenant-leak`); processos fora de visibilidade só em contagem; valor sigiloso nunca na visão de impacto sem POL-09.
- **Concorrência:** duas criações simultâneas; edição durante `AWAITING_APPROVAL`; novo vínculo concorrente à exclusão do item; duas decisões da mesma `Approval`.
- **E2E (Playwright):** revisar, comparar, enviar, aprovar como autoridade, ver a versão 1 como substituída e os vínculos no item da versão 2; erro de item com processo em andamento e recuperação.
- **Acessibilidade/performance:** axe na linha do tempo, no diálogo e na tabela de comparação; comparação de 500 itens e cópia de 500 itens na suíte de performance (medidas no endurecimento).

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
- [ ] Teste de contrato com a US-143: vínculos migram por `code` e vínculo histórico sem contraparte vira `UNRESOLVED` no relatório
- [ ] Nunca há duas versões `APPROVED` nem nenhuma, em teste de concorrência da substituição

## Estimativa
**M** — criação e cópia atômica de versão, comparação por `code`, impacto com leitura de vínculos por porta, extensão do envio e da decisão com substituição atômica e travas de vínculo; sem tela ou módulo novo além da aba de versões.

## Prioridade
**P1** — sem revisão o plano aprovado não pode mudar ao longo do exercício; é pré-requisito do uso real do PCA, mas não bloqueia o fluxo de aprovação inicial (US-140) nem o vínculo.
