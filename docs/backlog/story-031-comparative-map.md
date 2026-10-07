---
id: US-031
title: "Visualizar e exportar o mapa comparativo"
epic: EP-004
feature: FT-019
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-029, US-067]
modules: [price-research, document]
screens: [SCR-010]
endpoints: [PRS-21, PRS-22, DOC-20, DOC-21, DOC-22, DOC-23]
permissions: [PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: []
---

# US-031 — Visualizar e exportar o mapa comparativo

## Título
Visualizar e exportar o mapa comparativo

## Descrição
**Como** integrante da equipe de planejamento da contratação, **quero** ver todos os itens e todas as fontes da pesquisa lado a lado, com os preços cotados e os indicadores de estatística/alerta, **para** avaliar a pesquisa como um todo antes de concluí-la e anexar essa evidência ao processo em XLSX ou PDF.

O mapa comparativo é uma matriz itens × fontes: cada linha é um `PriceItem`, cada coluna uma `PriceSource`, e cada célula o `unitPrice` da `Quotation` daquele item naquela fonte (com seus selos de status/outlier/vencimento), encerrando com as estatísticas e o valor recomendado de cada item. A tela permite exportar a matriz em XLSX (síncrono) ou solicitar o PDF do documento da pesquisa, cujo template inclui a seção `PRICE_SUMMARY` com o mesmo conteúdo.

## Contexto
- A Lei 14.133/2021 exige que a pesquisa de preços fique documentada e anexável ao processo; o mapa comparativo é o artefato clássico de auditoria — mostra de forma auditável de onde vem cada preço usado no cálculo.
- Hoje esse mapa é montado manualmente em planilha, copiando valores de orçamentos e do Painel de Preços; qualquer cotação excluída (US-027) ou corrigida exige remontar a planilha inteira.
- Reaproveita as estatísticas e os alertas calculados em US-029/US-030; a exportação em PDF reaproveita o pipeline geral de renderização de documentos (US-067, worker `document-render`) — o mapa comparativo em PDF **é** a renderização do documento `PRICE_RESEARCH`, não um artefato novo.
- Processos com `isBudgetConfidential = true` exigem mascaramento também na exportação (DEC-030) — o mapa não pode ser uma forma de contornar o sigilo do orçamento.

## Objetivo
Permitir que qualquer usuário com visibilidade sobre o processo veja o mapa comparativo completo em até 2 segundos e exporte uma pesquisa de até 500 itens × 50 fontes em XLSX de forma síncrona, com 100% dos valores sigilosos mascarados quando aplicável, tanto na tela quanto nos arquivos exportados.

## Persona
- **Principal:** Equipe de planejamento da contratação (perfil `PLANEJAMENTO`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`), Autoridade competente (`AUTORIDADE`), Controle interno — consultam o mapa como evidência.

## Pré-condições
- Pesquisa de preços com ao menos um item e uma fonte cadastrados (US-024, US-026).
- Estatísticas calculadas conforme US-029 (podem estar parcialmente vazias se não houver cotação ainda).
- Usuário com `PROCESS_VIEW` sobre o processo (DEC-024); `PROCESS_VIEW_CONFIDENTIAL_BUDGET` ou custódia atual quando `isBudgetConfidential = true`.

## Fluxo principal
1. O usuário abre a pesquisa (SCR-009) e clica em "Ver mapa comparativo"; o sistema navega para SCR-010 (`/processos/[id]/pesquisa-precos/[researchId]/mapa`).
2. O front chama `PRS-21` e recebe a matriz: itens (linhas, com `sortOrder`), fontes (colunas, com `sortOrder`), células (`unitPrice`, `status`, `outlierFlag`, `isExpired` por cruzamento item × fonte) e, por item, as estatísticas e `alerts` de US-029/US-030.
3. A tela renderiza a matriz com rolagem sincronizada (cabeçalho de fontes fixo), aplicando mascaramento de valores (POL-09) quando o usuário não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` nem custódia atual.
4. Para exportar:
   - **XLSX:** o usuário clica em "Exportar XLSX"; o front chama `PRS-22` (síncrono); a API monta a planilha (uma aba com a matriz, mascarando valores quando aplicável) e responde com o arquivo; o browser baixa o arquivo; é registrada a auditoria `price_research.export`.
   - **PDF:** o usuário clica em "Gerar PDF"; o front solicita a renderização do documento da pesquisa (`DOC-20`/`DOC-21`, 202) e consulta o status (`DOC-22`) até `READY`, então baixa (`DOC-23`); o PDF inclui a seção `PRICE_SUMMARY` do template com a mesma matriz.
5. Em ambos os casos, o conteúdo exportado reflete o estado calculado no momento da exportação (não é um snapshot separado — ver RN-PRICE-57).

## Fluxos alternativos
- **FA-01 — Pesquisa maior que o limite síncrono:** acima de 500 itens ou 50 fontes, `PRS-22` responde `422 EXPORT_TOO_LARGE`; a tela sugere reduzir o recorte (ex.: exportar por lote de itens) ou usar o PDF.
- **FA-02 — Falha ao gerar o PDF:** o worker `document-render` publica `DocumentRenditionFailed` (US-067); a tela exibe "Não foi possível gerar o PDF agora" com "Tentar novamente"; a exportação XLSX continua disponível normalmente (caminhos independentes).
- **FA-03 — Orçamento sigiloso:** usuário sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` e sem custódia atual vê `null`/"Sigiloso" em toda célula monetária, nas estatísticas e nos totais — na tela, no XLSX e no PDF.
- **FA-04 — Pesquisa sem nenhuma fonte cadastrada:** a matriz mostra os itens em linha e a mensagem "Cadastre ao menos uma fonte para montar o mapa" no lugar das colunas.
- **FA-05 — Recálculo em andamento:** se uma mudança concorrente (US-026/027/029) estiver sendo persistida, a leitura do mapa reflete o último estado consolidado (commit mais recente) — nunca um estado parcial de uma transação em andamento.

## Regras de negócio
- **RN-PRICE-53** — O mapa comparativo é uma matriz com linhas = `PriceItem` (ordenados por `sortOrder`) e colunas = `PriceSource` (ordenadas por `sortOrder`); cada célula é a `Quotation` do cruzamento (quando existir), com `unitPrice`, `status`, `outlierFlag` e `isExpired`; cada linha é concluída com as estatísticas e `alerts` do item (US-029/US-030).
- **RN-PRICE-54** — Exportação em XLSX (`PRS-22`) é síncrona e limitada a 500 itens × 50 fontes; acima do limite, `422 EXPORT_TOO_LARGE` — não há exportação assíncrona/paginada do mapa no MVP 1.
- **RN-PRICE-55** — Exportação em PDF usa a renderização geral de documentos (`DOC-20`/`DOC-21`/`DOC-22`/`DOC-23`, US-067) do documento `PRICE_RESEARCH`; o template inclui a seção computada `PRICE_SUMMARY`, que renderiza a mesma matriz do mapa comparativo — não é editável via TipTap (é gerada a partir de `PriceItem`/`PriceSource`/`Quotation` no momento da renderização).
- **RN-PRICE-56** — Valores monetários do mapa (células, estatísticas, totais) seguem POL-09: sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` e sem custódia atual, todo valor é `null` com `masked: true` — na tela, no XLSX e no PDF, sem excecão.
- **RN-PRICE-57** — O mapa não é um snapshot: toda leitura (tela ou exportação) reflete o estado calculado mais recente (`PriceItem`/`Quotation` após o último `PriceResearchRecalculated`); a tela exibe `priceResearch.lastCalculatedAt` como referência de "calculado há".

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Formato de exportação | `format` (query `PRS-22`) | seleção | Sim (na exportação) | somente `xlsx` no MVP 1 | `xlsx` |

O mapa em si não tem campos de entrada: é uma visão somente leitura sobre `PriceItem`/`PriceSource`/`Quotation` (editados em US-026/US-027/US-029).

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Exportação acima de 500 itens ou 50 fontes | API | "Esta pesquisa tem mais itens/fontes do que o exportável de uma vez. Gere o PDF ou reduza o recorte." | `EXPORT_TOO_LARGE` |
| V-02 | `format` diferente de `xlsx` | API | "Formato de exportação não suportado." | `VALIDATION_ERROR` (`INVALID_ENUM`) |

## Permissões
- **Permissão:** `PROCESS_VIEW` para ver o mapa (DEC-024); nenhuma permissão de escrita (visão somente leitura).
- **Políticas:** POL-09 — `PROCESS_VIEW_CONFIDENTIAL_BUDGET` ou custódia atual do processo para ver valores monetários desmascarados, inclusive nas exportações.
- **MFA:** não exigido.
- **Sem `PROCESS_VIEW`:** rota retorna 404 (processo não visível, DEC-024); botão "Ver mapa comparativo" não aparece em SCR-009.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Visualização e exportação XLSX não geram evento de domínio (apenas auditoria `price_research.export`); a geração de PDF publica `DocumentRenditionReady`/`DocumentRenditionFailed`, de propriedade de US-067. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: exportações são solicitadas e consumidas pelo próprio usuário na mesma sessão. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Visualizar e exportar o mapa comparativo

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And a pesquisa de preços "PR-01" do processo "0012/2026" tem 3 itens e 4 fontes cadastradas
    And o usuário "Marcos" tem "PROCESS_VIEW" e "PROCESS_VIEW_CONFIDENTIAL_BUDGET" sobre o processo

  Scenario: [Sucesso] Visualizar o mapa comparativo completo
    When "Marcos" abrir o mapa comparativo da pesquisa "PR-01"
    Then a matriz deve exibir os 3 itens em linha e as 4 fontes em coluna
    And cada célula cotada deve exibir o preço unitário e o selo de status/outlier quando houver
    And cada linha deve exibir as estatísticas e os alertas do item

  Scenario: [Sucesso] Exportar o mapa em XLSX
    When "Marcos" clicar em "Exportar XLSX"
    Then a API deve responder 200 com o arquivo "xlsx" contendo a mesma matriz exibida em tela
    And deve gerar registro de auditoria "price_research.export"

  Scenario: [Validação] Exportação acima do limite síncrono
    Given que a pesquisa "PR-02" tem 600 itens
    When "Marcos" tentar exportar "PR-02" em XLSX
    Then a API deve responder 422 com código "EXPORT_TOO_LARGE"
    And a tela deve sugerir gerar o PDF ou reduzir o recorte

  Scenario: [Permissão] Usuário sem PROCESS_VIEW_CONFIDENTIAL_BUDGET em orçamento sigiloso
    Given que o processo "0012/2026" tem "isBudgetConfidential" igual a verdadeiro
    And o usuário "Bruno" tem "PROCESS_VIEW" mas não tem "PROCESS_VIEW_CONFIDENTIAL_BUDGET" nem custódia atual
    When "Bruno" abrir o mapa comparativo
    Then toda célula monetária deve retornar "null" com "masked" igual a verdadeiro
    And o mesmo mascaramento deve valer para a exportação em XLSX e em PDF

  Scenario: [Tenant incorreto] Mapa de pesquisa de outro tenant
    When "Marcos", no tenant "Prefeitura de São José", solicitar o mapa de uma "priceResearchId" existente apenas na "Prefeitura B"
    Then a API deve responder 404 com código "PRICE_RESEARCH_NOT_FOUND"

  Scenario: [Duplicidade] Exportar o mesmo XLSX duas vezes sem mudanças gera o mesmo conteúdo
    Given que a pesquisa "PR-01" não foi recalculada desde a última exportação
    When "Marcos" exportar o XLSX novamente
    Then o conteúdo do arquivo deve ser idêntico ao da exportação anterior
    And cada exportação deve gerar seu próprio registro de auditoria "price_research.export"

  Scenario: [Concorrência] Leitura do mapa durante um recálculo concorrente
    Given que uma cotação do "Item 1" está sendo excluída (US-027) no momento da leitura
    When "Marcos" abrir o mapa comparativo nesse instante
    Then a resposta deve refletir integralmente o estado antes ou depois da exclusão, nunca um estado parcial

  Scenario: [Falha de banco] Banco indisponível ao montar o XLSX
    Given que o banco de dados fica indisponível durante a exportação
    When "Marcos" clicar em "Exportar XLSX"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum arquivo parcial deve ser oferecido para download

  Scenario: [Falha de integração] Worker de renderização indisponível ao gerar o PDF
    Given que o worker "document-render" está indisponível
    When "Marcos" solicitar o PDF do mapa comparativo
    Then o sistema deve publicar o evento "DocumentRenditionFailed" quando a tentativa expirar
    And a tela deve exibir "Não foi possível gerar o PDF agora" com a opção "Tentar novamente"
    And a exportação em XLSX deve continuar disponível normalmente
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Exportação acima do limite | 422 | `EXPORT_TOO_LARGE` | "Esta pesquisa tem mais itens/fontes do que o exportável de uma vez." | Sugere PDF ou redução de recorte |
| Pesquisa não visível/outro tenant | 404 | `PRICE_RESEARCH_NOT_FOUND` | "Pesquisa não encontrada." | Redireciona à lista de processos |
| Rendition não pronta | 409 | `RENDITION_NOT_READY` | "O PDF ainda está sendo gerado. Aguarde." | Repete a consulta de status |
| Falha na geração do PDF | — | `DocumentRenditionFailed` (US-067) | "Não foi possível gerar o PDF agora." | Botão "Tentar novamente" |
| Banco/armazenamento indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível exportar agora. Tente novamente em instantes." | Mantém o mapa em tela; botão "Tentar novamente" |

## Dependências
- **Stories:** US-029 (estatísticas exibidas no mapa), US-030 (alertas/outliers exibidos no mapa), US-026 (fontes e cotações), US-067 (geração de PDF/renditions). Indireta: US-024 (criação da pesquisa).
- **Decisões/ADRs:** DEC-017 (seções de template e renditions), DEC-020 (estatísticas), DEC-024 (visibilidade), DEC-030/POL-09 (sigilo do orçamento).
- **Configurações:** nenhuma específica desta story (reaproveita os parâmetros de US-024/029/030).
- **Lacunas nas fontes canônicas:** nenhuma (`PRICE_SUMMARY` registrada em entities.md como seção computada do template `PRICE_RESEARCH`).

## Impacto técnico
- A montagem do XLSX deve ser feita em streaming/limite de memória controlado mesmo dentro do teto de 500 × 50, para manter a exportação síncrona dentro do limite de 20 req/min da classe "Exportações e renderização" (api.md §1.6) sem degradar p95.
- O PDF do mapa **não** é um endpoint próprio: reaproveita o pipeline de `document-render` (fila BullMQ, US-067); qualquer mudança nesse pipeline afeta esta story sem precisar de deploy coordenado, desde que o contrato de `DOC-20..23` não mude.
- Mascaramento (POL-09) deve ser aplicado no mesmo serializador central (`ConfidentialFieldsInterceptor`) usado pelas demais telas, tanto na resposta de `PRS-21` quanto na geração do XLSX e na renderização do PDF — não reimplementar a regra em cada exportador.

## Backend
- **Módulo(s):** `price-research` (dono do mapa e do XLSX); usa `document` (fachada de renditions — `DocumentRenditionFacade`, US-067).
- **Casos de uso:** `GetComparativeMapQuery` → `GetComparativeMapHandler`; `ExportComparativeMapXlsxCommand`.
- **Domínio:** `ComparativeMapBuilder` (monta a matriz a partir de `PriceItem`/`PriceSource`/`Quotation`, aplica `ConfidentialFieldsInterceptor`).
- **Integrações internas:** `document` (`DocumentRenditionFacade.requestRendition`, US-067) para o caminho de PDF.
- **Transação:** leitura em uma única transação `READ COMMITTED` (sem escrita) para `PRS-21`/`PRS-22`; não participa da transação de recálculo de US-029.

## Frontend
- **Tela(s):** SCR-010 (`/processos/[id]/pesquisa-precos/[researchId]/mapa`).
- **Componentes:** `ComparativeMapGrid` (cabeçalho de fonte fixo, rolagem sincronizada), `MapCellPrice` (valor + selos), `ExportMenu` (XLSX/PDF), `RenditionStatusPoller` (acompanha `DOC-22` até `READY`/`FAILED`).
- **Estados:** loading (skeleton da matriz), vazio (sem fontes — FA-04), erro (toast com `correlationId`), exportando (spinner no botão; polling para PDF).
- **Acessibilidade e responsividade:** matriz navegável por teclado (setas entre células); em telas estreitas, rolagem horizontal com cabeçalho de item fixo; selos com texto alternativo.

## Banco de dados
- **Tabelas:** leitura de `price_items`, `price_sources`, `quotations`, `price_research`; escrita apenas de auditoria (`audit_logs`) na exportação.
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** reaproveita os índices já existentes de US-026/029 (`(tenant_id, price_research_id)` em `price_sources`/`quotations`); nenhum índice novo.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRS-21 | GET | `/price-research/{id}/comparative-map` | — | `200 { data: { items[], sources[], cells[] } }` | 200, 403, 404 |
| PRS-22 | GET | `/price-research/{id}/comparative-map/export?format=xlsx` | — | `200` arquivo `xlsx` | 200, 403, 404, 422 (`EXPORT_TOO_LARGE`) |
| DOC-20 | POST | `/documents/{id}/preview` | — | `202` | 202, 403, 404 |
| DOC-21 | POST | `/document-versions/{versionId}/renditions` | `{ kind: "CONTENT" }` | `202` | 202, 403, 404 |
| DOC-22 | GET | `/document-renditions/{renditionId}` | — | `200 { data: { status, kind } }` | 200, 403, 404 |
| DOC-23 | GET | `/document-renditions/{renditionId}/download` | — | `200 { url, expiresAt }` | 200, 403, 404, 409 (`RENDITION_NOT_READY`) |

## Logs
- `info` `price_research.map_exported` — `priceResearchId`, `format`, `itemsCount`, `sourcesCount`, `durationMs`, `correlationId`.
- `warn` `price_research.export_near_limit` — exportação acima de 80% do teto (400 itens ou 40 fontes).
- `error` `price_research.export_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** preços unitários, estatísticas ou conteúdo do arquivo exportado.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `price_research.export` | `EXPORT` | Download do XLSX concluído | `metadata`: `format`, `itemsCount`, `sourcesCount`, `masked: boolean` |
| `document.download` | `EXPORT` | Download do PDF concluído (US-067) | `metadata`: `renditionId`, `kind` |

## Testes necessários
- **Unitários:** `ComparativeMapBuilder` com matriz completa, item sem fonte, fonte sem cotação; mascaramento de valores.
- **Integração (Testcontainers):** exportação XLSX com 500 × 50 (limite) e 501 × 50 (`EXPORT_TOO_LARGE`); mascaramento aplicado também ao arquivo gerado.
- **API/contrato:** `PRS-21`/`PRS-22` conforme api.md; `DOC-20..23` consumidos conforme contrato de US-067 (sem assumir detalhes de implementação do worker).
- **RBAC e multi-tenant:** processo de outro tenant → 404; sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` → valores mascarados em tela e nos arquivos.
- **Concorrência:** leitura do mapa durante recálculo concorrente não retorna estado parcial (transação única, `READ COMMITTED`).
- **E2E (Playwright):** abrir o mapa, exportar XLSX e validar o download; solicitar PDF e aguardar `READY`.
- **Acessibilidade/performance:** axe na matriz; k6 com exportações de 500×50 → p95 < 2 s.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] Mascaramento POL-09 verificado em tela, XLSX e PDF
- [ ] Limite de 500×50 aplicado e testado nos dois lados (dentro e fora do limite)
- [ ] Auditoria `price_research.export` verificada em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de PRS-21/22 compatível com api.md; integração com DOC-20..23 validada em contrato
- [ ] Logs sem dados sensíveis
- [ ] Matriz acessível (axe sem violações sérias) e responsiva (360 px, com rolagem horizontal)
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — a leitura e a exportação XLSX são relativamente diretas sobre dados já calculados; a complexidade está no mascaramento consistente entre tela/XLSX/PDF e na integração com o pipeline de renditions de outro épico.

## Prioridade
**P0** — o mapa comparativo é o artefato de evidência exigido para instruir o processo; sem ele a pesquisa de preços não tem documento de suporte apresentável.
