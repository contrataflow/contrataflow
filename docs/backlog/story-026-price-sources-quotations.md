---
id: US-026
title: "Registrar fontes de pesquisa e cotações"
epic: EP-004
feature: FT-017
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-024, US-025, US-068]
modules: [price-research, supplier, catalog, attachment, access, audit, platform]
screens: [SCR-009]
endpoints: [PRS-09, PRS-10, PRS-11, PRS-12, PRS-13, PRS-14, PRS-15, ATT-02]
permissions: [PRICE_RESEARCH_UPDATE, SUPPLIER_VIEW]
events: [PriceResearchRecalculated]
---

# US-026 — Registrar fontes de pesquisa e cotações

## Título
Registrar fontes de pesquisa e cotações

## Descrição
**Como** responsável pela pesquisa de preços, **quero** registrar as fontes de pesquisa (orçamentos, painel de preços, contratações similares, sítios eletrônicos etc.) e, para cada fonte, o preço cotado de cada item, **para** reunir as evidências exigidas pelo art. 23 da Lei 14.133/2021 e alimentar o cálculo do valor estimado (US-029).

Cada fonte (`PriceSource`) é uma evidência — com tipo, descrição, data e, quando aplicável, fornecedor, URL, órgão de referência, documento de referência e anexo — e recebe uma cotação (`Quotation`) por item da pesquisa, lançada em grade (todos os itens de uma fonte de uma vez). Os campos exigidos variam por tipo de fonte, conforme configurado no catálogo `PRICE_SOURCE_TYPE`.

## Contexto
- A Lei 14.133/2021, art. 23, §1º, I a V, lista os parâmetros de pesquisa de preços (preços praticados, bancos de dados, pesquisa direta com fornecedores, sítios eletrônicos especializados e contratações similares); cada um exige evidências diferentes — por isso os campos obrigatórios variam por tipo (metadados do catálogo `PRICE_SOURCE_TYPE`), e não há um formulário único fixo.
- IN SEGES/ME 65/2021 orienta sobre a combinação de parâmetros e a necessidade de registrar a data/hora de acesso a sítios eletrônicos (art. 23, §1º, III).
- A pesquisa de preços (`PriceResearch`) já existe a partir dos itens do processo (US-024); os fornecedores já estão cadastrados (US-025); o anexo de evidência segue o fluxo geral de upload (US-068).
- Esta story não calcula estatísticas nem aponta discrepâncias — apenas registra fontes e preços; o cálculo (média, mediana, CV, valor recomendado) é US-029, e a sinalização de outliers/alertas é US-030. Toda alteração aqui apenas **dispara** o recálculo descrito naquelas stories.

## Objetivo
Permitir que o responsável registre uma fonte completa e as cotações de todos os itens em menos de 3 minutos por fonte, com 100% das fontes gravadas respeitando os campos obrigatórios do seu tipo e 100% das alterações disparando o recálculo da pesquisa.

## Persona
- **Principal:** Equipe de planejamento da contratação (perfil `PLANEJAMENTO`).
- **Secundárias:** Setor de Compras (`COMPRAS`), Gestor de contratações (`GESTOR_CONTRATACOES`).

## Pré-condições
- Existe uma `PriceResearch` em `DRAFT`/`RETURNED` para o processo (US-024), com ao menos um `PriceItem`.
- Usuário possui `PRICE_RESEARCH_UPDATE` em escopo que cubra o processo, e o documento está em etapa que permite o tipo `PRICE_RESEARCH` (POL-02).
- Catálogo `PRICE_SOURCE_TYPE` tem itens ativos configurados com `requiredFields`.
- Fornecedores relevantes já cadastrados (US-025), quando a fonte exigir `supplierId`.

