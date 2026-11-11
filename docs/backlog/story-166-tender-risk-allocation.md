---
id: US-166
title: "Matriz de alocação de riscos do edital"
epic: EP-027
feature: FT-078
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-035, US-163]
modules: [tender, risk, document, process, access, timeline, audit, platform]
screens: [SCR-021]
endpoints: [TND-09, TND-10, TND-03, RSK-09]
permissions: [TENDER_UPDATE, PROCESS_VIEW]
events: [TenderRiskAllocationChanged]
---

# US-166 — Matriz de alocação de riscos do edital

## Título
Matriz de alocação de riscos do edital

## Descrição
**Como** servidor de Licitações que elabora a minuta do edital, **quero** montar a matriz de alocação de riscos a partir do mapa de riscos do planejamento (ou com riscos próprios da matriz), dizendo, para cada risco, quem o assume, por quê, com que mitigação e com que reflexo no equilíbrio econômico-financeiro, **para** que o edital cumpra o art. 22 da Lei 14.133/2021 quando a matriz é obrigatória e para que nenhum risco relevante do planejamento fique sem alocação.

A story entrega a leitura da matriz com os riscos do mapa ainda não alocados e a situação de completude (TND-09), a gravação da matriz inteira por substituição (TND-10), o vínculo com os riscos do mapa com título congelado, o aviso de exigência da matriz (`riskMatrixRequired`, calculado na US-163) e a aba "Matriz de riscos" da SCR-021. A **alocação nunca é sugerida nem decidida pelo sistema**: quem aloca é a pessoa. A criação do `Tender` é da US-163, a conclusão que recusa matriz incompleta é da US-168 e o texto de matriz proposto por IA, sempre apenas como texto de seção, é da US-169.

## Contexto
- O art. 22 da Lei 14.133/2021 permite e, em certos casos, exige que o edital contemple matriz de alocação de riscos entre contratante e contratado (art. 6º, XXVII): a matriz define o equilíbrio econômico-financeiro inicial do contrato em relação a eventos supervenientes (§ 2º) e é **obrigatória** nas contratações de obras e serviços de grande vulto e nas que adotam os regimes de contratação integrada e semi-integrada (§ 3º).
- A **matriz de alocação de riscos do contrato não é o mapa de riscos do planejamento** (terminologia do produto): o mapa (EP-005, `Risk`/`RiskTreatment`, documento `RISK_MAP`) registra riscos e tratamentos da contratação; a matriz do edital escolhe, entre eles e outros, a parte que assume cada risco no contrato. A DEC-201 modela `TenderRiskAllocation` com `riskId` opcional (nulo = risco próprio da matriz), `title` congelado do risco quando vinculado, `allocation` (`CONTRACTING_PARTY`, `CONTRACTOR`, `SHARED`), `rationale`, `mitigation`, `economicBalanceImpact` e `sortOrder`.
- A exigência é calculada na US-163 (`Tender.riskMatrixRequired`, RN-TND-30: regime integrado ou semi-integrado, obra ou serviço de engenharia de grande vulto, ou valor a partir de `tender.riskMatrixValueThreshold`). Quando a matriz **não** é exigida, ela pode ser usada de forma voluntária e não é cobrada na conclusão.
- A RN-TND-06 exige que, quando `riskMatrixRequired`, a matriz esteja **completa** para concluir (RN-TND-09, US-168); a RN-TND-07 manda registrar a parte que assume e a justificativa, com o título congelado quando o risco vem do mapa. O `RuleContext` v2 expõe `tender.riskMatrixRequired` e `tender.riskMatrixComplete` à regra de saída da etapa `MINUTA_EDITAL` (US-129).
- A DEC-202 e o `entities.md` §7.11 mandam que o rascunho por IA do edital proponha a matriz **só como texto** de seção, nunca gravando `TenderRiskAllocation` sozinha; esta story não cria endpoint de IA.
- Sigilo do orçamento (art. 24, DEC-030, POL-09): os textos da matriz (justificativa, mitigação e reflexo econômico) não podem trazer valores do orçamento sigiloso; a regra do `ConfidentialTextGuard` da US-153 é reaproveitada.

## Objetivo
Garantir que, nos editais em que a matriz de alocação de riscos é obrigatória, nenhuma minuta seja concluída com matriz vazia, com riscos altos do mapa sem alocação ou com alocação sem o reflexo econômico exigido; que cada linha preserve o risco de origem e o título congelado; e que a pessoa de Licitações monte a matriz a partir do mapa em até 5 cliques por risco, sem redigitar o que já está no planejamento.

## Persona
- **Principal:** Licitações (`LICITACOES`) — monta a matriz.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`); Consultoria externa (`CONSULTOR_EXTERNO`) como participante com `TENDER_UPDATE`; Planejamento (`PLANEJAMENTO`) e Compras (`COMPRAS`), donos do mapa de riscos (leitura); Jurídico e Controle Interno, que leem a matriz concluída.

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`, MFA conforme `security.mfaPolicy` (`TENDER_UPDATE` é risco `M`: MFA só com política `ALL`).
- Minuta criada (US-163): `Tender` e documento `EDITAL`.
- Para **ler** (TND-09): `PROCESS_VIEW` cobrindo o processo.
- Para **gravar** (TND-10): `TENDER_UPDATE` cobrindo o processo; custódia ou participação `COLLABORATOR`/`CONSULTANT` (POL-02); `EDITAL` em `DRAFT` ou `RETURNED`; tipo permitido na etapa; processo em `DRAFT`/`IN_PROGRESS`/`RETURNED`.
- Para **vincular riscos do mapa**: documento `RISK_MAP` do processo em `FINALIZED` ou `APPROVED` (mapa emitido — US-035) e riscos do processo ainda não encerrados; sem mapa emitido, só riscos próprios da matriz.

