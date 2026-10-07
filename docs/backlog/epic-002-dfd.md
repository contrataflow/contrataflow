---
id: EP-002
title: "DFD — Documento de Formalização da Demanda"
mvp: 1
priority: P0
features: [FT-008, FT-009, FT-010]
status: Especificado
---

# EP-002 — DFD — Documento de Formalização da Demanda

## Título
DFD — Documento de Formalização da Demanda

## Objetivo
Garantir que toda demanda de contratação seja formalizada em um DFD completo e padronizado — elaborado a partir do template do órgão, revisado, decidido pela autoridade competente e capaz de alimentar automaticamente o processo (valor, itens, PCA e prioridade) — com reaproveitamento para demandas recorrentes.

## Contexto e problema
- O Decreto 10.947/2022 (art. 8º) e a Lei 14.133/2021 (art. 12, VII; art. 18) exigem a formalização da demanda como primeiro artefato da fase preparatória; hoje isso é feito em documentos avulsos (Word, planilhas), sem padronização, verificação de completude ou ligação com os itens do processo.
- DEC-010 faz do processo o agregado central; DEC-017 define o modelo documental híbrido (cabeçalho tipado + seções do template); DEC-018 unifica o ciclo de vida de documentos; DEC-032 define a precedência de fontes do valor estimado do processo — o DFD é a primeira fonte na cadeia.
- Sem este épico, a decisão sobre a demanda não propaga dados ao processo, obrigando reentrada manual de valor, quantidades e PCA nas etapas seguintes.

## Escopo
- Criação do DFD em wizard de 5 passos a partir do template publicado, com itens ligados ao processo (US-014).
- Edição contínua com autosave genérico, retomada e tratamento de conflito (US-015).
- Conclusão com envio para aprovação ou finalização direta (US-016).
- Efeitos da decisão sobre o DFD — propagação de valor, quantidade, PCA e prioridade ao processo (US-017).
- Duplicação do DFD para novo processo ou processo existente (US-018).

## Fora de escopo
- Elaboração do ETP, mapa de riscos, pesquisa de preços e Termo de Referência (outros épicos da fase preparatória).
- PCA como entidade própria — DEC-029 mantém apenas a referência no MVP 1 (MVP 2).
- Assinatura eletrônica e publicação do DFD (MVP 3 — DEC-013).
- Mecanismo de anexos e de pré-visualização/renderização em si (US-067/US-068, apenas consumidos aqui).

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Área requisitante | `REQUISITANTE` | Elabora, edita, conclui e duplica o DFD |
| Titular da secretaria | `DEPARTMENT_HEAD` | Decide a aprovação do DFD |
| Gestor de contratações | `GESTOR_CONTRATACOES` | Acompanha, edita e duplica DFD entre processos |
| Planejamento | `PLANEJAMENTO` | Consulta os dados propagados (PCA, valor, prioridade) |

## Features
| Feature | Descrição | Stories | Prioridade |
|---|---|---|---|
| FT-008 Elaboração do DFD | Wizard de 5 passos, template, rascunho e autosave | US-014, US-015 | P0 |
| FT-009 Conclusão e decisão do DFD | Revisão, conclusão, envio para aprovação e efeitos da decisão | US-016, US-017 | P0 |
| FT-010 Reaproveitamento do DFD | Duplicação de DFD | US-018 | P2 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-014 | Elaborar DFD em wizard a partir de template | P0 | L | 8 |
| US-015 | Editar DFD com autosave, retomada e tratamento de conflito | P0 | M | 5 |
| US-016 | Revisar, concluir e enviar o DFD para aprovação | P0 | M | 5 |
| US-017 | Tratar decisão sobre o DFD e propagar dados ao processo | P0 | M | 5 |
| US-018 | Duplicar DFD | P2 | S | 2 |
| **Total** | | | | **25** |

