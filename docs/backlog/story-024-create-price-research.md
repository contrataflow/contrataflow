---
id: US-024
title: "Criar pesquisa de preços a partir dos itens do processo"
epic: EP-004
feature: FT-015
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-006, US-065, US-110]
modules: [price-research, document, process, catalog, tenancy, access, timeline, audit, platform]
screens: [SCR-009, SCR-006]
endpoints: [PRS-01, PRS-02, PRS-03, PRS-04, PRS-05, PRS-06, PRS-08, DOC-05, PRC-13]
permissions: [PRICE_RESEARCH_CREATE, PRICE_RESEARCH_UPDATE, PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: [DocumentCreated, PriceResearchRecalculated]
---

# US-024 — Criar pesquisa de preços a partir dos itens do processo

## Título
Criar pesquisa de preços a partir dos itens do processo

## Descrição
**Como** agente de compras (ou planejamento), **quero** criar a pesquisa de preços do processo já com os itens da contratação e os parâmetros vigentes do órgão, **para** começar a registrar fontes e cotações sem redigitar itens, quantidades e regras de cálculo.

Ao confirmar, o sistema cria — em uma única transação — o documento `PRICE_RESEARCH` (numerado, a partir do template padrão), o cabeçalho tipado `PriceResearch` com o **snapshot dos parâmetros** de `priceResearch.*` e um `PriceItem` para cada item selecionado, com a quantidade de referência. A pesquisa abre na tela SCR-009, vazia de fontes, com a orientação "Registre as fontes consultadas e os preços de cada item". Enquanto em rascunho, o usuário pode alterar a data-base, incluir itens do processo que ficaram de fora, remover itens e ajustar quantidades.

## Contexto
- A Lei 14.133/2021, art. 23, exige valor estimado compatível com o mercado, apurado pelos parâmetros do § 1º; a IN SEGES/ME 65/2021 detalha a metodologia (aplicável aos demais entes por adoção — art. 187). As regras do órgão são **configuração** (DEC-016, DEC-020), copiadas para a pesquisa no momento da criação.
- Modelo (DEC-020): `PriceResearch` é cabeçalho 1:1 do `Document` tipo `PRICE_RESEARCH` e **não tem status próprio** — usa o status do documento e `completedAt` (DEC-018). `PriceItem` é a linha do item canônico (`ProcessItem`, DEC-019) na pesquisa.
- No workflow padrão (DEC-015) a pesquisa é feita na etapa `PESQUISA_PRECOS`, sob custódia da unidade de Compras; nada impede que o órgão a permita em outra etapa (`WorkflowStage.documentTypeCodes`).
- Sigilo do orçamento (art. 24; DEC-030): a pesquisa de processo sigiloso nasce `RESTRICTED` e todos os seus valores monetários seguem POL-09.
- Stories relacionadas: US-006 (itens do processo), US-065 (ciclo de vida do documento), US-110 (template padrão), US-026 (fontes e cotações), US-029 (cálculos), US-032 (conclusão).

## Objetivo
Permitir criar uma pesquisa válida em até 1 minuto, com 100% das pesquisas contendo: documento numerado e vinculado ao processo, snapshot completo dos parâmetros, um `PriceItem` por item selecionado com quantidade > 0, auditoria, timeline e evento `DocumentCreated` — de forma atômica.

## Persona
- **Principal:** Compras (perfil `COMPRAS`) — Juliana/Rui, agentes do Setor de Cotações.
- **Secundárias:** Planejamento (`PLANEJAMENTO`), Gestor de contratações (`GESTOR_CONTRATACOES`); leitura por quem vê o processo (inclusive `AUDITOR` e `CONTROLE_INTERNO`).

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE` (US-087, US-097).
- Processo visível, em `DRAFT`, `IN_PROGRESS` ou `RETURNED`, sob custódia do usuário (POL-01) e em etapa que permite o tipo `PRICE_RESEARCH`.
- O processo tem ao menos um `ProcessItem` não excluído (US-006).
- Tipo `PRICE_RESEARCH` ativo com template publicado (US-061, US-108, US-110); chaves `priceResearch.*` com valores válidos (US-103).
- Não existe outra pesquisa não cancelada no processo.

## Fluxo principal
1. No painel do processo (SCR-006 — aba Documentos ou ação primária da etapa "Criar pesquisa de preços"), o usuário aciona **"Criar pesquisa de preços"**.
2. O sistema abre o diálogo de criação e carrega em paralelo: itens do processo (`PRC-13`), parâmetros vigentes (`GET /settings/public` não expõe `priceResearch.*`; o diálogo usa o resumo devolvido pela própria criação — ver FA-06) e o template padrão do tipo.
3. O diálogo lista os itens (nº, lote, descrição, unidade, quantidade de referência) **todos marcados**, a **data-base** (hoje, fuso do tenant) e o título sugerido "Pesquisa de preços — {código do processo}".
4. O usuário ajusta (desmarca itens, informa quantidades ausentes, altera a data-base) e clica em **"Criar pesquisa"**. O front valida com `createPriceResearchSchema` (Zod) e envia `POST /api/v1/processes/{id}/price-research` com `Idempotency-Key`.
5. A API, em **uma transação** com `app.tenant_id` definido:
   1. valida o corpo e as referências (itens do mesmo processo, não excluídos, sem repetição);
   2. autoriza `PRICE_RESEARCH_CREATE` no escopo do processo + POL-02 (custódia, status do processo, tipo permitido na etapa);
   3. verifica a unicidade da pesquisa (índice parcial `singleton_key`) e a existência de itens;
   4. cria o `Document` pela fachada do módulo `document` (tipo `PRICE_RESEARCH`, template, número/código pela máscara, `confidentiality`, `responsibleId`, `draftContent` com as seções `METHODOLOGY` e `CONCLUSION` do template);
   5. lê `priceResearch.*` e grava `PriceResearch` com o snapshot (RN-PRICE-05) e `referenceDate`;
   6. cria os `PriceItem` (quantidade conforme RN-PRICE-04, `sortOrder` = `ProcessItem.sequence`, `alerts = [{code:"NO_VALID_QUOTES"},{code:"BELOW_MINIMUM_QUOTES"}]` pelo cálculo inicial de US-029/US-030) e atualiza `itemsCount`/`itemsWithAlertsCount`;
   7. grava `AuditLog` `document.create`, o evento `DocumentCreated` (routing key `document.created.price_research`) no outbox e — pelo projetor síncrono — a entrada `DOCUMENT_CREATED` na timeline;
   8. confirma a transação.
6. A API responde **201** com a pesquisa, `Location: /api/v1/price-research/{id}` e `ETag: "1"`.
7. O front navega para SCR-009 (`/processos/{id}/pesquisa-precos/{researchId}`), exibe o toast "Pesquisa de preços {código} criada" e o estado vazio da aba **Fontes** com a ação "Registrar fonte" (US-026).

## Fluxos alternativos
- **FA-01 — Pesquisa já existente:** o botão "Criar pesquisa de preços" é substituído por "Abrir pesquisa {código}". Se a criação for tentada (corrida ou API), retorna 409 `DOCUMENT_ALREADY_EXISTS` com o `id` da pesquisa existente em `meta.existingId`; o front oferece "Abrir pesquisa existente".
- **FA-02 — Processo sem itens:** o diálogo mostra "Cadastre os itens da contratação antes de criar a pesquisa." com o link "Ir para Itens" (SCR-006, aba Itens); a API responde 422 `BUSINESS_RULE_VIOLATION` com a violação `PRICE_ITEMS_REQUIRED`.
- **FA-03 — Item sem quantidade de referência:** quando nem o processo, nem o ETP, nem o DFD informam quantidade, a linha fica destacada com "Informe a quantidade" e o botão permanece desabilitado até o preenchimento.
- **FA-04 — Incluir itens depois (PRS-06):** itens criados no processo após a pesquisa aparecem no aviso "2 itens do processo não estão na pesquisa" com a ação "Incluir itens"; a inclusão cria `PriceItem` sem cotações.
- **FA-05 — Remover item (PRS-08):** a remoção pede confirmação ("O item 3 tem 4 cotações registradas. Elas serão apagadas.") e é bloqueada se for o último item.
- **FA-06 — Parâmetros da pesquisa:** o painel lateral "Parâmetros" de SCR-009 mostra o snapshot (método padrão, CV limite, mínimo de cotações, validades, faixas de valor atípico, casas decimais) com a nota "Definidos pelo órgão em {data da criação}. Alterações posteriores nas configurações não afetam esta pesquisa."
- **FA-07 — Alterar data-base (PRS-04):** a nova data é gravada, a validade das cotações é reavaliada e os alertas recalculados (US-029/US-030), com toast "Data-base alterada para 06/10/2026; validades recalculadas".
- **FA-08 — Reenvio após falha de rede:** mesma `Idempotency-Key` → resposta original com `Idempotent-Replayed: true`; nenhuma pesquisa duplicada.
- **FA-09 — Processo com orçamento sigiloso:** a pesquisa nasce `RESTRICTED`; usuários sem POL-09 veem a pesquisa com valores mascarados ("Sigiloso") e sem ações de edição (RN-PRICE-12).
- **FA-10 — Template diferente do padrão:** se o tipo tiver mais de um template ativo publicado, o diálogo exibe o seletor "Modelo" (padrão pré-selecionado).

## Regras de negócio
- **RN-PRICE-01** — Há no máximo **uma pesquisa não cancelada por processo** (DEC-020; `singleton_key`). Nova criação com pesquisa existente → 409 `DOCUMENT_ALREADY_EXISTS`. Pesquisa `CANCELED` (US-065) libera a criação de outra.
- **RN-PRICE-02** — A criação exige ao menos um `ProcessItem` não excluído no processo; caso contrário, 422 `BUSINESS_RULE_VIOLATION` com `PRICE_ITEMS_REQUIRED`.
- **RN-PRICE-03** — Por padrão entram todos os itens não excluídos, na ordem de `sequence`; o usuário pode desmarcar itens, mantendo ao menos um. `PriceItem` é único por `processItemId` na pesquisa.
- **RN-PRICE-04** — Quantidade padrão do `PriceItem`: `ProcessItem.referenceQuantity`; se nula, a quantidade do item no ETP não cancelado do processo; se ausente, a do DFD; se nenhuma existir, é obrigatória no envio. Sempre > 0, até 4 casas decimais, e inteira quando a unidade (`UNIT_OF_MEASURE`) tiver `allowsDecimal = false`.
- **RN-PRICE-05** — Snapshot (DEC-020): na criação são copiados `defaultMethod`, `cvThresholdPercent`, `minQuotations`, `directQuoteMaxAgeDays`, `similarContractMaxAgeDays`, `outlierLowerPercent`, `outlierUpperPercent` e `unitPriceDecimals` das chaves `priceResearch.*`. Mudanças posteriores nas configurações não afetam a pesquisa. Esses campos são somente leitura no PRS-04, exceto `defaultMethod` (US-029).
- **RN-PRICE-06** — `referenceDate` (data-base) = hoje no fuso do tenant por padrão; não pode ser futura; alterável apenas com o documento editável; a alteração dispara recálculo (validade das cotações e alertas).
- **RN-PRICE-07** — O documento é do tipo `PRICE_RESEARCH`, baseado no template padrão publicado (ou outro template ativo e publicado do tipo), numerado pela máscara do tipo (`numbering.document.defaultMask` quando o tipo não define `numberingMask`), com `responsibleId` = criador e título editável (5–250 caracteres).
- **RN-PRICE-08** — `confidentiality = RESTRICTED` quando `Process.isBudgetConfidential = true`; senão, `defaultConfidentiality` do tipo (`INTERNAL`). A troca posterior do sigilo do processo é propagada por US-013.
- **RN-PRICE-09** — Criar exige `PRICE_RESEARCH_CREATE` com escopo que cubra o processo + POL-02 aplicável à criação (custódia, processo em `DRAFT`/`IN_PROGRESS`/`RETURNED`, tipo permitido na etapa). Participantes não criam pesquisas.
- **RN-PRICE-10** — Alterar data-base, título, itens e quantidades exige `PRICE_RESEARCH_UPDATE` + POL-02 completa (inclui documento em `DRAFT`/`RETURNED`); participantes `COLLABORATOR`/`CONSULTANT` podem editar.
- **RN-PRICE-11** — Incluir itens (PRS-06) aceita apenas itens do mesmo processo ainda ausentes da pesquisa; remover (PRS-08) apaga fisicamente as cotações do item (`ON DELETE CASCADE`) e é proibido se for o último item.
- **RN-PRICE-12** — Em processo sigiloso, quem não atende POL-09 recebe `null` + `<campo>Masked: true` em todo valor monetário da pesquisa (preços de cotação, estatísticas, valores recomendados, totais) e **não pode editá-la** (403 `PERMISSION_DENIED`, `reasonCode = POL-09`), pois editar exige ler os valores.
- **RN-PRICE-13** — Criação atômica: documento, cabeçalho, itens, auditoria, outbox e timeline na mesma transação; qualquer falha desfaz tudo, inclusive o número do documento.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Título | `title` (`Document.title`) | texto curto | Sim | 5–250 caracteres | "Pesquisa de preços — {código do processo}" |
| Modelo | `templateVersionId` (resolvido de `templateId`) | seleção | Sim (oculto se único) | template ativo, publicado, do tipo | template padrão do tipo |
| Data-base | `referenceDate` | data | Sim | ≤ hoje (fuso do tenant) | hoje |
| Itens | `items[].processItemId` | lista de seleção | Sim (≥ 1) | itens do processo, não excluídos, sem repetição | todos |
| Quantidade | `items[].quantity` | decimal (string) | Condicional (RN-PRICE-04) | > 0; até 4 casas; inteira se a unidade não aceita decimal | referência do processo/ETP/DFD |
| *(sistema)* Parâmetros | `defaultMethod`, `cvThresholdPercent`, `minQuotations`, `directQuoteMaxAgeDays`, `similarContractMaxAgeDays`, `outlierLowerPercent`, `outlierUpperPercent`, `unitPriceDecimals` | — | — | RN-PRICE-05 | `priceResearch.*` |
| *(sistema)* Código, status, sigilo | `Document.code`, `Document.status`, `Document.confidentiality` | — | — | RN-PRICE-07/08 | gerados |
| *(sistema)* Contadores | `itemsCount`, `itemsWithAlertsCount`, `totalEstimatedValue`, `lastCalculatedAt` | — | — | US-029/US-030 | calculados |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Lista de itens vazia | Front + API (Zod) | "Selecione ao menos um item." | `VALIDATION_ERROR` (`REQUIRED` em `items`) |
| V-02 | Item de outro processo, excluído, inexistente ou de outro tenant | API | "Selecione itens deste processo." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-03 | Item repetido na lista | Front + API | "O item {n} foi informado mais de uma vez." | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`) |
| V-04 | Quantidade ausente, ≤ 0, com mais de 4 casas ou fracionária em unidade inteira | Front + API | "Informe uma quantidade maior que zero (até 4 casas decimais)." | `VALIDATION_ERROR` (`REQUIRED`/`OUT_OF_RANGE`/`INVALID_DECIMAL`) |
| V-05 | Data-base futura | Front + API | "A data-base não pode ser posterior a hoje." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-06 | Título fora de 5–250 caracteres | Front + API | "O título deve ter entre 5 e 250 caracteres." | `VALIDATION_ERROR` (`TOO_SHORT`/`TOO_LONG`) |
| V-07 | Template inativo/não publicado | API | "Selecione um modelo válido." | `VALIDATION_ERROR` (`REFERENCE_INACTIVE`) |
| V-08 | Processo sem itens | API | "Cadastre os itens da contratação antes de criar a pesquisa." | `BUSINESS_RULE_VIOLATION` (`PRICE_ITEMS_REQUIRED`) |
| V-09 | Pesquisa não cancelada já existe | API (+ índice único) | "Este processo já tem uma pesquisa de preços." | `DOCUMENT_ALREADY_EXISTS` |
| V-10 | Remover o último item / alterar parâmetro do snapshot | API | "A pesquisa precisa de ao menos um item." / "Este parâmetro foi fixado na criação da pesquisa." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-11 | Mesma `Idempotency-Key` com corpo diferente | API | "Esta solicitação já foi enviada com outros dados." | `IDEMPOTENCY_KEY_REUSED` |