## Fluxo principal
1. Na SCR-021 (`/processos/[id]/edital/[tenderId]`), a pessoa abre a aba **"Matriz de riscos"**. O front chama TND-09, que devolve as linhas da matriz, os riscos do mapa ainda não alocados, o motivo da exigência e a situação de completude.
2. A aba mostra o aviso de exigência: **"A matriz de alocação de riscos é obrigatória neste edital (regime de contratação integrada)"** (ou o motivo correspondente), ou **"A matriz não é obrigatória neste edital; você pode usá-la mesmo assim"**, e o indicador de completude com as pendências listadas.
3. A pessoa aciona **"Trazer riscos do mapa"**, vê os riscos ainda não alocados (código, título, nível, categoria, tratamentos) ordenados do nível mais alto para o mais baixo, marca os que quer incluir e confirma; cada risco vira uma linha com o título congelado do mapa e, quando o risco tem tratamentos, a mitigação pré-preenchida (editável) com a descrição deles.
4. Para cada linha, a pessoa escolhe **quem assume** (Contratante, Contratado ou Compartilhado), escreve a **justificativa**, a **mitigação** (seguros, garantias, mecanismos) e o **reflexo no equilíbrio econômico-financeiro**. Para um risco que não está no mapa, usa **"Adicionar risco próprio"** e informa o título.
5. A pessoa reordena as linhas (arrastar ou menu "Mover para cima/baixo") e clica em **"Salvar matriz"**. O front envia TND-10 com a matriz completa e `If-Match` (ETag do `Tender`).
6. A API valida existência e tenant, permissão e POL-02, o corpo (alocação, textos, duplicidades, riscos), o sigilo dos textos e trava o `Tender` (`SELECT … FOR UPDATE`). Na mesma transação aplica a substituição (atualiza as linhas com `id`, cria as sem `id`, remove as ausentes), congela o título das linhas vinculadas a risco novo, grava `sortOrder` pela ordem do corpo, incrementa a `version` do `Tender`, audita `tender.risk_allocation_update` e grava `TenderRiskAllocationChanged` no outbox.
7. A API responde 200 com a matriz gravada, a completude recalculada e a nova `ETag`. O front mostra o toast "Matriz salva: 4 riscos alocados" e atualiza o indicador ("Matriz completa" ou "2 pendências").
8. Com a matriz exigida e completa, a regra de saída da etapa `MINUTA_EDITAL` e a conclusão (US-168) deixam de apontar a matriz; com pendências, a conclusão é recusada indicando-as.
9. Mais tarde, um risco alto é acrescentado ao mapa: a matriz **não** muda sozinha; a aba passa a listar a pendência "Risco R07 (alto) sem alocação" e a pessoa decide.
10. Planejamento, Compras e o Jurídico abrem a aba em modo somente leitura.

## Fluxos alternativos
- **FA-01 — Matriz não exigida e vazia:** a aba mostra "Nenhuma alocação registrada" com a explicação de que a matriz é voluntária; a completude é "não exigida" e nada bloqueia a conclusão.
- **FA-02 — Mapa de riscos não emitido:** "Trazer riscos do mapa" fica desabilitado com a dica "Emita o mapa de riscos para trazer os riscos" e o link para o processo; "Adicionar risco próprio" continua disponível (RN-TND-81).
- **FA-03 — Título do risco mudou no mapa:** a linha vinculada mostra o selo "Título alterado no mapa" com o título atual; a pessoa mantém o congelado ou escolhe **"Atualizar título"** (RN-TND-82).
- **FA-04 — Risco já alocado:** o risco some da lista "Trazer riscos do mapa"; reenviar o mesmo `riskId` em duas linhas responde 422 (`DUPLICATE_IN_LIST`).
- **FA-05 — Remover linha:** remover a linha de risco do mapa devolve o risco à lista de não alocados; o risco do mapa **não** é alterado.
- **FA-06 — Reflexo econômico pendente:** linha com alocação "Contratante" ou "Compartilhado" sem reflexo no equilíbrio econômico-financeiro grava normalmente e gera a pendência `ECONOMIC_IMPACT_REQUIRED` na completude (RN-TND-85).
- **FA-07 — Risco alto sem alocação:** risco do mapa em nível alto ou extremo, não encerrado e sem linha na matriz, gera a pendência `RISK_NOT_ALLOCATED` apenas quando a matriz é exigida (RN-TND-85).
- **FA-08 — Processo sigiloso:** textos com valor monetário são recusados com a orientação de remover o valor (RN-TND-87).
- **FA-09 — Matriz deixou de ser exigida:** ao mudar o regime no cabeçalho (US-163), a aba avisa "A matriz deixou de ser obrigatória" e mantém as linhas gravadas (RN-TND-99).
- **FA-10 — Gravação sem alteração:** corpo igual ao estado atual; 200 sem versão, sem auditoria e sem evento (RN-TND-91).
- **FA-11 — Documento não editável:** com o `EDITAL` fora de `DRAFT`/`RETURNED`, 409 `DOCUMENT_NOT_EDITABLE`; a aba fica em leitura.
- **FA-12 — Conflito de edição:** `If-Match` divergente, 412 `VERSION_CONFLICT`; o front recarrega e preserva o rascunho local para reaplicar.
- **FA-13 — Excluir risco do mapa que está na matriz:** a exclusão no módulo de riscos é recusada com 409 `ITEM_IN_USE` ("O risco está na matriz de alocação do edital") (RN-TND-90).

