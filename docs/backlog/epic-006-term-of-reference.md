---
id: EP-006
title: "Termo de Referência"
mvp: 1
priority: P0
features: [FT-024, FT-025, FT-026, FT-027]
status: Especificado
---

# EP-006 — Termo de Referência

## Título
Termo de Referência

## Objetivo
Permitir que a equipe de planejamento produza o Termo de Referência (TR) completo — com todas as seções do art. 6º, XXIII, da Lei 14.133/2021 — a partir do modelo padrão do órgão, reaproveitando os dados já elaborados no Estudo Técnico Preliminar (ETP) e especificando itens e condições contratuais tipadas, até a conclusão formal do documento que segue para a fase de seleção do fornecedor.

## Contexto e problema
Hoje a elaboração do TR costuma ocorrer em editores de texto genéricos, a partir de modelos soltos, sem garantia de que as 14 seções exigidas (Lei 14.133/2021, art. 6º, XXIII, alíneas a–j; IN SEGES/ME 81/2022) estejam presentes, sem reaproveitamento estruturado dos dados do ETP e sem validação de consistência (quantidades, valor estimado) antes de seguir à licitação — divergências só aparecem depois, já na fase externa, gerando retrabalho e risco de questionamento.

O modelo documental híbrido do produto (DEC-017) endereça isso: cabeçalho tipado (`TermOfReference`) para os campos que o sistema precisa validar e reportar, seções de template (`draftContent`) para o conteúdo narrativo e coleções tipadas (`DocumentItem`) para os itens — com ciclo de vida único (DEC-018), importação rastreável do ETP e avisos determinísticos de consistência antes da conclusão.

## Escopo
- Criação do TR a partir do template padrão do órgão, com navegação por seções, autosave e indicador de completude (FT-024).
- Importação rastreável de dados do ETP (seções, campos do cabeçalho e quantidades dos itens), com prévia seletiva antes de aplicar (FT-025).
- Especificação dos itens da contratação (quantidade, especificação, critérios de aceitação) e das condições contratuais tipadas — vigência, prazos, local de entrega, pagamento, garantias, subcontratação, critério de julgamento e tipo de adjudicação (FT-026).
- Validação de completude e conclusão formal do TR, com avisos determinísticos de consistência com o ETP (FT-027).

## Fora de escopo
- Geração de edital e demais peças da fase de seleção do fornecedor (MVP 2).
- Assinatura eletrônica do TR (MVP 3 — `RenditionKind.SIGNED`).
- Sugestões e validações assistidas por IA sobre o conteúdo do TR (MVP 5 — DEC-019).
- Gestão do catálogo de itens do processo (US-006, EP-001) e da pesquisa de preços (EP-004) — apenas consumidos aqui.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Planejamento | `PLANEJAMENTO` | Redige o TR, importa o ETP, especifica itens/condições e conclui |
| Compras | `COMPRAS` | Redige e ajusta itens e condições contratuais |
| Gestor de contratações | `GESTOR_CONTRATACOES` | Visão global; redige/conclui em qualquer processo |
| Área requisitante | `REQUISITANTE` | Redige quando custodia o processo |
| Consultoria externa | `CONSULTOR_EXTERNO` | Colabora/consulta em TRs de processos aos quais foi convidada |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-024 | Elaboração do TR | US-036 | P0 |
| FT-025 | Importação do ETP | US-037 | P0 |
| FT-026 | Itens e condições | US-038 | P0 |
| FT-027 | Validação e conclusão | US-039 | P0 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-036 | Criar TR e editar suas seções | P0 | L | 8 |
| US-037 | Importar dados do ETP para o TR | P0 | M | 5 |
| US-038 | Especificar itens e condições contratuais do TR | P0 | M | 5 |
| US-039 | Validar e concluir o TR | P0 | M | 5 |
| **Total** | | | | **23** |

