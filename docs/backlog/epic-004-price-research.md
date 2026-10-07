---
id: EP-004
title: "Pesquisa de preços"
mvp: 1
priority: P0
features: [FT-015, FT-016, FT-017, FT-018, FT-019, FT-020]
status: Especificado
---

# EP-004 — Pesquisa de preços

## Título
Pesquisa de preços

## Objetivo
Permitir estimar o valor da contratação com base em fontes e cotações de mercado — conforme o art. 23 da Lei 14.133/2021 —, com estatísticas, alertas de conformidade e mapa comparativo auditável, produzindo um preço de referência defensável que alimenta automaticamente o item do processo, o valor estimado da contratação e o ETP vinculado.

## Contexto e problema
- Base legal: art. 23, §1º, I a V (parâmetros de pesquisa: painel de preços, contratações similares, pesquisa direta com no mínimo três fornecedores, dados de referência de pesquisas publicadas, sítios eletrônicos especializados) e art. 24 da Lei 14.133/2021; IN SEGES/ME 65/2021 citada com prudência — os limiares (mínimo de cotações, validade das fontes, faixas de outlier) são configuração do tenant (DEC-020), não valores fixos em código.
- Hoje a pesquisa costuma ser feita em planilhas soltas, sem estatística padronizada (média, mediana, coeficiente de variação), sem registro uniforme da evidência de cada fonte e sem rastreabilidade de exclusões — risco relevante em auditorias do TCU e de controle interno.
- A pesquisa de preços é um `Document` do modelo documental híbrido (DEC-017): cabeçalho tipado (`PriceResearch`), seções narrativas (`METHODOLOGY`, `CONCLUSION`) e uma seção computada (`PRICE_SUMMARY`) que renderiza o mapa comparativo direto das coleções tipadas (`PriceItem`, `PriceSource`, `Quotation`).

## Escopo
- Criação da pesquisa a partir dos itens do processo, com snapshot dos parâmetros vigentes do tenant (FT-015).
- Cadastro único de fornecedores do tenant, com validação de CNPJ/CPF e deduplicação (FT-016).
- Registro de fontes de pesquisa e cotações, exclusão justificada/restauração e importação por planilha (FT-017).
- Cálculo automático de estatísticas, método efetivo e preço recomendado por item, com sinalização de outliers e alertas de conformidade (FT-018).
- Mapa comparativo itens × fontes, com exportação em XLSX e PDF (FT-019).
- Validação de completude, conclusão da pesquisa e propagação do valor ao item do processo, ao processo e ao ETP vinculado (FT-020).

## Fora de escopo
- Elaboração do ETP e do Termo de Referência que consomem o valor estimado — EP-003 e EP-006.
- Tramitação e aprovação formal da pesquisa pelo workflow do processo — EP-008.
- Integração automatizada com bases externas (Painel de Preços, PNCP); no MVP 1 essas fontes são registradas como evidência manual (descrição, data, anexo), não via API.
- Mapa de riscos da contratação — EP-005.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Agente de compras / planejamento | Equipe de planejamento da contratação | Cria a pesquisa, registra fontes e cotações, ajusta método e conclui |
| Servidor de Compras | Mantém o cadastro de fornecedores do órgão | Cadastra e atualiza fornecedores (CNPJ/CPF) usados pelas pesquisas |
| Gestor de contratações (`GESTOR_CONTRATACOES`) | Acompanhamento da contratação | Acompanha a pesquisa, revisa alertas e pode editar/concluir |
| Autoridade / controle interno | Fiscalização e auditoria | Consulta o mapa comparativo e a versão concluída como evidência do art. 23 |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-015 | Pesquisa e itens | US-024 | P0 |
| FT-016 | Fornecedores | US-025 | P0 |
| FT-017 | Fontes e cotações | US-026, US-027, US-028 | P0 |
| FT-018 | Cálculos e alertas | US-029, US-030 | P0 |
| FT-019 | Mapa comparativo | US-031 | P0 |
| FT-020 | Conclusão da pesquisa | US-032 | P0 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-024 | Criar pesquisa de preços a partir dos itens do processo | P0 | M | 5 |
| US-025 | Cadastrar e manter fornecedores | P0 | M | 5 |
| US-026 | Registrar fontes de pesquisa e cotações | P0 | L | 8 |
| US-027 | Desconsiderar e restaurar cotação com justificativa | P0 | S | 2 |
| US-028 | Importar cotações por planilha | P2 | M | 5 |
| US-029 | Calcular estatísticas e valor estimado por item | P0 | M | 5 |
| US-030 | Sinalizar outliers e alertas de conformidade | P1 | M | 5 |
| US-031 | Visualizar e exportar o mapa comparativo | P0 | M | 5 |
| US-032 | Concluir a pesquisa de preços | P0 | M | 5 |
| **Total** | | | | **45** |

