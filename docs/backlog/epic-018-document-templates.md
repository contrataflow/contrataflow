---
id: EP-018
title: "Templates de documentos"
mvp: 1
priority: P0
features: [FT-058]
status: Especificado
---

# EP-018 — Templates de documentos

## Título
Templates de documentos

## Objetivo
Dar a cada tipo de documento do produto um modelo versionado, publicável e auditável — com seções, base legal e layout de impressão — para que DFD, ETP, TR, mapa de riscos, pesquisa de preços e documentos livres sejam redigidos de forma consistente, orientada à Lei 14.133/2021 e sem retrabalho entre setores do mesmo órgão.

## Contexto e problema
Hoje os órgãos usam modelos de Word dispersos, sem controle de versão, sem rastro de quem alterou a base legal e sem padronização entre secretarias. A Lei 14.133/2021 exige elementos específicos no ETP (art. 18, §1º) e no TR (art. 6º, XXIII); a ausência de um padrão aumenta o risco de incompletude e de questionamento pelo Controle Interno/Tribunais de Contas. DEC-017 estabelece o modelo documental híbrido (cabeçalho tipado + seções narrativas de template); este épico entrega o lado de template desse modelo: editor, publicação/versão imutável, layout de impressão e a biblioteca padrão pronta já no provisionamento do tenant.

## Escopo
- Editor de seções do template (`SectionDefinition`, variáveis, `fieldConfig`) — US-107.
- Ciclo de publicação/versão imutável (`contentHash`) e padrão por tipo de documento — US-108.
- Layout de impressão (timbre, cabeçalho, rodapé, margens, fonte) com prévia em PDF — US-109.
- Biblioteca padrão semeada no provisionamento do tenant, com conteúdo orientado à Lei 14.133/2021, e adoção opcional de atualizações futuras dessa biblioteca — US-110.

## Fora de escopo
- Elaboração do conteúdo de DFD/ETP/TR/mapa de riscos/pesquisa de preços em si (módulos próprios — EP-002, EP-003, EP-004, EP-011).
- Assinatura eletrônica de documentos (MVP 3).
- Geração de PDF/A-2b (PEND-09).
- Tradução/i18n de templates (produto é pt-BR no MVP 1).

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Administrador de configurações documentais | `TEMPLATE_MANAGE`/`TEMPLATE_PUBLISH` | Cria, edita, publica e mantém os templates do órgão |
| Procuradoria/assessoria jurídica | mesmo perfil acima | Revisa e adapta o texto-base legal dos templates |
| Redator (requisitante/gestor) | `REQUISITANTE`, `GESTOR_CONTRATACOES` | Usa o template publicado ao criar DFD/ETP/TR/documentos |
| Operador da plataforma | `isPlatformOperator` | Dispara o provisionamento que semeia a biblioteca padrão |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-058 | Templates de documentos | US-107, US-108, US-109, US-110 | P0 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-107 | Criar e editar template de documento | P0 | L | 8 |
| US-108 | Publicar versão de template e definir padrão do tipo | P0 | M | 5 |
| US-109 | Layout de impressão (timbre, cabeçalho, rodapé) | P1 | M | 5 |
| US-110 | Biblioteca de templates padrão | P0 | M | 5 |
| **Total** | | | | **23** |

## Módulos e entidades
- Módulos: `document`.
- Entidades: `DocumentTemplate` (dono), `DocumentTemplateVersion` (dono); `DocumentType` (consumida — `defaultTemplateId`); `Attachment` (consumida — logo do layout, `targetType = TENANT_ASSET`).

## Telas
- SCR-033 — Templates (`/admin/templates`)
- SCR-114 — Editor de template, seções e layout (`/admin/templates/[id]/versoes/[versionId]`)

## Integrações
- Internas: worker de renderização → Gotenberg (prévia em PDF, DEC-060); S3 (armazenamento da prévia); Redis (token efêmero de prévia, TTL 24 h).
- Externas: nenhuma.

## Eventos principais
- `TemplateVersionPublished` (`template.version_published`)
- `TemplateVersionRetired` (`template.version_retired`)
- `DocumentTypeChanged` (`document_type.changed`, quando o padrão do tipo muda — `DTY-04`)

## Permissões envolvidas
- `TEMPLATE_VIEW`
- `TEMPLATE_MANAGE`
- `TEMPLATE_PUBLISH`
- `DOCUMENT_TYPE_MANAGE` (define o padrão do tipo em conjunto com `TEMPLATE_PUBLISH`)

## Regras configuráveis
- Nenhuma chave de configuração dedicada no MVP 1 — o layout inicial de um novo template usa valores fixos do sistema (RN-TPL-02); a biblioteca padrão é um fixture versionado com o release da plataforma, não uma configuração do tenant.

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| % de documentos criados a partir de um template `PUBLISHED` | 100% | auditoria `template.version_publish` vs. criação de documento |
| Tempo até o primeiro ETP/TR publicável após o provisionamento | ≤ 1 dia | timeline/auditoria do tenant |
| % de tenants que adaptaram ao menos um template da biblioteca em 90 dias | ≥ 60% | `template.version_publish` com template `isSystem = true` |

## Dependências
- **Depende de:** EP-011 (tipos de documento — `DocumentType`, DEC-017); EP-017 (provisionamento do tenant — US-099, onde a biblioteca padrão é semeada).
- **Habilita:** EP-002 (DFD), EP-003 (ETP), EP-004 (pesquisa de preços), EP-011 (documentos em geral) — todos consomem templates publicados para criar e renderizar documentos.

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Texto-base jurídico desatualizado frente a mudanças na Lei 14.133/2021 | Média | Alto | Revisão periódica pela Procuradoria do tenant; adoção opcional de atualizações da biblioteca (US-110) |
| Publicação de versão com seção/variável inválida quebra a criação de documentos | Baixa | Alto | Validação completa antes de `PUBLISHED` (RN-TPL-04 a RN-TPL-09 e RN-TPL-14) |
| Geração de prévia em PDF sobrecarrega a fila `document-render` em picos | Baixa | Médio | Rate limit dedicado (api.md §1.6) e TTL de 24h nas prévias |

## Pontos em aberto
- Nenhum — a única lacuna identificada (mecanismo de "atualização da biblioteca padrão" em US-110) já foi resolvida dentro da própria story com o conceito canônico mais próximo, sem pendência aberta para o épico.

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados
- [ ] Testes E2E das jornadas do épico passando
- [ ] Documentação e treinamento (guia do usuário) atualizados