## Módulos e entidades
- Módulos: `dfd` (dono), `document`, `process`, `approval`, `workflow`, `catalog`, `access`, `timeline`, `audit`, `notification`, `platform`
- Entidades: `Dfd` (dono); `Document`, `DocumentVersion`, `DocumentItem`, `DocumentTemplateVersion` (modelo documental compartilhado); `ProcessItem`, `Process` (consumidas e atualizadas); `Approval` (consumida, dono em outro épico)

## Telas
- SCR-007 — DFD (wizard/editor) (`/processos/[id]/dfd/[dfdId]`)
- SCR-103 — Encaminhar processo (painel lateral)
- SCR-113 — Duplicar processo/DFD (diálogo)
- SCR-006 — Painel do processo (reflete status e dados propagados)

## Integrações
- Internas: `approval` (solicitar/decidir aprovação), `workflow` (encaminhamento e regras de etapa), `process` (itens, valor estimado, PCA, prioridade), `platform` (outbox, idempotência, IndexedDB local).
- Externas: nenhuma diretamente neste épico (integrações como PNCP ficam com a pesquisa de preços).

## Eventos principais
- `DocumentCreated` (`DFDCreated`), `DocumentVersionCreated`, `DocumentSubmitted`, `DocumentFinalized`
- `DFDApproved` (`DocumentApproved`), `DocumentReturned`, `DocumentRejected`
- `ProcessItemsChanged`, `ProcessStatusChanged`, `ApprovalRequested`

## Permissões envolvidas
- `DFD_CREATE`, `DFD_UPDATE`, `DFD_SUBMIT`, `DOCUMENT_REOPEN`
- `PROCESS_VIEW`, `PROCESS_FORWARD`, `PROCESS_CREATE` (duplicação para novo processo)
- `ATTACHMENT_UPLOAD`

## Regras configuráveis
- `numbering.document.defaultMask` — máscara de numeração do DFD quando o tipo não define a própria.
- `uploads.maxFileSizeMb`, `uploads.allowedExtensions` — anexos do DFD.
- `approval.preventSelfApproval` — aplicada à decisão da aprovação que cobre o DFD.

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Tempo médio para concluir o DFD | < 30 min | Telemetria do wizard (US-014/US-016) |
| % de DFDs aprovados sem devolução | > 70% | Eventos `DocumentApproved`/`DocumentReturned` |
| % de decisões com propagação correta ao processo | 100% | Auditoria `process.update` (US-017) |
| DFDs criados por duplicação | Acompanhar (sem meta no MVP 1) | Auditoria `document.duplicate` (US-018) |

## Dependências
- **Depende de:** EP-001 (criação do processo — agregado central), fundação de plataforma e autorização (US-073, US-082, US-097), épico de workflow (US-042, US-047) e épico de aprovações (US-051, US-052).
- **Habilita:** épicos seguintes da fase preparatória — ETP, mapa de riscos, pesquisa de preços e Termo de Referência, que reaproveitam o autosave (US-015) e os padrões de decisão (US-017).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Regra de precedência de valor/prioridade mal aplicada na decisão | Média | Alto | Testes de integração dedicados (DEC-032); lacunas registradas revisadas com produto (US-017) |
| Conflito de edição concorrente no autosave perder conteúdo | Média | Médio | Diálogo de conflito, revisão por seção e contingência local (DEC-055/DEC-182, US-015) |
| Duplicação criar itens órfãos entre processos | Baixa | Médio | Transação única e testes de concorrência (US-018) |

## Pontos em aberto
- PEND-02 — cancelamento automático vs. apenas sugerido quando o DFD é indeferido.
- PEND-08 — imagens embutidas em rich text (afeta as seções do DFD).
- PEND-16 — publicação do processo (MVP 3) ainda não se aplica ao DFD.

## Definition of Done do épico
- [ ] FT-008 e FT-009 (P0) concluídas e aceitas; FT-010 (P2) priorizada no MVP 1 ou formalmente adiada
- [ ] KPIs instrumentados (telemetria do wizard, auditoria de propagação, eventos de decisão)
- [ ] Testes E2E das jornadas "elaborar → concluir → decidir" e "duplicar" passando
- [ ] Documentação e guia do usuário do DFD atualizados