## Módulos e entidades
- Módulos: `price-research` (dono), `supplier` (dono), `document`, `process`, `catalog`, `attachment` (consumidos/compartilhados).
- Entidades: `PriceResearch`, `PriceItem`, `PriceSource`, `Quotation`, `Supplier` (dono); `ProcessItem`, `Document`, `DocumentVersion`, `CatalogItem` (`PRICE_SOURCE_TYPE`) (consumidas).

## Telas
- SCR-009 — Pesquisa de preços (`/processos/[id]/pesquisa-precos/[researchId]`)
- SCR-010 — Mapa comparativo (`/processos/[id]/pesquisa-precos/[researchId]/mapa`)
- SCR-107 — Fornecedores (`/fornecedores`)

## Integrações
- Interna com `document` (DEC-017/DEC-018: cabeçalho tipado, seções de template incluindo a seção computada `PRICE_SUMMARY`, ciclo de vida e versionamento).
- Interna com `process` (`ProcessItem` — DEC-019 — origem dos itens e da quantidade de referência; atualização de `referenceUnitPrice` e `Process.estimatedValue` na conclusão).
- Interna com `etp` (sincronização assíncrona do valor estimado ao ETP vinculado — RN-PRICE-62/RN-ETP-29, consumida por EP-003).
- Interna com `attachment` (evidência de fonte — US-068).
- Nenhuma integração externa no MVP 1 (fontes como "Painel de Preços" são registradas como evidência manual, não via API).

## Eventos principais
- `DocumentCreated` (criação da pesquisa)
- `PriceResearchRecalculated` (toda mudança relevante em fontes, cotações ou parâmetros)
- `QuotationExcluded` / `QuotationRestored`
- `SupplierCreated` / `SupplierUpdated`
- `PriceResearchCompleted` (forma tipada de `DocumentFinalized`) / `DocumentVersionCreated`

## Permissões envolvidas
- `PRICE_RESEARCH_CREATE`
- `PRICE_RESEARCH_UPDATE`
- `PRICE_RESEARCH_EXCLUDE_QUOTATION`
- `PRICE_RESEARCH_COMPLETE`
- `SUPPLIER_VIEW`
- `SUPPLIER_MANAGE`
- `PROCESS_VIEW_CONFIDENTIAL_BUDGET`

## Regras configuráveis
- `priceResearch.defaultMethod` (`AUTO_CV` padrão) — método de cálculo do valor recomendado quando o item não tem método próprio.
- `priceResearch.cvThresholdPercent` — limite de coeficiente de variação para `AUTO_CV` escolher a mediana em vez da média.
- `priceResearch.minQuotations` — mínimo de cotações válidas por item antes de exigir justificativa para concluir.
- `priceResearch.directQuoteMaxAgeDays` / `priceResearch.similarContractMaxAgeDays` — validade máxima das fontes por tipo.
- `priceResearch.outlierLowerPercent` / `priceResearch.outlierUpperPercent` — faixas de sinalização de outlier.
- `priceResearch.unitPriceDecimals` / `priceResearch.roundingMode` — precisão e arredondamento dos cálculos.

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Tempo médio de elaboração (criação → conclusão) | ≤ 5 dias úteis | Timeline/auditoria |
| Pesquisas concluídas com `minQuotations` atingido em todos os itens (sem justificativa de exceção) | ≥ 70% | `PriceItem.alerts` / `belowMinimumJustification` |
| Pesquisas com alertas (`itemsWithAlertsCount > 0`) revisadas antes da conclusão | 100% | `PriceResearch.itemsWithAlertsCount` + auditoria de conclusão |

## Dependências
- **Depende de:** EP-001 (processo e itens canônicos — `ProcessItem`, US-006), EP-011 (ciclo de vida e versionamento genéricos do documento — DEC-017/DEC-018).
- **Habilita:** EP-003 ETP (valor estimado sincronizado ao concluir — RN-PRICE-62/RN-ETP-29), EP-006 Termo de Referência (depende também diretamente desta pesquisa, conforme docs/mvp-01/epics.md).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Equipe lançar preços fora do sistema (planilha solta) e só colar o resultado final | Média | Alto | Grade de lançamento (US-026) e importação por planilha com prévia (US-028) tornam o fluxo no sistema mais rápido que a planilha solta |
| Conclusão com poucas cotações sem evidência suficiente para defender o preço perante controle externo | Média | Alto | Alertas não bloqueantes (US-030) + justificativa obrigatória para concluir abaixo do mínimo (RN-PRICE-58) |

## Pontos em aberto
- Nenhum ponto em aberto (lacunas de US-024 resolvidas nas fontes canônicas em 2026-10-07). US-100 (isolamento por tenant) é dependência transversal de FT-016 e não altera o desenho da feature.

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados
- [ ] Testes E2E das jornadas do épico passando
- [ ] Documentação e treinamento (guia do usuário) atualizados
