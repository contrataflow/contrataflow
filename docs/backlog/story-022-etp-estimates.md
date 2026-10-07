---
id: US-022
title: "Estimar quantidades e vincular valor à pesquisa de preços"
epic: EP-003
feature: FT-013
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-019, US-029]
modules: [etp, document, price-research]
screens: [SCR-008]
endpoints: [ETP-04, DOC-06, DOC-07, PRS-01, PRS-03]
permissions: [ETP_UPDATE]
events: []
---

# US-022 — Estimar quantidades e vincular valor à pesquisa de preços

## Título
Estimar quantidades e vincular valor à pesquisa de preços

## Descrição
**Como** redator do ETP (área requisitante ou Planejamento), **quero** ajustar a quantidade de cada item com sua memória de cálculo e definir o valor estimado total — manualmente ou vinculado à pesquisa de preços do processo —, **para** fundamentar a estimativa de quantitativos e de valor exigida pelo art. 18, §1º, IV e VI, da Lei 14.133/2021.

Na seção "Estimativas" do editor do ETP (SCR-008), o usuário revisa os itens herdados do DFD (US-019), ajusta a quantidade e registra a memória de cálculo de cada um, e escolhe a origem do valor estimado total: informado manualmente ou vinculado à pesquisa de preços do processo (US-024/US-029). Quando vinculado, o valor fica somente leitura e se mantém sincronizado automaticamente a cada recálculo ou conclusão da pesquisa.

## Contexto
- A IN SEGES/ME 58/2022 exige, nos incisos IV e VI do art. 18, §1º, a estimativa das quantidades com memória de cálculo e a estimativa do valor da contratação; ambos compõem, no template semeado, a seção `ESTIMATES` (`REQUIRED` — DEC-016).
- `DocumentItem` é a linha do item **no ETP** (quantidade, memória de cálculo); `ProcessItem` é a identidade do item no processo; `PriceItem` é a linha do item **na pesquisa de preços** (DEC-019) — a mesma identidade de item atravessa os três sem duplicar o conceito.
- `PriceResearch` é única e não cancelada por processo (DEC-020); suas estatísticas por item e o valor total (`totalEstimatedValue`) são calculados em US-029 e atualizados a cada recálculo (`PriceResearchRecalculated`) ou na conclusão (`PriceResearchCompleted`; DEC-018 — concluir a pesquisa é finalizar o documento).
- `Etp.estimatedTotalValue`/`estimatedValueSource`/`priceResearchId` são campos do cabeçalho tipado (DEC-017), distintos de `Process.estimatedValue` (DEC-032, que tem precedência própria entre fontes).
- Valores são mascarados para quem não atende à POL-09 quando o orçamento do processo é sigiloso.

## Objetivo
Ao final da elaboração do ETP, 100% dos itens têm quantidade informada e todo ETP tem um valor estimado total definido (manual ou vinculado), sem necessidade de reentrada de dados quando a pesquisa de preços for recalculada ou concluída.

