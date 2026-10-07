---
id: EP-012
title: "Comentários"
mvp: 1
priority: P0
features: [FT-043]
status: Especificado
---

# EP-012 — Comentários

## Título
Comentários

## Objetivo
Dar à instrução do processo um espaço de discussão contextual — comentários no processo e em documentos, com menção a pessoas e unidades — que substitua e-mails e mensageiros paralelos, com histórico rastreável e aviso a quem precisa se posicionar.

## Contexto e problema
- Hoje a discussão da instrução de um processo acontece em e-mails, mensageiros e despachos impressos; o que motivou uma alteração num ETP ou TR se perde e não fica vinculado ao processo (DEC-010 — o processo é o agregado central de todo artefato de negócio).
- Chamar a atenção de alguém específico depende de repetir o nome em texto livre ou de canais fora do sistema, sem garantia de que a pessoa tenha acesso ao processo nem registro de que foi avisada.
- Comentário é artefato do módulo `collaboration` (DEC-040); participantes `OBSERVER`, `COLLABORATOR` e `CONSULTANT` podem comentar por força da participação (DEC-036). Visibilidade segue a visibilidade do próprio processo (DEC-024); orçamento sigiloso é protegido pela política central (POL-09). Rich text é validado contra schema restrito e nunca renderizado como HTML do cliente (risco de XSS); nada é excluído fisicamente (DEC-034).

## Escopo
- Comentar no processo e em documentos (com âncora opcional em seção), responder (1 nível), editar (até 15 min) e excluir o próprio comentário.
- Moderação (exclusão por terceiro com motivo obrigatório).
- Menção a usuários e a unidades (até 50 membros) dentro do comentário, com notificação a quem tem visibilidade do processo.

## Fora de escopo
- Comentários restritos por unidade (PEND-11).
- Reações/curtidas, menções em outros artefatos fora de comentário, histórico de versões do texto do comentário.
- Resolução de comentário (campos `resolvedAt`/`resolvedById` já previstos na entidade, mas marcados P2 — fora do MVP 1).

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Área requisitante / colaborador | `REQUISITANTE`, `COLABORADOR`, `CONSULTANT` | Discutir a instrução e chamar atenção de quem precisa agir |
| Gestor de contratações | `GESTOR_CONTRATACOES` | Acompanhar e moderar discussões no processo |
| Perfis só leitura | `AUDITOR`, `SOMENTE_LEITURA` | Ler comentários sem poder comentar |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-043 | Comentários e menções | US-071, US-072 | P0 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-071 | Comentar no processo e em documentos | P0 | M | 5 |
| US-072 | Mencionar usuários e unidades | P1 | M | 5 |
| **Total** | | | | **10** |

## Módulos e entidades
- Módulos: `collaboration` (dono); consome `process`, `document`, `access`, `organization`, `timeline`, `notification`, `audit`, `platform`.
- Entidades: `Comment` (dono), `Mention` (dono); `Process`, `Document`, `ProcessAccess`, `Department`, `User` (consumidas).

## Telas
- SCR-006 — Detalhe do processo (painel situacional + aba Comentários); as demais telas com comentário embutido no editor de documento (SCR-007 a SCR-012, SCR-105) seguem o mesmo compositor, detalhadas nas stories.

## Integrações
- Nenhuma integração externa. Internamente depende do `NotificationDispatcher` (EP-019/US-111) para `COMMENT_REPLY` e `MENTIONED`, e do projetor síncrono de Timeline (EP-010) para `COMMENT_ADDED`/`COMMENT_REMOVED`.

## Eventos principais
- `CommentCreated`, `CommentUpdated`, `CommentDeleted`, `UserMentioned`

## Permissões envolvidas
- `COMMENT_CREATE`, `COMMENT_MODERATE`, `PROCESS_VIEW_CONFIDENTIAL_BUDGET`

## Regras configuráveis
- Nenhuma chave de configuração própria identificada nas stories do épico.

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Processos com ao menos um comentário em 30 dias | ≥ 50% dos processos ativos | Consulta analítica sobre `comments` |
| Notificações `MENTIONED`/`COMMENT_REPLY` entregues com sucesso | ≥ 99% | Logs do `NotificationDispatcher` |
| Tempo entre menção e primeira visualização pelo mencionado | p50 < 4 h em horário comercial | Evento de leitura da notificação |

## Dependências
- **Depende de:** EP-001 (Processos — processo como agregado central, DEC-010); EP-019 (Notificações — `NotificationDispatcher` para `MENTIONED`/`COMMENT_REPLY`).
- **Habilita:** nenhum épico do MVP 1 depende de EP-012.

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| XSS via conteúdo rico do comentário | Baixa | Alto | Schema restrito server-side (RN-CMT-03); HTML do cliente nunca renderizado |
| Menção notificar quem não deveria ver o processo | Baixa | Alto | Revalidação de visibilidade no commit (DEC-024, RN-CMT-22) |
| Unidade grande gerar excesso de notificações | Média | Médio | Cap de 50 membros no autocomplete (RN-CMT-21) |

## Pontos em aberto
- PEND-11 — Comentários restritos por unidade (fora do MVP 1).
- PEND-07 — Política de retenção de conteúdo excluído logicamente (`comments`, `mentions`).

## Definition of Done do épico
- [ ] Todas as features concluídas (FT-043)
- [ ] KPIs instrumentados
- [ ] Testes E2E das jornadas do épico passando (comentar, responder, editar, excluir, moderar, mencionar)
- [ ] Documentação e treinamento (guia do usuário) atualizados
