---
id: US-142
title: "Vincular DFD e processo a item do PCA"
epic: EP-023
feature: FT-070
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-005, US-014, US-140]
modules: [pca, process, dfd, document, organization, timeline, audit, platform]
screens: [SCR-005, SCR-006, SCR-007, SCR-041]
endpoints: [PCA-40, PCA-41, PCA-42, PCA-43, PRC-02, PRC-04, PRC-05, PRC-07, DFD-02, DFD-03, DFD-04, DOC-08, SET-02]
permissions: [PROCESS_CREATE, PROCESS_UPDATE, DFD_UPDATE, PCA_VIEW, SETTINGS_MANAGE]
events: [ProcessCreated, ProcessUpdated, ProcessPcaItemLinked, ProcessPcaItemUnlinked, DfdPcaItemLinked, DfdPcaItemUnlinked]
---

# US-142 — Vincular DFD e processo a item do PCA

## Título
Vincular o DFD e o processo a um item do plano aprovado do exercício, com herança, troca justificada e situação do vínculo

## Descrição
**Como** servidor da área requisitante ou do planejamento que registra ou corrige um DFD ou um processo, **quero** escolher o item do PCA aprovado a que a demanda pertence, em vez de digitar exercício e código à mão, **para** que cada demanda aponte para o item exato do plano, o vínculo acompanhe o DFD até o processo e o órgão enxergue, no painel do processo, qual item do plano está sendo atendido.

No MVP 1 o PCA é só texto (`pcaStatus`, `pcaYear`, `pcaItemCode`, `pcaJustification` — DEC-029). Com o plano aprovado (US-140), `Process` e `Dfd` ganham `pcaItemId` (FK composta com o tenant) e `pcaLinkStatus`. Esta story entrega: o seletor `GET /pca-items/lookup`; a escolha do item no cadastro do processo (SCR-005), no DFD (SCR-007) e na edição de ambos; a validação do item (mesmo órgão e exercício, plano `APPROVED` vigente, item não `CANCELED`); a verificação do **saldo previsto** do item contra o valor estimado do processo, com severidade configurável; a herança do vínculo entre processo e DFD; o espelhamento em `pcaStatus`/`pcaYear`/`pcaItemCode`; a troca e a remoção do vínculo com justificativa, histórico, timeline e auditoria; a regra opcional `pca.requireLinkForPlanned`; e o cartão do vínculo no painel situacional do processo (SCR-006). As referências já gravadas como texto pelo MVP 1 são resolvidas pela US-143, não por esta story.