## Persona
- **Principal:** Redator do ETP com custódia do processo (perfil `REQUISITANTE` ou `PLANEJAMENTO`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`), que acompanha o valor consolidado.

## Pré-condições
- ETP criado (US-019), em status `DRAFT` ou `RETURNED`, com itens importados do DFD.
- Para vincular à pesquisa: existe `PriceResearch` não cancelada no processo (US-024), idealmente com estatísticas já calculadas (US-029).
- Usuário com `ETP_UPDATE` e custódia/participação (POL-02).

## Fluxo principal
1. O usuário abre o ETP (SCR-008) e seleciona a seção "Estimativas" na navegação lateral (US-020).
2. O sistema carrega os itens do ETP (`DOC-06`) — herdados do DFD, com memória de cálculo em branco na primeira vez — e o estado atual do valor estimado.
3. Para cada item, o usuário ajusta a **Quantidade** e escreve a **Memória de cálculo**; ao salvar, o front envia a coleção completa via `DOC-07` com `If-Match` da versão atual do documento.
4. No painel "Valor estimado", o usuário escolhe **Valor manual** (digita o total) ou **Vincular à pesquisa de preços** (seleciona a pesquisa do processo, listada por `PRS-01`).
5. O front envia `PATCH /etps/{id}` (`ETP-04`) com `estimatedValueSource`, `estimatedTotalValue` e/ou `priceResearchId`, e `If-Match`.
6. Se vinculado, a API copia `PriceResearch.totalEstimatedValue` (lido via `PRS-03`) para `Etp.estimatedTotalValue`; o campo passa a somente leitura, com link "Ver pesquisa de preços".
7. A partir daí, sempre que a pesquisa vinculada recalcular ou concluir, um consumidor assíncrono atualiza `Etp.estimatedTotalValue`; a tela reflete o novo valor ao revalidar a consulta.
8. O sistema indica "Salvo às HH:mm" (padrão de autosave do editor — DEC-182); valores aparecem mascarados para quem não atende POL-09.

## Fluxos alternativos
- **FA-01 — Trocar de manual para pesquisa de preços:** o valor manual é descartado e substituído pelo valor calculado da pesquisa; o campo fica somente leitura.
- **FA-02 — Trocar de pesquisa de preços para manual:** o último valor copiado é preservado como ponto de partida editável.
- **FA-03 — Pesquisa vinculada ainda sem cálculo:** exibe "Aguardando cálculo da pesquisa de preços" e trata o valor como ausente até a primeira estatística.
- **FA-04 — Pesquisa vinculada é cancelada:** o vínculo é desfeito automaticamente (`priceResearchId` e `estimatedValueSource` voltam a nulo); o último valor fica preservado como referência e a seção sinaliza "Valor desatualizado — escolha a origem novamente".
- **FA-05 — Orçamento sigiloso:** quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` nem custódia vê o valor mascarado (`estimatedTotalValueMasked: true`); a edição continua restrita pela POL-02 normal.
- **FA-06 — Memória de cálculo extensa:** acima de 1 MB (DEC-056), o editor bloqueia novos caracteres e orienta a resumir ou anexar planilha de apoio.

## Regras de negócio
- **RN-ETP-25** — Os itens do ETP (`DocumentItem`) espelham os `ProcessItem` do processo (DEC-019); adicionar/remover um item usa `DOC-07` e respeita `ITEM_IN_USE` quando o item já estiver referenciado na pesquisa de preços.
- **RN-ETP-26** — `quantity` é obrigatório, decimal(18,4), maior que zero.
- **RN-ETP-27** — `calculationMemo` é rich text opcional por item (limite de 1 MB — DEC-056), recomendado sempre que a quantidade resultar de cálculo (art. 18, §1º, IV).
- **RN-ETP-28** — `estimatedValueSource` é `MANUAL` ou `PRICE_RESEARCH`. `MANUAL` exige `estimatedTotalValue` ≥ 0 com 2 casas; `PRICE_RESEARCH` exige `priceResearchId` de uma pesquisa não cancelada do mesmo processo (DEC-020), e o valor passa a ser derivado (somente leitura).
- **RN-ETP-29** — Quando vinculado, `estimatedTotalValue` é recalculado automaticamente ao evento `PriceResearchRecalculated` ou `PriceResearchCompleted` da pesquisa vinculada; processamento idempotente por `priceResearchId` + `lastCalculatedAt`.
- **RN-ETP-30** — Itens e valor só são editáveis com o ETP em `DRAFT`/`RETURNED` (POL-02); fora disso, somente leitura.
- **RN-ETP-31** — Se a pesquisa vinculada for cancelada, o vínculo é desfeito automaticamente preservando o último valor (FA-04) — comportamento não detalhado nas fontes canônicas; ver "Dependências → Lacunas".
- **RN-ETP-32** — `estimatedTotalValue` é mascarado conforme POL-09 nas mesmas condições de `EtpAlternative.estimatedCost`.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Quantidade (por item) | `quantity` | decimal | Sim | > 0; 4 casas (RN-ETP-26) | quantidade importada do DFD |
| Memória de cálculo (por item) | `calculationMemo` | rich text | Não | até 1 MB (RN-ETP-27) | vazio |
| Origem do valor estimado | `estimatedValueSource` | seleção (`MANUAL`\|`PRICE_RESEARCH`) | Sim, para definir valor | RN-ETP-28 | — |
| Valor estimado total | `estimatedTotalValue` | moeda (BRL) | Condicional (`MANUAL`) | ≥ 0; 2 casas; somente leitura se `PRICE_RESEARCH` | cópia da pesquisa |
| Pesquisa de preços vinculada | `priceResearchId` | seleção (pesquisa do processo) | Condicional (`PRICE_RESEARCH`) | não cancelada; mesmo processo | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `quantity` ausente, zero ou negativa | Front + API | "Informe uma quantidade maior que zero." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-02 | `quantity` com mais de 4 casas | Front + API | "Use no máximo 4 casas decimais." | `VALIDATION_ERROR` (`INVALID_DECIMAL`) |
| V-03 | `calculationMemo` fora do schema ou acima de 1 MB | API | "O conteúdo da memória de cálculo é inválido ou excede o limite." | `RICH_TEXT_INVALID` / `PAYLOAD_TOO_LARGE` |
| V-04 | `estimatedValueSource` ausente ao tentar salvar valor | Front + API | "Escolha como o valor estimado será definido." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-05 | `estimatedTotalValue` negativo ou com mais de 2 casas (`MANUAL`) | Front + API | "Informe um valor válido, com até 2 casas decimais." | `VALIDATION_ERROR` (`INVALID_DECIMAL`) |
| V-06 | `priceResearchId` inexistente, cancelada ou de outro processo/tenant | API | "Selecione uma pesquisa de preços válida deste processo." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-07 | Edição com ETP fora de `DRAFT`/`RETURNED` | API | "Este ETP não pode ser editado no momento." | `DOCUMENT_NOT_EDITABLE` |
| V-08 | `If-Match` ausente ou divergente | API | "Os dados foram alterados por outra pessoa." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |

## Permissões
- **Permissão:** `ETP_UPDATE` (inclui alternativas e estimativas), com custódia ou participação `COLLABORATOR`/`CONSULTANT` (POL-02).
- **Políticas:** POL-02 (edição); POL-09 (mascaramento de valores sigilosos).
- **MFA:** não exigido (risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** campos somente leitura na tela; API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Este caso de uso não emite evento de domínio próprio. |

Consome, de forma assíncrona e idempotente, `PriceResearchRecalculated` (`price_research.recalculated`) e `PriceResearchCompleted` (`document.finalized.price_research`) para manter `estimatedTotalValue` sincronizado (RN-ETP-29).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: a atualização do valor é refletida na tela; não há tipo de notificação dedicado no catálogo atual. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Estimar quantidades e vincular valor à pesquisa de preços

  Background:
    Given que o usuário está autenticado no tenant "Prefeitura de São José"
    And possui vínculo ativo
    And existe o ETP "0007/2026" do processo "0012/2026" em status "DRAFT", importado do DFD, com os itens "1 - Cimento CP-II (saco 50kg)" e "2 - Areia média (m³)"

  Scenario: [Sucesso] Informar quantidade e memória de cálculo de um item
    Given que "Ana" tem o perfil "PLANEJAMENTO" com custódia do processo
    When "Ana" informar a quantidade "500" para o item "1" e escrever a memória de cálculo "Consumo médio mensal (50) × 10 meses de obra"
    And salvar
    Then o item "1" do ETP deve ter quantidade "500,0000"
    And deve gerar registro de auditoria "document.items_update"

  Scenario: [Sucesso] Vincular o valor estimado à pesquisa de preços concluída
    Given que a pesquisa de preços "0003/2026" do processo está concluída com valor total estimado "R$ 125.000,00"
    When "Ana" escolher "Vincular à pesquisa de preços" e selecionar "0003/2026"
    Then o ETP deve ter "estimatedValueSource" igual a "PRICE_RESEARCH" e "priceResearchId" da pesquisa "0003/2026"
    And o valor estimado do ETP deve ser "R$ 125.000,00" e o campo deve ficar somente leitura

  Scenario: [Validação] Quantidade zerada ou negativa
    When "Ana" informar a quantidade "0" para o item "2"
    Then o sistema deve exibir "Informe uma quantidade maior que zero."
    And a API deve responder 422 com código "VALIDATION_ERROR" e erro "OUT_OF_RANGE" no campo "quantity"

  Scenario: [Validação] Valor sem origem definida
    When "Ana" tentar salvar o valor estimado sem escolher "Valor manual" ou "Vincular à pesquisa de preços"
    Then o sistema deve exibir "Escolha como o valor estimado será definido."
    And a API deve responder 422 com código "VALIDATION_ERROR" e erro "REQUIRED" no campo "estimatedValueSource"

  Scenario: [Permissão] Usuário sem ETP_UPDATE
    Given que "Bruno" possui apenas "PROCESS_VIEW"
    When "Bruno" abrir o ETP
    Then os campos de itens e valor devem ser somente leitura na tela
    When "Bruno" enviar PUT para os itens do documento
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Vincular pesquisa de preços de outro tenant
    Given que existe a pesquisa de preços "0009/2026" no tenant "Prefeitura B"
    When "Ana", no tenant "Prefeitura de São José", enviar "priceResearchId" da pesquisa "0009/2026"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "priceResearchId"
    And a resposta não deve revelar que a pesquisa existe em outro tenant

  Scenario: [Duplicidade] Reentrega do evento de recálculo da pesquisa
    Given que o ETP está vinculado à pesquisa "0003/2026" com valor "R$ 125.000,00"
    When o evento "PriceResearchRecalculated" da pesquisa "0003/2026" for entregue duas vezes pela fila
    Then o valor estimado do ETP deve ser atualizado uma única vez
    And nenhum registro de auditoria duplicado deve ser criado

  Scenario: [Concorrência] Duas edições simultâneas dos itens
    Given que "Ana" e "Carlos" abriram o ETP na versão "3"
    When "Ana" salvar os itens e, em seguida, "Carlos" salvar com "If-Match" da versão "3"
    Then a API deve responder 412 com código "VERSION_CONFLICT" para "Carlos"
    And a tela de "Carlos" deve oferecer "Ver diferenças" e "Recarregar"

  Scenario: [Falha de banco] Banco indisponível ao salvar os itens
    Given que o banco de dados fica indisponível durante o PUT dos itens
    When "Ana" salvar a quantidade do item "1"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a quantidade anterior do item deve permanecer inalterada

  Scenario: [Falha de integração] Relay do outbox indisponível ao recalcular a pesquisa
    Given que o relay do outbox está indisponível quando a pesquisa "0003/2026" é recalculada
    When a pesquisa for recalculada
    Then o evento "PriceResearchRecalculated" deve permanecer "PENDING" no outbox
    And quando o relay voltar o valor do ETP vinculado deve ser atualizado
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Quantidade inválida | 422 | `VALIDATION_ERROR` (`OUT_OF_RANGE`/`INVALID_DECIMAL`) | "Informe uma quantidade maior que zero." | Marca o campo; foca a linha |
| Memória de cálculo inválida/grande | 422/413 | `RICH_TEXT_INVALID` / `PAYLOAD_TOO_LARGE` | "Reduza o conteúdo da memória de cálculo." | Bloqueia novos caracteres |
| Pesquisa inexistente/cancelada/outro tenant | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | "Selecione uma pesquisa de preços válida." | Recarrega a lista de pesquisas |
| Documento não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "Este ETP não pode ser editado no momento." | Campos tornam-se somente leitura |
| `If-Match` ausente/divergente | 428/412 | `PRECONDITION_REQUIRED`/`VERSION_CONFLICT` | "Os dados foram alterados por outra pessoa." | Oferece "Ver diferenças"/"Recarregar" |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para editar este ETP." | Campos somente leitura |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Mantém os dados digitados |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão para copiar o código |

## Dependências
- **Stories:** US-019 (cria o ETP e importa os itens do DFD), US-029 (calcula o valor recomendado por item na pesquisa de preços), US-024 (cria a pesquisa de preços do processo). Indiretas: US-014 (origem dos itens no DFD), US-032 (conclusão da pesquisa), US-065 (ciclo de vida do documento).
- **Decisões/ADRs:** DEC-016, DEC-017, DEC-018, DEC-019, DEC-020, DEC-032, DEC-056.
- **Configurações:** nenhuma específica a este card.
- **Lacunas nas fontes canônicas:** (1) não há ação de auditoria específica para a atualização dos campos tipados do cabeçalho do ETP (`estimatedValueSource`/`estimatedTotalValue`/`priceResearchId`) no catálogo (events.md §7); usamos `document.draft_update` como conceito mais próximo. (2) o comportamento do vínculo quando a pesquisa referenciada é cancelada (RN-ETP-31) não está definido nas fontes canônicas; assumimos desvínculo automático com preservação do último valor calculado.

## Impacto técnico
- Não requer migração: reaproveita campos já modelados em `etps` e `document_items` (entities.md).
- Introduz um consumidor assíncrono (`price-research` → `etp`) que deve ser idempotente e tolerante a reentrega, seguindo o padrão já adotado por outros consumidores do outbox (dedup por evento).
- `DOC-07` substitui a coleção inteira de itens por requisição; a implementação deve preservar `sortOrder` e ids existentes para não perder `calculationMemo` já salvo.

## Backend
- **Módulo(s):** `etp` (dono do cabeçalho); `document` (coleção de itens, compartilhada com DFD/TR); consulta a fachada de `price-research`.
- **Casos de uso:** `UpdateDocumentItemsCommand` (reaproveitado de US-014) → `UpdateDocumentItemsHandler`; `UpdateEtpEstimateCommand` → `UpdateEtpEstimateHandler`; listener de `PriceResearchRecalculated`/`PriceResearchCompleted` → `SyncEtpEstimatedValueHandler`.
- **Domínio:** `Etp.setEstimate(source, value | priceResearchId)` (RN-ETP-28); `DocumentItem.updateQuantityAndMemo(...)`.
- **Integrações internas:** `price-research` (consulta ao valor total atual da pesquisa).
- **Transação:** os passos 3 e 5 do fluxo principal ocorrem em transações independentes (coleção de itens / cabeçalho), ambas com `app.tenant_id` e verificação de `If-Match`.

## Frontend
- **Tela(s):** SCR-008 (`/processos/[id]/etp/[etpId]`), seção "Estimativas".
- **Componentes:** `ItemsEstimateTable` (quantidade + editor rich text de memória de cálculo por linha), `EstimatedValuePanel` (alternância manual/pesquisa), `MoneyInput`, `PriceResearchSelect`, `ConfidentialValue`.
- **Estados:** skeleton ao carregar itens/valor; vazio ("Nenhum item herdado do DFD"); erro com "Tentar novamente"; "Salvando…/Salvo às HH:mm" (DEC-182); somente leitura quando vinculado à pesquisa.
- **Acessibilidade e responsividade:** tabela de itens com rótulos associados e navegação por teclado; painel de valor com `aria-live` ao atualizar automaticamente; em telas < 768 px, itens em cartões empilhados.

## Banco de dados
- **Tabelas:** `document_items` (escrita), `etps` (escrita dos campos de valor), `price_research` (leitura).
- **Migrações:** nenhuma — campos já existentes (entities.md).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, document_id, process_item_id)` em `document_items`; `UNIQUE (tenant_id, document_id)` em `etps`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| DOC-07 | PUT | `/documents/{id}/items` | `{ items: [{ processItemId, quantity, calculationMemo? }] }` + `If-Match` | `200 { data: DocumentItem[] }` | 200, 403, 409, 412, 422 |
| ETP-04 | PATCH | `/etps/{id}` | `{ estimatedValueSource, estimatedTotalValue?, priceResearchId? }` + `If-Match` | `200 { data: Etp }` com `estimatedTotalValue`, `estimatedTotalValueMasked` | 200, 403, 409, 412, 422 |
| PRS-01 | GET | `/processes/{id}/price-research` | — | `200 { data: PriceResearch[] }` | 200, 403 |
| PRS-03 | GET | `/price-research/{id}` | — | `200 { data: PriceResearch }` com `totalEstimatedValue`, `totalEstimatedValueMasked` | 200, 403, 404 |

## Logs
- `info` `document.items_updated` — `documentId`, `itemsCount`, `durationMs`.
- `info` `etp.estimate_synced` — `etpId`, `priceResearchId`, `trigger` (`recalculated`\|`completed`).
- `warn` `etp.estimate_sync_retry` — reentrega de evento tratada sem duplicar efeito.
- `error` `etp.estimate_sync_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** quantidades, memórias de cálculo, valores estimados.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.items_update` | `DATA_CHANGE` | Salvar itens | `changes`: quantidades alteradas (memória registrada como hash + tamanho) |
| `document.draft_update` | `DATA_CHANGE` | Alterar origem/valor/pesquisa vinculada | `metadata`: `estimatedValueSource`, `priceResearchId` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = ETP_UPDATE` |

## Testes necessários
- **Unitários:** `Etp.setEstimate` (RN-ETP-28/29); validação de quantidade e decimais; cópia e desvínculo de valor.
- **Integração (Testcontainers):** listener idempotente ao reentregar `PriceResearchRecalculated`; RLS entre tenants no vínculo de pesquisa.
- **API/contrato:** `DOC-07`/`ETP-04` conforme api.md; mascaramento POL-09 nas respostas.
- **RBAC e multi-tenant:** `ETP_UPDATE` com e sem custódia; pesquisa de outro tenant → `REFERENCE_NOT_FOUND`.
- **Concorrência:** duas edições simultâneas de itens → `VERSION_CONFLICT`.
- **E2E (Playwright):** editar itens, vincular pesquisa, trocar para manual e vice-versa.
- **Acessibilidade/performance:** axe na seção "Estimativas"; sincronização refletida em até 5 s após o evento em ambiente de teste.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] `ETP_UPDATE` e POL-02/POL-09 aplicados na API; UI oculta edição sem permissão
- [ ] Listener de recálculo idempotente testado com reentrega
- [ ] Auditoria `document.items_update`/`document.draft_update` verificada em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de DOC-07/ETP-04 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — reaproveita campos e padrões já estabelecidos (itens do documento, cabeçalho tipado); a complexidade está na sincronização assíncrona com a pesquisa de preços.

## Prioridade
**P0** — sem quantidade e valor estimado o ETP não pode ser concluído como viável (US-023), bloqueando toda a fase preparatória.
