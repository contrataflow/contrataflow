---
id: EP-011
title: "Documentos"
mvp: 1
priority: P0
features: [FT-038, FT-039, FT-040, FT-041, FT-042]
status: Especificado
---

# EP-011 — Documentos

## Título
Documentos

## Objetivo
Dar ao processo de contratação um modelo documental único — tipos configuráveis, ciclo de vida, versões imutáveis com hash, geração de PDF, documentos livres/externos e anexos seguros — que sirva de base consistente para todos os artefatos de negócio (DFD, ETP, pesquisa de preços, mapa de riscos, TR, despachos, ofícios) produzidos ao longo da fase preparatória da Lei 14.133/2021.

## Contexto e problema
Hoje os artefatos da fase preparatória (art. 18) circulam como arquivos soltos em e-mail, papel ou pastas de rede: sem numeração confiável, sem histórico de versões, sem garantia de integridade e com uploads que podem introduzir arquivos maliciosos. O modelo documental híbrido (DEC-017) resolve isso tratando `Document` como o artefato genérico do processo, com três formas de conteúdo (`STRUCTURED`, `FREE_TEXT`, `UPLOADED`), um ciclo de vida único (DEC-018), versões imutáveis com hash SHA-256 (DEC-084, ADR-006) e um fluxo de upload com quarentena e antivírus (DEC-136) antes de qualquer arquivo ficar disponível. Este épico implementa essa base; os módulos tipados (DFD, ETP, TR, mapa de riscos, pesquisa de preços) são especificados em outros épicos e apenas consomem o que está aqui.

## Escopo
- Tipos de documento de sistema e personalizados por tenant, com numeração e política de aprovação (FT-038).
- Painel de documentos do processo, documentos livres a partir de template (com autosave) e documentos externos por upload com versões (FT-039).
- Ciclo de vida único do documento e versionamento imutável com comparação (FT-040).
- Geração assíncrona de PDF com marca d'água de rascunho e hash no rodapé (FT-041).
- Upload seguro de anexos (quarentena + antivírus), download auditado por URL pré-assinada e indicador de presença na edição concorrente (FT-042).

## Fora de escopo
- Campos e regras específicas dos módulos tipados (DFD, ETP, TR, mapa de riscos, pesquisa de preços) — EP-002 a EP-006.
- Criação/publicação de templates de documento — EP-018 (este épico apenas consome o modelo publicado).
- Assinatura eletrônica de PDF (`SIGNED`) e PDF/A-2b — MVP 3 (PEND-09).
- Edição colaborativa em tempo real (fusão automática de edições simultâneas) — fora do MVP 1 (PEND-12); este épico entrega só o indicador de presença (FT-042/US-070).
- Imagens embutidas em rich text — PEND-08.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Redator do processo | `REQUISITANTE`, `PLANEJAMENTO`, `GESTOR_CONTRATACOES` | Cria e edita documentos livres/externos, anexa evidências |
| Administrador do órgão | `ADMIN` | Configura tipos de documento personalizados e políticas de aprovação |
| Aprovador | `AUTORIDADE`, `GESTOR_CONTRATACOES` | Analisa versões submetidas, baixa PDFs para despacho |
| Auditor/controle interno | `SOMENTE_LEITURA` | Consulta histórico de versões, PDFs e trilha de auditoria de download |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-038 | Tipos de documento | US-061 | P1 |
| FT-039 | Documentos do processo | US-062, US-063, US-064 | P0 |
| FT-040 | Ciclo de vida e versões | US-065, US-066 | P0 |
| FT-041 | Geração de PDF | US-067 | P0 |
| FT-042 | Anexos | US-068, US-069, US-070 | P0 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-061 | Gerenciar tipos de documento | P1 | M | 5 |
| US-062 | Painel de documentos do processo | P0 | M | 5 |
| US-063 | Criar documento livre a partir de template | P1 | M | 5 |
| US-064 | Incluir documento externo (upload) com versões | P1 | M | 5 |
| US-065 | Ciclo de vida do documento | P0 | L | 8 |
| US-066 | Versionamento imutável e comparação de versões | P0 | M | 5 |
| US-067 | Gerar PDF de documentos | P0 | L | 8 |
| US-068 | Upload seguro de anexos | P0 | L | 8 |
| US-069 | Visualizar e baixar anexos | P0 | S | 2 |
| US-070 | Indicador de edição concorrente | P2 | M | 5 |
| **Total** | | | | **56** |

## Módulos e entidades
- Módulos: `document` (dono), `files` (dono)
- Entidades: `DocumentType`, `Document`, `DocumentVersion`, `DocumentRendition`, `DocumentItem`, `Attachment` (dono); `DocumentTemplate`/`DocumentTemplateVersion` (consumida — EP-018), `ProcessItem` (consumida — EP-001), `WorkflowStage` (consumida — EP-007), `Approval` (consumida — EP-008)