## Contexto
- DEC-197 cria o módulo `pca` e o vínculo por `pcaItemId`; a DEC-029 manda manter os campos textuais como histórico. `entities.md` (MVP 2) §5.1 e §5.2 fixam `Process`/`Dfd` `pcaItemId` e `pcaLinkStatus` e os checks `pca_item_id IS NULL OR pca_status = 'PLANNED'` e `(pca_item_id IS NOT NULL) = (pca_link_status = 'LINKED')`. A feature FT-070 fixa RN-PCA-15 a RN-PCA-18 (vínculo por FK; plano `APPROVED` do órgão e do exercício; seletor sem valores e sem `PCA_VIEW` — permissions.md §5.1).
- Quando e por quem se edita já está definido: processo com `PROCESS_UPDATE` + POL-01 em `DRAFT`/`IN_PROGRESS`/`RETURNED` (RN-PROC-59); DFD com `DFD_UPDATE` + POL-02 em `DRAFT`/`RETURNED` (DFD-04). A aprovação do DFD (US-017, RN-DFD-65) já copia os campos de PCA do DFD para o processo; `entities.md` §5.2 cita a propagação como "US-016", mas o efeito está na US-017 e é estendido aqui.
- Módulos (domains.md §11.6): `process` e `dfd` chamam o `pca` por `PcaFacade.resolveItem`; o `pca` (nível inferior) não chama `process` nem `dfd`. Por isso o **saldo** (soma dos valores estimados dos processos vinculados) é calculado pelo `process`, dono do dado, com o `plannedValue` devolvido pela fachada.
- Sigilo (DEC-030, POL-09 estendida): valores do item e dos processos sigilosos não saem para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`; nenhum valor entra em evento, timeline, auditoria ou log. `CONSULTOR_EXTERNO` não acessa o PCA (DEC-197, L-07).
- Meta do épico: ≥ 90% dos DFDs e processos planejados novos nascem vinculados em 3 meses.

## Objetivo
Entregar o vínculo estruturado com o PCA aprovado: 100% dos vínculos gravados apontam para item elegível do mesmo órgão e exercício, com `pcaStatus`/`pcaYear`/`pcaItemCode`/`pcaLinkStatus` coerentes; 100% das trocas e remoções com justificativa, auditoria e entrada na timeline; o aviso (ou bloqueio) de saldo e de duplicidade exibido antes da gravação; e nenhum contrato do MVP 1 alterado de forma incompatível (campos aditivos — DEC-108).

## Persona
- **Principal:** Planejamento (`PLANEJAMENTO`) — vincula DFDs e processos ao PCA e mantém o vínculo.
- **Secundárias:** Área requisitante (`REQUISITANTE`) — escolhe o item ao registrar o DFD e o processo; gestores com a custódia do processo ou do DFD (`COMPRAS`, `LICITACOES`, `GESTOR_CONTRATACOES`); Administrador do órgão (`ADMIN_ORGAO`) — configura `pca.requireLinkForPlanned` e `pca.itemBalanceSeverity`; Auditor (`AUDITOR`) — rastreia vínculos pela auditoria.
- **Sem acesso:** `CONSULTOR_EXTERNO`.

## Pré-condições
- Tenant ativo; órgão do processo com plano do exercício `APPROVED` (US-140) para haver item selecionável. Sem plano aprovado, a story opera em modo texto (RN-PCA-233).
- Para vincular no processo: `PROCESS_CREATE` (criação) ou `PROCESS_UPDATE` + POL-01 (edição), processo em `DRAFT`, `IN_PROGRESS` ou `RETURNED`.
- Para vincular no DFD: `DFD_UPDATE` + POL-02, DFD em `DRAFT` ou `RETURNED`, processo em status editável.
- Situação no PCA `PLANNED` (RN-PROC-12 / RN-DFD-13).

## Fluxo principal
1. Na criação do processo (SCR-005, passo 2) ou no DFD (SCR-007, passo "Planejamento"), a usuária escolhe a situação no PCA "Previsto". O `PcaFieldset` consulta `GET /pca-items/lookup` (PCA-40) com o órgão e o exercício (padrão: ano corrente) e, havendo plano aprovado, troca os campos de texto por um seletor de item ("Buscar por código ou objeto").
2. A usuária digita ao menos 2 caracteres; o seletor lista até 20 itens do plano aprovado (código, objeto, secretaria, situação do item), por padrão da secretaria solicitante, com a opção "Mostrar todas as secretarias".
3. Ao escolher o item, o front chama `POST /pca-items/check-link` (PCA-41) com o valor estimado informado; a resposta traz os avisos (saldo excedido, item já vinculado a outro processo, item contratado ou adiado) e, para quem tem `PCA_VIEW`, o saldo.
4. A usuária lê os avisos, marca "Estou ciente" quando houver aviso não bloqueante e salva. O front envia `pcaItemId` junto com o restante do corpo (`POST /processes` — PRC-02, ou `PATCH /processes/{id}` — PRC-05, ou `PATCH /dfds/{id}` — DFD-04) e `pcaAcknowledgedWarnings`.
5. A API, na transação da operação: valida a permissão e o estado (RN-PCA-237); resolve o item por `PcaFacade.resolveItem` e confere a elegibilidade (RN-PCA-231); avalia saldo e avisos conforme `pca.itemBalanceSeverity` (RN-PCA-242 a RN-PCA-244); aplica o espelho (`pcaStatus = PLANNED`, `pcaYear` do plano, `pcaItemCode` do item, `pcaLinkStatus = LINKED`) e incrementa `version`.
6. Na mesma transação grava a auditoria (`process.pca_link` ou `dfd.pca_link`), publica `ProcessPcaItemLinked` (ou `DfdPcaItemLinked`) no outbox e, no processo, a entrada `PCA_ITEM_LINKED` na timeline (projetor síncrono).
7. A API responde 200/201 com o recurso e o novo `ETag`; o front exibe "Vinculado ao item {código} do PCA {ano}" e, no painel do processo (SCR-006), o cartão "Plano de Contratações" com o item, a secretaria, a versão do plano e a situação do vínculo.
8. Quando o DFD é criado a partir de um processo já vinculado, ele nasce com o mesmo vínculo (RN-PCA-239). Quando o DFD é aprovado (US-017), o vínculo do DFD é propagado ao processo na mesma transação da decisão (RN-PCA-240).

## Fluxos alternativos
- **FA-01 — Plano do exercício ainda não aprovado:** `meta.planFound = false` em PCA-40. O `PcaFieldset` mantém exercício e código em texto, exibe "O PCA de {ano} ainda não foi aprovado. A referência será vinculada ao item depois da aprovação." e o alvo fica `PENDING` (RN-PCA-233).
- **FA-02 — Item não encontrado no seletor:** a usuária pode manter o código em texto ("Meu item não aparece") e salvar `PLANNED` sem `pcaItemId` (`PENDING`). Com `pca.requireLinkForPlanned = true`, o DFD só conclui com o item (RN-PCA-247).
- **FA-03 — Trocar o item:** em "Alterar item" (SCR-006 ou formulário de edição), a usuária escolhe outro item e informa a justificativa (≥ 20 caracteres). A API grava o novo vínculo, `previousPcaItemId` no evento e a justificativa na timeline e na auditoria (RN-PCA-236).
- **FA-04 — Remover o vínculo:** "Remover vínculo" (ou mudar a situação para "Não previsto"/"Não se aplica") exige justificativa; `pcaLinkStatus` volta a `PENDING` (texto mantido) ou `NOT_APPLICABLE` (RN-PCA-235).
- **FA-05 — Avisos reconhecíveis:** item já vinculado a outro processo, item `CONTRACTED`/`POSTPONED` ou saldo excedido com severidade `WARNING` exigem o reconhecimento explícito; sem ele a API responde 422 `WARNINGS_NOT_ACKNOWLEDGED` com `violations[]` (RN-PCA-243, RN-PCA-244).
- **FA-06 — Saldo excedido com severidade `BLOCKING`:** a API responde 422 `PCA_ITEM_BALANCE_EXCEEDED`; a usuária reduz o valor estimado, escolhe outro item ou pede revisão do plano (US-141).
- **FA-07 — Item que deixou de ser elegível depois do vínculo:** item `CANCELED` ou plano substituído sem correspondente (US-143). O vínculo é mantido; o cartão do painel exibe o alerta "Item cancelado no PCA" ou "Item de versão anterior do plano — aguarda reconciliação" e o DFD recebe o aviso `DFD_PCA_ITEM_UNAVAILABLE` na completude (RN-PCA-247).
- **FA-08 — DFD aprovado com vínculo diferente do processo:** a propagação prevalece (RN-PCA-240); trocas posteriores no processo não reescrevem o DFD aprovado e o painel indica "O DFD aprovado referencia o item {código}".
- **FA-09 — Processo ou DFD fora do estado editável:** os campos do vínculo aparecem somente leitura; a API responde 409 `INVALID_PROCESS_STATUS` ou `DOCUMENT_NOT_EDITABLE`. O vínculo desses casos só muda pela conciliação (US-143).
- **FA-10 — Duplicação:** o processo (US-011) ou o DFD (US-018) duplicado herda o vínculo apenas se o item ainda for elegível para o órgão e o exercício do destino; caso contrário, herda só o texto e fica `PENDING` (RN-PCA-241).

## Regras de negócio
- **RN-PCA-230** — Derivação do vínculo (estende RN-PCA-17). `pcaStatus ≠ PLANNED` ⇒ `pcaItemId` nulo e `pcaLinkStatus = NOT_APPLICABLE`; `PLANNED` sem item ⇒ `PENDING`; `PLANNED` com item ⇒ `LINKED`. `UNRESOLVED`, `AMBIGUOUS` e o "sem item no PCA" (`NOT_APPLICABLE` com `PLANNED`) são gravados **apenas** pela US-143 e preservados até que `pcaYear` ou `pcaItemCode` (texto) mudem, quando o alvo volta a `PENDING`.
- **RN-PCA-231** — Elegibilidade do item (via `PcaFacade.resolveItem`): item do tenant, não excluído, de plano `APPROVED` vigente cujo `organizationId` é o do alvo e cujo `year` é o `pcaYear` do alvo, com `status ≠ CANCELED`. Plano `DRAFT`/`AWAITING_APPROVAL` ⇒ `PCA_ITEM_NOT_ELIGIBLE` (`meta.reason = PLAN_NOT_APPROVED`); plano `SUPERSEDED` ⇒ `PLAN_SUPERSEDED`; item cancelado ⇒ `ITEM_CANCELED`; exercício fora do permitido ⇒ `YEAR_NOT_ALLOWED`. Item inexistente, de outro tenant **ou de outro órgão** ⇒ 422 `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`), idêntico nos três casos (api.md §1.5).
- **RN-PCA-232** — Exercício permitido: o do plano do item precisa ser o ano corrente ou o seguinte (RN-PROC-12), **ou** igual ao `pcaYear` que o alvo já tem gravado (processo antigo que continua no exercício de origem). O `pcaYear` enviado em conjunto com `pcaItemId` é ignorado: o servidor usa o ano do plano.
- **RN-PCA-233** — Sem plano `APPROVED` do órgão e do exercício, `pcaItemId` não é aceito (`PCA_ITEM_NOT_ELIGIBLE`/`PLAN_NOT_APPROVED`); o alvo `PLANNED` guarda exercício e código em texto e fica `PENDING` (DEC-197). A aprovação do plano dispara a US-143.
- **RN-PCA-234** — Espelho (vínculo por `CREATE`, `UPDATE` ou `DFD`): `pcaStatus = PLANNED`, `pcaYear` = ano do plano, `pcaItemCode` = `code` do item, `pcaJustification` = nulo. Os valores textuais anteriores seguem em `changes` da auditoria. Enquanto vinculados, `pcaYear` e `pcaItemCode` são somente leitura ("Definido pelo item do PCA"); para mudá-los troca-se ou remove-se o vínculo. (O vínculo gravado pela US-143 **não** reescreve o texto — RN-PCA-265.)
- **RN-PCA-235** — Remoção. `pcaItemId = null` com `pcaStatus = PLANNED` ⇒ `pcaLinkStatus = PENDING`, `pcaYear` e `pcaItemCode` permanecem com os valores espelhados e passam a ser texto editável. Mudar `pcaStatus` para `NOT_PLANNED` ou `NOT_APPLICABLE` remove o vínculo implicitamente e `pcaLinkStatus = NOT_APPLICABLE`, com as regras de RN-PROC-12 (em `NOT_APPLICABLE`, os demais campos de PCA ficam nulos).
- **RN-PCA-236** — Justificativa. Trocar ou remover um vínculo existente (inclusive o implícito da RN-PCA-235) exige `pcaItemChangeReason` de 20 a 500 caracteres (`CONDITIONAL_REQUIRED` / `TOO_SHORT`). O primeiro vínculo (nulo → item) não exige. Reaplicar o mesmo item é "sem diferença efetiva" (RN-PROC-67): 200 sem nova versão, evento, timeline nem auditoria.
- **RN-PCA-237** — Estado e custódia. Processo: `PROCESS_UPDATE` + POL-01 + status `DRAFT`/`IN_PROGRESS`/`RETURNED` (RN-PROC-59); criação: `PROCESS_CREATE` (RN-PROC-03). DFD: `DFD_UPDATE` + POL-02, DFD em `DRAFT`/`RETURNED`. `AWAITING_APPROVAL`, `SUSPENDED`, `CANCELED`, `COMPLETED`, `PUBLISHED` ⇒ 409 `INVALID_PROCESS_STATUS`; DFD fora do estado ⇒ 409 `DOCUMENT_NOT_EDITABLE`. A troca de item **não** altera o workflow, a etapa, o responsável, os prazos nem o status do processo (DEC-014).
- **RN-PCA-238** — Processos em andamento. O vínculo pode ser feito, trocado ou removido em qualquer etapa enquanto o processo estiver em status editável e a pessoa tiver a custódia; cada troca preserva o histórico (timeline e auditoria) e não reescreve documentos já finalizados ou aprovados (o DFD aprovado mantém o seu próprio vínculo).
- **RN-PCA-239** — Herança processo → DFD. O DFD criado (DFD-02) copia `pcaItemId` e `pcaLinkStatus` do processo, estendendo RN-DFD-05; se o item já não for elegível no instante da criação, o DFD copia só o texto e fica `PENDING`. A cópia não gera evento.
- **RN-PCA-240** — Herança DFD → processo. Na decisão `APPROVED` (US-017, mesma transação — RN-DFD-62), `Process.pcaItemId` e `pcaLinkStatus` passam a ser os do DFD, com `via = DFD` e `previousPcaItemId` quando havia outro item. A propagação **não** revalida elegibilidade nem saldo e nunca bloqueia a aprovação. Se o DFD não tem item e o processo tinha, o vínculo do processo é removido (`ProcessPcaItemUnlinked`, `metadata.cause = DFD_APPROVED`) e o `pcaLinkStatus` passa a ser o do DFD. Vínculo igual ao já existente não gera evento.
- **RN-PCA-241** — Duplicação. US-011 (RN-PROC-118) e US-018 (RN-DFD-76) passam a copiar `pcaItemId` e `pcaLinkStatus` quando o item é elegível para o órgão e o exercício do destino (RN-PCA-231); senão copiam o texto e `PENDING`.
- **RN-PCA-242** — Saldo previsto. `saldo = plannedValue do item − Σ estimatedValue` dos **demais** processos vinculados ao item com `status ≠ CANCELED` (calculado pelo `process`). O processo é avaliado com o `estimatedValue` informado ou gravado; `estimatedValue` nulo ⇒ saldo não avaliado (`balance.evaluated = false`, sem aviso). O DFD não é avaliado (valor preliminar): o saldo é verificado no processo, onde o valor é o de referência.
- **RN-PCA-243** — Severidade do saldo, configurável por `pca.itemBalanceSeverity` (`OFF`, `WARNING` padrão, `BLOCKING`). `WARNING`: violação `PCA_ITEM_BALANCE_EXCEEDED` de severidade `WARNING`, que exige o reconhecimento (`pcaAcknowledgedWarnings`) sob pena de 422 `WARNINGS_NOT_ACKNOWLEDGED`. `BLOCKING`: 422 `PCA_ITEM_BALANCE_EXCEEDED`. `OFF`: não avalia. A regra também vale na edição manual de `estimatedValue` de processo já vinculado (PRC-05); valores derivados de ETP/pesquisa/TR (DEC-032) nunca bloqueiam e aparecem como alerta no cartão do painel (calculado na leitura). O padrão `WARNING` reflete que o valor do PCA é uma previsão; órgãos de regimento rígido escolhem `BLOCKING` (a confirmar com o produto).
- **RN-PCA-244** — Avisos de situação (sempre `WARNING`, reconhecíveis, nunca bloqueiam): `PCA_ITEM_ALREADY_LINKED` (já há outro processo não cancelado vinculado ao item — a resposta lista só os códigos visíveis à pessoa e `hasOthers`, sem revelar processos fora do seu escopo — RN-PCA-25), `PCA_ITEM_CONTRACTED` e `PCA_ITEM_POSTPONED`. Vários processos por item são permitidos (parcelamento, registro de preços); o aviso evita a contratação em duplicidade.
- **RN-PCA-245** — Sigilo do saldo. Valores numéricos (`plannedValue`, `committedValue`, `available`) só saem para quem tem `PCA_VIEW` cobrindo o item; a soma exibida exclui processos sigilosos para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (`confidentialExcluded: true`). Os demais recebem apenas `exceeded` (booleano). A avaliação do servidor considera todos os processos. Eventos, timeline, auditoria (só `balanceExceeded`) e logs nunca carregam valores.
- **RN-PCA-246** — Painel situacional (SCR-006). Cartão "Plano de Contratações": situação do vínculo (Vinculado, Pendente de vínculo, Não localizado, Ambíguo, Sem item no PCA, Não se aplica), item (código, objeto, secretaria, categoria, situação), exercício e versão do plano, alertas (RN-PCA-243, FA-07, FA-08) e, com `PCA_VIEW`, o saldo e o link para o item em SCR-018. Para `CONSULTOR_EXTERNO` o cartão não é exibido e a API devolve `pcaItem = null` em PRC-04/PRC-07.
- **RN-PCA-247** — Completude do DFD. Com `pca.requireLinkForPlanned = true`, DFD `PLANNED` sem `pcaItemId` ganha a violação `DFD_PCA_LINK_REQUIRED` (`BLOCKING`, `field = pcaItemId`) **somente** se existir plano `APPROVED` do órgão e exercício (RN-PCA-16); a chave é `false` por padrão. Independentemente da chave, DFD vinculado a item cancelado ou a versão substituída sem correspondente ganha `DFD_PCA_ITEM_UNAVAILABLE` (`WARNING`).
- **RN-PCA-248** — Concorrência. Os PATCH usam `If-Match` com a `version` do recurso (RN-PROC-66, RN-DFD-27). Com `BLOCKING`, a avaliação do saldo é serializada por item com `pg_advisory_xact_lock` sobre `(tenant, pcaItemId)` até o fim da transação, evitando que dois processos "caibam" isoladamente e estourem juntos.
- **RN-PCA-249** — Atomicidade e rastro. Gravação do vínculo, espelho, `version + 1`, auditoria, evento (outbox) e timeline (processo) acontecem na mesma transação; falha em qualquer parte desfaz tudo. `ProcessCreated` carrega `pcaItemId?` (aditivo) e a criação também publica `ProcessPcaItemLinked` com `via = CREATE`. A entrada de timeline `PCA_ITEM_LINKED` leva `pcaItemCode`, `year`, `via` e, quando houver, `previousPcaItemCode` e `reason` (justificativa, texto curto não sigiloso).
- **RN-PCA-250** — Isolamento. `tenant_id` em todas as consultas; o seletor e a verificação só enxergam planos do órgão do alvo; nenhuma resposta revela a existência de item, plano ou processo de outro tenant ou órgão. Alvo (processo/DFD) inexistente ou invisível ⇒ 404 sem `access.denied`.
- **RN-PCA-251** — Seletor (PCA-40): exige informar **um** entre `processId`, `dfdId` ou `organizationId` (criação); `q` com mínimo de 2 caracteres quando presente; `limit` de 1 a 50 (padrão 20); ordenação por `code`; itens `CANCELED` não são listados; `POSTPONED` e `CONTRACTED` aparecem com a situação. Devolve código, objeto, secretaria, categoria, situação e plano; **nunca** valores. `Cache-Control: no-store`.
- **RN-PCA-252** — Compatibilidade (DEC-108): `pcaItemId`, `pcaItemChangeReason` e `pcaAcknowledgedWarnings` são campos **opcionais** novos em PRC-02, PRC-05 e DFD-04; `pcaItemId`, `pcaLinkStatus` e `pcaItem` são campos novos nas respostas de `Process` e `Dfd`. Clientes do MVP 1 continuam funcionando; nada deixa de ser aceito.
- **RN-PCA-253** — Auditoria sem duplicidade: quando o PATCH altera o vínculo, os campos `pcaItemId`, `pcaYear`, `pcaItemCode` e `pcaLinkStatus` vão em `process.pca_link` e **não** se repetem no diff de `process.update`.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Situação no PCA | `pcaStatus` | rádio (`PcaStatus`) | Sim (MVP 1) | `PLANNED` é a única que aceita item (RN-PCA-230) | MVP 1 |
| Exercício do PCA | `pcaYear` | número | Condicional (`PLANNED`) | Ano corrente/seguinte ou o já gravado (RN-PCA-232); somente leitura com item | Ano corrente |
| Item do PCA | `pcaItemId` | uuid (seletor) | Não* | Elegível (RN-PCA-231); `null` remove; *obrigatório para concluir o DFD só com `pca.requireLinkForPlanned` | `Process.pcaItemId` → `Dfd.pcaItemId` |
| Código do item | `pcaItemCode` | texto (≤ 60) | Não | Espelho do `code` quando vinculado (somente leitura) | `PcaItem.code` |
| Justificativa (fora do PCA) | `pcaJustification` | texto longo | Condicional (`NOT_PLANNED`) | ≥ 20 caracteres (RN-PROC-12) | MVP 1 |
| Justificativa da troca ou remoção | `pcaItemChangeReason` | texto longo | Condicional | 20–500; exigida ao trocar/remover (RN-PCA-236) | — |
| Avisos reconhecidos | `pcaAcknowledgedWarnings` | lista de códigos | Condicional | Subconjunto de `PCA_ITEM_BALANCE_EXCEEDED`, `PCA_ITEM_ALREADY_LINKED`, `PCA_ITEM_CONTRACTED`, `PCA_ITEM_POSTPONED` | — |
| Situação do vínculo | `pcaLinkStatus` | `PcaLinkStatus` | — (sistema) | RN-PCA-230; somente leitura | `NOT_APPLICABLE` |
| Vínculo obrigatório (config.) | `pca.requireLinkForPlanned` | booleano | Não | `SETTINGS_MANAGE` | `false` |
| Severidade do saldo (config.) | `pca.itemBalanceSeverity` | `OFF` \| `WARNING` \| `BLOCKING` | Não | `SETTINGS_MANAGE` | `WARNING` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `pcaItemId` com `pcaStatus ≠ PLANNED` | Front + API (Zod) | "Só é possível vincular um item quando a contratação está prevista no PCA." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`/`NOT_ALLOWED`) |
| V-02 | Item inexistente, de outro tenant ou de outro órgão | API | "Selecione um item válido do PCA." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-03 | Plano do exercício não aprovado | API | "O PCA de {ano} ainda não foi aprovado. Mantenha o código em texto; o vínculo será feito depois." | `PCA_ITEM_NOT_ELIGIBLE` (`meta.reason = PLAN_NOT_APPROVED`) |
| V-04 | Item de versão substituída do plano | API | "Este item pertence a uma versão anterior do plano. Escolha o item da versão vigente." | `PCA_ITEM_NOT_ELIGIBLE` (`PLAN_SUPERSEDED`) |
| V-05 | Item cancelado | API | "Este item foi cancelado no PCA e não pode ser vinculado." | `PCA_ITEM_NOT_ELIGIBLE` (`ITEM_CANCELED`) |
| V-06 | Exercício do plano fora do permitido | API | "Informe um item do PCA do ano corrente ou do seguinte." | `PCA_ITEM_NOT_ELIGIBLE` (`YEAR_NOT_ALLOWED`) |
| V-07 | Troca/remoção sem justificativa ou com menos de 20 caracteres | Front + API | "Informe a justificativa da troca (mín. 20 caracteres)." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`/`TOO_SHORT`) |
| V-08 | Saldo excedido com severidade `BLOCKING` | API | "O valor estimado excede o saldo previsto deste item do PCA. Reduza o valor, escolha outro item ou peça a revisão do plano." | `PCA_ITEM_BALANCE_EXCEEDED` |
| V-09 | Aviso (`WARNING`) sem reconhecimento | Front + API | "Há avisos sobre este vínculo. Leia e confirme para continuar." | `WARNINGS_NOT_ACKNOWLEDGED` (`violations[]`) |
| V-10 | Processo fora de status editável | API | "Não é possível alterar o vínculo com o PCA neste momento." | `INVALID_PROCESS_STATUS` |
| V-11 | DFD fora de `DRAFT`/`RETURNED` | API | "Este DFD não pode ser editado." | `DOCUMENT_NOT_EDITABLE` |
| V-12 | `If-Match` ausente ou divergente | API | "Recarregue e tente novamente." / "Outra pessoa alterou este registro." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-13 | Seletor sem alvo, com mais de um alvo ou `q` curto | API | "Informe o processo, o DFD ou o órgão e ao menos 2 caracteres na busca." | `VALIDATION_ERROR` |
| V-14 | DFD `PLANNED` sem item com `pca.requireLinkForPlanned = true` e plano aprovado | API (DOC-08) | "Vincule o DFD a um item do PCA {ano}." | `DFD_PCA_LINK_REQUIRED` (`violations[]`, `BLOCKING`) |

## Permissões
- **Permissão:** `PROCESS_CREATE` (criação) ou `PROCESS_UPDATE` (edição) com escopo que cubra o processo; `DFD_UPDATE` com escopo que cubra o processo do DFD. O seletor (PCA-40) e a pré-verificação (PCA-41) usam essas mesmas permissões como capacidade implícita — **não** exigem `PCA_VIEW` (permissions.md §5.1). Saldo numérico: `PCA_VIEW` cobrindo o item. Configuração das chaves: `SETTINGS_MANAGE` (SET-02).
- **Políticas:** POL-01 (custódia do processo), POL-02 (edição do DFD), POL-09 (sigilo do orçamento, estendida a `PcaItem.plannedValue` na visão por processo), DEC-024 (visibilidade do processo no painel).
- **MFA:** não exigido (nenhuma das permissões é de risco `H`).
- **Sem permissão:** na UI o seletor fica desabilitado e o campo vira somente leitura; na API, 403 `PERMISSION_DENIED` (`access.denied`, `reasonCode` da permissão) ou 403 `NOT_PROCESS_CUSTODIAN`. `CONSULTOR_EXTERNO` recebe 403 `PERMISSION_DENIED` no seletor e não vê o cartão do PCA. Processo/DFD de outro tenant ou invisível: 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessCreated` | `process.created` | Criação do processo (PRC-02) | `pcaItemId?` aditivo (events.md §2) |
| `ProcessPcaItemLinked` | `process.pca_item_linked` | Criação, edição (PRC-05) ou propagação do DFD | `pcaItemId`, `pcaId`, `pcaItemCode`, `via` (`CREATE`, `UPDATE`, `DFD`), `previousPcaItemId?`; consumidores T P R |
| `ProcessPcaItemUnlinked` | `process.pca_item_unlinked` | Remoção explícita ou implícita (RN-PCA-235, RN-PCA-240) | `pcaItemId` (o removido), `hasReason`; T P R |
| `ProcessUpdated` | `process.updated` | PRC-05 com outros campos alterados | `changedFields` pode incluir `pcaItemId` (nome, nunca valor) |
| `DfdPcaItemLinked` | `dfd.pca_item_linked` | DFD-04 vincula ou troca o item | **Novo** (já assinado pelo `PcaExecutionTracker`): `dfdId`, `processId`, `pcaItemId`, `pcaId`, `pcaItemCode`, `previousPcaItemId?` |
| `DfdPcaItemUnlinked` | `dfd.pca_item_unlinked` | DFD-04 remove o vínculo | **Novo**: `dfdId`, `processId`, `pcaItemId`, `hasReason` |