## Permissões
- **Permissão:** `PRICE_RESEARCH_CREATE` (criar) e `PRICE_RESEARCH_UPDATE` (data-base, título, itens) com escopo que cubra o processo; `PROCESS_VIEW` para leitura (PRS-01, PRS-03, PRS-05).
- **Políticas:** POL-01/POL-02 (custódia ou participação para editar; status do documento e do processo; tipo permitido na etapa); POL-09 para valores (RN-PRICE-12).
- **MFA:** não exigido (permissões de risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** o botão "Criar pesquisa de preços" não é exibido (sem permissão) ou fica desabilitado com explicação ("O processo não está com você" / "A etapa atual não permite pesquisa de preços"). A API responde 403 `PERMISSION_DENIED`/`NOT_PROCESS_CUSTODIAN`, 409 `INVALID_PROCESS_STATUS` ou 422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` e registra `access.denied` quando for negação de autorização.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DocumentCreated` | `document.created.price_research` | Commit da criação | `documentId`, `documentTypeCode = PRICE_RESEARCH`, `kind = STRUCTURED`, `code`, `title`, `templateVersionId` |
| `PriceResearchRecalculated` | `price_research.recalculated` | Commit de PRS-04 (data-base), PRS-06 (inclusão de item) e PRS-08 (remoção de item) | `priceResearchId`, `itemsCount`, `itemsWithAlertsCount`; sem valores |

Projeção síncrona: `ProcessTimelineEntry` `DOCUMENT_CREATED` ("{actor} criou {documentLabel}").

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: a pesquisa nasce sob custódia de quem a criou. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Criar pesquisa de preços a partir dos itens do processo

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And as configurações "priceResearch.defaultMethod" = "AUTO_CV", "priceResearch.cvThresholdPercent" = 25, "priceResearch.minQuotations" = 3, "priceResearch.directQuoteMaxAgeDays" = 180, "priceResearch.outlierLowerPercent" = 70, "priceResearch.outlierUpperPercent" = 130 e "priceResearch.unitPriceDecimals" = 2
    And o processo "0012/2026" está "IN_PROGRESS" na etapa "PESQUISA_PRECOS" com "Rui" (COMPRAS) como responsável
    And o processo tem os itens 1 "Cimento CP II 50 kg" (100 SC), 2 "Areia média" (12 M3) e 3 "Brita 1" sem quantidade de referência, sendo 6 M3 no ETP

  Scenario: [Sucesso] Criar pesquisa com todos os itens
    When "Rui" criar a pesquisa de preços mantendo os 3 itens e a data-base "2026-10-06"
    Then deve ser criado um documento "PRICE_RESEARCH" com status "DRAFT", código gerado pela máscara do tipo e sigilo "INTERNAL"
    And a pesquisa deve ter 3 itens com quantidades "100.0000", "12.0000" e "6.0000"
    And o snapshot deve registrar método padrão "AUTO_CV", CV limite "25.0000", mínimo de 3 cotações e faixas "70.0000"/"130.0000"
    And cada item deve ter os alertas "NO_VALID_QUOTES" e "BELOW_MINIMUM_QUOTES"
    And a API deve responder 201 com "Location" e "ETag" igual a "1"
    And deve gerar registro de auditoria "document.create"
    And deve gerar o evento "DocumentCreated" com routing key "document.created.price_research"
    And deve existir a entrada "DOCUMENT_CREATED" na timeline

  Scenario: [Sucesso] Snapshot não muda com a configuração do tenant
    Given que a pesquisa foi criada com "minQuotations" = 3
    When o administrador alterar "priceResearch.minQuotations" para 5
    Then a pesquisa deve continuar exigindo 3 cotações por item

  Scenario: [Validação] Processo sem itens
    Given que o processo "0013/2026" não tem itens
    When "Rui" tentar criar a pesquisa de preços
    Then a API deve responder 422 com código "BUSINESS_RULE_VIOLATION" e violação "PRICE_ITEMS_REQUIRED"
    And o diálogo deve exibir "Cadastre os itens da contratação antes de criar a pesquisa." com o link "Ir para Itens"

  Scenario: [Validação] Quantidade inválida e data-base futura
    When "Rui" enviar a quantidade "0" para o item 3 e a data-base "2026-10-10"
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    And deve haver erro "OUT_OF_RANGE" em "items[2].quantity" e em "referenceDate"

  Scenario: [Permissão] Usuário sem permissão de criar
    Given que "Ana" possui apenas o perfil "REQUISITANTE"
    When "Ana" enviar POST para "/api/v1/processes/{id}/price-research"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "PRICE_RESEARCH_CREATE"

  Scenario: [Permissão] Compras sem custódia do processo
    Given que o processo está com "Paula" (PLANEJAMENTO) na etapa "ESTUDOS_PRELIMINARES"
    When "Rui" tentar criar a pesquisa
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN"

  Scenario: [Tenant incorreto] Item de processo de outro tenant
    Given que existe o item "X" em um processo do tenant "Prefeitura B"
    When "Rui" enviar a criação com "processItemId" do item "X"
    Then a API deve responder 422 com erro "REFERENCE_NOT_FOUND" em "items[0].processItemId"
    And a resposta não deve revelar a existência do item no outro tenant

  Scenario: [Tenant incorreto] Pesquisa de outro tenant
    When "Rui" consultar GET "/api/v1/price-research/{id}" de uma pesquisa do tenant "Prefeitura B"
    Then a API deve responder 404

  Scenario: [Duplicidade] Segunda pesquisa no mesmo processo
    Given que o processo já tem a pesquisa em "DRAFT"
    When "Rui" tentar criar outra pesquisa
    Then a API deve responder 409 com código "DOCUMENT_ALREADY_EXISTS" e "meta.existingId" da pesquisa atual

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que "Rui" criou a pesquisa com a chave "K7" e recebeu 201
    When a mesma requisição for reenviada com a chave "K7"
    Then a API deve responder 201 com a mesma pesquisa e "Idempotent-Replayed: true"
    And deve existir apenas uma pesquisa no processo

  Scenario: [Concorrência] Criações simultâneas no mesmo processo
    When "Rui" e "Juliana" (COMPRAS, mesma unidade, processo sem responsável) criarem a pesquisa ao mesmo tempo com chaves diferentes
    Then apenas uma criação deve responder 201
    And a outra deve responder 409 com código "DOCUMENT_ALREADY_EXISTS"

  Scenario: [Concorrência] Alteração da data-base com versão desatualizada
    Given que a pesquisa está na versão 4
    When "Rui" enviar PATCH com "If-Match" igual a "3"
    Then a API deve responder 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível na criação
    Given que o banco fica indisponível durante a transação
    When "Rui" clicar em "Criar pesquisa"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum documento, item, número, auditoria ou evento deve ser persistido

  Scenario: [Falha de integração] Redis indisponível
    Given que o Redis está indisponível
    When "Rui" criar a pesquisa com chave de idempotência
    Then a pesquisa deve ser criada normalmente
    And deve ser registrado log "warn" "idempotency.store_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca linhas/campos com `errors[]` |
| Processo sem itens | 422 | `BUSINESS_RULE_VIOLATION` (`PRICE_ITEMS_REQUIRED`) | "Cadastre os itens da contratação antes de criar a pesquisa." | Link para a aba Itens |
| Sem permissão / sem custódia | 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | "Você não pode criar a pesquisa deste processo agora." | Fecha o diálogo; mostra o responsável atual |
| Processo suspenso, cancelado ou concluído | 409 | `INVALID_PROCESS_STATUS` | "O processo não permite novos documentos na situação atual." | Atualiza o painel |
| Etapa não permite o tipo | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "A etapa atual não permite criar pesquisa de preços." | Mostra a etapa atual |
| Pesquisa já existe | 409 | `DOCUMENT_ALREADY_EXISTS` | "Este processo já tem uma pesquisa de preços." | Botão "Abrir pesquisa existente" |
| Documento não editável (PRS-04/06/08) | 409 | `DOCUMENT_NOT_EDITABLE` | "A pesquisa está concluída. Reabra-a para alterar." | Modo somente leitura |
| Versão desatualizada | 412 | `VERSION_CONFLICT` | "A pesquisa foi alterada por outra pessoa. Recarregue." | Recarrega e reaplica a alteração |
| Requisição idêntica em processamento | 409 | `IDEMPOTENCY_IN_PROGRESS` | "Estamos criando a pesquisa. Aguarde." | Repete a consulta após 2 s |
| Banco/Redis crítico indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível criar a pesquisa agora. Tente novamente." | Mantém o diálogo; exibe correlationId |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-006 (itens canônicos e `ITEM_IN_USE`), US-065 (criação e ciclo de vida do documento), US-110 (template padrão `PRICE_RESEARCH` com `METHODOLOGY`, `CONCLUSION` e seção `PRICE_SUMMARY`). Indiretas: US-013 (sigilo), US-059, US-073, US-082, US-097, US-103, US-105.
- **Decisões/ADRs:** DEC-010, DEC-016, DEC-017, DEC-018, DEC-019, DEC-020, DEC-024, DEC-030, DEC-055, DEC-105, DEC-161; ADR-006.
- **Configurações:** `priceResearch.defaultMethod`, `priceResearch.cvThresholdPercent`, `priceResearch.minQuotations`, `priceResearch.directQuoteMaxAgeDays`, `priceResearch.similarContractMaxAgeDays`, `priceResearch.outlierLowerPercent`, `priceResearch.outlierUpperPercent`, `priceResearch.unitPriceDecimals`, `priceResearch.roundingMode`, `numbering.document.defaultMask`.
- **Lacunas nas fontes canônicas:** nenhuma (resolvidas em 2026-10-07: `roundingMode` no snapshot de `PriceResearch` em entities.md; `document.items_update` já cobre inclusão/remoção de itens em events.md §7; `PRS-06` emite `PriceResearchRecalculated`; edição sob POL-09 explícita em permissions.md; máscara `PP {seq:4}/{year}` semeada para o tipo).

## Impacto técnico
- Introduz o módulo `price-research`, com dependências `document` (criação do documento), `process` (itens e custódia via fachada/porta), `catalog` (unidades) e `tenancy` (configurações). A dependência `price-research → process` não aparece no diagrama de architecture.md (ver relatório).
- O snapshot de parâmetros torna a pesquisa reprodutível (RT-06) e defensável (RL-03).
- Mutação da pesquisa sempre bloqueia a linha de `price_research` (`SELECT … FOR UPDATE`) para serializar recálculos de totais (US-029).
- Criação com até 500 itens: inserção em lote (`createMany`); meta p95 < 800 ms.

## Backend
- **Módulo(s):** `price-research` (dono); usa `DocumentFacade.createStructured`, `ProcessFacade.getItemsForResearch` (itens + quantidades de ETP/DFD via `DocumentFacade.getItemQuantities`), `ProcessAccessPort` (custódia/visibilidade), `SettingsFacade.get('priceResearch.*')`, `CatalogFacade` (unidade), `AuthorizationService`, `AuditService`, `OutboxWriter`, `IdempotencyService`.
- **Casos de uso:** `CreatePriceResearchCommand`, `UpdatePriceResearchHeaderCommand` (data-base, título), `AddPriceItemsCommand`, `RemovePriceItemCommand`; consultas `GetProcessPriceResearchQuery`, `GetPriceResearchQuery`, `ListPriceItemsQuery`.
- **Domínio:** `PriceResearch.create(params, snapshot)`; value objects `PriceParametersSnapshot`, `Quantity`; `PriceItem.create`; recálculo por `PriceResearchRecalculator` (US-029).
- **Transação:** passos 5.1–5.8 em transação interativa com `app.tenant_id`; bloqueio da sequência de numeração do documento (DEC-028).
- **Serialização:** `PriceResearchPresenter` passa pelo `ConfidentialFieldsInterceptor` (POL-09) e devolve `meta.allowedActions` (`update`, `addItems`, `complete`, `reopen`).

## Frontend
- **Tela(s):** diálogo de criação em SCR-006; SCR-009 (`/processos/[id]/pesquisa-precos/[researchId]`) com abas **Itens**, **Fontes**, **Cotações (grade)**, **Mapa** (link para SCR-010) e **Documento** (seções `METHODOLOGY`/`CONCLUSION`, autosave via DOC-05).
- **Componentes:** `CreatePriceResearchDialog` (tabela de itens com seleção e `QuantityInput`), `DatePicker` (data-base), `ParametersPanel` (snapshot, somente leitura), `PriceItemsTable` (TanStack Table), `MissingItemsBanner`, `DocumentStatusBadge` (com selo derivado "Em aprovação" quando `pendingApprovalId` — DEC-018), `ConfidentialValue` ("Sigiloso").
- **Dados:** `['t', tenantId, 'price-research', researchId]`; `useMutation(createPriceResearch)` com `Idempotency-Key` por abertura do diálogo; invalidar `['t', tenantId, 'processes', processId, 'documents']` e o resumo do processo.
- **Estados:** skeleton; vazio ("Nenhuma fonte registrada ainda"); erro com "Tentar novamente"; somente leitura quando não editável.
- **Acessibilidade e responsividade:** tabela de itens com `caption`, seleção por teclado (Espaço), erros por linha anunciados via `aria-live`; edição *desktop-first* (DEC-183), leitura em mobile com cartões por item.

## Banco de dados
- **Tabelas:** `documents`, `price_research`, `price_items`, `number_sequences`, `audit_logs`, `outbox_events`, `process_timeline_entries`.
- **Migrações:** criação de `price_research` e `price_items` conforme entities.md §4.8 (FKs compostas, RLS `FORCE`, `version`), `ON DELETE CASCADE` de `price_items` → `price_research`.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, document_id)` em `price_research`; `UNIQUE (tenant_id, price_research_id, process_item_id)` em `price_items`; índice parcial do singleton em `documents`; `CHECK (quantity > 0)`; `CHECK (min_quotations >= 1)`; `CHECK (unit_price_decimals IN (2, 4))`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRS-01 | GET | `/api/v1/processes/{id}/price-research` | — | `200 { data: [PriceResearchSummary] }` (0 ou 1 não cancelada + canceladas) | 200, 404 |
| PRS-02 | POST | `/api/v1/processes/{id}/price-research` | `{ title?, templateId?, referenceDate?, items?: [{ processItemId, quantity? }] }` + `Idempotency-Key` | `201 { data: PriceResearch }` | 201, 403, 404, 409, 422, 503 |
| PRS-03 | GET | `/api/v1/price-research/{id}` | — | `200 { data: PriceResearch, meta: { allowedActions } }` + `ETag` | 200, 404 |
| PRS-04 | PATCH | `/api/v1/price-research/{id}` | `{ referenceDate?, title? }` + `If-Match` | `200 { data: PriceResearch }` | 200, 403, 409, 412, 422, 428 |
| PRS-05 | GET | `/api/v1/price-research/{id}/items` | `?page&pageSize&lot&hasAlerts` | `200 { data: [PriceItem], meta }` | 200, 404 |
| PRS-06 | POST | `/api/v1/price-research/{id}/items` | `{ items: [{ processItemId, quantity? }] }` | `201 { data: [PriceItem] }` | 201, 403, 409, 422 |
| PRS-08 | DELETE | `/api/v1/price-items/{itemId}` | `If-Match` | `204` | 204, 403, 409, 412, 422 |

Exemplo de resposta `201` (resumida):
```json
{ "data": { "id": "0192…", "documentId": "0192…", "processId": "0192…", "code": "PP 0003/2026",
  "title": "Pesquisa de preços — 0012/2026", "status": "DRAFT", "confidentiality": "INTERNAL", "referenceDate": "2026-10-06",
  "parameters": { "defaultMethod": "AUTO_CV", "cvThresholdPercent": "25.0000", "minQuotations": 3, "directQuoteMaxAgeDays": 180,
    "similarContractMaxAgeDays": 365, "outlierLowerPercent": "70.0000", "outlierUpperPercent": "130.0000", "unitPriceDecimals": 2 },
  "itemsCount": 3, "itemsWithAlertsCount": 3, "totalEstimatedValue": null, "totalEstimatedValueMasked": false,
  "completedAt": null, "pendingApprovalId": null, "version": 1 } }