## Módulos e entidades
- Módulos: `term` (dono), `document` (dono do ciclo de vida genérico, das versões e das coleções tipadas).
- Entidades: `TermOfReference` (dono), `DocumentItem` (dono — coleção de itens), `Document`/`DocumentVersion` (dono — ciclo de vida e versionamento), `DocumentTemplateVersion` (consumida — seções e `importMappings`), `Etp` (consumida — origem da importação), `ProcessItem` (consumida — catálogo de itens do processo), `CatalogItem` (consumida — `JUDGMENT_CRITERION`).

## Telas
- SCR-012 — TR (editor) (`/processos/[id]/tr/[termId]`)

## Integrações
- Internas apenas: `etp` (leitura para importação), `process` (itens canônicos), `catalog` (`JUDGMENT_CRITERION`), `workflow` (tipo permitido na etapa), `access`, `timeline`, `audit`, `platform` (outbox, idempotência).
- Nenhuma integração externa neste épico (PNCP e assinatura eletrônica ficam em MVPs futuros).

## Eventos principais
- `DocumentCreated` (TR)
- `TermImportedFromEtp`
- `DocumentVersionCreated`
- `DocumentFinalized` (alias de domínio `TermCompleted`)
- `DocumentSubmitted` (somente quando o tipo TR exigir aprovação avulsa)

## Permissões envolvidas
- `TERM_CREATE`, `TERM_UPDATE`, `TERM_SUBMIT`
- `PROCESS_VIEW`, `PROCESS_VIEW_CONFIDENTIAL_BUDGET`

## Regras configuráveis
- `DocumentType.numberingMask` / `numbering.document.defaultMask` — numeração do TR.
- `DocumentTemplateVersion.importMappings` — mapeamento de importação do ETP (seções, campos, itens).
- `DocumentType.requiresApproval` (tipo TR) — concluir (`FINALIZED`) ou submeter para aprovação avulsa (`IN_REVIEW`).

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| TRs concluídos sem reconhecimento de avisos de divergência com o ETP | ≥ 90% | eventos `DocumentFinalized`/`TermCompleted` × `TR_ITEM_QUANTITY_DIVERGENT` |
| Tempo médio entre criação e conclusão do TR | ≤ 5 dias úteis | timeline (`DOCUMENT_CREATED` → `DOCUMENT_FINALIZED`) |
| TRs de processos com ETP finalizado que usam a importação | ≥ 80% | evento `TermImportedFromEtp` |

## Dependências
- **Depende de:** EP-002 (DFD — origina o processo), EP-003 (ETP — fonte da importação, FT-025), EP-001 (fundação: itens do processo, workflow, ciclo de vida genérico de documento, templates).
- **Habilita:** a fase de seleção do fornecedor (edital e demais peças, MVP 2).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| TR concluído sem coerência com o ETP (quantidades, valor estimado) | Média | Alto | Avisos determinísticos de consistência com reconhecimento obrigatório antes de concluir (FT-027) |
| Importação do ETP sobrescrever edição manual já feita no TR | Média | Média | Prévia seletiva por seção/campo/item com confirmação explícita (FT-025) |
| Template do tipo TR sem `importMappings` configurado | Baixa | Média | Mapeamento padrão semeado na biblioteca de templates (US-110) |
| Condições contratuais fora dos limites legais (garantia, prazos) | Baixa | Alto | Validação de faixa na API, não só na interface (FT-026) |

## Pontos em aberto
- PEND-05 — arredondamento (ABNT NBR 5891 × `ROUND_HALF_UP`) afeta o valor estimado do TR.
- PEND-16 — `PUBLISHED` só alcançável no MVP 3; a publicação do processo após o TR fica fora deste épico.

## Definition of Done do épico
- [ ] Todas as features (FT-024 a FT-027) concluídas
- [ ] KPIs instrumentados (timeline e eventos do épico)
- [ ] Testes E2E das jornadas do épico passando (criar → importar → especificar → concluir)
- [ ] Documentação e orientação ao usuário (ajuda contextual das seções do TR) atualizadas