Sem valores monetários em nenhum payload. O DFD não tem entrada de timeline própria para o vínculo (as mudanças do DFD já constam na auditoria `dfd.pca_link`).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| Nenhuma nova | — | — | O vínculo é ato do próprio usuário e aparece na timeline; `PCA_ITEM_LINKED` não gera notificação (events.md §8). Alertas de saldo e de item cancelado são exibidos no cartão do painel, não enviados. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Vincular DFD e processo a item do PCA

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o órgão "Prefeitura Municipal de A" tem o plano "PCA 2026" aprovado (versão 1)
    And o plano tem o item "PCA-017" ("Aquisição de cimento para vias", secretaria "Obras", valor previsto 120.000,00, situação "PLANNED")
    And o item "PCA-020" tem a situação "CANCELED" e o item "PCA-021" pertence à secretaria "Saúde"
    And a usuária "Ana" (REQUISITANTE da secretaria "Obras") tem "PROCESS_CREATE", "PROCESS_UPDATE" e "DFD_UPDATE"
    And a configuração "pca.itemBalanceSeverity" é "WARNING"

  Scenario: [Sucesso] Criar o processo escolhendo o item do PCA
    When "Ana" buscar "cimento" no seletor de itens do PCA 2026
    Then o seletor deve listar "PCA-017" com código, objeto e secretaria e sem nenhum valor
    When "Ana" criar o processo com situação "PLANNED" e o item "PCA-017"
    Then o processo deve ficar com "pcaItemId" do item, "pcaYear" 2026, "pcaItemCode" "PCA-017" e "pcaLinkStatus" "LINKED"
    And deve gerar registro de auditoria "process.pca_link" e "process.create"
    And deve gerar os eventos "ProcessCreated" (com "pcaItemId") e "ProcessPcaItemLinked" com "via" "CREATE"
    And a timeline deve registrar "Processo vinculado ao item PCA-017 do PCA 2026"

  Scenario: [Sucesso] DFD herda o vínculo do processo e o processo o recebe de volta na aprovação
    Given que o processo "0045/2026" está vinculado ao item "PCA-017"
    When "Ana" criar o DFD do processo
    Then o DFD deve nascer com "pcaItemId" do item e "pcaLinkStatus" "LINKED"
    When "Ana" trocar o item do DFD para "PCA-018" com a justificativa "Item correto após revisão da demanda com o planejamento"
    And o titular aprovar o DFD
    Then o processo deve ficar vinculado ao item "PCA-018" com "via" "DFD" e "previousPcaItemId" do "PCA-017"
    And a aprovação deve ser concluída sem revalidar saldo nem elegibilidade

  Scenario: [Sucesso] Trocar o item de um processo em andamento com justificativa
    Given que o processo "0045/2026" está "IN_PROGRESS" na etapa "ETP" e vinculado ao item "PCA-017"
    When "Ana", com a custódia, trocar o item para "PCA-018" informando a justificativa de 40 caracteres
    Then o vínculo deve apontar para "PCA-018" e "version" deve ser incrementada
    And a etapa, o responsável e o prazo do processo não devem mudar
    And a timeline deve registrar a troca com "previousPcaItemCode" "PCA-017" e a justificativa
    And a auditoria "process.pca_link" deve conter o item anterior, o novo e o texto da justificativa
    And deve gerar o evento "ProcessPcaItemLinked" com "previousPcaItemId"

  Scenario: [Sucesso] Remover o vínculo volta o alvo para pendente com o texto preservado
    Given que o processo "0045/2026" está vinculado ao item "PCA-017"
    When "Ana" remover o vínculo informando a justificativa
    Then "pcaLinkStatus" deve ser "PENDING" e "pcaItemCode" deve continuar "PCA-017" como texto editável
    And deve gerar o evento "ProcessPcaItemUnlinked" com "hasReason" verdadeiro
    And deve gerar registro de auditoria "process.pca_unlink"

  Scenario: [Sucesso] Saldo excedido com aviso reconhecido
    Given que o item "PCA-017" tem 120.000,00 previstos e outro processo vinculado com 90.000,00 estimados
    When "Ana" vincular o processo "0050/2026" com valor estimado 50.000,00 sem reconhecer os avisos
    Then a API deve responder 422 com código "WARNINGS_NOT_ACKNOWLEDGED" e as violações "PCA_ITEM_BALANCE_EXCEEDED" e "PCA_ITEM_ALREADY_LINKED"
    When "Ana" reenviar com "pcaAcknowledgedWarnings" contendo os dois códigos
    Then o processo deve ficar "LINKED"
    And a auditoria deve registrar "balanceExceeded" verdadeiro sem nenhum valor monetário

  Scenario: [Sucesso] Saldo excedido com severidade BLOCKING
    Given que a configuração "pca.itemBalanceSeverity" é "BLOCKING" e o saldo do item é 30.000,00
    When "Ana" vincular o processo "0050/2026" com valor estimado 50.000,00
    Then a API deve responder 422 com código "PCA_ITEM_BALANCE_EXCEEDED"
    And o processo não deve ser alterado

  Scenario: [Sucesso] Sem plano aprovado o vínculo fica pendente em texto
    Given que o plano "PCA 2027" está em "DRAFT"
    When "Ana" criar o processo com situação "PLANNED", exercício 2027 e código "PCA-100" em texto
    Then o processo deve ficar com "pcaLinkStatus" "PENDING" e sem "pcaItemId"
    And o seletor deve informar que o plano de 2027 ainda não foi aprovado

  Scenario: [Sucesso] Vínculo obrigatório para concluir o DFD planejado
    Given que a configuração "pca.requireLinkForPlanned" é verdadeira
    And o DFD do processo "0052/2026" está "PLANNED" sem item e o plano 2026 está aprovado
    When "Ana" consultar a completude do DFD
    Then deve haver a violação "DFD_PCA_LINK_REQUIRED" de severidade "BLOCKING"
    And o DFD não deve poder ser finalizado até escolher o item

  Scenario: [Validação] Item cancelado, de plano não aprovado ou justificativa curta
    When "Ana" vincular o processo ao item "PCA-020"
    Then a API deve responder 422 com código "PCA_ITEM_NOT_ELIGIBLE" e "meta.reason" "ITEM_CANCELED"
    When "Ana" trocar o item sem informar a justificativa
    Then a API deve responder 422 com "VALIDATION_ERROR" e o campo "pcaItemChangeReason" com "CONDITIONAL_REQUIRED"
    When "Ana" enviar "pcaItemId" com "pcaStatus" "NOT_PLANNED"
    Then a API deve responder 422 com "VALIDATION_ERROR" no campo "pcaItemId"

  Scenario: [Permissão] Usuário sem PROCESS_UPDATE e consultor externo
    Given que "Bruno" não possui "PROCESS_UPDATE"
    When "Bruno" tentar vincular o processo "0045/2026" a um item
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    Given que "Carla" é "CONSULTOR_EXTERNO" participante do processo "0045/2026"
    When "Carla" chamar o seletor e consultar o processo
    Then o seletor deve responder 403 "PERMISSION_DENIED"
    And "pcaItem" deve vir nulo na resposta do processo

  Scenario: [Tenant incorreto] Item de outro tenant ou de outro órgão e processo alheio
    Given que existe o item "PCA-900" no tenant "Prefeitura B" e o item "PCA-310" no plano de outro órgão do tenant "Prefeitura A"
    When "Ana" vincular o processo ao item "PCA-900"
    Then a API deve responder 422 com "VALIDATION_ERROR" e "REFERENCE_NOT_FOUND" em "pcaItemId"
    When "Ana" vincular o processo ao item "PCA-310"
    Then a API deve responder exatamente a mesma resposta de item inexistente
    Given que existe o processo "0007/2026" no tenant "Prefeitura B"
    When "Ana" consultar "GET /processes/{id}/pca-link" desse processo
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum código, objeto ou plano do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Item já vinculado a outro processo e reenvio da criação
    Given que o processo "0045/2026" já está vinculado ao item "PCA-017"
    When "Ana" vincular o processo "0050/2026" ao mesmo item
    Then a API deve exigir o reconhecimento do aviso "PCA_ITEM_ALREADY_LINKED" listando só os códigos visíveis a "Ana"
    When "Ana" enviar PRC-02 duas vezes com a mesma "Idempotency-Key"
    Then a segunda resposta deve trazer "Idempotent-Replayed" verdadeiro
    And deve existir um único processo, uma única auditoria "process.pca_link" e um único evento "ProcessPcaItemLinked"
    When "Ana" reenviar o mesmo item já vinculado em um PATCH sem outras mudanças
    Then a API deve responder 200 sem nova versão, evento ou auditoria

  Scenario: [Concorrência] Dois usuários trocam o item ao mesmo tempo
    Given que "Ana" e "Marcos" carregaram o processo "0045/2026" com o mesmo "ETag"
    When os dois enviarem PATCH com itens diferentes e o mesmo "If-Match"
    Then um PATCH deve responder 200 e o outro 412 com código "VERSION_CONFLICT" e "meta.current"
    And o vínculo final deve ser o do PATCH aceito, com um único evento de troca

  Scenario: [Concorrência] Dois processos disputam o último saldo com BLOCKING
    Given que a severidade é "BLOCKING" e o saldo do item é 50.000,00
    When "Ana" e "Marcos" vincularem, ao mesmo tempo, dois processos de 40.000,00 ao item
    Then apenas um vínculo deve ser gravado
    And o outro pedido deve responder 422 com código "PCA_ITEM_BALANCE_EXCEEDED"

  Scenario: [Falha de banco] Banco falha ao gravar o vínculo
    Given que o banco de dados falha ao gravar a auditoria do vínculo
    When "Ana" trocar o item do processo
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o processo deve manter o item anterior e a "version" original
    And nenhum evento deve ter sido publicado e nenhuma entrada de timeline criada

  Scenario: [Falha de integração] Redis e relay do outbox indisponíveis
    Given que o Redis das filas está indisponível
    When "Ana" vincular o processo ao item "PCA-017"
    Then a API deve responder 200 com o processo "LINKED"
    And a entrada de timeline deve existir
    And o evento "ProcessPcaItemLinked" deve ficar "PENDING" no outbox até o relay voltar
    And o acompanhamento da execução do item deve ser atualizado depois, sem duplicidade
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Item inexistente, de outro tenant ou órgão | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Selecione um item válido do PCA." | Destaca o seletor e recarrega a lista |
| Plano não aprovado, substituído, item cancelado, exercício fora | 422 | `PCA_ITEM_NOT_ELIGIBLE` | Conforme `meta.reason` (V-03 a V-06) | Mostra o motivo no seletor; oferece manter em texto |
| Saldo excedido (`BLOCKING`) | 422 | `PCA_ITEM_BALANCE_EXCEEDED` | "O valor estimado excede o saldo previsto deste item do PCA." | Mantém o formulário; sugere reduzir o valor, trocar o item ou pedir revisão |
| Avisos não reconhecidos | 422 | `WARNINGS_NOT_ACKNOWLEDGED` | "Há avisos sobre este vínculo. Leia e confirme para continuar." | Abre o painel de avisos com a caixa "Estou ciente" |
| Justificativa ausente ou curta | 422 | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`/`TOO_SHORT`) | "Informe a justificativa da troca (mín. 20 caracteres)." | Foca o campo |
| Processo fora de status editável | 409 | `INVALID_PROCESS_STATUS` | "Não é possível alterar o vínculo com o PCA neste momento." | Campo somente leitura com o motivo |
| DFD fora de `DRAFT`/`RETURNED` | 409 | `DOCUMENT_NOT_EDITABLE` | "Este DFD não pode ser editado." | Campo somente leitura |
| Sem custódia | 403 | `NOT_PROCESS_CUSTODIAN` | "O processo não está sob a sua responsabilidade." | Oculta a ação |
| Sem permissão / consultor externo | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta o seletor |
| Processo/DFD de outro tenant ou invisível | 404 | `NOT_FOUND` / `DFD_NOT_FOUND` | "Não encontrado." | Volta à lista |
| Versão divergente | 412 | `VERSION_CONFLICT` | "Outra pessoa alterou este registro. Recarregue e tente de novo." | Diálogo de conflito com `meta.current` |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Mantém o formulário e oferece "Tentar novamente" |

## Dependências
- **Stories:** US-005 (edição do processo: PATCH, status e custódia), US-014 (DFD: cabeçalho e `PcaFieldset`), US-140 (plano aprovado). Indiretas: US-001 (criação — PRC-02), US-011 e US-018 (duplicação), US-016 e US-017 (finalização e efeitos da decisão do DFD), US-013 (sigilo), US-138 (itens do plano). Habilita US-143 (reconciliação), US-144 (execução) e o namespace `pca.*` do `RuleContext` v2 (US-129).
- **Decisões/ADRs:** DEC-029, DEC-197, DEC-030, DEC-108, DEC-014, DEC-024, DEC-032; domains.md §11.6 (`PcaFacade.resolveItem`).
- **Configurações:** `pca.requireLinkForPlanned` (existente), `pca.itemBalanceSeverity` (nova).
- **Lacunas nas fontes canônicas:**
  1. **Endpoints novos (PCA-40..PCA-47):** PCA-40 `GET /pca-items/lookup`, PCA-41 `POST /pca-items/check-link`, PCA-42 `GET /processes/{id}/pca-link`, PCA-43 `GET /dfds/{id}/pca-link` (PCA-44..PCA-47 reservados). A rota do seletor existe em permissions.md §5.1 e na feature, sem ID nem contrato.
  2. **Contrato do MVP 1 estendido (aditivo, DEC-108):** PRC-02, PRC-05 e DFD-04 ganham `pcaItemId`, `pcaItemChangeReason` e `pcaAcknowledgedWarnings` (opcionais); PRC-04, PRC-07, DFD-02 e DFD-03 ganham `pcaItemId`, `pcaLinkStatus` e `pcaItem`. A feature só prevê `pcaItemId` no PATCH.
  3. **Chave de configuração nova:** `pca.itemBalanceSeverity` (`OFF` \| `WARNING` \| `BLOCKING`, padrão `WARNING`). As fontes não definem a regra de saldo; a definição de "saldo previsto" é desta story.
  4. **Códigos novos:** `PCA_ITEM_NOT_ELIGIBLE` (422, `meta.reason`), `PCA_ITEM_BALANCE_EXCEEDED` (422 ou violação `WARNING`) e, em `violations[]`: `PCA_ITEM_ALREADY_LINKED`, `PCA_ITEM_CONTRACTED`, `PCA_ITEM_POSTPONED`, `DFD_PCA_LINK_REQUIRED` (`BLOCKING`), `DFD_PCA_ITEM_UNAVAILABLE` (`WARNING`).
  5. **Eventos e auditoria novos:** `DfdPcaItemLinked` (`dfd.pca_item_linked`, hoje só citado na assinatura do `PcaExecutionTracker`), `DfdPcaItemUnlinked` e a ação `dfd.pca_unlink` (o catálogo só tem `process.pca_link`, `process.pca_unlink`, `dfd.pca_link`). Timeline `PCA_ITEM_LINKED` com `previousPcaItemCode?` e `reason?`; `ProcessPcaItemUnlinked.metadata.cause`; justificativa **integral** na auditoria (exceção a "texto longo = hash + tamanho": texto curto, administrativo e necessário ao rastro).
  6. **Divergências:** `entities.md` §5.2 atribui a propagação à US-016 (o efeito está na US-017); US-011 (RN-PROC-118) e US-018 (RN-DFD-76) passam a copiar o vínculo (RN-PCA-241). Índice novo `dfds (tenant_id, pca_item_id) WHERE pca_item_id IS NOT NULL` (entities.md §5.2 só cita checks).
  7. **Produto:** severidade padrão `WARNING`; vários processos por item com aviso (sem bloqueio); reconhecimento por `pcaAcknowledgedWarnings`; os campos de `pca.requireLinkForPlanned` e `pca.itemBalanceSeverity` em SCR-041 são entregues aqui (a US-138 trata de `pca.elaborationDeadline`).

## Impacto técnico
- **Módulos e níveis:** `process` e `dfd` dependem do `pca` (nível inferior) por `PcaFacade.resolveItem`; o `pca` não importa nenhum dos dois (regra do dependency-cruiser). O seletor e a pré-verificação vivem no `pca`; o saldo, no `process`.
- **Desempenho:** o seletor usa o índice `(tenant_id, pca_id, status)` e busca por prefixo de `code` mais trigrama em `object`; meta de p95 ≤ 300 ms para planos de até 5.000 itens (medida no endurecimento). A soma do saldo usa o índice `(tenant_id, pca_item_id)` de `processes`.
- **Concorrência:** `pg_advisory_xact_lock` por item só com `BLOCKING`; sem ele, a corrida de saldo é aceita como risco do modo `WARNING`.
- **Compatibilidade:** campos aditivos (DEC-108), sem nova `eventVersion` (campos opcionais). Migração M2-11/M2-12 já cria colunas e `pcaLinkStatus`; esta story não cria tabelas.
- **Sigilo:** a existência de excedente em processo sigiloso pode ser inferida por quem vincula sem POL-09 (a resposta de bloqueio é a mesma); risco aceito e mitigado por mensagem genérica sem valores.
- **Segurança:** `pcaItemChangeReason` é texto livre: sanitizado como os demais textos curtos, nunca logado. Recusa de item de outro tenant/órgão sem diferenciar do inexistente.

## Backend
- **Módulo(s):** `pca` (fachada, seletor e verificação de elegibilidade), `process` (PRC-02/04/05/07, saldo, painel, herança), `dfd` (DFD-02/03/04, completude, propagação), `document` (DOC-08), `timeline`, `audit`, `platform` (outbox, configurações).
- **Casos de uso:** `LookupPcaItemsQuery`, `CheckPcaItemLinkQuery`, `GetProcessPcaLinkQuery`, `GetDfdPcaLinkQuery`, `ApplyPcaItemLinkService` (dentro de `CreateProcessCommand`, `UpdateProcessCommand`, `UpdateDfdHeaderCommand`), `PropagateDfdPcaLinkEffect` (extensão do efeito da US-017), `EvaluatePcaBalancePolicy`, `PcaLinkStatusDeriver`.
- **Domínio:** value object `PcaReference` (compartilhado por `Process` e `Dfd`) estendido com `itemId` e `linkStatus`; `PcaLinkStatusDeriver.derive({ pcaStatus, itemId, current, textChanged })`; `PcaItemEligibility` (RN-PCA-231/62); `PcaBalance` (RN-PCA-242); regras `DFD_PCA_LINK_REQUIRED` e `DFD_PCA_ITEM_UNAVAILABLE` em `evaluateDfdCompleteness` (`packages/validation`).
- **Integrações internas:** `PcaFacade.resolveItem` (item, plano, `plannedValue`), `ProcessAccessPort` (visibilidade para a lista de processos do aviso), `SettingsFacade` (chaves), `OutboxWriter`, `AuditService`, `TimelineProjector` (síncrono).
- **Transação:** a da operação de origem, com `app.tenant_id`: `SELECT … FOR UPDATE` do alvo → permissão/estado → `resolveItem` → lock de saldo (se `BLOCKING`) → avaliação → espelho e `version + 1` → auditoria → outbox → timeline.

## Frontend
- **Tela(s):** SCR-005 (`/processos/novo`, passo 2), SCR-007 (`/processos/[id]/dfd/[dfdId]`, passo "Planejamento"), SCR-006 (`/processos/[id]`: cartão no painel situacional e ação "Alterar item" no painel lateral de edição), SCR-041 (`/admin/configuracoes`, regras do PCA).
- **Componentes:** `PcaFieldset` (estendido) com `PcaItemPicker` (combobox assíncrona, busca com *debounce* de 300 ms, ≥ 2 caracteres, resultados com código, objeto, secretaria e selo de situação); `PcaLinkWarnings` (lista de avisos com "Estou ciente"); `PcaLinkCard` (painel do processo); `ChangePcaItemDialog` (justificativa); `LockedField` para `pcaYear`/`pcaItemCode` com item; `PcaLinkStatusBadge`.
- **Estados:** loading (esqueleto do seletor e do cartão), vazio ("Nenhum item encontrado. Mantenha o código em texto."), plano não aprovado (modo texto com orientação), erro (mensagem por código), sucesso (toast "Vinculado ao item {código} do PCA {ano}").
- **Acessibilidade e responsividade:** combobox com papel `combobox`/`listbox`, `aria-activedescendant`, anúncio de resultados por `aria-live`; alertas de saldo e de item cancelado por texto e ícone, não só por cor; diálogo com foco preso e retorno ao gatilho; seletor em tela cheia abaixo de 768 px; cartão do painel em coluna única.

## Banco de dados
- **Tabelas:** `processes` (`pca_item_id`, `pca_link_status`, `pca_status`, `pca_year`, `pca_item_code`), `dfds` (`pca_item_id`, `pca_link_status`, campos de PCA), `pca_items` e `pcas` (leitura via fachada), `outbox_events`, `audit_logs`, `process_timeline_entries`, `tenant_settings`.
- **Migrações:** nenhuma tabela nova; colunas, FKs compostas e checks vêm de M2-11 e M2-12. Esta story acrescenta o índice de `dfds` (Lacuna 9) e as chaves `pca.itemBalanceSeverity` (semente com padrão `WARNING`).
- **Índices/constraints relevantes:** FK composta `(tenant_id, pca_item_id) → pca_items`; `CHECK pca_item_id IS NULL OR pca_status = 'PLANNED'`; `CHECK (pca_item_id IS NOT NULL) = (pca_link_status = 'LINKED')`; `(tenant_id, pca_item_id) WHERE pca_item_id IS NOT NULL` em `processes` (e em `dfds`); `(tenant_id, pca_link_status) WHERE pca_link_status IN ('PENDING','UNRESOLVED','AMBIGUOUS')`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `PCA-40` | GET | `/pca-items/lookup` | Query: um entre `processId`, `dfdId`, `organizationId`; `year?`, `q?` (≥ 2), `departmentId?`, `allDepartments?`, `limit?` (1–50, padrão 20) | `200 { data: [{ id, code, object, department{id,name}, category{id,label}, status, plan{id,year,versionNumber} }], meta: { planFound, planYear, planId?, hasMore } }` — sem valores · `Cache-Control: no-store` | 200, 403, 404, 422, 429 |
| `PCA-41` | POST | `/pca-items/check-link` | `{ pcaItemId, targetType: PROCESS\|DFD, targetId?, organizationId?, estimatedValue? }` (sem gravar) | `200 { data: { eligible, violations[{code,severity,message,params}], balance? } }` · `balance`: `{ evaluated, exceeded }` e, com `PCA_VIEW`, `{ plannedValue, committedValue, available, confidentialExcluded }` | 200, 403, 404, 422, 429 |
| `PCA-42` | GET | `/processes/{id}/pca-link` | — | `200 { data: { pcaStatus, pcaYear, pcaItemCode, pcaLinkStatus, item?{id,code,object,department,category,status}, plan?{id,year,versionNumber,status}, alerts[], balance?, history[{at,actor,via,fromCode,toCode,reason?}] } }` · `ETag` | 200, 403, 404 |
| `PCA-43` | GET | `/dfds/{id}/pca-link` | — | Igual a PCA-42 para o DFD (sem `balance`) | 200, 403, 404 |
| `PRC-02` | POST | `/processes` | MVP 1 + `pcaItemId?`, `pcaAcknowledgedWarnings?` | `201 { data: Process }` com `pcaItemId`, `pcaLinkStatus`, `pcaItem` (aditivos) | 201, 403, 409, 422, 429, 503 |
| `PRC-05` | PATCH | `/processes/{id}` | MVP 1 + `pcaItemId?` (uuid ou `null`), `pcaItemChangeReason?`, `pcaAcknowledgedWarnings?` + `If-Match` | `200 { data: Process }` + `ETag` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `PRC-04` / `PRC-07` | GET | `/processes/{id}` e `/summary` | — | Acrescentam `pcaItemId`, `pcaLinkStatus`, `pcaItem` (nulo para `CONSULTOR_EXTERNO`) | 200, 404 |
| `DFD-02` / `DFD-03` | POST/GET | `/processes/{id}/dfds`, `/dfds/{id}` | — | `Dfd` com `pcaItemId`, `pcaLinkStatus`, `pcaItem`; DFD novo herda o vínculo | 200/201, 404 |
| `DFD-04` | PATCH | `/dfds/{id}` | MVP 1 + `pcaItemId?`, `pcaItemChangeReason?`, `pcaAcknowledgedWarnings?` + `If-Match` | `200 { data: Dfd }` + `ETag` | 200, 403, 404, 409, 412, 422, 428 |
| `DOC-08` | GET | `/documents/{id}/validation` | — | `violations[]` com `DFD_PCA_LINK_REQUIRED` e `DFD_PCA_ITEM_UNAVAILABLE` | 200, 404 |
| `SET-02` | PATCH | `/settings` | `pca.requireLinkForPlanned`, `pca.itemBalanceSeverity` | `200` | 200, 403, 422 |

Notas de contrato: `Cache-Control: no-store` em PCA-40 a PCA-43; item de outro tenant/órgão no **corpo** ⇒ 422 `REFERENCE_NOT_FOUND`; alvo no **caminho** ⇒ 404. Limites: PCA-40 sujeito à classe de leitura (600/min), com *debounce* no cliente.

## Logs
- `info` `pca.link_applied` — `targetType`, `targetId`, `pcaItemId`, `via`, `replaced` (bool), `warningsAcknowledged` (códigos), `durationMs`.
- `info` `pca.link_removed` — `targetType`, `targetId`, `cause` (`EXPLICIT`, `STATUS_CHANGE`, `DFD_APPROVED`).
- `warn` `pca.link_rejected` — `targetType`, `reason` (`PLAN_NOT_APPROVED`, `ITEM_CANCELED`, `PLAN_SUPERSEDED`, `YEAR_NOT_ALLOWED`, `BALANCE_EXCEEDED`, `WARNINGS_NOT_ACKNOWLEDGED`).
- `info` `pca.lookup` — `resultCount`, `planFound`, `durationMs` (sem o texto de busca).
- `error` `pca.link_failed` — `targetType`, causa técnica; métrica `cf_pca_link_total{via,outcome}`.
- **Nunca logar:** texto de busca, objeto do item, justificativa da troca, valores (previsto, estimado, saldo), nomes dos usuários.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.pca_link` | `DATA_CHANGE` | Criação, troca ou propagação do DFD que grava o vínculo | `changes`: `pcaItemId`, `pcaYear`, `pcaItemCode`, `pcaLinkStatus` (antes/depois). `metadata`: `via`, `pcaId`, `planVersion`, `previousPcaItemId?`, `reason?` (texto integral, ≤ 500), `warningsAcknowledged[]`, `balanceExceeded` (booleano), `idempotencyKey?` — sem valores monetários |
| `process.pca_unlink` | `DATA_CHANGE` | Remoção explícita ou implícita do vínculo | `changes`: idem; `metadata`: `cause`, `reason?` |
| `dfd.pca_link` | `DATA_CHANGE` | DFD-04 vincula ou troca o item | idem, com `dfdId`, `processCode` |
| `dfd.pca_unlink` | `DATA_CHANGE` | DFD-04 remove o vínculo | idem (**ação nova**, Lacuna 5) |
| `process.create` / `process.update` | `DATA_CHANGE` | Como no MVP 1 | Sem repetir os campos do vínculo quando houver `process.pca_link` (RN-PCA-253) |
| `access.denied` | `ACCESS` | Tentativa sem permissão ou custódia | `reasonCode` da permissão ou `POL-01`/`POL-02` |