## Regras de negócio
- **RN-TND-06** — A matriz de riscos é obrigatória quando `riskMatrixRequired` (hipóteses do art. 22, § 3º ou valor acima de `tender.riskMatrixValueThreshold`) e deve estar completa para concluir (DEC-201). *(regra da feature, adotada)*
- **RN-TND-07** — A alocação de cada risco registra a parte que assume (`CONTRACTING_PARTY`, `CONTRACTOR`, `SHARED`) e a justificativa; riscos do mapa entram com o título congelado (DEC-201). *(regra da feature, adotada)*
- **RN-TND-10** — A edição segue o ciclo de vida do documento (DEC-018) e a POL-02 com `TENDER_UPDATE`, apenas em `DRAFT` ou `RETURNED` para o colaborador. *(regra da feature, adotada)*
- **RN-TND-80** *(nova)* — Pré-requisitos: gravar (TND-10) exige `TENDER_UPDATE` cobrindo o processo, custódia ou participação `COLLABORATOR`/`CONSULTANT`, `EDITAL` em `DRAFT`/`RETURNED`, tipo permitido na etapa e processo editável (POL-02: `DOCUMENT_NOT_EDITABLE`, `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`, `INVALID_PROCESS_STATUS`, `NOT_PROCESS_CUSTODIAN`); ler (TND-09) exige `PROCESS_VIEW` cobrindo o processo (DEC-024); minuta de outro tenant ou de processo invisível responde 404 (`TENDER_NOT_FOUND`). Independe de `riskMatrixRequired`: a matriz pode ser montada mesmo quando não é exigida.
- **RN-TND-81** *(nova)* — Fonte dos riscos: são os `Risk` do **mesmo processo** (módulo `risk`, leitura por `RiskFacade`), com `status` diferente de `CLOSED`, e só podem ser vinculados quando existe o documento `RISK_MAP` do processo em `FINALIZED` ou `APPROVED` (mapa emitido, US-035). Sem mapa emitido, `riskId` no corpo responde 422 `VALIDATION_ERROR` (`NOT_ALLOWED`); risco de outro processo ou tenant, `REFERENCE_NOT_FOUND`; risco `CLOSED`, `REFERENCE_INACTIVE`. A matriz lê os riscos vigentes do processo, não o snapshot da versão do mapa (lacuna 3).
- **RN-TND-82** *(nova)* — Linha da matriz (`TenderRiskAllocation`): com `riskId`, o `title` é gravado pelo servidor a partir de `Risk.title` no momento do primeiro vínculo e fica **congelado** (o `title` enviado pelo cliente é ignorado); mudanças posteriores do título no mapa geram o indicador calculado `riskTitleChanged`, e a atualização do título só ocorre com `refreshTitle: true` na linha. Sem `riskId`, `title` é obrigatório (3 a 200 caracteres). Um mesmo `riskId` aparece em no máximo uma linha do edital (`UNIQUE (tenant_id, tender_id, risk_id) WHERE risk_id IS NOT NULL`).
- **RN-TND-83** *(nova)* — Campos: `allocation` obrigatória (`CONTRACTING_PARTY`, `CONTRACTOR` ou `SHARED`); `rationale` obrigatória de 10 a 2.000 caracteres; `mitigation` e `economicBalanceImpact` opcionais de até 2.000 caracteres (texto puro, aparado); `sortOrder` definido pela posição da linha no corpo (0 a n-1). O sistema **nunca** sugere nem preenche a alocação: só pré-preenche a mitigação com a descrição dos tratamentos do risco, quando há, em edição inicial da linha.
- **RN-TND-84** *(nova)* — Exigência: `riskMatrixRequired` e `riskMatrixReasons[]` vêm do `Tender` (US-163, RN-TND-30) e são apenas lidos aqui; com `riskMatrixRequired = false` a matriz é voluntária e não entra na completude exigida; com `true`, é obrigatória para concluir (US-168).
- **RN-TND-85** *(nova)* — Completude (`TypedDocumentModule.validateCompleteness`, usada pela US-168 e pelo `RuleContext`): quando `riskMatrixRequired`, a matriz está **completa** se (a) há ao menos uma linha (`MATRIX_EMPTY`); (b) toda linha com `allocation` `CONTRACTING_PARTY` ou `SHARED` tem `economicBalanceImpact` preenchido (`ECONOMIC_IMPACT_REQUIRED`, `allocationId`); e (c) todo `Risk` do processo em nível `HIGH` ou `EXTREME` e `status` diferente de `CLOSED` tem linha vinculada (`RISK_NOT_ALLOCATED`, `riskId`). Com `riskMatrixRequired = false`, `complete = true`. A completude é **calculada na leitura** (TND-09, TND-03) e recalculada na conclusão; nunca é gravada; a gravação nunca é recusada por pendência de completude (trabalho em andamento).
- **RN-TND-86** *(nova)* — Mapa que muda depois da matriz: riscos novos, riscos cujo nível passa a `HIGH`/`EXTREME` e riscos que passam a `CLOSED` alteram só a lista de não alocados e a completude; a matriz gravada nunca é alterada automaticamente.
- **RN-TND-87** *(nova)* — Sigilo e texto livre (art. 24, DEC-030, POL-09): com orçamento sigiloso no processo, `rationale`, `mitigation`, `economicBalanceImpact` e `title` de risco próprio não podem conter valor monetário (padrão `R$` ou número com formato de moeda); a API recusa com 422 `TENDER_TEXT_CONFIDENTIAL` (mesmo `ConfidentialTextGuard` das US-153 e US-154, lacuna 6). Textos da matriz nunca entram em evento, log, auditoria (só tamanhos e hashes), notificação ou prompt de IA.
- **RN-TND-88** *(nova)* — Gravação atômica por substituição: TND-10 recebe a matriz **completa** (`allocations[]`); linhas com `id` são atualizadas, sem `id` criadas e ausentes removidas; `id` de outro edital ou tenant é recusado (`REFERENCE_NOT_FOUND`); a ordem do corpo define `sortOrder`. Não existe endpoint por linha nesta story.
- **RN-TND-89** *(nova)* — Limites: até 200 linhas por edital e corpo de até 2 MB; acima disso, 422 `VALIDATION_ERROR` (`OUT_OF_RANGE`) ou 413 `PAYLOAD_TOO_LARGE`.
- **RN-TND-90** *(nova)* — Integridade com o mapa: `TenderRiskAllocation.riskId` tem FK `ON DELETE RESTRICT`; a exclusão de `Risk` vinculado a uma linha da matriz é recusada pelo módulo `risk` (409 `ITEM_IN_USE`, consulta por `TenderFacade.isRiskAllocated`); remover a linha da matriz libera o risco. A matriz nunca altera `Risk`, `RiskTreatment` nem o documento `RISK_MAP` (verificado por teste).
- **RN-TND-91** *(nova)* — Concorrência e no-op: TND-10 exige `If-Match` com a `version` do `Tender` (412 `VERSION_CONFLICT`; ausente, 428 `PRECONDITION_REQUIRED`) e trava o `Tender`; a mesma `version` é incrementada por qualquer escrita do tender (US-163, RN-TND-35); corpo idêntico ao estado atual responde 200 sem versão, sem auditoria e sem evento. O `PUT` não usa `Idempotency-Key` (padrão do DOC-07).
- **RN-TND-92** *(nova)* — Eventos, timeline e notificação: uma gravação efetiva publica `TenderRiskAllocationChanged` (`tenderId`, `allocationsCount` após o fato, `change`); como o `PUT` pode misturar criações, alterações e remoções, publica **um evento por tipo de mudança presente** (`CREATED`, `UPDATED`, `DELETED`) na mesma transação (lacuna 1). `events.md` não prevê entrada na timeline nem notificação para a matriz; a auditoria `tender.risk_allocation_update` registra contagens e ids.
- **RN-TND-93** *(nova)* — IA (US-169): o rascunho por IA do edital propõe a matriz apenas como texto de seção (`entities.md` §7.11) e nunca grava `TenderRiskAllocation`, nunca escolhe a parte que assume e nunca altera `riskMatrixRequired`; aplicar texto de IA numa seção não altera a matriz (POL-18). Esta story não cria endpoint de IA.
- **RN-TND-94** *(nova)* — Leitura (TND-09): devolve `allocations[]` ordenadas por `sortOrder` (com `riskCode`, `riskLevel`, `riskTitleChanged` e `currentRiskTitle` quando vinculadas), `availableRisks[]` (riscos do mapa ainda sem linha, do nível mais alto ao mais baixo; só com mapa emitido), `meta.required`, `meta.reasons[]`, `meta.complete`, `meta.pending[]` (`MATRIX_EMPTY`, `ECONOMIC_IMPACT_REQUIRED`, `RISK_NOT_ALLOCATED`), `meta.riskMapAvailable` e `editable`/`editBlockedReason`; os riscos do mapa são visíveis com `PROCESS_VIEW`.
- **RN-TND-95** *(nova)* — Mitigação sugerida: ao incluir um risco do mapa que tem `RiskTreatment`, a **tela** (não a API) pré-preenche a `mitigation` com a descrição dos tratamentos (prevenção e contingência), editável; o corpo enviado à API é sempre o texto final da pessoa. Linhas incompletas (sem alocação ou sem justificativa) ficam como rascunho local e a tela avisa quantas **não serão salvas**; a API nunca grava linha incompleta.
- **RN-TND-96** *(nova)* — Efeitos em outras partes: `tender.riskMatrixComplete` do `RuleContext` v2 (US-129) e o resumo de TND-03 (`riskMatrix`: `required`, `count`, `complete`) refletem esta story; a conclusão (US-168) congela as linhas no snapshot das versões do `EDITAL`; o documento renderiza a matriz como coleção tipada (tabela) pelo template.
- **RN-TND-97** *(nova)* — Rótulos: `CONTRACTING_PARTY` é exibido como "Contratante", `CONTRACTOR` como "Contratado" e `SHARED` como "Compartilhado"; o rótulo nunca é a única informação (ícone e texto) e a ordem alfabética não define a prioridade dos riscos.
- **RN-TND-98** *(nova)* — Matriz fora da exigência: quando `riskMatrixRequired = false`, linhas podem existir e entram no snapshot e no documento normalmente, mas as pendências de RN-TND-85 não são calculadas nem cobradas.
- **RN-TND-99** *(nova)* — Mudança da exigência: se o cabeçalho (US-163) passa a ligar ou desligar `riskMatrixRequired`, as linhas gravadas permanecem; ao ligar, a aba mostra o aviso de matriz obrigatória e as pendências; ao desligar, mostra "A matriz deixou de ser obrigatória".

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Matriz | `allocations[]` (TND-10) | lista | Sim (pode ser vazia para remover todas) | RN-TND-88, RN-TND-89 | matriz atual |
| Identificador da linha | `allocations[].id` | uuid | Não | sem `id` cria; com `id` atualiza | `GET` TND-09 |
| Risco do mapa | `allocations[].riskId` | uuid | Não | RN-TND-81; único no edital | `availableRisks[]` |
| Título do risco | `allocations[].title` | texto (3..200) | Condicional | obrigatório sem `riskId`; congelado com `riskId` (RN-TND-82) | título do risco no mapa |
| Atualizar título | `allocations[].refreshTitle` | booleano | Não | só com `riskId` (RN-TND-82) | `false` |
| Quem assume | `allocations[].allocation` | `CONTRACTING_PARTY` \| `CONTRACTOR` \| `SHARED` | Sim | RN-TND-83 | em branco (a pessoa escolhe) |
| Justificativa | `allocations[].rationale` | texto (10..2.000) | Sim | RN-TND-83, RN-TND-87 | em branco |
| Mitigação | `allocations[].mitigation` | texto (até 2.000) | Não | RN-TND-83, RN-TND-87 | tratamentos do risco (tela) |
| Reflexo no equilíbrio econômico-financeiro | `allocations[].economicBalanceImpact` | texto (até 2.000) | Condicional na completude | exigido para `CONTRACTING_PARTY` e `SHARED` (RN-TND-85) | em branco |
| Ordem | posição em `allocations[]` | inteiro | — | `sortOrder` 0..n-1 | ordem do corpo |
| Versão da minuta | `If-Match` (ETag) | texto | Sim (TND-10) | `Tender.version` | `GET` TND-09 |
| *(saída)* Exigência | `meta.required`, `meta.reasons[]` | booleano / lista | — | RN-TND-84 | `Tender` |
| *(saída)* Completude | `meta.complete`, `meta.pending[]` | booleano / lista | — | RN-TND-85 | calculado |
| *(saída)* Riscos disponíveis | `availableRisks[]` (`riskId`, `code`, `title`, `level`, `category`, `treatments[]`) | lista | — | RN-TND-94 | `Risk` do processo |
| *(saída)* Linha vinculada | `riskCode`, `riskLevel`, `riskTitleChanged`, `currentRiskTitle` | texto / booleano | — | RN-TND-82 | `Risk` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `allocation` ausente ou fora do enum | Front + API (Zod) | "Escolha quem assume o risco." | `VALIDATION_ERROR` (`REQUIRED`/`INVALID_ENUM`) |
| V-02 | `rationale` com menos de 10 ou mais de 2.000 caracteres | Front + API | "Justifique a alocação (10 a 2.000 caracteres)." | `VALIDATION_ERROR` (`TOO_SHORT`/`TOO_LONG`) |
| V-03 | `mitigation` ou `economicBalanceImpact` acima de 2.000 caracteres | Front + API | "Use até 2.000 caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-04 | Risco próprio sem `title` ou fora de 3 a 200 caracteres | Front + API | "Informe o título do risco (3 a 200 caracteres)." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`/`TOO_LONG`) |
| V-05 | `riskId` repetido na matriz | Front + API | "O risco {código} já está na matriz." | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`) |
| V-06 | `riskId` sem mapa de riscos emitido | API | "Emita o mapa de riscos para vincular riscos à matriz." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-07 | `riskId` inexistente, de outro processo ou tenant | API | "O risco informado não pertence a este processo." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-08 | `riskId` de risco encerrado | API | "O risco {código} está encerrado e não pode entrar na matriz." | `VALIDATION_ERROR` (`REFERENCE_INACTIVE`) |
| V-09 | `id` de linha inexistente ou de outro edital | API | "Linha não encontrada. Atualize a página." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-10 | `refreshTitle` em linha sem `riskId` ou campo desconhecido | API | "Este campo não pode ser usado aqui." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-11 | Texto com valor monetário em processo sigiloso | API | "O texto não pode conter valores do orçamento sigiloso. Remova os valores e tente de novo." | `TENDER_TEXT_CONFIDENTIAL` (422) |
| V-12 | Mais de 200 linhas ou corpo acima de 2 MB | API | "A matriz excede o limite de {n} riscos." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) / `PAYLOAD_TOO_LARGE` (413) |
| V-13 | Documento fora de `DRAFT`/`RETURNED` | API | "A minuta não pode ser editada no status atual." | `DOCUMENT_NOT_EDITABLE` (409) |
| V-14 | Tipo não permitido na etapa | API | "O edital é elaborado na etapa Minuta do edital." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` (422) |
| V-15 | `If-Match` ausente ou divergente | API | "Atualize a página e tente de novo." / "A matriz foi alterada por outra pessoa." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-16 | Exclusão de risco do mapa que está na matriz | API (módulo `risk`) | "O risco está na matriz de alocação do edital. Remova-o da matriz antes de excluir." | `ITEM_IN_USE` (409) |