## Telas
- SCR-006 — Detalhe do processo, aba Documentos (`/processos/[id]`)
- SCR-105 — Documento livre/externo, editor e visualizador (`/processos/[id]/documentos/[docId]`)
- SCR-106 — Versões e comparação (`/processos/[id]/documentos/[docId]/versoes`)
- SCR-108 — Tipos de documento (`/admin/tipos-documento`)

## Integrações
- Gotenberg (HTML → PDF, FT-041)
- ClamAV (antivírus de anexos em quarentena, FT-042)
- S3/MinIO (binários de anexos e renditions, URL pré-assinada)
- Redis (quarentena/idempotência de upload; presença de edição, FT-042)

## Eventos principais
- `DocumentCreated`, `DocumentVersionCreated`, `DocumentSubmitted`, `DocumentFinalized`
- `DocumentApproved`, `DocumentReturned`, `DocumentRejected`, `DocumentWithdrawn`, `DocumentReopened`, `DocumentCanceled`
- `DocumentRenditionReady`, `DocumentRenditionFailed`
- `AttachmentUploaded`, `AttachmentRejected`, `AttachmentDeleted`

## Permissões envolvidas
- `DOCUMENT_CREATE`, `DOCUMENT_UPDATE`, `DOCUMENT_SUBMIT`, `DOCUMENT_REOPEN`, `DOCUMENT_CANCEL`
- `ATTACHMENT_UPLOAD`, `ATTACHMENT_DELETE`
- `DOCUMENT_TYPE_MANAGE`

## Regras configuráveis
- `numbering.document.defaultMask` — máscara padrão de numeração de documentos
- `uploads.maxFileSizeMb` — tamanho máximo por arquivo (padrão 50 MB, teto de plataforma 100 MB)
- `uploads.allowedExtensions` — subconjunto permitido da allowlist da plataforma

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| p95 de geração de PDF (`CONTENT`/`APPROVAL_STAMPED`), do pedido ao `READY` | ≤ 30 s | RN-DOC-70 (US-067) / observability.md |
| Anexos promovidos a `AVAILABLE` sem varredura antivírus limpa | 0 | RN-DOC-75 (US-068) / storage.md princípio P3 |
| Documentos aprovados com versão imutável e `contentHash` íntegro | 100% | DEC-018, DEC-084 |
| Conflitos de revisão de seção (`SECTION_REVISION_CONFLICT`) percebidos após a adoção do indicador de presença | redução frente à linha de base sem indicador | RT-04 / US-070 |

## Dependências
- **Depende de:** EP-015 (fundação técnica — transação, outbox, worker, observabilidade); EP-016 (identidade/RBAC — POL-02/POL-09/POL-11 e permissões do épico); EP-018 (templates de documentos — modelo publicado consumido por documentos `FREE_TEXT`).
- **Habilita:** EP-002 (DFD), EP-003 (ETP), EP-004 (Pesquisa de preços), EP-005 (Mapa de riscos), EP-006 (Termo de Referência), EP-007 (Workflow — tipos de documento referenciados nas regras de etapa), EP-008 (Tramitação — documentos como pendência de etapa).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Geração de PDF fiel (tabelas, quebras de página, fontes) consumir mais esforço que o previsto (RT-03) | Alta | Média | Gotenberg + CSS de impressão padronizado; testes de regressão visual por hash do PDF |
| Autosave por seção com conflitos frequentes em documentos colaborativos (RT-04) | Média | Média | Revisão por seção (DEC-055), diálogo de conflito, indicador de presença (US-070) |
| Upload de arquivo malicioso ou de tipo não permitido | Baixa | Alta | Quarentena + *magic bytes* + ClamAV + allowlist de extensão/MIME (DEC-136); nunca libera sem varredura limpa |

## Pontos em aberto
- PEND-07 — Política de retenção do binário de anexos logicamente excluídos.
- PEND-08 — Imagens embutidas em conteúdo rich text.
- PEND-09 — Geração de PDF/A-2b.
- PEND-17 — Valor definitivo do limite de armazenamento por tenant (proposta: 50 GB, avisos em 80 %/95 %).

## Definition of Done do épico
- [ ] Todas as features concluídas (FT-038 a FT-042)
- [ ] KPIs instrumentados (observability.md)
- [ ] Testes E2E das jornadas do épico passando (criar tipo → criar documento → editar/anexar → finalizar/submeter → versionar → gerar PDF → baixar)
- [ ] Documentação e guia do usuário atualizados
