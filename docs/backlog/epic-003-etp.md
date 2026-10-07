---
id: EP-003
title: "Estudo Técnico Preliminar (ETP)"
mvp: 1
priority: P0
features: [FT-011, FT-012, FT-013, FT-014]
status: Especificado
---

# EP-003 — Estudo Técnico Preliminar (ETP)

## Título
Estudo Técnico Preliminar (ETP)

## Objetivo
Permitir a elaboração completa do ETP exigido pelo art. 18 da Lei 14.133/2021 — template por seções, importação do DFD, alternativas de solução, estimativas de quantidade e valor, e validação de completude com conclusão —, assegurando que a contratação só avance ao Termo de Referência e à aprovação formal com a fundamentação técnica exigida por lei.

## Contexto e problema
- Base legal: art. 6º, XX, e art. 18, §1º, I a XIII, e §2º, da Lei 14.133/2021; IN SEGES/ME 58/2022 (16 elementos do ETP).
- Hoje o ETP costuma ser redigido em documentos de texto soltos, sem padronização dos elementos obrigatórios, com estimativas de quantidade e de valor desconectadas da pesquisa de preços e sem rastreabilidade de quem decidiu pela viabilidade ou pela alternativa recomendada.
- A obrigatoriedade de cada seção (`REQUIRED`, `REQUIRED_OR_JUSTIFY`, `OPTIONAL`) é configuração semeada (DEC-016), não código — permite ajuste por tenant sem nova versão de software.
- O ETP é um `Document` do modelo documental híbrido (DEC-017): cabeçalho tipado (`Etp`), seções narrativas por template e coleções tipadas (`EtpAlternative`, `DocumentItem`).

## Escopo
- Criação do ETP a partir do template vigente, com importação opcional do DFD (necessidade, PCA, itens).
- Edição de seções com autosave e "não se aplica" justificado.
- Levantamento de alternativas de solução, com decisão (recomendada/descartada) e justificativa.
- Estimativa de quantidade por item (com memória de cálculo) e do valor total (manual ou vinculado à pesquisa de preços, com sincronização automática).
- Validação de completude configurável e conclusão (viável/não viável), com finalização do documento.

## Fora de escopo
- Elaboração da pesquisa de preços em si — EP-004.
- Mapa de riscos — EP-005.
- Elaboração do Termo de Referência a partir do ETP — EP-006.
- Tramitação e aprovação formal do ETP — EP-008.
- Assinatura eletrônica e publicação — MVP 3.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Redator do ETP | `REQUISITANTE`/`PLANEJAMENTO` | Elabora o estudo: seções, alternativas, estimativas e conclusão |
| Gestor de contratações | `GESTOR_CONTRATACOES` | Acompanha e pode editar o ETP; cobra pendências |
| Autoridade competente | perfil aprovador (EP-008) | Decide a aprovação formal com base no ETP concluído |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-011 | Elaboração do ETP | US-019, US-020 | P0 |
| FT-012 | Alternativas de solução | US-021 | P0 |
| FT-013 | Estimativas | US-022 | P0 |
| FT-014 | Validação e conclusão do ETP | US-023 | P0 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-019 | Criar ETP a partir de template com importação do DFD | P0 | M | 5 |
| US-020 | Editar seções do ETP com autosave e "não se aplica" justificado | P0 | L | 8 |
| US-021 | Gerenciar alternativas de solução | P0 | M | 5 |
| US-022 | Estimar quantidades e vincular valor à pesquisa de preços | P0 | M | 5 |
| US-023 | Validar completude do ETP e concluí-lo | P0 | M | 5 |
| **Total** | | | | **28** |

## Módulos e entidades
- Módulos: `etp` (dono), `document` (coleção de itens e ciclo de vida, compartilhado), `price-research` (consumida).
- Entidades: `Etp`, `EtpAlternative` (dono); `DocumentItem`, `Document`, `DocumentVersion` (consumidas/compartilhadas); `PriceResearch` (consumida).

## Telas
- SCR-008 — ETP (editor por seções) (`/processos/[id]/etp/[etpId]`)

## Integrações
- Interna com `document` (DEC-017/DEC-018: cabeçalho, seções, versionamento, finalização).
- Interna com `price-research` (valor estimado vinculado e sincronizado — US-022).
- Interna com `process` (itens canônicos — DEC-019; precedência de `Process.estimatedValue` — DEC-032).
- Interna com `workflow`/aprovação (EP-008), consumida após a conclusão (fora deste épico).
- Nenhuma integração externa.

## Eventos principais
- `ETPCreated` (US-019)
- `EtpAlternativeRecommended` (US-021)
- `DocumentFinalized`, `DocumentVersionCreated` (US-023)

## Permissões envolvidas
- `ETP_CREATE`, `ETP_UPDATE`, `ETP_SUBMIT`

## Regras configuráveis
- `SectionDefinition.requirement` por seção do template ETP (`REQUIRED`\|`REQUIRED_OR_JUSTIFY`\|`OPTIONAL`), semeado conforme o art. 18 (DEC-016).
- `DocumentTemplateVersion.sections` do tipo `ETP` (biblioteca padrão — US-110).

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Tempo médio de elaboração (criação → conclusão) | ≤ 5 dias úteis | Timeline/auditoria |
| ETPs com valor vinculado à pesquisa de preços | ≥ 60% | `Etp.estimatedValueSource` |
| ETPs devolvidos na aprovação por incompletude | ≤ 10% | `Approval` + `DocumentStatus` |

## Dependências
- **Depende de:** EP-002 DFD (fonte da importação), EP-004 Pesquisa de preços (valor vinculado), EP-011 Documentos (ciclo de vida e versionamento genéricos), EP-018 Templates de documentos (biblioteca padrão semeada).
- **Habilita:** EP-006 Termo de Referência (importa dados do ETP).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Equipes continuarem elaborando o ETP fora do sistema (planilhas/Word) | Média | Alto | Importação do DFD, template padrão e autosave reduzem o retrabalho |
| Valor do ETP desatualizado após recálculo da pesquisa de preços | Baixa | Médio | Sincronização automática por evento (RN-ETP-29) |
| Seções configuráveis mal calibradas pelo tenant | Baixa | Médio | Configuração semeada com valores padrão alinhados ao art. 18 (DEC-016) |

## Pontos em aberto
- Nenhum ponto em aberto específico deste épico; lacunas pontuais (ex.: código de duplicidade de nome de alternativa, comportamento ao cancelar pesquisa vinculada) estão registradas nas stories US-021/US-022.

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados
- [ ] Testes E2E das jornadas do épico passando
- [ ] Documentação e treinamento (guia do usuário) atualizados