## Fluxo principal
1. Na tela da pesquisa (SCR-009, aba "Fontes"), o usuário clica em **"Nova fonte"**.
2. O sistema abre o formulário com **Tipo de fonte** (catálogo `PRICE_SOURCE_TYPE`); ao escolher o tipo, exibe somente os campos daquele tipo (`requiredFields`) como obrigatórios e oferece os demais como opcionais.
3. O usuário preenche **Descrição** (sempre obrigatória) e os campos exigidos — por exemplo, para "Pesquisa direta com fornecedores": **Fornecedor** (busca por nome/documento, US-025), **Data do orçamento**, **Justificativa da escolha do fornecedor** e o **anexo** do orçamento; para "Sítio eletrônico especializado": **URL** e **Data/hora de acesso**; para "Contratação similar": **Órgão de referência**, **Documento de referência** e **Data**.
4. O usuário clica em **"Salvar fonte"**. O front envia `POST /api/v1/price-sources` (`PRS-10`, rota efetiva do recurso da pesquisa) com `Idempotency-Key`; a API valida os campos exigidos pelo tipo (`QUOTATION_REQUIRED_FIELDS` se faltar algum) e grava a `PriceSource`.
5. Se a fonte exigir anexo, o usuário envia o arquivo pelo fluxo padrão de upload (US-068: `ATT-02` intenção → upload direto → confirmação), associado a `AttachmentTargetType.PRICE_SOURCE`.
6. Com a fonte criada, o sistema abre a **grade de preços** daquela fonte: uma linha por item da pesquisa, com campos **Preço unitário** e **Marca/modelo** (opcional).
7. O usuário preenche os preços e clica em **"Salvar preços"**. O front envia `PUT /api/v1/price-sources/{sourceId}/quotations` (`PRS-13`) com `If-Match` da versão da fonte e a lista de linhas preenchidas.
8. A API, em uma transação: valida `unitPrice > 0` com até `unitPriceDecimals` casas em cada linha; cria/atualiza a `Quotation` de cada item informado (ignora linhas vazias; não altera cotações `EXCLUDED`); recalcula `isExpired` de cada cotação pela regra do tipo da fonte; atualiza `PriceResearch.lastCalculatedAt`; grava auditoria `price_research.quotation_create`/`quotation_update` e publica `PriceResearchRecalculated`.
9. A API responde **200** com as cotações gravadas; o front atualiza a grade, mostra os totais recalculados (US-029) e o toast "Preços salvos".

## Fluxos alternativos
- **FA-01 — Editar fonte:** "Editar" na lista de fontes reabre o formulário (`PATCH /price-sources/{id}`, `PRS-11`, `If-Match`); trocar o **Tipo de fonte** reavalia os campos obrigatórios e pode exigir preencher novos campos antes de salvar.
- **FA-02 — Remover fonte:** "Remover" (`DELETE /price-sources/{id}`, `PRS-12`, `If-Match`) exclui a fonte e, em cascata, todas as suas cotações; pede confirmação informando quantas cotações serão perdidas; dispara recálculo dos itens afetados.
- **FA-03 — Editar uma única cotação:** a partir da grade, editar uma célula já salva usa `PATCH /quotations/{quotationId}` (`PRS-14`, `If-Match`) em vez de reenviar a grade inteira.
- **FA-04 — Remover uma única cotação:** "Remover" numa célula usa `DELETE /quotations/{quotationId}` (`PRS-15`, `If-Match`); diferente de excluir (US-027), a cotação deixa de existir (sem motivo/justificativa).
- **FA-05 — Cotação já desconsiderada:** células com cotação `EXCLUDED` aparecem somente leitura na grade, com indicação do motivo; para alterar o preço é preciso restaurá-la primeiro (US-027).
- **FA-06 — Fonte sem fornecedor obrigatório:** ao tentar salvar uma fonte de tipo que exige `supplierId` sem selecioná-lo, o formulário impede o envio e destaca "Selecione o fornecedor"; se enviado direto à API, responde `QUOTATION_REQUIRED_FIELDS`.
- **FA-07 — Reenvio da grade após falha de rede:** o front reenvia `PRS-13` com a mesma `Idempotency-Key`; a API devolve a resposta original (`Idempotent-Replayed: true`).
- **FA-08 — Pesquisa não editável:** se a `PriceResearch` já foi concluída (documento `FINALIZED`/`APPROVED`) ou está `IN_REVIEW`, os formulários de fonte/cotação ficam somente leitura; a API responde `DOCUMENT_NOT_EDITABLE`.

