---
id: US-165
title: "Organizar os lotes do edital"
epic: EP-027
feature: FT-078
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-006, US-163]
modules: [tender, process, catalog, access, timeline, audit, platform]
screens: [SCR-021, SCR-006]
endpoints: [TND-07, TND-08, TND-03]
permissions: [TENDER_UPDATE, PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: [TenderLotsChanged]
---

# US-165 — Organizar os lotes do edital

## Título
Organizar os lotes do edital

## Descrição
**Como** servidor de Licitações que elabora a minuta do edital, **quero** agrupar os itens do processo em lotes, nomear cada lote, mover itens entre lotes e ver na hora se os lotes cobrem todos os itens quando a adjudicação é por lote, **para** que a estrutura do edital reflita a decisão de parcelamento do planejamento, nenhum item fique de fora e o valor de cada lote seja conferido sem expor o orçamento sigiloso.

A story entrega a leitura dos lotes e da cobertura (TND-07), a gravação da estrutura completa de lotes e da distribuição dos itens (TND-08), a sugestão de lotes a partir do planejamento (`ProcessItem.lotNumber`/`lotName`), o valor estimado de cada lote com a máscara do orçamento sigiloso e a aba "Itens e lotes" da SCR-021. Criar a minuta é da US-163, importar do TR da US-164, a matriz de riscos da US-166 e a conclusão, que recusa a minuta sem cobertura de lotes, da US-168.

## Contexto
- A Lei 14.133/2021 admite a divisão do objeto em itens, lotes ou global e a adjudicação correspondente (art. 40, § 2º e § 3º, e art. 82, § 1º). No planejamento o parcelamento já foi decidido: `ProcessItem.lotNumber` e `lotName` (US-006) e `AwardType` (`BY_ITEM`, `BY_LOT`, `GLOBAL`) no TR (US-038). O edital precisa de uma estrutura própria, porque o lote **do edital** pode mudar durante a elaboração sem reescrever o planejamento.
- A DEC-201 modela `TenderLot` (`number`, `name`, `description`, `smallBusinessBenefit`, `estimatedValue`) e `TenderLotItem` (um `ProcessItem` em um só lote do edital, `UNIQUE (tenant_id, tender_id, process_item_id)`). `ProcessItem.lotNumber`/`lotName` continuam como planejamento (dono `process`); os lotes do edital nascem deles na criação (US-163) e na importação do TR (US-164), e depois evoluem por esta story.
- A RN-TND-05 manda que um item pertença a um só lote e que, com `awardType = BY_LOT`, os lotes cubram todos os itens do processo. A cobertura é **cobrada na conclusão** (US-168, RN-TND-09): durante a elaboração o trabalho em andamento pode ser salvo incompleto, com a lista dos itens sem lote sempre à vista.
- Sigilo do orçamento (art. 24, DEC-030, POL-09): o `estimatedValue` do lote é um valor derivado dos itens e segue a máscara central (`null` mais `masked: true`) para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo nem a custódia, em todas as respostas, e nunca aparece em evento, log ou auditoria.
- A edição segue o ciclo de vida do documento `EDITAL` (DEC-018) e a POL-02 com `TENDER_UPDATE`; coleções tipadas do edital seguem a regra do documento dono (permissions.md §7).

## Objetivo
Garantir que 100% dos itens do processo possam ser distribuídos em lotes do edital sem item em dois lotes, que a cobertura incompleta com adjudicação por lote seja sempre visível e apontada item a item, que a distribuição seja gravada de forma atômica e que nenhum valor sigiloso de lote apareça para quem não pode vê-lo.

## Persona
- **Principal:** Licitações (`LICITACOES`) — organiza os lotes.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`); Consultoria externa (`CONSULTOR_EXTERNO`) como participante com `TENDER_UPDATE`; Planejamento (`PLANEJAMENTO`) e Compras (`COMPRAS`), que conferem a fidelidade ao planejamento (leitura); Jurídico e Controle Interno (leitura da versão concluída).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`, MFA conforme `security.mfaPolicy` (`TENDER_UPDATE` é risco `M`: MFA só com política `ALL`).
- Minuta criada (US-163): `Tender` e documento `EDITAL`.
- Para **ler** (TND-07): `PROCESS_VIEW` cobrindo o processo.
- Para **gravar** (TND-08): `TENDER_UPDATE` cobrindo o processo; custódia ou participação `COLLABORATOR`/`CONSULTANT` (POL-02); `EDITAL` em `DRAFT` ou `RETURNED`; tipo permitido na etapa; processo em `DRAFT`/`IN_PROGRESS`/`RETURNED`.
- Processo com ao menos um `ProcessItem` (sem itens, a aba mostra o estado vazio com o atalho para a aba "Itens" do processo).

## Fluxo principal
1. Na SCR-021 (`/processos/[id]/edital/[tenderId]`), a pessoa abre a aba **"Itens e lotes"**. O front chama TND-07, que devolve os lotes do edital (com os itens de cada um), a lista de itens sem lote, a cobertura e a sugestão a partir do planejamento.
2. A tela mostra o indicador de cobertura: com `awardType = BY_LOT`, **"8 de 8 itens em lotes"** (verde, com ícone e texto) ou **"3 itens sem lote"** (alerta, com a lista); com outra adjudicação, a cobertura é apenas informativa.
3. A pessoa cria um lote com **"Novo lote"** (número sugerido, nome obrigatório, descrição opcional e benefício a pequenas empresas opcional), arrasta itens da lista "Sem lote" para o lote ou usa o menu **"Mover para lote…"** (alternativa por teclado), e remove ou renomeia lotes.
4. Quando o edital está sem lotes e o planejamento definiu lotes, o botão **"Sugerir a partir do planejamento"** preenche o rascunho de lotes com os grupos de `ProcessItem.lotNumber`/`lotName`; a pessoa revisa antes de salvar.
5. O valor estimado de cada lote aparece como soma dos itens (quando a pessoa pode ver o valor); itens sem quantidade ou preço de referência marcam o lote com "Valor incompleto".
6. Ao clicar em **"Salvar lotes"**, o front envia TND-08 com a estrutura completa (lotes e itens de cada um) e `If-Match` (ETag do `Tender`).
7. A API valida existência e tenant, permissão e POL-02, o corpo (números, nomes, itens, duplicidades), trava o `Tender` (`SELECT … FOR UPDATE`) e, na mesma transação, substitui a estrutura: atualiza os lotes com `id`, cria os sem `id`, remove os ausentes (liberando seus itens), grava os `TenderLotItem`, recalcula `estimatedValue` de cada lote, incrementa a `version` do `Tender`, audita `tender.lots_update` e grava `TenderLotsChanged` no outbox.
8. A API responde 200 com a estrutura gravada, a cobertura e a nova `ETag`. O front mostra o toast "Lotes salvos: 2 lotes, 8 itens" e atualiza o indicador de cobertura.
9. Se algum item ficou sem lote com adjudicação por lote, a resposta traz `coverage.complete = false` com a lista; a gravação **não** é recusada (trabalho em andamento) e a conclusão da minuta (US-168) só prossegue com a cobertura completa.
10. Planejamento, Compras ou o Jurídico abrem a aba e leem os lotes em modo somente leitura.

## Fluxos alternativos
- **FA-01 — Edital sem lotes e sem planejamento de lotes:** a aba mostra "Nenhum lote criado" com os botões **"Novo lote"** e, quando `awardType = BY_ITEM`, a explicação "Com adjudicação por item os lotes são opcionais".
- **FA-02 — Sugestão do planejamento diverge dos lotes do edital:** TND-07 informa `planningSuggestion.differsFromCurrent = true`; a tela mostra "Os lotes do planejamento (aba Itens do processo) diferem dos lotes do edital" com "Ver sugestão"; nada é alterado sem ação da pessoa (RN-TND-64).
- **FA-03 — Item novo no processo depois dos lotes:** o item aparece em "Sem lote" com a marca "Novo no processo"; com `BY_LOT`, a cobertura passa a incompleta.
- **FA-04 — Adjudicação diferente de `BY_LOT`:** `BY_ITEM` e `GLOBAL` aceitam lotes opcionais; com `GLOBAL`, a tela avisa "Com adjudicação global os lotes não definem a adjudicação" (RN-TND-63).
- **FA-05 — Valor sigiloso:** sem direito de ver o orçamento, o valor do lote aparece como "Valor reservado (art. 24)"; a soma e a ordenação por valor ficam indisponíveis (RN-TND-66).
- **FA-06 — Lotes com lacuna de numeração:** a gravação aceita (por exemplo lotes 1 e 3) e retorna o aviso `LOT_NUMBER_GAP`; o botão **"Renumerar lotes"** reordena de 1 a n (RN-TND-70).
- **FA-07 — Lote vazio:** a gravação com lote sem itens é recusada (422); a tela mantém o lote em edição e indica "Inclua ao menos um item ou remova o lote" (RN-TND-62).
- **FA-08 — Gravação sem alteração:** o corpo reproduz a estrutura atual; 200 sem incrementar a `version`, sem auditoria e sem evento (RN-TND-72).
- **FA-09 — Documento não editável:** com o `EDITAL` fora de `DRAFT`/`RETURNED`, 409 `DOCUMENT_NOT_EDITABLE`; a aba fica em leitura.
- **FA-10 — Conflito de edição:** `If-Match` divergente, 412 `VERSION_CONFLICT`; o front recarrega e mostra o que mudou, preservando o rascunho local para reaplicar.
- **FA-11 — Excluir item do processo que está em lote:** a exclusão no módulo do processo é recusada com 409 `ITEM_IN_USE` ("O item está em um lote do edital") enquanto o item estiver em um `TenderLotItem` (RN-TND-69).

## Regras de negócio
- **RN-TND-05** — Um item pertence a um só lote; com `awardType = BY_LOT` os lotes devem cobrir todos os itens do processo (DEC-201). *(regra da feature, adotada; a cobrança na conclusão é da US-168)*
- **RN-TND-10** — A edição segue o ciclo de vida do documento (DEC-018) e a POL-02 com `TENDER_UPDATE`, apenas em `DRAFT` ou `RETURNED` para o colaborador; valores seguem o sigilo do orçamento (DEC-030). *(regra da feature, adotada)*
- **RN-TND-60** *(nova)* — Pré-requisitos: gravar (TND-08) exige `TENDER_UPDATE` cobrindo o processo, custódia ou participação `COLLABORATOR`/`CONSULTANT`, `EDITAL` em `DRAFT`/`RETURNED`, tipo permitido na etapa e processo editável (POL-02: `DOCUMENT_NOT_EDITABLE`, `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`, `INVALID_PROCESS_STATUS`, `NOT_PROCESS_CUSTODIAN`); ler (TND-07) exige `PROCESS_VIEW` cobrindo o processo (DEC-024); minuta de outro tenant ou de processo invisível responde 404 (`TENDER_NOT_FOUND`).
- **RN-TND-61** *(nova)* — Lote (`TenderLot`): `number` inteiro de 1 a 999 (mesma faixa de `ProcessItem.lotNumber`), único no edital; `name` obrigatório, aparado, de 1 a 150 caracteres; `description` opcional de até 2.000 caracteres; `smallBusinessBenefit` opcional (`NONE`, `EXCLUSIVE`, `RESERVED_QUOTA`, `SUBCONTRACTING`), com `null` significando "o do edital"; `estimatedValue` é derivado e somente leitura (`NOT_ALLOWED` se enviado). Os limites de valor do benefício a pequenas empresas (LC 123/2006, arts. 47 a 49) não são validados por esta story (lacuna 8).
- **RN-TND-62** *(nova)* — Itens do lote: cada `processItemIds[]` deve ser um `ProcessItem` não excluído do **mesmo processo** do edital (`REFERENCE_NOT_FOUND` para outro processo ou outro tenant); o mesmo item não pode constar duas vezes na estrutura (`DUPLICATE_IN_LIST`, com o caminho do lote); todo lote tem ao menos um item (`REQUIRED` em `processItemIds`); item sem lote é permitido e fica na lista de itens sem lote.
- **RN-TND-63** *(nova)* — Cobertura: `itemsTotal` é a quantidade de `ProcessItem` do processo; `itemsAssigned` a dos itens em lotes; `itemsUnassigned` a diferença, com a lista (`processItemId`, `sequence`, `description`); `coverage.required = (awardType = BY_LOT)`; `coverage.complete = (itemsUnassigned = 0)`. A cobertura incompleta **nunca bloqueia a gravação**; ela bloqueia a conclusão quando `required` (US-168, `TypedDocumentModule.validateCompleteness`). Com `GLOBAL`, os lotes são aceitos e ignorados para efeito de adjudicação (aviso `LOTS_IGNORED_BY_AWARD`); com `BY_ITEM`, são apenas agrupamento do texto.
- **RN-TND-64** *(nova)* — Semente a partir do planejamento: o `TenderLotSeeder` agrupa os `ProcessItem` por `lotNumber` (nome do lote = `lotName` do grupo; se os itens do grupo têm nomes diferentes, o do item de menor `sequence`; se não há nome, "Lote {n}"), ignora itens sem `lotNumber` e produz a estrutura proposta. Ele roda automaticamente apenas quando o edital **não tem lotes** (na criação, US-163, e na importação do TR, US-164) e, por ação explícita da pessoa, quando ela pede "Sugerir a partir do planejamento" (que apenas preenche o rascunho local, sem gravar). Nunca altera `ProcessItem` nem sobrescreve lotes já existentes sem confirmação. TND-07 devolve `planningSuggestion` (`lots[]`, `differsFromCurrent`).
- **RN-TND-65** *(nova)* — Valor estimado do lote: `estimatedValue` = soma, para os itens do lote, de `ProcessItem.referenceQuantity × ProcessItem.referenceUnitPrice`, com duas casas (arredondamento comercial). Se algum item do lote não tem quantidade ou preço de referência, o valor é `null` com `valueIncomplete = true`. O servidor recalcula o valor a cada gravação e **também ao ler** (TND-07), de modo que mudanças posteriores nas referências do item (conclusão da pesquisa de preços, aprovação do TR) não deixem a coluna desatualizada; a conclusão (US-168) recalcula antes de congelar o snapshot.
- **RN-TND-66** *(nova)* — Sigilo (art. 24, DEC-030, POL-09): com `Process.isBudgetConfidential = true`, `estimatedValue` do lote (e qualquer total derivado) sai `null` com `masked: true` para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo nem a custódia atual, aplicado pelo serializador central; a gravação nunca aceita nem devolve valor para esse público; eventos, logs, auditoria e a timeline não carregam valores. Valor visível ao usuário não significa divulgável: a divulgação no texto do edital segue `estimatedValueDisclosed` (US-163, RN-TND-28).
- **RN-TND-67** *(nova)* — Benefício por lote: `smallBusinessBenefit` do lote prevalece sobre o do edital quando preenchido; a tela mostra o benefício efetivo ("do edital" ou o próprio); o `NONE` explícito num lote é diferente de `null` (herda).
- **RN-TND-68** *(nova)* — Gravação atômica por substituição: TND-08 recebe a estrutura **completa** (`lots[]`); lotes com `id` são atualizados, sem `id` criados e ausentes removidos (com seus `TenderLotItem`, que só podem ser removidos enquanto o documento é editável); `id` de outro edital ou tenant é recusado (`REFERENCE_NOT_FOUND`); a troca de itens entre lotes acontece na mesma transação, sem violar a unicidade por item (a API aplica remoções antes das inclusões). Não existe endpoint por item ou por lote isolado nesta story.
- **RN-TND-69** *(nova)* — Concorrência e integridade com o processo: TND-08 exige `If-Match` com a `version` do `Tender` (412 `VERSION_CONFLICT`; ausente, 428 `PRECONDITION_REQUIRED`) e trava o `Tender`; a mesma `version` é incrementada por qualquer escrita do tender (US-163, RN-TND-35). A exclusão de `ProcessItem` que consta em `TenderLotItem` é recusada pelo módulo `process` (409 `ITEM_IN_USE`, consulta por `TenderFacade`, além do `ON DELETE RESTRICT` da FK); a renumeração de itens do processo não afeta os lotes (a ordem exibida usa `ProcessItem.sequence` corrente); item criado depois entra em "Sem lote".
- **RN-TND-70** *(nova)* — Numeração e ordem: lotes são exibidos por `number` crescente e, dentro do lote, por `ProcessItem.sequence`; lacunas de numeração são aceitas com o aviso `LOT_NUMBER_GAP`; "Renumerar lotes" (ação de tela) apenas reescreve os números de 1 a n no rascunho local, mantendo a ordem atual.
- **RN-TND-71** *(nova)* — Limites: até 200 lotes por edital, 1.000 itens no total (limite de itens do processo) e corpo de até 2 MB; acima disso, 422 `VALIDATION_ERROR` (`OUT_OF_RANGE`/`TOO_LONG`).
- **RN-TND-72** *(nova)* — Idempotência natural: o `PUT` não usa `Idempotency-Key` (mesmo padrão do DOC-07 do MVP 1); repetir a mesma estrutura com a ETag vigente é um no-op (200, sem versão, sem auditoria, sem evento); repetir com a ETag antiga recebe 412.
- **RN-TND-73** *(nova)* — Eventos, timeline e notificação: uma gravação efetiva publica `TenderLotsChanged` (`tenderId`, `lotsCount`, `itemsUnassigned`) uma vez; `events.md` não prevê entrada na timeline nem notificação para lotes; a auditoria `tender.lots_update` registra contagens e ids (lotes criados, atualizados e removidos, itens movidos), sem valores e sem texto de nomes ou descrições (só tamanhos).
- **RN-TND-74** *(nova)* — Efeitos em outras partes: `tender.lotsCount` do `RuleContext` v2 (US-129) passa a refletir a gravação; a cobertura e o valor dos lotes são lidos pela conclusão (US-168) e pelo rascunho por IA (US-169, que nunca define lotes); mudar `awardType` no cabeçalho (US-163, RN-TND-32) não apaga lotes.
- **RN-TND-75** *(nova)* — Leitura (TND-07): devolve `lots[]` com `items[]` (id, número, descrição, unidade, quantidade de referência), `unassignedItems[]`, `coverage` (`required`, `complete`, `itemsTotal`, `itemsAssigned`, `itemsUnassigned`), `planningSuggestion`, `awardType` e `editable`/`editBlockedReason`; sem sigilo, valores de itens e lotes seguem a RN-TND-66.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Lotes | `lots[]` (TND-08) | lista | Sim (pode ser vazia para remover todos) | RN-TND-68, RN-TND-71 | estrutura atual |
| Identificador do lote | `lots[].id` | uuid | Não | sem `id` cria; com `id` atualiza | `GET` TND-07 |
| Número do lote | `lots[].number` | inteiro (1..999) | Sim | único no edital (RN-TND-61) | próximo número livre |
| Nome do lote | `lots[].name` | texto (1..150) | Sim | RN-TND-61 | `lotName` do planejamento ou "Lote {n}" |
| Descrição | `lots[].description` | texto (até 2.000) | Não | RN-TND-61 | em branco |
| Benefício a pequenas empresas | `lots[].smallBusinessBenefit` | `NONE` \| `EXCLUSIVE` \| `RESERVED_QUOTA` \| `SUBCONTRACTING` \| nulo | Não | nulo = o do edital (RN-TND-67) | nulo |
| Itens do lote | `lots[].processItemIds[]` | lista de uuid | Sim (mín. 1) | RN-TND-62 | itens arrastados |
| Versão da minuta | `If-Match` (ETag) | texto | Sim (TND-08) | `Tender.version` | `GET` TND-07 |
| *(saída)* Itens sem lote | `unassignedItems[]` | lista | — | RN-TND-63 | `ProcessItem` |
| *(saída)* Cobertura | `coverage` (`required`, `complete`, `itemsTotal`, `itemsAssigned`, `itemsUnassigned`) | objeto | — | RN-TND-63 | calculado |
| *(saída)* Valor do lote | `lots[].estimatedValue`, `valueIncomplete`, `masked` | decimal / booleanos | — | RN-TND-65, RN-TND-66 | calculado; mascarado |
| *(saída)* Sugestão do planejamento | `planningSuggestion` (`lots[]`, `differsFromCurrent`) | objeto | — | RN-TND-64 | `ProcessItem.lotNumber`/`lotName` |
| *(saída)* Avisos | `warnings[]` (`LOT_NUMBER_GAP`, `LOTS_IGNORED_BY_AWARD`) | lista | — | RN-TND-63, RN-TND-70 | calculado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `number` fora de 1 a 999 ou repetido | Front + API (Zod) | "Informe um número de lote entre 1 e 999, sem repetir." | `VALIDATION_ERROR` (`OUT_OF_RANGE`/`DUPLICATE_IN_LIST`) |
| V-02 | `name` vazio ou acima de 150 caracteres | Front + API | "Informe o nome do lote (até 150 caracteres)." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_LONG`) |
| V-03 | `description` acima de 2.000 caracteres | Front + API | "A descrição do lote aceita até 2.000 caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-04 | Lote sem itens | Front + API | "Inclua ao menos um item no lote ou remova o lote." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-05 | Mesmo item em mais de um lote ou repetido no lote | Front + API | "O item {n} já está em outro lote. Cada item pertence a um só lote." | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`) |
| V-06 | Item inexistente, excluído ou de outro processo ou tenant | API | "O item informado não pertence a este processo." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-07 | `id` de lote inexistente ou de outro edital | API | "Lote não encontrado. Atualize a página." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-08 | `smallBusinessBenefit` fora do enum | API | "Escolha uma opção válida de benefício." | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-09 | `estimatedValue` ou campo desconhecido no corpo | API | "Este campo não pode ser alterado aqui." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-10 | Mais de 200 lotes ou corpo acima de 2 MB | API | "A estrutura excede o limite de {n} lotes." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) / `PAYLOAD_TOO_LARGE` (413) |
| V-11 | Documento fora de `DRAFT`/`RETURNED` | API | "A minuta não pode ser editada no status atual." | `DOCUMENT_NOT_EDITABLE` (409) |
| V-12 | Tipo não permitido na etapa | API | "O edital é elaborado na etapa Minuta do edital." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` (422) |
| V-13 | `If-Match` ausente ou divergente | API | "Atualize a página e tente de novo." / "Os lotes foram alterados por outra pessoa." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-14 | Exclusão de item do processo que está em lote | API (módulo `process`) | "O item está em um lote do edital. Remova-o do lote antes de excluir." | `ITEM_IN_USE` (409) |

## Permissões
- **Permissão:** `TENDER_UPDATE` com escopo que cubra o processo para gravar (TND-08); `PROCESS_VIEW` para ler (TND-07); `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo (ou custódia) para ver o valor dos lotes quando o orçamento é sigiloso.
- **Políticas:** POL-02 (edição: `EDITAL` ← `TENDER_UPDATE`, custódia ou participação, `DRAFT`/`RETURNED`, etapa, status do processo; as coleções `TenderLot` e `TenderLotItem` seguem o documento dono), POL-09 (sigilo do valor), DEC-024 (visibilidade).
- **MFA:** `TENDER_UPDATE` é risco `M`: exigido apenas com `security.mfaPolicy = ALL`.
- **Sem permissão:** a aba abre em leitura (sem "Novo lote", "Salvar lotes" nem arrastar); a API responde 403 `PERMISSION_DENIED` ou `NOT_PROCESS_CUSTODIAN` e grava `access.denied`; edital ou processo de outro tenant ou invisível responde 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `TenderLotsChanged` | `tender.lots_changed` | Commit de TND-08 com alteração efetiva (e na semente das US-163/US-164) | `tenderId`, `lotsCount`, `itemsUnassigned`; sem valores nem nomes; sem consumidor síncrono nem entrada na timeline |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação nesta story: `events.md` §6 não prevê tipo para alteração de lotes do edital |