## Permissões
- **Permissão:** `TENDER_UPDATE` com escopo que cubra o processo para gravar (TND-10); `PROCESS_VIEW` para ler (TND-09) e para ver os riscos do mapa.
- **Políticas:** POL-02 (edição: `EDITAL` ← `TENDER_UPDATE`, custódia ou participação, `DRAFT`/`RETURNED`, etapa, status do processo; `TenderRiskAllocation` segue o documento dono), POL-09 (sigilo do orçamento nos textos), POL-18 (IA só gera texto; nunca grava a matriz), DEC-024 (visibilidade).
- **MFA:** `TENDER_UPDATE` é risco `M`: exigido apenas com `security.mfaPolicy = ALL`.
- **Sem permissão:** a aba abre em leitura (sem "Trazer riscos do mapa", "Adicionar risco próprio" nem "Salvar matriz"); a API responde 403 `PERMISSION_DENIED` ou `NOT_PROCESS_CUSTODIAN` e grava `access.denied`; edital ou processo de outro tenant ou invisível responde 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `TenderRiskAllocationChanged` | `tender.risk_allocation_changed` | Commit de TND-10 com alteração efetiva | `tenderId`, `allocationsCount` (após o fato), `change` (`CREATED`, `UPDATED` ou `DELETED`); um evento por tipo de mudança presente; sem texto nem valores; sem consumidor síncrono nem entrada na timeline |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação nesta story: `events.md` §6 não prevê tipo para alteração da matriz de riscos do edital |