## Testes necessários
- **Unitários:** `PcaLinkStatusDeriver` (todas as combinações de `pcaStatus` × item × mudança de texto); `PcaItemEligibility` (plano `DRAFT`/`AWAITING_APPROVAL`/`SUPERSEDED`, item cancelado, órgão, exercício permitido); `PcaBalance` (soma dos demais processos, exclusão de cancelados, valor nulo, centavos); política de severidade `OFF`/`WARNING`/`BLOCKING`; regras de completude `DFD_PCA_LINK_REQUIRED` e `DFD_PCA_ITEM_UNAVAILABLE`; justificativa 19/20/500/501 caracteres.
- **Integração (Testcontainers PostgreSQL + Redis):** PRC-02 e PRC-05 com vínculo, troca e remoção (checks do banco, auditoria, outbox, timeline); herança processo → DFD na criação; propagação DFD → processo na decisão `APPROVED` (US-017); duplicação (US-011/US-018) com item elegível e inelegível; rollback total por falha de auditoria; `pg_advisory_xact_lock` com dois processos disputando saldo; índice de `PCA_ITEM_IN_USE`.
- **API/contrato:** PCA-40 a PCA-43; campos aditivos de PRC-02/04/05/07 e DFD-02/03/04 (contrato do MVP 1 intacto: corpo sem os campos novos continua válido); `WARNINGS_NOT_ACKNOWLEDGED` com `violations[]`; ausência de valores na resposta do seletor.
- **RBAC e multi-tenant:** `PROCESS_UPDATE` sem escopo, sem custódia, status não editável; `CONSULTOR_EXTERNO` (403 no seletor, `pcaItem` nulo); item/plano/processo de outro tenant e de outro órgão (suíte `test/tenant-leak`, arquivo novo `pca-linking.tenant-leak.test.ts`); POL-09 no saldo (usuário sem permissão não vê valores).
- **Concorrência:** dois PATCH com o mesmo `If-Match`; duas criações disputando saldo com `BLOCKING`; vínculo versus aprovação do DFD ao mesmo tempo.
- **E2E (Playwright):** criar processo com item; DFD herdando e propagando; trocar item com justificativa; fluxo de aviso de saldo e duplicidade; plano não aprovado (modo texto); `pca.requireLinkForPlanned` impedindo concluir o DFD.
- **Acessibilidade/performance:** axe no `PcaItemPicker`, no `PcaLinkCard` e nos diálogos; teclado completo no combobox; p95 do seletor na suíte de performance (medida no endurecimento).

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
- [ ] Teste de contrato do MVP 1 (criação e edição de processo/DFD sem os campos novos) verde
- [ ] Sigilo verificado: seletor e eventos sem valores; saldo mascarado sem POL-09

## Estimativa
**M** — estende três contratos do MVP 1 de forma aditiva (PRC-02/05, DFD-04), cria o seletor e a pré-verificação, aplica elegibilidade, saldo com severidade configurável e avisos, a herança nos dois sentidos e o cartão do painel; não cria tabelas nem job.

## Prioridade
**P1** — alimenta o acompanhamento da execução do plano (US-144), os indicadores (US-175) e a reconciliação (US-143); sem o vínculo, o PCA aprovado fica isolado dos processos e o critério de saída do MVP 2 ("PCA vinculado aos DFDs") não se cumpre.