## Critérios de aceite em Gherkin
```gherkin
Feature: Organizar os lotes do edital

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o processo "0012/2026" está "IN_PROGRESS" na etapa "MINUTA_EDITAL", que permite o tipo "EDITAL", e tem 8 itens, 5 no lote de planejamento 1 "Material de expediente" e 3 no lote 2 "Informática"
    And a minuta "ED 0001/2026" está "DRAFT" com adjudicação "BY_LOT" e ETag "T1", e ainda sem lotes
    And "Lia Moreira" tem o perfil "LICITACOES" com "TENDER_UPDATE" e a custódia do processo
    And "Paulo Reis", da consultoria externa, é participante "CONSULTANT" com "TENDER_UPDATE"
    And "Marcos Ribeiro", de Compras, tem apenas "PROCESS_VIEW"
    And os itens têm quantidade e preço de referência e o orçamento do processo não é sigiloso

  Scenario: [Sucesso] Consultar a estrutura e a sugestão do planejamento
    When "Lia Moreira" chamar "GET /tenders/{id}/lots"
    Then a API deve responder 200 com 0 lotes, 8 itens em "unassignedItems" e "coverage.required" verdadeiro e "coverage.complete" falso
    And "planningSuggestion" deve trazer 2 lotes, "Material de expediente" com 5 itens e "Informática" com 3 itens
    And a resposta deve trazer a "ETag" "T1"

  Scenario: [Sucesso] Organizar dois lotes e cobrir todos os itens
    When "Lia Moreira" chamar "PUT /tenders/{id}/lots" com o lote 1 "Material de expediente" (itens 1 a 5), o lote 2 "Informática" (itens 6 a 8) e "If-Match" "T1"
    Then a API deve responder 200 com 2 lotes, "coverage.complete" verdadeiro e a "ETag" incrementada
    And cada lote deve trazer "estimatedValue" igual à soma de quantidade de referência vezes preço de referência dos seus itens
    And deve ser publicado "TenderLotsChanged" com "lotsCount" 2 e "itemsUnassigned" 0
    And deve gerar a auditoria "tender.lots_update" com contagens e sem valores nem nomes
    And os itens do processo devem continuar com os mesmos "lotNumber" e "lotName"

  Scenario: [Sucesso] Mover um item de lote
    Given que os lotes 1 e 2 estão gravados com a ETag "T2"
    When "Lia Moreira" enviar "PUT /tenders/{id}/lots" movendo o item 5 do lote 1 para o lote 2 com "If-Match" "T2"
    Then a API deve responder 200 com o lote 1 de 4 itens e o lote 2 de 4 itens
    And o item 5 deve constar em um só lote

  Scenario: [Sucesso] Gravar cobertura incompleta com adjudicação por lote
    When "Lia Moreira" gravar apenas o lote 1 com os itens 1 a 5
    Then a API deve responder 200 com "coverage.complete" falso e "itemsUnassigned" 3 com os itens 6, 7 e 8
    And deve ser publicado "TenderLotsChanged" com "itemsUnassigned" 3

  Scenario: [Sucesso] Adjudicação por item aceita lotes como agrupamento opcional
    Given que a adjudicação da minuta é "BY_ITEM"
    When "Lia Moreira" chamar "GET /tenders/{id}/lots"
    Then a API deve responder 200 com "coverage.required" falso

  Scenario: [Sucesso] Valor do lote mascarado em orçamento sigiloso
    Given que o orçamento do processo é sigiloso e os lotes estão gravados
    When "Paulo Reis", sem "PROCESS_VIEW_CONFIDENTIAL_BUDGET" e sem a custódia, chamar "GET /tenders/{id}/lots"
    Then cada lote deve trazer "estimatedValue" nulo e "masked" verdadeiro
    When "Lia Moreira", com a custódia, chamar "GET /tenders/{id}/lots"
    Then cada lote deve trazer o valor calculado
    And nenhum valor deve aparecer em eventos, logs ou auditoria

  Scenario: [Sucesso] Valor incompleto quando falta preço de referência
    Given que o item 7 não tem preço de referência
    When "Lia Moreira" chamar "GET /tenders/{id}/lots"
    Then o lote do item 7 deve trazer "estimatedValue" nulo e "valueIncomplete" verdadeiro

  Scenario: [Sucesso] Gravação idêntica não altera a versão
    Given que os lotes estão gravados com a ETag "T2"
    When "Lia Moreira" repetir "PUT /tenders/{id}/lots" com a mesma estrutura e "If-Match" "T2"
    Then a API deve responder 200 com a ETag "T2" e nenhum evento nem auditoria devem ser gerados

  Scenario: [Validação] Dados inválidos de lotes
    When "Lia Moreira" gravar um lote com "number" 1000
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "OUT_OF_RANGE" em "lots[0].number"
    When "Lia Moreira" gravar um lote sem nome
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REQUIRED" em "lots[0].name"
    When "Lia Moreira" gravar um lote sem itens
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REQUIRED" em "lots[0].processItemIds"
    When "Lia Moreira" enviar "estimatedValue" no corpo
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED"
    And nenhum lote deve ter sido alterado

  Scenario: [Validação] Etapa fora de MINUTA_EDITAL e edital já finalizado
    Given que o processo está na etapa "JURIDICO", que não permite o tipo "EDITAL"
    When "Lia Moreira" chamar "PUT /tenders/{id}/lots"
    Then a API deve responder 422 com código "DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE"
    Given que o documento "EDITAL" está "FINALIZED"
    When "Lia Moreira" chamar "PUT /tenders/{id}/lots"
    Then a API deve responder 409 com código "DOCUMENT_NOT_EDITABLE"
    And a leitura "GET /tenders/{id}/lots" deve continuar respondendo 200

  Scenario: [Validação] Item de outro processo e exclusão de item em lote
    Given que o item "X" pertence ao processo "0013/2026"
    When "Lia Moreira" gravar o lote 1 com o item "X"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" em "lots[0].processItemIds[0]"
    Given que o item 3 está no lote 1
    When "Lia Moreira" tentar excluir o item 3 do processo
    Then a API deve responder 409 com código "ITEM_IN_USE"

  Scenario: [Permissão] Sem TENDER_UPDATE, leitor e participante
    Given que "Marcos Ribeiro" não tem "TENDER_UPDATE"
    When "Marcos Ribeiro" chamar "PUT /tenders/{id}/lots"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar a auditoria "access.denied"
    When "Marcos Ribeiro" chamar "GET /tenders/{id}/lots"
    Then a API deve responder 200 com "editable" falso
    When "Paulo Reis" chamar "PUT /tenders/{id}/lots" com uma estrutura válida
    Then a API deve responder 200
    Given que "Bruno Lopes", de Licitações, não tem a custódia do processo e não é participante
    When "Bruno Lopes" chamar "PUT /tenders/{id}/lots"
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN"

  Scenario: [Tenant incorreto] Edital e itens de outro órgão
    Given que o edital "ED 0002/2026" e os itens dele pertencem ao tenant "Prefeitura B"
    When "Lia Moreira" chamar "GET /tenders/{id-ED2}/lots" e "PUT /tenders/{id-ED2}/lots"
    Then a API deve responder 404 com código "TENDER_NOT_FOUND" nas duas chamadas
    When "Lia Moreira" gravar um lote com o item de um processo da "Prefeitura B"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND"
    And nenhum dado da "Prefeitura B" deve aparecer na resposta, nos logs ou na auditoria

  Scenario: [Duplicidade] Item em dois lotes, número repetido e reenvio
    When "Lia Moreira" gravar o item 1 nos lotes 1 e 2
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "DUPLICATE_IN_LIST"
    When "Lia Moreira" gravar dois lotes com o número 1
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "DUPLICATE_IN_LIST" em "lots[1].number"
    Given que "Lia Moreira" gravou os lotes com sucesso e recebeu a ETag "T2"
    When a mesma requisição for reenviada com a ETag "T1"
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    And a estrutura gravada não deve ter sido duplicada

  Scenario: [Concorrência] Gravações simultâneas, item excluído e importação
    Given que "Lia Moreira" e "Paulo Reis" leram a estrutura com a ETag "T1"
    When ambos enviarem "PUT /tenders/{id}/lots" com "If-Match" "T1" e distribuições diferentes
    Then uma chamada deve responder 200 e a outra 412 com código "VERSION_CONFLICT"
    And a estrutura final deve ser exatamente a da chamada que respondeu 200
    When "Lia Moreira" gravar o item 8 em um lote ao mesmo tempo em que o item 8 é excluído do processo
    Then exatamente uma das operações deve prevalecer e o lote nunca deve apontar para item excluído
    When "Paulo Reis" editar o cabeçalho antes de "Lia Moreira" gravar com a ETag antiga
    Then a gravação de "Lia Moreira" deve responder 412 com código "VERSION_CONFLICT"
    When "Lia Moreira" enviar "PUT /tenders/{id}/lots" sem "If-Match"
    Then a API deve responder 428 com código "PRECONDITION_REQUIRED"

  Scenario: [Falha de banco] Falha na transação de gravação dos lotes
    Given que o banco de dados fica indisponível durante a transação de "PUT /tenders/{id}/lots"
    When "Lia Moreira" tentar gravar os lotes
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And a estrutura de lotes, a "version" do "Tender", a auditoria e o outbox devem continuar como antes
    And o rascunho local da tela deve ser preservado com o botão "Tentar novamente"

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Lia Moreira" gravar os lotes com sucesso
    Then a API deve responder 200 com a estrutura gravada
    And o evento "TenderLotsChanged" deve permanecer "PENDING" no outbox até o relay voltar

  Scenario: [Sucesso] Desempenho da leitura e da gravação (teste de suíte, sem benchmark no card)
    Given a suíte de desempenho com um processo de 300 itens em 20 lotes
    When forem executadas 200 leituras de "GET /tenders/{id}/lots" e 50 gravações de "PUT /tenders/{id}/lots"
    Then o p95 de "TND-07" deve ser menor que 300 ms e o de "TND-08" menor que 800 ms
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Dados inválidos | 422 | `VALIDATION_ERROR` | Mensagem do campo | Marca o lote ou o item e foca o primeiro erro |
| Sem `If-Match` | 428 | `PRECONDITION_REQUIRED` | "Atualize a página e tente de novo." | Recarrega os lotes |
| ETag divergente | 412 | `VERSION_CONFLICT` | "Os lotes foram alterados por outra pessoa. Atualize a página." | Recarrega, mostra a diferença e preserva o rascunho local |
| Minuta inexistente, de outro tenant ou de processo invisível | 404 | `TENDER_NOT_FOUND` | "Minuta do edital não encontrada." | Volta ao detalhe do processo |
| Documento não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "A minuta não pode ser editada no status atual." | Aba em leitura |
| Processo em status não editável | 409 | `INVALID_PROCESS_STATUS` | "O processo não está em andamento." | Aba em leitura |
| Tipo fora da etapa | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "O edital é elaborado na etapa Minuta do edital." | Aba em leitura |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para alterar os lotes." | Oculta as ações de edição |
| Sem custódia | 403 | `NOT_PROCESS_CUSTODIAN` | "Você não está com este processo." | Oculta as ações de edição |
| Item do processo em lote | 409 | `ITEM_IN_USE` | "O item está em um lote do edital. Remova-o do lote antes de excluir." | Exibe link para a aba de lotes |
| Corpo acima do limite | 413 | `PAYLOAD_TOO_LARGE` | "A estrutura de lotes é grande demais." | Mantém o rascunho |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar os lotes agora. Tente novamente em instantes." | Botão "Tentar novamente"; respeita `Retry-After`; preserva o rascunho |

## Dependências
- **Stories:** US-163 (o `Tender`, o ETag compartilhado, a regra de edição e a semente de lotes na criação); US-006 (itens do processo, `lotNumber`/`lotName`, `referenceQuantity`/`referenceUnitPrice` e a exclusão de item). Indiretas: US-038 (`AwardType` e itens do TR), US-164 (semente na importação), US-166 (matriz de riscos do mesmo edital), US-168 (cobrança da cobertura na conclusão), US-129 (`tender.lotsCount` no `RuleContext` v2), US-065 (ciclo de vida do documento), US-032 (preços de referência dos itens, ao concluir a pesquisa de preços).
- **Decisões/ADRs:** DEC-201, DEC-019, DEC-018, DEC-030; POL-02, POL-09; RN-TND-05, RN-TND-09, RN-TND-10.
- **Configurações:** nenhuma chave nova.
- **Lacunas nas fontes canônicas:**
  1. **Contrato de TND-07 e TND-08:** rotas indicativas na feature (`PUT /tenders/{id}/lots`); a leitura (`GET /tenders/{id}/lots`), o corpo por substituição e os campos de resposta (cobertura, sugestão do planejamento, `valueIncomplete`) não constam em `api.md`. A consolidar no `api.md` do MVP 2.
  2. **Fórmula de `TenderLot.estimatedValue`:** `entities.md` diz apenas "desnormalizado dos itens; mascarado se sigiloso". A story define soma de `referenceQuantity × referenceUnitPrice`, recalculada na leitura e na gravação (RN-TND-65); confirmar a fonte da quantidade (`ProcessItem.referenceQuantity` versus quantidade do TR) e registrar `TenderLot.estimatedValue` no registro de campos sigilosos do `ConfidentialFieldsInterceptor` (DEC-030).
  3. **Exclusão de `ProcessItem` em lote:** `ITEM_IN_USE` do MVP 1 descreve "item referenciado por documento/pesquisa"; ampliar a descrição para incluir `TenderLotItem` e acrescentar a consulta ao `TenderFacade` na US-006 (PRC de exclusão de item).
  4. **Faixas de `TenderLot`:** `entities.md` diz `number` inteiro maior ou igual a 1 e `name` com até 150 caracteres; a story fixa `number` de 1 a 999 (igual ao do `ProcessItem`) e `name` obrigatório. Confirmar.
  5. **Lote sem itens:** não há regra canônica; a story recusa lote vazio na gravação (RN-TND-62). **Dúvida de produto:** permitir lote vazio durante a elaboração e cobrar só na conclusão?
  6. **Cobertura só na conclusão:** a story não bloqueia a gravação com itens sem lote (RN-TND-63); a conclusão (US-168) deve apontar os itens. Alinhar a mensagem e o código da violação (`TENDER_LOT_COVERAGE`, a definir na US-168).
  7. **`GLOBAL` com lotes:** a feature só trata `BY_LOT`; a story aceita lotes com `GLOBAL` e `BY_ITEM` como agrupamento e avisa. **Dúvida de produto:** proibir lotes quando a adjudicação é global?
  8. **Benefício a pequenas empresas por lote:** os limites de valor e de cota da LC 123/2006 (arts. 47 a 49) não são validados, porque dependem do valor estimado (sigiloso) e do tipo de objeto; ficam para a revisão jurídica. **Dúvida de produto:** automatizar o aviso quando o valor do lote ultrapassa o limite de `EXCLUSIVE`?
  9. **Evento `TenderLotsChanged` na semente:** `events.md` descreve o evento como "Gerenciar lotes"; a story também o publica quando a semente (criação ou importação) cria lotes.
  10. **Ordem de entrega do `TenderLotSeeder`:** ver lacuna 12 da US-163.

## Impacto técnico
- **Gravação por substituição:** a estrutura completa é aplicada em uma transação que remove antes de inserir, para respeitar `UNIQUE (tenant_id, tender_id, process_item_id)` e `UNIQUE (tenant_id, tender_id, number)` durante a troca de itens entre lotes; `TenderLotItem` é filho de `TenderLot` com `CASCADE`, só exercido com o documento editável.
- **Integridade com o processo:** `TenderLotItem.processItemId` tem FK `ON DELETE RESTRICT`; o módulo `process` consulta `TenderFacade.isItemInLot` antes de excluir item e devolve `ITEM_IN_USE`; nenhuma escrita do módulo `tender` em `process`.
- **Valor derivado:** o cálculo do valor do lote usa o serializador central de sigilo; o valor persistido é cache de conveniência (para relatórios e para o snapshot da conclusão), nunca fonte de verdade.
- **Desempenho:** metas p95 de TND-07 < 300 ms e TND-08 < 800 ms para 300 itens em 20 lotes, escritas na suíte de performance e medidas no endurecimento; a leitura faz uma só consulta de itens com junção e agrega em memória.
- **Compatibilidade:** nenhum contrato do MVP 1 muda além do texto do `ITEM_IN_USE`; `RuleContext` v2 lê `tender.lotsCount` (US-129).
- **Segurança:** valores de lote nunca saem sem passar pelo serializador de sigilo; nenhum texto de nome ou descrição de lote entra em log, evento ou auditoria (só ids, números e tamanhos).

## Backend
- **Módulo(s):** `tender` (dono), `process` (itens, custódia, etapa e status, exclusão de item), `catalog` (enum de benefício via tipos fixos), `access`, `audit`, `platform` (`OutboxWriter`).
- **Casos de uso:** `GetTenderLotsQuery` (TND-07), `ReplaceTenderLotsCommand` (TND-08); `TenderLotSeeder` (reutilizado por `CreateTenderCommand` e `ApplyImportTermToTenderCommand`).
- **Domínio:** `TenderLot`, `TenderLotItem`, `TenderLotStructure` (valida números, nomes, itens e duplicidades; produz o diff de criar, atualizar e remover), `TenderLotCoverage` (RN-TND-63), `TenderLotValueCalculator` (RN-TND-65), `TenderLotSeeder` (RN-TND-64).
- **Integrações internas:** `ProcessFacade.getItems(processId)` e `getStageAndCustody`, `AuthorizationService.assertCan('TENDER_UPDATE', { processId })`, serializador de sigilo (`ConfidentialFieldsInterceptor`), `TenderFacade.isItemInLot` (consumida pelo módulo `process`), `OutboxWriter`, `AuditService`.
- **Transação:** TND-08 trava o `Tender`, aplica a substituição (remoções, atualizações, inclusões), recalcula valores, incrementa a `version`, audita e grava no outbox, tudo em transação interativa com `app.tenant_id`; falha desfaz tudo.

## Frontend
- **Tela(s):** SCR-021 (`/processos/[id]/edital/[tenderId]`), aba "Itens e lotes"; SCR-006 (aba "Itens", com o aviso de divergência entre planejamento e edital, quando existir).
- **Componentes:** `TenderLotsBoard` (lotes e lista "Sem lote"), `LotCard` (número, nome, benefício, valor, itens), `UnassignedItemsList`, `MoveToLotMenu` (alternativa de teclado ao arrastar), `LotFormDialog`, `CoverageIndicator`, `PlanningSuggestionBanner`, `RenumberLotsButton`, `ConfidentialValue` (valor mascarado, do MVP 1), `LotWarnings`.
- **Estados:** loading (skeleton); vazio ("Nenhum lote criado"; sem itens, com atalho para a aba Itens do processo); erro com "Tentar novamente" e rascunho local preservado; somente leitura (documento não editável ou sem permissão, com o motivo em `editBlockedReason`); sucesso com toast e foco no indicador de cobertura; alterações não salvas sinalizadas antes de sair da aba.
- **Acessibilidade e responsividade:** arrastar e soltar sempre com alternativa por teclado e leitor de tela ("Mover para lote…", anúncio por `aria-live` do novo lote e da cobertura); cobertura nunca só por cor (texto e ícone); lista de itens com cabeçalhos associados; foco preso e devolvido nos diálogos; abaixo de 768 px os lotes viram acordeões em coluna única e o item é movido pelo menu; contraste AA.

## Banco de dados
- **Tabelas:** `tender_lots` (insert, update, delete), `tender_lot_items` (insert, delete), `tenders` (`version`), `audit_logs`, `outbox_events`; leitura de `process_items`, `processes`.
- **Migrações:** nenhuma nova (tabelas do módulo `tender` na migração do MVP 2).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, tender_id, number)` em `tender_lots`; `UNIQUE (tenant_id, tender_id, process_item_id)` em `tender_lot_items`; FK `process_item_id` com `ON DELETE RESTRICT`; FK `tender_lot_id` com `ON DELETE CASCADE`; checks `number >= 1` e comprimento de `name`; índice `(tenant_id, tender_id)` em ambas as tabelas; RLS por `tenant_id`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `TND-07` | GET | `/api/v1/tenders/{id}/lots` | — | `200 { data: { lots: [{ id, number, name, description?, smallBusinessBenefit?, effectiveBenefit, estimatedValue?, valueIncomplete, masked, items: [{ processItemId, sequence, description, unit, quantity }] }], unassignedItems: [{ processItemId, sequence, description }] }, meta: { awardType, coverage, planningSuggestion, warnings[], editable, editBlockedReason? } }` + `ETag` | 200, 401, 403, 404 |
| `TND-08` | PUT | `/api/v1/tenders/{id}/lots` | `{ lots: [{ id?, number, name, description?, smallBusinessBenefit?, processItemIds: uuid[] }] }` + `If-Match` | `200` com o mesmo formato de TND-07 + `ETag` | 200, 401, 403, 404, 409, 412, 413, 422, 428, 429, 503 |
| `TND-03` | GET | `/api/v1/tenders/{id}` | — (US-163) | `meta.lots` (`count`, `itemsUnassigned`) refletem esta story | 200, 401, 403, 404 |