## Critérios de aceite em Gherkin
```gherkin
Feature: Matriz de alocação de riscos do edital

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o processo "0012/2026" é uma obra, está "IN_PROGRESS" na etapa "MINUTA_EDITAL", que permite o tipo "EDITAL", e o orçamento não é sigiloso
    And a minuta "ED 0001/2026" está "DRAFT" com "executionRegime" "INTEGRATED", "riskMatrixRequired" verdadeiro e ETag "T1"
    And o mapa de riscos "MR 0001/2026" está "FINALIZED" com os riscos "R01" extremo, "R02" alto, "R03" médio, "R04" baixo e "R05" alto, o "R02" com um tratamento de prevenção
    And "Lia Moreira" tem o perfil "LICITACOES" com "TENDER_UPDATE" e a custódia do processo
    And "Paulo Reis", da consultoria externa, é participante "CONSULTANT" com "TENDER_UPDATE"
    And "Marcos Ribeiro", de Compras, tem apenas "PROCESS_VIEW"

  Scenario: [Sucesso] Consultar a matriz vazia com a exigência e as pendências
    When "Lia Moreira" chamar "GET /tenders/{id}/risk-allocations"
    Then a API deve responder 200 com 0 linhas, "meta.required" verdadeiro e "meta.reasons" contendo "INTEGRATED_REGIME"
    And "availableRisks" deve trazer "R01", "R02", "R05", "R03" e "R04", nessa ordem de nível
    And "meta.complete" deve ser falso com as pendências "MATRIX_EMPTY", "RISK_NOT_ALLOCATED" de "R01", "R02" e "R05"
    And a resposta deve trazer a "ETag" "T1"

  Scenario: [Sucesso] Vincular riscos do mapa e alocá-los
    When "Lia Moreira" chamar "PUT /tenders/{id}/risk-allocations" com "R01" para "CONTRACTOR", "R02" para "SHARED" com reflexo econômico e "R05" para "CONTRACTING_PARTY" com reflexo econômico, cada um com justificativa, e "If-Match" "T1"
    Then a API deve responder 200 com 3 linhas, o título de cada uma congelado a partir do mapa e a "ETag" incrementada
    And "meta.complete" deve ser verdadeiro e "meta.pending" vazio
    And deve ser publicado "TenderRiskAllocationChanged" com "change" "CREATED" e "allocationsCount" 3
    And deve gerar a auditoria "tender.risk_allocation_update" sem o texto de justificativa, mitigação ou reflexo
    And o mapa de riscos, os riscos e os tratamentos devem permanecer inalterados

  Scenario: [Sucesso] Adicionar um risco próprio da matriz
    When "Lia Moreira" gravar uma linha sem "riskId" com o título "Atraso na liberação de licença ambiental", alocação "CONTRACTING_PARTY", justificativa e reflexo econômico
    Then a API deve responder 200 com a linha "riskId" nulo e o título informado
    And "R01" e os demais riscos do mapa devem continuar em "availableRisks"

  Scenario: [Sucesso] Alterar a alocação, reordenar e remover linhas
    Given que a matriz tem as linhas de "R01", "R02" e "R05" com a ETag "T2"
    When "Lia Moreira" alterar a alocação de "R01", remover a linha de "R05" e trocar a ordem das duas linhas restantes com "If-Match" "T2"
    Then a API deve responder 200 com 2 linhas na nova ordem
    And devem ser publicados "TenderRiskAllocationChanged" com "change" "UPDATED" e outro com "change" "DELETED", ambos com "allocationsCount" 2
    And o risco "R05" deve voltar a constar em "availableRisks"

  Scenario: [Sucesso] Título congelado e título alterado no mapa
    Given que a linha de "R02" foi gravada com o título "Falha de fundação"
    When o título de "R02" no mapa de riscos for alterado para "Falha de fundação profunda"
    And "Lia Moreira" chamar "GET /tenders/{id}/risk-allocations"
    Then a linha deve trazer o título "Falha de fundação", "riskTitleChanged" verdadeiro e "currentRiskTitle" "Falha de fundação profunda"
    When "Lia Moreira" gravar a linha com "refreshTitle" verdadeiro
    Then a linha deve passar a trazer o título "Falha de fundação profunda" e "riskTitleChanged" falso

  Scenario: [Sucesso] Matriz voluntária quando não é exigida
    Given que o regime da minuta é "UNIT_PRICE" e "riskMatrixRequired" é falso
    When "Lia Moreira" chamar "GET /tenders/{id}/risk-allocations"
    Then a API deve responder 200 com "meta.required" falso e "meta.complete" verdadeiro
    When "Lia Moreira" gravar uma linha de "R03"
    Then a API deve responder 200 e a matriz não deve gerar pendências

  Scenario: [Sucesso] Gravação idêntica não altera a versão
    Given que a matriz está gravada com a ETag "T2"
    When "Lia Moreira" repetir "PUT /tenders/{id}/risk-allocations" com o mesmo corpo e "If-Match" "T2"
    Then a API deve responder 200 com a ETag "T2" e nenhum evento nem auditoria devem ser gerados

  Scenario: [Validação] Dados inválidos da matriz
    When "Lia Moreira" gravar uma linha sem "allocation"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REQUIRED" em "allocations[0].allocation"
    When "Lia Moreira" gravar uma linha com justificativa de 5 caracteres
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "TOO_SHORT" em "allocations[0].rationale"
    When "Lia Moreira" gravar um risco próprio sem título
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REQUIRED" em "allocations[0].title"
    When "Lia Moreira" gravar o "riskId" de um risco encerrado
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_INACTIVE"
    And nenhuma linha deve ter sido alterada

  Scenario: [Validação] Vincular risco sem mapa emitido e texto com valor sigiloso
    Given que o mapa de riscos do processo está "DRAFT"
    When "Lia Moreira" gravar uma linha com o "riskId" de "R01"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED" em "allocations[0].riskId"
    Given que o orçamento do processo é sigiloso
    When "Lia Moreira" gravar uma linha cuja justificativa cita "R$ 2.300.000,00"
    Then a API deve responder 422 com código "TENDER_TEXT_CONFIDENTIAL"

  Scenario: [Validação] Etapa fora de MINUTA_EDITAL e edital já finalizado
    Given que o processo está na etapa "JURIDICO", que não permite o tipo "EDITAL"
    When "Lia Moreira" chamar "PUT /tenders/{id}/risk-allocations"
    Then a API deve responder 422 com código "DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE"
    Given que o documento "EDITAL" está "FINALIZED"
    When "Lia Moreira" chamar "PUT /tenders/{id}/risk-allocations"
    Then a API deve responder 409 com código "DOCUMENT_NOT_EDITABLE"
    And a leitura "GET /tenders/{id}/risk-allocations" deve continuar respondendo 200

  Scenario: [Validação] Pendências de completude não impedem a gravação
    When "Lia Moreira" gravar só a linha de "R03" com alocação "SHARED" sem reflexo econômico
    Then a API deve responder 200 com "meta.complete" falso
    And "meta.pending" deve conter "ECONOMIC_IMPACT_REQUIRED" da linha de "R03" e "RISK_NOT_ALLOCATED" de "R01", "R02" e "R05"

  Scenario: [Permissão] Sem TENDER_UPDATE, leitor e participante
    Given que "Marcos Ribeiro" não tem "TENDER_UPDATE"
    When "Marcos Ribeiro" chamar "PUT /tenders/{id}/risk-allocations"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar a auditoria "access.denied"
    When "Marcos Ribeiro" chamar "GET /tenders/{id}/risk-allocations"
    Then a API deve responder 200 com "editable" falso
    When "Paulo Reis" chamar "PUT /tenders/{id}/risk-allocations" com uma matriz válida
    Then a API deve responder 200
    Given que "Bruno Lopes", de Licitações, não tem a custódia do processo e não é participante
    When "Bruno Lopes" chamar "PUT /tenders/{id}/risk-allocations"
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN"

  Scenario: [Tenant incorreto] Edital e riscos de outro órgão
    Given que o edital "ED 0002/2026" e o risco "R09" pertencem ao tenant "Prefeitura B"
    When "Lia Moreira" chamar "GET /tenders/{id-ED2}/risk-allocations" e "PUT /tenders/{id-ED2}/risk-allocations"
    Then a API deve responder 404 com código "TENDER_NOT_FOUND" nas duas chamadas
    When "Lia Moreira" gravar uma linha com o "riskId" de "R09"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND"
    And nenhum dado da "Prefeitura B" deve aparecer na resposta, nos logs ou na auditoria

  Scenario: [Duplicidade] Mesmo risco em duas linhas e reenvio com ETag antiga
    When "Lia Moreira" gravar duas linhas com o "riskId" de "R01"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "DUPLICATE_IN_LIST" em "allocations[1].riskId"
    Given que "Lia Moreira" gravou a matriz com sucesso e recebeu a ETag "T2"
    When a mesma requisição for reenviada com a ETag "T1"
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    And não deve existir linha duplicada para "R01"

  Scenario: [Concorrência] Gravações simultâneas, exclusão de risco e edição do cabeçalho
    Given que "Lia Moreira" e "Paulo Reis" leram a matriz com a ETag "T1"
    When ambos enviarem "PUT /tenders/{id}/risk-allocations" com "If-Match" "T1" e conteúdos diferentes
    Then uma chamada deve responder 200 e a outra 412 com código "VERSION_CONFLICT"
    And a matriz final deve ser exatamente a da chamada que respondeu 200
    Given que "R01" está na matriz
    When a exclusão de "R01" no módulo de riscos acontecer ao mesmo tempo em que a linha é gravada
    Then a exclusão deve responder 409 com código "ITEM_IN_USE" ou a linha deve responder 422 com "REFERENCE_NOT_FOUND", nunca ficando linha apontando para risco excluído
    When "Paulo Reis" editar o cabeçalho antes de "Lia Moreira" gravar com a ETag antiga
    Then a gravação de "Lia Moreira" deve responder 412 com código "VERSION_CONFLICT"
    When "Lia Moreira" enviar "PUT /tenders/{id}/risk-allocations" sem "If-Match"
    Then a API deve responder 428 com código "PRECONDITION_REQUIRED"

  Scenario: [Falha de banco] Falha na transação de gravação da matriz
    Given que o banco de dados fica indisponível durante a transação de "PUT /tenders/{id}/risk-allocations"
    When "Lia Moreira" tentar gravar a matriz
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And as linhas, a "version" do "Tender", a auditoria e o outbox devem continuar como antes
    And o rascunho local da tela deve ser preservado com o botão "Tentar novamente"

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Lia Moreira" gravar a matriz com sucesso
    Then a API deve responder 200 com a matriz gravada
    And os eventos "TenderRiskAllocationChanged" devem permanecer "PENDING" no outbox até o relay voltar

  Scenario: [Sucesso] Desempenho da leitura e da gravação (teste de suíte, sem benchmark no card)
    Given a suíte de desempenho com um mapa de 100 riscos e uma matriz de 100 linhas
    When forem executadas 200 leituras de "GET /tenders/{id}/risk-allocations" e 50 gravações de "PUT /tenders/{id}/risk-allocations"
    Then o p95 de "TND-09" deve ser menor que 300 ms e o de "TND-10" menor que 800 ms
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Dados inválidos | 422 | `VALIDATION_ERROR` | Mensagem do campo | Marca a linha e o campo e foca o primeiro erro |
| Texto com valor sigiloso | 422 | `TENDER_TEXT_CONFIDENTIAL` | "O texto não pode conter valores do orçamento sigiloso. Remova os valores e tente de novo." | Destaca o campo |
| Sem `If-Match` | 428 | `PRECONDITION_REQUIRED` | "Atualize a página e tente de novo." | Recarrega a matriz |
| ETag divergente | 412 | `VERSION_CONFLICT` | "A matriz foi alterada por outra pessoa. Atualize a página." | Recarrega, mostra a diferença e preserva o rascunho local |
| Minuta inexistente, de outro tenant ou de processo invisível | 404 | `TENDER_NOT_FOUND` | "Minuta do edital não encontrada." | Volta ao detalhe do processo |
| Documento não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "A minuta não pode ser editada no status atual." | Aba em leitura |
| Processo em status não editável | 409 | `INVALID_PROCESS_STATUS` | "O processo não está em andamento." | Aba em leitura |
| Tipo fora da etapa | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "O edital é elaborado na etapa Minuta do edital." | Aba em leitura |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para alterar a matriz de riscos." | Oculta as ações de edição |
| Sem custódia | 403 | `NOT_PROCESS_CUSTODIAN` | "Você não está com este processo." | Oculta as ações de edição |
| Risco do mapa na matriz | 409 | `ITEM_IN_USE` | "O risco está na matriz de alocação do edital. Remova-o da matriz antes de excluir." | Exibe link para a aba da matriz |
| Corpo acima do limite | 413 | `PAYLOAD_TOO_LARGE` | "A matriz é grande demais." | Mantém o rascunho |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar a matriz agora. Tente novamente em instantes." | Botão "Tentar novamente"; respeita `Retry-After`; preserva o rascunho |

## Dependências
- **Stories:** US-163 (o `Tender`, `riskMatrixRequired`, o ETag compartilhado e a regra de edição); US-035 (mapa de riscos emitido e matriz de calor, de onde vêm os riscos vinculáveis). Indiretas: US-033 e US-034 (riscos e tratamentos), US-065 (ciclo de vida do documento), US-129 (`tender.riskMatrixRequired`/`riskMatrixComplete` no `RuleContext` v2), US-153 (`ConfidentialTextGuard`), US-165 (lotes, mesma `version`), US-168 (conclusão que cobra a completude), US-169 (matriz proposta por IA só como texto).
- **Decisões/ADRs:** DEC-201, DEC-202, DEC-018, DEC-030, DEC-016; POL-02, POL-09, POL-18; RN-TND-06, RN-TND-07, RN-TND-10.
- **Configurações:** `tender.riskMatrixValueThreshold` (padrão `null`; usada pela US-163 no cálculo da exigência); regra semeada de exigência da matriz (hipóteses do art. 22, § 3º).
- **Lacunas nas fontes canônicas:**
  1. **Payload e granularidade de `TenderRiskAllocationChanged`:** `events.md` define `change` com um só valor (`CREATED`, `UPDATED`, `DELETED`), mas o `PUT` por substituição mistura mudanças; a story publica um evento por tipo presente. Propor `changes: { created, updated, deleted }` (contagens) no mesmo evento, mantendo `change` como opcional por compatibilidade.
  2. **Definição de "matriz completa":** `entities.md` e a RN-TND-06 dizem "matriz completa quando `riskMatrixRequired`" sem defini-la. A story adota (a) ao menos uma linha, (b) reflexo econômico nas alocações `CONTRACTING_PARTY` e `SHARED` e (c) todo risco `HIGH`/`EXTREME` não encerrado do processo alocado. **Dúvida de produto:** validar os critérios (b) e (c) com o jurídico do piloto; a pendência por nível (c) depende de `RiskLevel` e deveria ser configurável?
  3. **Fonte dos riscos:** a story lê os `Risk` vigentes do processo e exige o `RISK_MAP` emitido; `TenderRiskAllocation` não guarda a versão do mapa usada. **Dúvida de produto:** registrar a versão do mapa de origem (campo novo) ou aceitar o vínculo só pelo `riskId`?
  4. **Exclusão de `Risk` vinculado:** `RSK-05` não prevê recusa por referência em matriz; ampliar `ITEM_IN_USE` ("item referenciado por documento/pesquisa") para a linha da matriz e acrescentar `TenderFacade.isRiskAllocated` na US-033/US-035. Alternativa: `ON DELETE SET NULL`, tratando a linha como risco próprio (o título já é congelado) — **dúvida de produto**.
  5. **Reflexo no equilíbrio econômico-financeiro obrigatório:** `economicBalanceImpact` é opcional em `entities.md`; a obrigatoriedade para `CONTRACTING_PARTY` e `SHARED` é regra proposta desta story (art. 22, § 2º).
  6. **Código de texto sigiloso:** `LEGAL_TEXT_CONFIDENTIAL` é do módulo jurídico (US-153); a story usa `TENDER_TEXT_CONFIDENTIAL` com o mesmo `ConfidentialTextGuard`. Propor um código genérico (`CONFIDENTIAL_TEXT_NOT_ALLOWED`) no `api.md`.
  7. **Contrato de TND-09 e TND-10:** rotas indicativas na feature (`PUT /tenders/{id}/risk-allocations`); a leitura (`GET`), o corpo por substituição, `availableRisks`, `riskTitleChanged`, `refreshTitle` e `meta.pending` não constam em `api.md`. A consolidar no `api.md` do MVP 2.
  8. **Atualização do título congelado (`refreshTitle`):** não prevista em `entities.md`; é comando de tela sobre o campo `title` da própria linha.
  9. **Rótulos pt-BR de `RiskAllocation`:** não constam em `terminology.md`; a story usa "Contratante", "Contratado" e "Compartilhado". Registrar.
  10. **Limite de grande vulto:** a exigência por valor depende da regra semeada da US-163 (lacuna 8 daquela story).

## Impacto técnico
- **Gravação por substituição:** a matriz inteira é aplicada em uma transação, com `sortOrder` pela posição no corpo e a unicidade parcial `(tenant_id, tender_id, risk_id) WHERE risk_id IS NOT NULL` como rede de segurança contra o mesmo risco em duas linhas.
- **Completude calculada, não gravada:** a mesma função `TenderRiskMatrixCompleteness` serve TND-09, TND-03, a regra de saída (`RuleContext` v2) e a conclusão (US-168), para que nenhum deles divirta; ela lê `Risk` por fachada, nunca por consulta direta a tabelas de `risk`.
- **Isolamento do mapa:** o módulo `tender` só **lê** `risk` e `document` por fachada; nenhuma escrita em `Risk`, `RiskTreatment` ou `RISK_MAP` (domains.md); teste de arquitetura e de integração (hash do mapa inalterado).
- **Integridade referencial:** `risk_id` com `ON DELETE RESTRICT` e recusa amigável (`ITEM_IN_USE`) no módulo `risk`; título congelado preserva a leitura histórica mesmo se o mapa mudar.
- **Desempenho:** metas p95 de TND-09 < 300 ms e TND-10 < 800 ms para 100 riscos, escritas na suíte de performance e medidas no endurecimento.
- **Compatibilidade:** nenhum contrato do MVP 1 muda além do texto do `ITEM_IN_USE`; a rota `RSK-09` (matriz de calor) é reaproveitada na tela só para exibir o nível; `RuleContext` v2 lê `tender.riskMatrixRequired` e `riskMatrixComplete`.
- **Segurança:** textos livres só em `tender_risk_allocations` e nunca em evento, log ou auditoria; o `ConfidentialTextGuard` roda no servidor.

## Backend
- **Módulo(s):** `tender` (dono), `risk` (leitura de riscos e tratamentos, recusa de exclusão), `document` (estado do `RISK_MAP` e do `EDITAL`), `process` (custódia, etapa e status), `access`, `audit`, `platform` (`OutboxWriter`).
- **Casos de uso:** `GetTenderRiskAllocationsQuery` (TND-09), `ReplaceTenderRiskAllocationsCommand` (TND-10).
- **Domínio:** `TenderRiskAllocation`, `TenderRiskMatrix` (valida linhas, duplicidades e vínculos; produz o diff de criar, atualizar e remover), `RiskAllocation` (enum), `TenderRiskMatrixCompleteness` (RN-TND-85), `ConfidentialTextGuard` (US-153), `RiskTitleFreezer` (RN-TND-82).
- **Integrações internas:** `RiskFacade.getRisksForTender(processId)` e `getRiskMapState(processId)`, `DocumentFacade.getStatus`, `ProcessFacade.getStageAndCustody`, `AuthorizationService.assertCan('TENDER_UPDATE', { processId })`, `TenderFacade.isRiskAllocated` (consumida pelo módulo `risk`), `OutboxWriter`, `AuditService`.
- **Transação:** TND-10 trava o `Tender`, aplica a substituição, congela os títulos, incrementa a `version`, audita e grava no outbox, tudo em transação interativa com `app.tenant_id`; falha desfaz tudo.

## Frontend
- **Tela(s):** SCR-021 (`/processos/[id]/edital/[tenderId]`), aba "Matriz de riscos".
- **Componentes:** `RiskMatrixTab`, `RiskMatrixRequiredNotice` (motivo da exigência), `CompletenessIndicator` (pendências listadas e clicáveis), `AddMapRisksDialog` (riscos do mapa com nível, categoria e tratamentos), `AllocationRow` (quem assume, justificativa, mitigação, reflexo econômico), `OwnRiskDialog`, `AllocationBadge`, `RiskTitleChangedBadge`, `LocalDraftBanner` (linhas incompletas que não serão salvas), `ReorderMenu`.
- **Estados:** loading (skeleton); vazio ("Nenhuma alocação registrada", com a explicação conforme a exigência); erro com "Tentar novamente" e rascunho local preservado; somente leitura (documento não editável ou sem permissão, com o motivo em `editBlockedReason`); sucesso com toast e foco no indicador de completude; alterações não salvas sinalizadas antes de sair da aba.
- **Acessibilidade e responsividade:** quem assume e o nível do risco nunca só por cor (texto e ícone); reordenação por menu e teclado, com anúncio por `aria-live`; contadores de caracteres anunciados de forma educada; diálogos com foco preso e devolvido; tabela com cabeçalhos associados e, abaixo de 768 px, linhas viram cartões empilhados; contraste AA.

## Banco de dados
- **Tabelas:** `tender_risk_allocations` (insert, update, delete), `tenders` (`version`), `audit_logs`, `outbox_events`; leitura de `risks`, `risk_treatments`, `documents` (`RISK_MAP`).
- **Migrações:** nenhuma nova (tabela do módulo `tender` na migração do MVP 2).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, tender_id, risk_id) WHERE risk_id IS NOT NULL`; FK `risk_id` com `ON DELETE RESTRICT` (lacuna 4); checks de comprimento de `title` (3..200), `rationale` (10..2.000) e demais textos (até 2.000); índice `(tenant_id, tender_id, sort_order)`; RLS por `tenant_id`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `TND-09` | GET | `/api/v1/tenders/{id}/risk-allocations` | — | `200 { data: { allocations: [{ id, riskId?, riskCode?, riskLevel?, title, riskTitleChanged, currentRiskTitle?, allocation, rationale, mitigation?, economicBalanceImpact?, sortOrder }], availableRisks: [{ riskId, code, title, level, category, treatments: [{ type, description }] }] }, meta: { required, reasons[], complete, pending: [{ code, riskId?, allocationId? }], riskMapAvailable, editable, editBlockedReason? } }` + `ETag` | 200, 401, 403, 404 |
| `TND-10` | PUT | `/api/v1/tenders/{id}/risk-allocations` | `{ allocations: [{ id?, riskId?, title?, refreshTitle?, allocation, rationale, mitigation?, economicBalanceImpact? }] }` + `If-Match` | `200` com o mesmo formato de TND-09 + `ETag` | 200, 401, 403, 404, 409, 412, 413, 422, 428, 429, 503 |
| `TND-03` | GET | `/api/v1/tenders/{id}` | — (US-163) | `meta.riskMatrix` (`required`, `count`, `complete`) reflete esta story | 200, 401, 403, 404 |
| `RSK-09` | GET | `/api/v1/processes/{id}/risk-matrix` | MVP 1 (US-035) | matriz de calor do mapa, usada para exibir o nível dos riscos | 200, 403, 404 |