## Regras de negócio
- **RN-PRICE-21** — Toda `PriceSource` exige `sourceTypeId` (item ativo do catálogo `PRICE_SOURCE_TYPE` do tenant) e `description` (até 300 caracteres); os demais campos (`supplierId`, `quoteDate`, `accessedAt`, `url`, `referenceOrganization`, `referenceDocument`, `supplierChoiceJustification`, anexo) são obrigatórios apenas quando listados em `CatalogItem.metadata.requiredFields` do tipo selecionado; faltando algum → `QUOTATION_REQUIRED_FIELDS` (422).
- **RN-PRICE-22** — Quando `supplierId` é exigido ou informado, deve referenciar um `Supplier` ativo do tenant (US-025); o tipo "pesquisa direta com fornecedores" (art. 23, §1º, IV) exige também `supplierChoiceJustification`.
- **RN-PRICE-23** — `url`, quando informado, deve começar com `https://`; `accessedAt` registra data e hora da consulta ao sítio eletrônico (art. 23, §1º, III) e não pode ser futura.
- **RN-PRICE-24** — O lançamento de preços por fonte (`PRS-13`) é uma grade com uma linha por `PriceItem` da pesquisa: cria, atualiza ou (se a linha vier vazia) não altera a `Quotation` daquele item nessa fonte; `unitPrice` deve ser > 0 com até `unitPriceDecimals` casas (2 ou 4, conforme a pesquisa); `brandModel` é opcional.
- **RN-PRICE-25** — `Quotation` é única por `(priceItemId, priceSourceId)`; a grade (`PRS-13`) e a edição unitária (`PRS-14`) não alteram cotações em status `EXCLUDED` — é preciso restaurá-las primeiro (US-027); tentar alterar retorna `INVALID_STATE`.
- **RN-PRICE-26** — `isExpired` é recalculado a cada gravação de fonte ou cotação: verdadeiro quando a data de referência (`quoteDate` ou `accessedAt`, conforme `ageReference` do tipo) antecede `referenceDate − maxAgeDays` do tipo da fonte; sem `maxAgeDays` definido no tipo, nunca expira. O efeito de `isExpired` nos alertas da pesquisa é detalhado em US-030.
- **RN-PRICE-27** — Qualquer criação, edição ou remoção de fonte/cotação dispara o recálculo das estatísticas do(s) item(ns) afetado(s) (evento `PriceResearchRecalculated`, cálculo detalhado em US-029) e atualiza `PriceResearch.lastCalculatedAt`.
- **RN-PRICE-28** — O anexo de evidência da fonte segue o fluxo de upload de US-068 (`ATT-02`, alvo `PRICE_SOURCE`); é obrigatório quando o tipo exige `'attachment'` em `requiredFields`, e só é aceito após a fonte existir (precisa de um `priceSourceId` como alvo).
- **RN-PRICE-29** — Remover uma `PriceSource` (`PRS-12`) remove em cascata suas `Quotation` (`ON DELETE CASCADE`) e recalcula os itens afetados; a ação não pode ser desfeita (diferente da exclusão justificada de cotação, US-027).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Tipo de fonte | `sourceTypeId` | seleção (catálogo `PRICE_SOURCE_TYPE`) | Sim | item ativo | — |
| Descrição | `description` | texto curto | Sim | até 300 caracteres | — |
| Fornecedor | `supplierId` | busca (US-025) | Condicional (`requiredFields`) | fornecedor ativo do tenant | — |
| Data do orçamento/documento | `quoteDate` | data | Condicional | — | — |
| Data/hora de acesso | `accessedAt` | data e hora | Condicional | não futura | — |
| URL | `url` | url | Condicional | inicia com `https://` | — |
| Órgão de referência | `referenceOrganization` | texto | Condicional | até 250 caracteres | — |
| Documento de referência | `referenceDocument` | texto curto | Condicional | até 120 caracteres | — |
| Justificativa da escolha do fornecedor | `supplierChoiceJustification` | texto longo | Condicional | — | — |
| Anexo | `attachment` | arquivo | Condicional (`requiredFields`) | fluxo US-068 | — |
| Observações | `notes` | texto longo | Não | — | — |
| Preço unitário (por item, na grade) | `unitPrice` | moeda | Sim (por linha preenchida) | > 0; `unitPriceDecimals` casas | — |
| Marca/modelo (por item, na grade) | `brandModel` | texto curto | Não | até 200 caracteres | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Campos obrigatórios do tipo de fonte ausentes | Front + API | "Para este tipo de fonte, informe: {campos}." | `QUOTATION_REQUIRED_FIELDS` |
| V-02 | `sourceTypeId` inativo/inexistente/outro tenant | API | "Selecione um tipo de fonte válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-03 | `supplierId` inexistente/inativo/outro tenant | API | "Selecione um fornecedor válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-04 | `url` sem `https://` | Front + API | "Informe um endereço iniciado por https://." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-05 | `accessedAt`/`quoteDate` no futuro | Front + API | "A data informada não pode ser futura." | `VALIDATION_ERROR` (`DATE_IN_PAST`) |
| V-06 | `unitPrice` ausente, zero/negativo ou com casas além do permitido | Front + API | "Informe um preço válido, maior que zero." | `VALIDATION_ERROR` (`INVALID_DECIMAL`) |
| V-07 | Alterar cotação `EXCLUDED` pela grade/edição unitária | API | "Esta cotação foi desconsiderada. Restaure-a para editar o preço." | `INVALID_STATE` |
| V-08 | Pesquisa não editável (documento não está em `DRAFT`/`RETURNED`) | API | "Esta pesquisa de preços não pode mais ser editada." | `DOCUMENT_NOT_EDITABLE` |
| V-09 | Mesma `Idempotency-Key` com corpo diferente | API | "Esta solicitação já foi enviada com outros dados. Recarregue a página." | `IDEMPOTENCY_KEY_REUSED` |