## Logs
- `info` `tender.lots_replaced` — `tenderId`, `lotsCount`, `lotsCreated`, `lotsUpdated`, `lotsRemoved`, `itemsMoved`, `itemsUnassigned`, `durationMs`, `correlationId`.
- `warn` `tender.lots_denied` — `reasonCode`, `tenderId`; `warn` `tender.lots_stale_version` — `If-Match` divergente.
- `error` `tender.lots_failed` — `errorCode`, causa resumida, `correlationId`.
- Nunca logar: nomes e descrições de lotes, descrições de itens, valores de lotes ou do orçamento.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `tender.lots_update` | `DATA_CHANGE` | Commit de TND-08 com alteração efetiva | `metadata`: `tenderId`, `source` `MANUAL`, `lotsCreated`, `lotsUpdated`, `lotsRemoved`, `itemsMoved`, `itemsAssigned`, `itemsUnassigned`, `nameLengths` e `nameHashes` (sem o texto); sem valores |
| `access.denied` | `ACCESS` | 403 em TND-08 | `reasonCode` (`TENDER_UPDATE`, `POL-02`), `tenderId` |

## Testes necessários
- **Unitários:** `TenderLotStructure` (números, nomes, itens, duplicidades, lote vazio, limites, diff de criar, atualizar e remover); `TenderLotCoverage` (`BY_LOT`, `BY_ITEM`, `GLOBAL`); `TenderLotValueCalculator` (soma, arredondamento, valor incompleto); `TenderLotSeeder` (grupos, nomes divergentes, itens sem lote, edital com lotes); máscara do valor sigiloso.
- **Integração (Testcontainers):** gravação atômica por substituição e troca de itens entre lotes sem violar as unicidades; rollback total em falha induzida; `ITEM_IN_USE` na exclusão de item em lote; FK `RESTRICT`; RLS entre tenants; item de outro processo recusado; valor recalculado após mudança de preço de referência.
- **API/contrato:** TND-07 e TND-08 (códigos, `ETag`, `If-Match`, 412, 413, 428); campos aditivos de TND-03; contrato do `ITEM_IN_USE`.
- **RBAC e multi-tenant:** suíte "tenant leak" com TND-07 e TND-08; matriz de autorização com `TENDER_UPDATE` e `PROCESS_VIEW`; bateria de POL-02 (custódia, participação, `DRAFT`/`RETURNED`, etapa, status do processo) e de POL-09 (valor do lote com e sem direito).
- **Concorrência:** gravações simultâneas, gravação contra edição do cabeçalho (mesma `version`), gravação contra exclusão de item, gravação contra importação do TR.
- **E2E (Playwright):** semente do planejamento, criar lotes, arrastar e mover por menu, cobertura incompleta e completa, valor mascarado, leitura por Compras e conflito de edição.
- **Acessibilidade/performance:** axe na aba e nos diálogos; navegação por teclado completa; 360 px; metas de p95 na suíte de performance (sem benchmark no card).

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
- [ ] Gravação por substituição comprovadamente atômica, sem violar unicidades na troca de itens
- [ ] Item em dois lotes impossível por API e por banco
- [ ] Valor de lote comprovadamente mascarado conforme a POL-09 e ausente de eventos, logs e auditoria
- [ ] Mover item por teclado e leitor de tela verificado
- [ ] Gherkin das 8 categorias automatizado, incluindo etapa fora de `MINUTA_EDITAL`, `If-Match` e cobertura incompleta

## Estimativa
**M** — duas operações de API sobre uma coleção com unicidades cruzadas, o cálculo de cobertura e de valor com máscara de sigilo, a semente a partir do planejamento e uma aba com arrastar e soltar acessível; reaproveita o ETag e as regras de edição da US-163.

## Prioridade
**P0** — com adjudicação por lote, a cobertura dos itens é condição para concluir a minuta (US-168); sem a organização dos lotes o edital por lote não pode ser elaborado.