## Logs
- `info` `tender.risk_matrix_replaced` — `tenderId`, `allocationsCount`, `created`, `updated`, `deleted`, `linkedRisks`, `ownRisks`, `required`, `complete`, `durationMs`, `correlationId`.
- `warn` `tender.risk_matrix_denied` — `reasonCode`, `tenderId`; `warn` `tender.risk_matrix_stale_version` — `If-Match` divergente.
- `error` `tender.risk_matrix_failed` — `errorCode`, causa resumida, `correlationId`.
- Nunca logar: justificativa, mitigação, reflexo econômico, títulos de riscos próprios, valores do orçamento.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `tender.risk_allocation_update` | `DATA_CHANGE` | Commit de TND-10 com alteração efetiva | `metadata`: `tenderId`, `created`, `updated`, `deleted`, `allocationsCount`, `riskIds` afetados, `allocationChanges` (linha, de e para o valor do enum), `textLengths` e `textHashes` (sem o texto) |
| `access.denied` | `ACCESS` | 403 em TND-10 | `reasonCode` (`TENDER_UPDATE`, `POL-02`), `tenderId` |

## Testes necessários
- **Unitários:** `TenderRiskMatrix` (alocação, textos, duplicidade de `riskId`, risco próprio, diff de criar, atualizar e remover); `TenderRiskMatrixCompleteness` (exigida e não exigida; `MATRIX_EMPTY`, `ECONOMIC_IMPACT_REQUIRED`, `RISK_NOT_ALLOCATED`); `RiskTitleFreezer` e `refreshTitle`; `ConfidentialTextGuard` (formatos de moeda); regra de mapa emitido e risco encerrado.
- **Integração (Testcontainers):** gravação atômica por substituição e rollback total em falha induzida; um evento por tipo de mudança; unicidade parcial por `riskId`; FK `RESTRICT` e `ITEM_IN_USE` na exclusão de risco; mapa, riscos e tratamentos inalterados (hash); RLS entre tenants; completude com mudanças posteriores no mapa.
- **API/contrato:** TND-09 e TND-10 (códigos, `ETag`, `If-Match`, 412, 413, 428); campos aditivos de TND-03; contrato do `ITEM_IN_USE`.
- **RBAC e multi-tenant:** suíte "tenant leak" com TND-09 e TND-10 (inclusive `riskId` de outro tenant); matriz de autorização com `TENDER_UPDATE` e `PROCESS_VIEW`; bateria de POL-02 (custódia, participação, `DRAFT`/`RETURNED`, etapa, status do processo) e de POL-09 (textos com valor).
- **Concorrência:** gravações simultâneas, gravação contra edição do cabeçalho ou dos lotes (mesma `version`), gravação contra exclusão de risco.
- **E2E (Playwright):** trazer riscos do mapa, alocar, completar a matriz exigida, ver a pendência de risco novo, título alterado no mapa, leitura por Compras e conflito de edição.
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
- [ ] Gravação por substituição comprovadamente atômica, com um evento por tipo de mudança
- [ ] Mapa de riscos, riscos e tratamentos comprovadamente intactos após qualquer gravação da matriz
- [ ] Completude idêntica em TND-09, TND-03, `RuleContext` v2 e conclusão (mesma função)
- [ ] Texto da matriz comprovadamente ausente de eventos, logs e auditoria, e sem valor sigiloso em processo sigiloso
- [ ] Gherkin das 8 categorias automatizado, incluindo etapa fora de `MINUTA_EDITAL`, `If-Match` e matriz voluntária

## Estimativa
**M** — duas operações de API sobre uma coleção com vínculo opcional a outro módulo, título congelado, regras de completude calculadas na leitura e uma aba com várias interações; reaproveita o ETag e as regras de edição da US-163 e a leitura do mapa de riscos do MVP 1.

## Prioridade
**P1** — obrigatória para concluir a minuta apenas nas hipóteses do art. 22, § 3º (regime integrado ou semi-integrado, grande vulto ou limite configurado); nas demais é opcional, e o edital comum já pode ser concluído sem ela.
