---
id: EP-013
title: "Auditoria"
mvp: 1
priority: P0
features: [FT-044, FT-045]
status: Especificado
---

# EP-013 — Auditoria

## Título
Auditoria

## Objetivo
Garantir que toda ação relevante do ContrataFlow — mudanças de dados, decisões de workflow, acessos negados, exportações e alterações de configuração — fique registrada em uma trilha transacional, íntegra, à prova de adulteração e consultável, para responder a diligências do TCU/TCE, sustentar investigações internas e cumprir as exigências de rastreabilidade da Lei 14.133/2021 sem depender de acesso direto ao banco de dados.

## Contexto e problema
- Hoje, em planilhas, sistemas legados e processos manuais, não existe uma trilha única e confiável de quem fez o quê, quando e com que resultado — a reconstrução de um histórico para uma diligência de controle externo é manual, lenta e sujeita a lacunas.
- DEC-025 separa a timeline (narrativa do processo, para usuários) da auditoria (evidência de conformidade e segurança, escopo = todas as ações relevantes, inclusive negadas, acessos e exportações, acesso restrito a `AUDIT_VIEW`). DEC-161 exige que a auditoria seja escrita explicitamente pelo caso de uso, na mesma transação da mudança de negócio — nunca via outbox assíncrono, para não haver janela em que uma ação exista sem o registro correspondente.
- DEC-138 proíbe logar tokens, senhas, CPF e conteúdo de documento; DEC-084 define o padrão de hash (SHA-256 sobre JSON canonicalizado RFC 8785) reaproveitado tanto no `rowHash` de cada registro quanto no encadeamento dos selos de integridade.
- Este épico é consumido por praticamente todas as demais stories do produto (qualquer ação mutável deve gerar um registro de auditoria), mas só tem três stories próprias: o mecanismo de registro, a selagem periódica de integridade e a consulta/exportação para quem fiscaliza.

## Escopo
- Serviço transacional de registro de auditoria (`AuditService`), com mascaramento de dados sensíveis, contexto de requisição, coalescência de ações de alto volume (ex.: autosave) e amostragem de tentativas de acesso negado (US-073).
- Selagem periódica (horária) da trilha por tenant, com encadeamento criptográfico verificável e endpoint de verificação de integridade (US-074).
- Consulta filtrada, detalhe e exportação (CSV/NDJSON) da trilha para perfis autorizados, com proteção contra CSV injection e restrição adicional durante o encerramento (`OFFBOARDING`) do tenant (US-075).

## Fora de escopo
- Política de retenção de longo prazo e expurgo de partições antigas de `audit_logs` (PEND-07 — DEC-085 já define particionamento mensal, mas não o prazo de retenção).
- Alertas automáticos (notificação) em caso de quebra de integridade detectada — ver lacuna registrada em `story-074-audit-seal.md`; tratado por log/métrica neste MVP.
- Reabertura/edição de qualquer registro de auditoria — `audit_logs` e `audit_seals` são imutáveis por definição; não há story de "correção" de auditoria.
- Auditoria de ações do MVP 2/3 (ex.: assinatura eletrônica, portal externo) — cobertas quando esses módulos forem especificados, reaproveitando o mesmo `AuditService`.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Auditor / controle interno | `AUDITOR` | Consulta, exporta e verifica a integridade da trilha para diligências e investigações |
| Administrador do órgão | `ADMIN_ORGAO` | Consulta a trilha, acompanha selos e mantém acesso mesmo durante o encerramento do tenant |
| Auditor externo (TCE) | `AUDITOR` (vínculo `EXTERNAL`) | Mesma consulta/exportação, sem o sigilo de orçamento se aplicar a ele (Lei 14.133, art. 24, I) |
| Qualquer usuário do sistema | — (todos) | Suas ações são registradas automaticamente, sem ação própria necessária |
| Desenvolvedor de outros módulos | — | Consome o `AuditService` em todo caso de uso mutável que escrever |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-044 | Registro de auditoria | US-073, US-074 | P0 |
| FT-045 | Consulta de auditoria | US-075 | P0 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-073 | Registrar auditoria transacional | P0 | L | 8 |
| US-074 | Selagem de integridade da trilha de auditoria | P1 | M | 5 |
| US-075 | Consultar e exportar a trilha de auditoria | P0 | M | 5 |
| **Total** | | | | **18** |

## Módulos e entidades
- Módulos: `audit` (dono)
- Entidades: `AuditLog` (dono — imutável, particionada por mês), `AuditSeal` (dono — imutável)

## Telas
- SCR-037 — Auditoria (`/auditoria`) — abas "Registros" (US-075) e "Selos" (US-074)