```

## Logs
- `info` `price_research.created` — `priceResearchId`, `documentId`, `processId`, `itemsCount`, `durationMs`, `correlationId`.
- `info` `price_research.items_changed` — `added`, `removed`, `priceResearchId`.
- `warn` `idempotency.store_unavailable` — Redis indisponível.
- `error` `price_research.create_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** títulos, descrições de itens, quantidades associadas a valores, preços ou totais.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.create` | `DATA_CHANGE` | Criação | `metadata`: `documentCode`, `documentTypeCode = PRICE_RESEARCH`, `processCode`, `itemsCount`, snapshot de parâmetros, `idempotencyKey` |
| `document.items_update` | `DATA_CHANGE` | PRS-06/PRS-08 | `changes`: itens incluídos/removidos com quantidade; `metadata`: `documentTypeCode = PRICE_RESEARCH`, nº de cotações apagadas |
| `document.draft_update` | `DATA_CHANGE` | PRS-04 (data-base, título) | `changes`: `referenceDate`/`title` antigo e novo; `metadata.field` |
| `access.denied` | `ACCESS` | Negação | `reasonCode` (`PRICE_RESEARCH_CREATE`, `PRICE_RESEARCH_UPDATE`, `POL-09`) |

> As duas primeiras ações são as mais próximas do catálogo para o cabeçalho e os itens da pesquisa (Lacuna 2).

## Testes necessários
- **Unitários:** resolução de quantidade (processo → ETP → DFD → obrigatória); unidade inteira × decimal; montagem do snapshot; regras de inclusão/remoção de itens.
- **Integração (Testcontainers):** atomicidade com falha induzida após numerar; RLS e FK composta com item de outro tenant; singleton com índice parcial; cascata de cotações ao remover item.
- **API/contrato:** PRS-01..06/08 conforme api.md; `ETag`, `Location`, `Idempotent-Replayed`; mascaramento de `totalEstimatedValue`.
- **RBAC e multi-tenant:** COMPRAS com/sem custódia; PLANEJAMENTO; REQUISITANTE (403); CONSULTOR_EXTERNO participante edita mas não cria; suíte "tenant leak" para PRS-01..08.
- **Concorrência:** duas criações simultâneas → uma 201 e uma 409; PATCH com `If-Match` antigo → 412.
- **E2E (Playwright):** criar a pesquisa a partir do painel, desmarcar item, informar quantidade ausente, abrir SCR-009.
- **Acessibilidade/performance:** axe no diálogo e em SCR-009; criação com 500 itens p95 < 800 ms.

## Definition of Done
- [ ] Cenários Gherkin automatizados (API + E2E) e passando
- [ ] POL-02 e POL-09 aplicadas na API; botões ocultos/desabilitados com explicação
- [ ] Atomicidade comprovada por teste de falha induzida (inclui número do documento)
- [ ] Auditoria `document.create` e evento `DocumentCreated` verificados
- [ ] Teste de isolamento na suíte "tenant leak"
- [ ] OpenAPI de PRS-01..06/08 compatível com api.md
- [ ] Logs sem valores nem descrições; métrica `price_research_created_total`
- [ ] SCR-009 acessível (axe) e legível em 360 px
- [ ] Revisão de código e de segurança aprovadas
- [ ] Lacunas registradas consolidadas em risks-and-decisions.md

## Estimativa
**M** — criação transacional sobre a fachada de documentos já existente, snapshot de parâmetros, resolução de quantidades e manutenção de itens; a complexidade de cálculo fica em US-029/US-030.

## Prioridade
**P0** — sem a pesquisa não há valor estimado nem conclusão da etapa `PESQUISA_PRECOS` do workflow padrão.