## Permissões
- **Permissão:** `PRICE_RESEARCH_UPDATE` com escopo que cubra o processo; leitura de fornecedores usa `SUPPLIER_VIEW`.
- **Políticas:** POL-02 (edição do documento — documento `PRICE_RESEARCH` em `DRAFT`/`RETURNED`, custódia/participação e etapa que permite o tipo) e POL-09 (orçamento sigiloso — preços e totais mascarados nas respostas para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`, aplicado pelo serializador central independentemente do endpoint).
- **MFA:** não exigido (`PRICE_RESEARCH_UPDATE` é risco M), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** "Nova fonte" e a grade de preços ficam ocultas/desabilitadas; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `PriceResearchRecalculated` | `price_research.recalculated` | Commit de qualquer criação/edição/remoção de fonte ou cotação | `priceResearchId`, `itemsCount`, `itemsWithAlertsCount` (detalhado em US-029/US-030) |

Projeções síncronas: auditoria por ação (`price_research.source_create`, `source_update`, `source_delete`, `quotation_create`, `quotation_update`, `quotation_delete`).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: edição de rascunho, sem impacto em terceiros até a conclusão (US-032). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Registrar fontes de pesquisa e cotações

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And existe a pesquisa de preços do processo "0012/2026" com 2 itens, em "DRAFT"
    And o usuário "Diego" tem vínculo ativo e "PRICE_RESEARCH_UPDATE" sobre o processo

  Scenario: [Sucesso] Registrar fonte de pesquisa direta e lançar preços
    When "Diego" criar a fonte "Orçamento Construtora XYZ" do tipo "Pesquisa direta com fornecedores" com fornecedor, data e justificativa
    And lançar o preço unitário "150.00" para o item 1 e "80.00" para o item 2
    Then a fonte deve ser criada e as 2 cotações devem ficar "VALID"
    And deve gerar o evento "PriceResearchRecalculated"
    And deve gerar registro de auditoria "price_research.source_create"

  Scenario: [Sucesso] Registrar fonte de sítio eletrônico com data e hora de acesso
    When "Diego" criar a fonte "Painel de Preços" do tipo "Sítio eletrônico especializado" com URL "https://paineldeprecos.planejamento.gov.br" e acesso em "12/09/2026 14:32"
    Then a fonte deve ser criada com "accessedAt" igual a "2026-09-12T14:32:00Z"

  Scenario: [Validação] Fonte sem campo exigido pelo tipo
    When "Diego" tentar salvar uma fonte do tipo "Pesquisa direta com fornecedores" sem informar o fornecedor
    Then a API deve responder 422 com código "QUOTATION_REQUIRED_FIELDS"
    And nenhuma fonte deve ser criada

  Scenario: [Validação] Preço unitário zero ou negativo
    When "Diego" lançar o preço unitário "0" para um item na grade
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_DECIMAL" no campo "unitPrice"
    And a cotação não deve ser gravada

  Scenario: [Permissão] Usuário sem PRICE_RESEARCH_UPDATE
    Given que o usuário "Eva" possui apenas "PROCESS_VIEW"
    When "Eva" enviar POST para criar uma fonte
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And nenhuma fonte deve ser criada

  Scenario: [Tenant incorreto] Referenciar fornecedor de outro tenant
    Given que existe o fornecedor "Fornecedor X" no tenant "Prefeitura B"
    When "Diego", no tenant "Prefeitura de São José", criar uma fonte com "supplierId" do "Fornecedor X"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "supplierId"

  Scenario: [Duplicidade] Reenvio da grade de preços com a mesma chave de idempotência
    Given que "Diego" enviou a grade de preços com a chave "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o cabeçalho "Idempotent-Replayed: true"
    And nenhuma cotação duplicada deve ser criada

  Scenario: [Concorrência] Duas edições simultâneas da mesma fonte
    Given que a fonte "Orçamento Construtora XYZ" está na versão 2
    When dois usuários enviarem "PRS-13" simultaneamente com cabeçalho "If-Match" igual a "2"
    Then apenas um deve receber 200 e versão 3
    And o outro deve receber 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível ao salvar a grade de preços
    Given que o banco de dados fica indisponível durante a gravação
    When "Diego" salvar a grade de preços
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma cotação da grade deve ser persistida

  Scenario: [Falha de integração] Upload do anexo da fonte falha
    Given que o serviço de armazenamento de anexos está indisponível
    When "Diego" tentar enviar o anexo obrigatório da fonte "Orçamento Construtora XYZ"
    Then a fonte deve permanecer salva sem o anexo
    And o sistema deve exibir "Não foi possível enviar o anexo agora. Tente novamente." mantendo a fonte editável
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Campo exigido pelo tipo ausente | 422 | `QUOTATION_REQUIRED_FIELDS` | "Para este tipo de fonte, informe: {campos}." | Destaca os campos exigidos |
| Referência inexistente/inativa/outro tenant | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | "Selecione um {campo} válido." | Recarrega opções |
| Preço inválido | 422 | `VALIDATION_ERROR` (`INVALID_DECIMAL`) | "Informe um preço válido, maior que zero." | Marca a célula na grade |
| Cotação desconsiderada | 409 | `INVALID_STATE` | "Esta cotação foi desconsiderada. Restaure-a para editar o preço." | Oferece link para restaurar (US-027) |
| Documento não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "Esta pesquisa de preços não pode mais ser editada." | Grade em somente leitura |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Esta fonte foi alterada por outra pessoa. Recarregue os dados." | Recarrega a fonte/grade |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para editar esta pesquisa de preços." | Oculta ações de escrita |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Mantém dados preenchidos |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Mantém dados; botão copiar código |

## Dependências
- **Stories:** US-024 (pesquisa e itens já existem), US-025 (fornecedores cadastrados), US-068 (upload de anexos — intenção/confirmação/varredura). US-029 (cálculo das estatísticas) e US-030 (outliers/alertas) consomem o resultado desta story.
- **Decisões/ADRs:** DEC-003 (decimais e `decimal.js`), DEC-010, DEC-017, DEC-020, DEC-030.
- **Configurações:** `priceResearch.unitPriceDecimals`, `priceResearch.directQuoteMaxAgeDays`, `priceResearch.similarContractMaxAgeDays`.
- **Lacunas nas fontes canônicas:** nenhuma.

## Impacto técnico
- A grade de preços (`PRS-13`, `PUT`) é um "upsert em lote": o handler precisa diferenciar linha ausente (não altera) de linha com preço (cria/atualiza) sem apagar cotações `EXCLUDED` por engano — tratar com cuidado na implementação do repositório.
- `CatalogItem.metadata.requiredFields` é lido em tempo de validação (não há cópia por fonte): mudanças no catálogo após a fonte criada não retroagem sobre fontes já salvas.
- Cálculos monetários desta story (apenas gravação, sem agregação) ainda devem usar `decimal.js` para evitar arredondamento incorreto antes de persistir.
- Volume esperado por pesquisa: dezenas de fontes × itens; a grade deve suportar atualização parcial sem round-trip de todas as linhas a cada tecla (debounce no front, envio único ao "Salvar").

## Backend
- **Módulo(s):** `price-research` (dono); usa `supplier` (`SupplierFacade.assertActive`), `catalog` (`CatalogFacade.assertActive`, leitura de `requiredFields`), `attachment`/`document` (upload, US-068), `access`, `audit`, `platform` (`OutboxWriter`).
- **Casos de uso:** `CreatePriceSourceCommand`/`Handler`, `UpdatePriceSourceCommand`/`Handler`, `DeletePriceSourceCommand`/`Handler`, `UpsertQuotationsCommand`/`Handler` (grade), `UpdateQuotationCommand`/`Handler`, `DeleteQuotationCommand`/`Handler`.
- **Domínio:** `PriceSource.create/update(props)` (valida `requiredFields` do tipo); `Quotation.upsertPrice(unitPrice, brandModel)`; `Quotation.computeExpiration(referenceDate, sourceType)`.
- **Integrações internas:** `PriceResearchFacade.recalculate(priceItemId)` (lógica detalhada em US-029) chamado ao final de cada transação desta story.
- **Transação:** criação/edição de fonte e upsert da grade cada em transação única com `app.tenant_id`; grava entidade(s), auditoria e outbox.

## Frontend
- **Tela(s):** SCR-009 (`/processos/[id]/pesquisa-precos/[researchId]`), aba "Fontes".
- **Componentes:** `PriceSourceList`, `PriceSourceForm` (campos condicionais por `requiredFields`, React Hook Form + Zod dinâmico), `SupplierCombobox` (US-025), `AttachmentUploader` (US-068), `QuotationGrid` (uma linha por item, edição inline com debounce e salvamento em lote).
- **Estados:** skeleton na lista/grade; vazio ("Nenhuma fonte registrada ainda"); erro com "Tentar novamente"; células com cotação `EXCLUDED` em somente leitura com tooltip do motivo.
- **Acessibilidade e responsividade:** grade navegável por teclado (setas entre células); rótulos condicionais anunciados ao trocar o tipo de fonte; em telas estreitas a grade rola horizontalmente com a coluna "Item" fixa.

## Banco de dados
- **Tabelas:** `price_sources`, `quotations`.
- **Migrações:** criação conforme entities.md (`price_sources` Padrão + SD; `quotations` Padrão).
- **Índices/constraints relevantes:** `(tenant_id, price_research_id)` e `(tenant_id, supplier_id)` em `price_sources`; `UNIQUE (tenant_id, price_item_id, price_source_id)` e `CHECK (status <> 'EXCLUDED' OR (exclusion_reason IS NOT NULL AND exclusion_justification IS NOT NULL))` em `quotations`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRS-09 | GET | `/api/v1/price-research/{id}/sources` | — | `200 { data: [PriceSource], meta }` | 200, 403, 404 |
| PRS-10 | POST | `/api/v1/price-research/{id}/sources` | `{ sourceTypeId, description, supplierId?, quoteDate?, accessedAt?, url?, referenceOrganization?, referenceDocument?, supplierChoiceJustification?, notes? }` + `Idempotency-Key` | `201 { data: PriceSource }` | 201, 403, 404, 422 |
| PRS-11 | PATCH | `/api/v1/price-sources/{sourceId}` | campos editáveis + `If-Match` | `200 { data: PriceSource }` | 200, 403, 404, 412, 422 |
| PRS-12 | DELETE | `/api/v1/price-sources/{sourceId}` | `If-Match` | `204` | 204, 403, 404, 412 |
| PRS-13 | PUT | `/api/v1/price-sources/{sourceId}/quotations` | `{ items: [{ priceItemId, unitPrice, brandModel? }] }` + `If-Match` (versão da fonte) | `200 { data: [Quotation] }` | 200, 403, 404, 412, 422 |
| PRS-14 | PATCH | `/api/v1/quotations/{quotationId}` | `{ unitPrice?, brandModel? }` + `If-Match` | `200 { data: Quotation }` | 200, 403, 404, 409, 412, 422 |
| PRS-15 | DELETE | `/api/v1/quotations/{quotationId}` | `If-Match` | `204` | 204, 403, 404, 412 |
| ATT-02 | POST | `/api/v1/attachments` | intenção de upload, alvo `PRICE_SOURCE` (US-068) | `201 { data: Attachment }` | 201, 403, 404, 413, 415 |

## Logs
- `info` `price_research.source_created` — `priceSourceId`, `sourceTypeId`, `priceResearchId`, `correlationId`.
- `info` `price_research.quotations_upserted` — `priceSourceId`, quantidade de linhas criadas/atualizadas.
- `warn` `price_research.required_field_missing` — tipo e campo faltante (sem valores sensíveis).
- `error` `price_research.source_save_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** preços, descrição da fonte, URL completa, justificativa de escolha do fornecedor.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `price_research.source_create` | `DATA_CHANGE` | Commit da criação da fonte | `metadata`: `sourceTypeId` |
| `price_research.source_update` | `DATA_CHANGE` | Commit da edição | `changes`: campos alterados |
| `price_research.source_delete` | `DATA_CHANGE` | Remoção da fonte | `metadata`: quantidade de cotações removidas |
| `price_research.quotation_create` / `quotation_update` | `DATA_CHANGE` | Commit da grade/edição unitária | `metadata`: `priceItemId`, `priceSourceId` |
| `price_research.quotation_delete` | `DATA_CHANGE` | Remoção unitária | `metadata`: `priceItemId`, `priceSourceId` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = PRICE_RESEARCH_UPDATE` |

## Testes necessários
- **Unitários:** validação de `requiredFields` por tipo; cálculo de `isExpired`; upsert da grade (linha vazia não altera; `EXCLUDED` não é sobrescrita).
- **Integração (Testcontainers PostgreSQL + Redis):** cascade delete de fonte → cotações; unicidade `(price_item_id, price_source_id)`; RLS entre tenants; outbox gravado na mesma transação.
- **API/contrato:** respostas e erros conforme api.md; `ETag`/`If-Match` em todos os endpoints de escrita.
- **RBAC e multi-tenant:** `PRICE_RESEARCH_UPDATE` por escopo; `supplierId`/`sourceTypeId` de outro tenant → `REFERENCE_NOT_FOUND`.
- **Concorrência:** duas gravações simultâneas da grade com o mesmo `If-Match` → uma 200, outra 412.
- **E2E (Playwright):** criar fonte de cada tipo relevante, lançar preços na grade, editar e remover fonte/cotação.
- **Acessibilidade/performance:** axe na grade; grade com 50 itens × 10 fontes sem degradação perceptível.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `PRICE_RESEARCH_UPDATE` e POL-02 aplicados na API; UI oculta/desabilita conforme permissão e estado do documento
- [ ] `requiredFields` por tipo de fonte validados em teste para todos os tipos semeados
- [ ] Auditoria e evento `PriceResearchRecalculated` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de PRS-09..15 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas de latência da grade
- [ ] Acessibilidade (axe) e responsividade (360 px) verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**L** — maior superfície do épico: formulário dinâmico por tipo de fonte, grade de preços em lote, integração com anexos (US-068) e fornecedores (US-025), e disparo de recálculo consumido por duas outras stories (US-029/US-030).

## Prioridade
**P0** — sem fontes e cotações não há dados para calcular o valor estimado nem para concluir a pesquisa de preços.