## Integrações
- Interna: `platform` (contexto de requisição/`AsyncLocalStorage` de US-084; worker de filas de US-083; persistência Prisma de US-081); `access` (autorização `AUDIT_VIEW`/`AUDIT_EXPORT` de US-097).
- Externa: nenhuma neste MVP (exportação é download direto; não há integração com sistemas do TCU/TCE).

## Eventos principais
- Nenhum evento de domínio é publicado por este épico (DEC-161, DEC-025): a auditoria é escrita de forma síncrona e explícita pelo caso de uso chamador, não via outbox. O próprio ato de registrar/selar/consultar/exportar gera entradas no `AuditLog` (`*.* ` do catálogo de events.md §7), não eventos de outbox.

## Permissões envolvidas
- `AUDIT_VIEW` — consultar registros e selos (risco `H`)
- `AUDIT_EXPORT` — exportar registros (risco `H`)

## Regras configuráveis
- `audit.coalesce.windowMinutes`, `audit.coalesce.maxRevisionGap`, `audit.coalesce.maxSizeVariationPct` — cadência de coalescência de ações de alto volume (ex.: `document.draft_update`)
- `audit.accessDeniedSampling.windowSeconds`, `audit.accessDeniedSampling.maxPerWindow` — amostragem de `access.denied` sob alto volume
- `audit.sealVerification.maxPeriods` — limite de selos verificáveis por requisição
- `audit.export.maxRows` (100.000), `audit.search.maxPeriodDays` (90) — limites de consulta e exportação
- `security.mfaPolicy` — determina (via POL-14) se `AUDIT_VIEW`/`AUDIT_EXPORT` exigem MFA

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Cobertura de rotas mutáveis com auditoria | 100% | Meta-teste de CI (RN-AUD-09) |
| Atraso da selagem horária | < 5 min após o fechamento da hora | Métrica `audit_seal_created` vs. agendamento |
| Selos íntegros verificados | 100% dos selos sem quebra detectada em operação normal | `AUD-05` / alerta operacional |
| Tempo de resposta de uma diligência (consulta + exportação) | < 5 min para auditor treinado | Observação de uso / suporte |
| Exportação de 100 mil linhas | < 30 s | Teste de performance (US-075) |

## Dependências
- **Depende de:** EP-015 (Fundação — persistência Prisma/concorrência otimista, outbox, worker de filas, logging/contexto de requisição e autorização reutilizados por este épico).
- **Habilita:** EP-001 (Processo de contratação — depende explicitamente de EP-013 no catálogo de épicos); na prática, todo épico de negócio com ações mutáveis depende transitivamente deste épico para cumprir seus próprios critérios de aceite de auditoria, ainda que só EP-001 liste a dependência de forma explícita no catálogo.

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Falha silenciosa do job de selagem (agendador para de disparar) | Baixa | Alto (quebra a prova de integridade sem ninguém notar) | Métrica de "selos pendentes por tenant" com alerta; retries e dead letter queue (US-083) |
| Crescimento de `audit_logs` degradar consultas | Média | Médio | Particionamento mensal, período obrigatório ≤ 90 dias na consulta, índices por tenant+dimensão |
| Mascaramento incompleto expor dado sensível em `changes` | Baixa | Alto (vazamento de CPF/token) | Lista fechada de campos sensíveis + redação total por padrão quando a regra não existir (US-073, V-04) |
| Amostragem/coalescência mal calibrada esconder um acesso negado relevante | Baixa | Médio | Amostragem nunca chega a zero (RN-AUD-07 sempre grava uma fração) e é sempre contabilizada em `suppressedCount` |
| Ausência de alerta automático em quebra de integridade (fora de escopo neste MVP) | Média | Alto | Log `error` + métrica cobrem o MVP 1; `NotificationType` dedicado proposto para story futura (ver lacuna em US-074) |

## Pontos em aberto
- PEND-07 — política de retenção de longo prazo de `audit_logs` (hoje só particionamento mensal está definido, sem prazo de expurgo).
- Lacuna registrada em `story-074-audit-seal.md`: ausência de `NotificationType` para alerta de quebra de integridade ou de esgotamento de tentativas do job de selagem — proposta: criar um tipo de notificação dedicado em story futura (nome a definir pelo time de produto).

## Definition of Done do épico
- [ ] Todas as features concluídas (FT-044, FT-045)
- [ ] KPIs instrumentados (cobertura de rotas, atraso de selagem, tempo de exportação)
- [ ] Testes E2E das jornadas do épico passando (registrar → selar → consultar → exportar → verificar integridade)
- [ ] Documentação e treinamento (guia do usuário para auditores) atualizados
