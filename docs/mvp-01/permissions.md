# MVP 1 — Permissões, Perfis e Políticas de Acesso

> **Documento canônico** de autorização do MVP 1. Base: [DEC-023, DEC-024, DEC-035, DEC-036, DEC-134](../architecture/decisions.md). Entidades: [`Permission`, `Role`, `RolePermission`, `RoleAssignment`, `ProcessParticipant`, `ProcessAccess`](entities.md#42-identidade-e-acesso).
> A API **sempre** decide; o frontend apenas esconde/desabilita elementos com base em `GET /api/v1/me/permissions`.

Sumário: [1. Modelo](#1-modelo-de-autorização) · [2. Catálogo](#2-catálogo-de-permissões) · [3. Perfis padrão](#3-perfis-padrão-e-matriz) · [4. Participação](#4-permissões-por-participação-no-processo) · [5. Visibilidade](#5-visibilidade-de-processos) · [6. Políticas contextuais](#6-políticas-contextuais) · [7. Implícitas](#7-capacidades-implícitas) · [8. Plataforma](#8-permissões-de-plataforma) · [9. Frontend](#9-uso-no-frontend) · [10. Testes](#10-testes-de-autorização)

---

## 1. Modelo de autorização

```
Decisão = Autenticado
        ∧ Tenant ACTIVE ∧ Vínculo ACTIVE e não expirado
        ∧ (MFA satisfeito, se a permissão for HIGH e a política exigir)
        ∧ Permissão concedida por (perfil com escopo que cobre o recurso) ∪ (participação no processo)
        ∧ Política contextual da ação (custódia, estado, segregação…)
```

| Conceito | Descrição |
|---|---|
| **Permissão** | Capacidade atômica `RESOURCE_ACTION` (catálogo global, §2) |
| **Perfil (`Role`)** | Conjunto de permissões, por tenant. 15 perfis padrão semeados (§3); o administrador pode criar perfis personalizados |
| **Atribuição (`RoleAssignment`)** | Vínculo × perfil × **escopo** × vigência. Todas as permissões do perfil valem dentro do escopo da atribuição |
| **Escopo** | `TENANT` (tudo), `ORGANIZATION` (um órgão), `DEPARTMENT` (uma unidade, com ou sem subárvore), `OWN_DEPARTMENTS` (as unidades de lotação do usuário, dinamicamente) |
| **Participação** | Acesso explícito a um processo (`ProcessParticipant`) com conjunto fixo de permissões por papel (§4) |
| **Política contextual** | Regra em código que depende do estado do recurso (custódia, status, segregação de funções…) (§6) |

### 1.1 Como um escopo "cobre" um processo
Um escopo cobre o processo P quando:
- `TENANT`: sempre (mesmo tenant).
- `ORGANIZATION = O`: `P.organizationId = O`.
- `DEPARTMENT = D` (`includeSubtree`): existe `ProcessAccess` ativo de P para alguma unidade em `{D}` ∪ subárvore(D) com motivo `REQUESTING`, `CURRENT` ou `HISTORICAL` (este último somente se `access.historicalDepartmentsCanView = true`).
- `OWN_DEPARTMENTS`: igual a `DEPARTMENT`, usando as unidades de lotação (`MembershipDepartment`) do usuário (com subárvore se `includeSubtree`).

Para permissões não ligadas a processo (ex.: `USER_MANAGE`), apenas os escopos `TENANT` e `ORGANIZATION` são considerados quando a ação recai sobre um recurso de um órgão. Permissões **não escopáveis** do catálogo (`scopable = false` — administração, catálogos, `INBOX_VIEW`, `SUPPLIER_VIEW`, `TEMPLATE_VIEW`…) não são restringidas pelo escopo da atribuição: valem em qualquer atribuição vigente (é o que a matriz §3.2 pressupõe para perfis com escopo `OWN_DEPARTMENTS`, como `REQUISITANTE` com `INBOX_VIEW`) — US-097.

### 1.2 Cálculo e cache
- `EffectivePermissions(membership)` = lista de pares `(permission, scope)` das atribuições válidas (`validFrom ≤ now < validUntil`, não revogadas, perfil ativo).
- Cache Redis `cf:{env}:t:{tenantId}:access:eff:{membershipId}` (TTL 5 min), invalidado pelos eventos `RoleUpdated`, `RoleAssigned`, `RoleRevoked`, `MembershipUpdated`, `MembershipSuspended`, `MembershipRevoked`, `DepartmentMoved`. O retrato guarda os tokens de geração lidos antes do cálculo (`access:eff-gen` do tenant e `access:eff-gen:{membershipId}` do vínculo); toda invalidação troca o token, e retrato com token antigo é descartado — um cálculo concorrente a uma revogação nunca volta a conceder o acesso revogado (US-097). Os casos de uso de atribuição, vínculo e perfil invalidam já no commit; o `PermissionCacheInvalidator` repete pelo evento.
- Toda negação gera auditoria `access.denied` (`result = DENIED`, `reasonCode = <permissão ou política>`), com amostragem de no máximo 1 registro por usuário/rota/minuto para evitar inundação.

### 1.3 Chaves de perfil do vínculo (`roleKeys`)
`roleKeys` é o conjunto de `Role.key` dos perfis que o vínculo **detém agora**: derivado das atribuições não revogadas, dentro da validade (`validFrom ≤ now < validUntil`) e de perfil ativo — a mesma regra das permissões efetivas (§1.2), sem escopo nem concessões. Não é coluna nem dado editável: muda só pelas atribuições (ROL-11/12) e pelo status do perfil. Vem do próprio tenant do vínculo (nunca de outro) — no banco, pela função `cf_user_memberships` (início de sessão e pipeline) e pela leitura dos membros no tenant da transação (multi-tenancy.md §6); no modo fake, do diretório de usuários (spec-531).

Quem decide pela chave e quem decide pela permissão efetiva:

| Ponto | Decide por | Por quê |
|---|---|---|
| Leitura de instituição em `OFFBOARDING` (pipeline de guards e `usable`/`readOnly` do ME-04/início de sessão) | Chave (`ADMIN_ORGAO`/`AUDITOR` — DEC-132) | A regra é por perfil, não por permissão; roda antes do retrato de permissões (o guard de tenant precede o de autorização) e, no ME-04, sem contexto de tenant |
| Aprovador `USER` da `approvalPolicy` (RN-DOC-07) | Permissão efetiva `APPROVAL_DECIDE` do terceiro, calculada na transação | Respeita a matriz editada do tenant (US-095) e o perfil inativo (RN-IAM-84) |
| Titular/substituto sem lotação na unidade (RN-TEN-48) | Chave (perfil de escopo padrão `TENANT`, §3.1) | Ponte mantida: o escopo real da atribuição ainda não entra nesta verificação |
| Aprovador designado por perfil no painel do processo (POL-03, só exibição) | Chave do contexto da requisição | Só exibição; a decisão (POL-03) usa os detentores do perfil com escopo sobre a unidade solicitante (US-051) |
| Job de geração de IA (POL-18, fora do pipeline HTTP) | Permissão efetiva `AI_GENERATE` sobre o processo, calculada no job; as chaves do vínculo relido entram no contexto só para a ponte e para `AccessFacade.can` | O retrato não vem do guard, mas é calculado das atribuições (`AuthorizationService.current`) |

O vínculo sem **nenhuma** atribuição gravada tem `roleKeys` vazio no banco; a ponte por chave das permissões efetivas (US-097) só tem efeito no modo fake.

---

## 2. Catálogo de permissões

Legenda: **Risco** `L`/`M`/`H` (`H` exige MFA quando `security.mfaPolicy ∈ {ADMINS, ALL}`); **Esc.** = aceita escopo de processo/unidade.

### 2.1 Processo (`process`)
| Código | Nome (pt-BR) | Risco | Esc. | Descrição / política associada |
|---|---|---|---|---|
| `PROCESS_VIEW` | Visualizar processos | L | ✔ | Ver lista, detalhe, documentos, timeline, tramitações (§5) |
| `PROCESS_CREATE` | Criar processo | M | ✔ | Criar processo cuja unidade solicitante está no escopo |
| `PROCESS_UPDATE` | Editar processo | M | ✔ | Editar dados, itens e etiquetas — exige custódia (POL-01) |
| `PROCESS_FORWARD` | Encaminhar processo | M | ✔ | Exige custódia (POL-01) |
| `PROCESS_RETURN` | Devolver processo | M | ✔ | Exige custódia (POL-01) |
| `PROCESS_CLAIM` | Assumir processo | L | ✔ | Processo na fila de unidade em que o usuário é lotado (POL-04) |
| `PROCESS_ASSIGN` | Atribuir responsável | M | ✔ | Atribuir/reatribuir dentro da unidade atual (POL-05) |
| `PROCESS_SUSPEND` | Suspender e retomar | M | ✔ | POL-07 |
| `PROCESS_CANCEL` | Cancelar processo | H | ✔ | POL-06 |
| `PROCESS_COMPLETE` | Concluir processo | M | ✔ | POL-08 |
| `PROCESS_DUPLICATE` | Duplicar processo | L | ✔ | Requer também `PROCESS_CREATE` para a unidade solicitante do novo processo |
| `PROCESS_MANAGE_PARTICIPANTS` | Gerenciar participantes | M | ✔ | POL-10 |
| `PROCESS_FOLLOW` | Seguir processo | L | ✔ | Torna-se `OBSERVER` de si mesmo |
| `PROCESS_VIEW_CONFIDENTIAL_BUDGET` | Ver orçamento sigiloso | H | ✔ | POL-09 |
| `PROCESS_SET_CONFIDENTIAL_BUDGET` | Definir sigilo do orçamento | H | ✔ | |
| `PROCESS_EXPORT` | Exportar lista de processos | M | ✔ | CSV (P2) |
| `TAG_MANAGE` | Gerenciar etiquetas | L | — | Cadastro de etiquetas do tenant |

### 2.2 Documentos (`document`, `files`, `supplier`)
| Código | Nome | Risco | Esc. | Descrição |
|---|---|---|---|---|
| `DOCUMENT_CREATE` | Criar documento livre/externo | M | ✔ | Tipos `FREE_TEXT` e `UPLOADED` |
| `DOCUMENT_UPDATE` | Editar documento livre/externo | M | ✔ | POL-02 |
| `DOCUMENT_SUBMIT` | Finalizar/submeter documento livre/externo | M | ✔ | POL-02 |
| `DOCUMENT_REOPEN` | Reabrir documento | H | ✔ | POL-11 (qualquer tipo) |
| `DOCUMENT_CANCEL` | Cancelar documento | M | ✔ | Qualquer tipo, com custódia |
| `ATTACHMENT_UPLOAD` | Anexar arquivos | M | ✔ | Inclui excluir os próprios anexos enquanto o alvo estiver editável |
| `ATTACHMENT_DELETE` | Excluir anexos de terceiros | M | ✔ | Exclusão lógica com motivo |
| `SUPPLIER_VIEW` | Visualizar fornecedores | L | — | |
| `SUPPLIER_MANAGE` | Gerenciar fornecedores | M | — | |
| `TEMPLATE_VIEW` | Visualizar templates | L | — | |
| `TEMPLATE_MANAGE` | Editar templates | M | — | Rascunhos de versão |
| `TEMPLATE_PUBLISH` | Publicar templates | H | — | |
| `DOCUMENT_TYPE_MANAGE` | Gerenciar tipos de documento | H | — | |

### 2.3 Documentos tipados (`dfd`, `etp`, `price-research`, `risk`, `term`)
| Código | Nome | Risco | Esc. | Descrição |
|---|---|---|---|---|
| `DFD_CREATE` | Criar DFD | M | ✔ | Inclui duplicar DFD |
| `DFD_UPDATE` | Editar DFD | M | ✔ | POL-02 |
| `DFD_SUBMIT` | Concluir/submeter DFD | M | ✔ | Finalizar (ou submeter, se o tipo exigir aprovação avulsa) |
| `ETP_CREATE` | Criar ETP | M | ✔ | |
| `ETP_UPDATE` | Editar ETP | M | ✔ | Inclui alternativas e estimativas |
| `ETP_SUBMIT` | Concluir/submeter ETP | M | ✔ | |
| `PRICE_RESEARCH_CREATE` | Criar pesquisa de preços | M | ✔ | |
| `PRICE_RESEARCH_UPDATE` | Editar pesquisa de preços | M | ✔ | Fontes, cotações, itens, método |
| `PRICE_RESEARCH_EXCLUDE_QUOTATION` | Desconsiderar/restaurar cotação | M | ✔ | Exige justificativa |
| `PRICE_RESEARCH_COMPLETE` | Concluir pesquisa de preços | M | ✔ | |
| `RISK_MANAGE` | Gerenciar riscos | M | ✔ | Riscos e tratamentos |
| `RISK_MAP_SUBMIT` | Concluir/submeter mapa de riscos | M | ✔ | |
| `TERM_CREATE` | Criar TR | M | ✔ | |
| `TERM_UPDATE` | Editar TR | M | ✔ | Inclui importação do ETP |
| `TERM_SUBMIT` | Concluir/submeter TR | M | ✔ | |

### 2.4 Workflow e aprovações (`workflow`, `approval`)
| Código | Nome | Risco | Esc. | Descrição |
|---|---|---|---|---|
| `WORKFLOW_VIEW` | Visualizar workflows | L | — | |
| `WORKFLOW_MANAGE` | Editar workflows | H | — | Rascunhos; regras |
| `WORKFLOW_PUBLISH` | Publicar/aposentar workflows | H | — | |
| `APPROVAL_VIEW` | Visualizar aprovações | L | ✔ | Lista de aprovações dos processos no escopo |
| `APPROVAL_DECIDE` | Decidir aprovações | H | ✔ | Somente quando designado (POL-03) |
| `APPROVAL_REASSIGN` | Redirecionar aprovação | M | ✔ | Trocar aprovador de pendência (ausência, impedimento) |

### 2.5 Colaboração, caixa, painel e auditoria
| Código | Nome | Risco | Esc. | Descrição |
|---|---|---|---|---|
| `COMMENT_CREATE` | Comentar | L | ✔ | Em processos visíveis |
| `COMMENT_MODERATE` | Moderar comentários | M | ✔ | Excluir comentários de terceiros com motivo |
| `INBOX_VIEW` | Acessar caixa de tarefas | L | — | |
| `DASHBOARD_VIEW` | Acessar dashboard | L | ✔ | Dados restritos à visibilidade de processos |
| `AUDIT_VIEW` | Consultar auditoria | H | — | |
| `AUDIT_EXPORT` | Exportar auditoria | H | — | |

### 2.6 Administração do tenant (`identity`, `access`, `tenancy`, `organization`, `catalog`)
| Código | Nome | Risco | Esc. | Descrição |
|---|---|---|---|---|
| `USER_VIEW` | Visualizar usuários | L | — | Tela de administração de usuários |
| `USER_INVITE` | Convidar usuários | H | — | |
| `USER_MANAGE` | Gerenciar usuários | H | — | Editar, lotar, suspender, reativar, revogar |
| `ROLE_VIEW` | Visualizar perfis | L | — | |
| `ROLE_MANAGE` | Gerenciar perfis | H | — | Criar/editar perfis e matriz de permissões |
| `ROLE_ASSIGN` | Atribuir perfis | H | — | POL-13 |
| `ORGANIZATION_MANAGE` | Gerenciar órgãos/entidades | H | — | |
| `DEPARTMENT_MANAGE` | Gerenciar secretarias e setores | M | — | |
| `CATALOG_MANAGE` | Gerenciar catálogos | M | — | |
| `CALENDAR_MANAGE` | Gerenciar calendário | M | — | |
| `SETTINGS_MANAGE` | Gerenciar configurações gerais | H | — | Inclui ligar/desligar a IA, limites e consumo (US-116) |

### 2.7 Inteligência artificial (`ai`)
| Código | Nome | Risco | Esc. | Descrição |
|---|---|---|---|---|
| `AI_GENERATE` | Gerar conteúdo com IA | M | ✔ | Pedir rascunho completo ou ajuste de seção de DFD, ETP, mapa de riscos e TR (POL-18). Aplicar e revisar o conteúdo usam a permissão de edição do tipo (US-115..US-122) |

**Total MVP 1: 69 permissões** (a contagem anterior, 67, estava errada — corrigida na US-094; `AI_GENERATE` entrou com o EP-020 em 2026-10-16). Fonte em código: `packages/types/src/permissions.ts` (constante `PERMISSIONS` com `code`, `module`, `riskLevel`, `scopable`, `introducedIn`), sincronizada com a tabela `permissions` por migração.

---

## 3. Perfis padrão e matriz

### 3.1 Perfis e escopo padrão de atribuição
| Perfil | Persona | Escopo padrão ao atribuir | Observação |
|---|---|---|---|
| `ADMIN_ORGAO` (ADM) | Administrador do órgão | `TENANT` | Configuração e administração; não tramita por padrão. `isProtected` |
| `GESTOR_CONTRATACOES` (GES) | Gestor de contratações | `TENANT` | Visão global, distribuição, intervenção |
| `REQUISITANTE` (REQ) | Área requisitante | `OWN_DEPARTMENTS` | Abre demandas, DFD, ETP, riscos, TR |
| `PLANEJAMENTO` (PLA) | Planejamento | `TENANT` | ETP, riscos, TR, pesquisa |
| `COMPRAS` (COM) | Compras | `TENANT` | Pesquisa de preços, fornecedores, TR |
| `LICITACOES` (LIC) | Licitações | `TENANT` | Recebe processos concluídos; edital no MVP 2 |
| `CONTABILIDADE` (CTB) | Contabilidade | `TENANT` | Tramita; dotação no MVP 2 |
| `JURIDICO` (JUR) | Jurídico/Procuradoria | `TENANT` | Tramita, comenta, decide quando designado; parecer no MVP 2 |
| `CONTROLE_INTERNO` (CI) | Controle Interno | `TENANT` | Leitura ampla, auditoria; análise no MVP 2 |
| `AUTORIDADE_COMPETENTE` (AUT) | Autoridade competente | `ORGANIZATION` | Aprovações, cancelamento, suspensão |
| `FISCAL_CONTRATO` (FIS) | Fiscal de contrato | `OWN_DEPARTMENTS` | Leitura no MVP 1; ampliado no MVP 4 |
| `GESTOR_CONTRATO` (GCT) | Gestor de contrato | `OWN_DEPARTMENTS` | Leitura e abertura de demandas no MVP 1; ampliado no MVP 4 |
| `AUDITOR` (AUD) | Auditor | `TENANT` | Somente leitura + auditoria |
| `SOMENTE_LEITURA` (LEI) | Usuário somente leitura | `OWN_DEPARTMENTS` | Somente leitura |
| `CONSULTOR_EXTERNO` (EXT) | Consultoria externa | `OWN_DEPARTMENTS` (sem lotação ⇒ nenhum processo) | Acesso efetivo via participação (§4) |

### 3.2 Matriz perfil × permissão (✔ = concedida por padrão)

| Permissão | ADM | GES | REQ | PLA | COM | LIC | CTB | JUR | CI | AUT | FIS | GCT | AUD | LEI | EXT |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `PROCESS_VIEW` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `PROCESS_CREATE` | | ✔ | ✔ | ✔ | ✔ | | | | | | | ✔ | | | |
| `PROCESS_UPDATE` | | ✔ | ✔ | ✔ | ✔ | ✔ | | | | | | ✔ | | | |
| `PROCESS_FORWARD` | | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | | ✔ | | | |
| `PROCESS_RETURN` | | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | | ✔ | | | |
| `PROCESS_CLAIM` | | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | | ✔ | | | |
| `PROCESS_ASSIGN` | | ✔ | | | | | | | | | | | | | |
| `PROCESS_SUSPEND` | | ✔ | | | | | | | | ✔ | | | | | |
| `PROCESS_CANCEL` | | ✔ | | | | | | | | ✔ | | | | | |
| `PROCESS_COMPLETE` | | ✔ | | ✔ | ✔ | ✔ | | | | | | | | | |
| `PROCESS_DUPLICATE` | | ✔ | ✔ | ✔ | ✔ | | | | | | | ✔ | | | |
| `PROCESS_MANAGE_PARTICIPANTS` | | ✔ | ✔ | ✔ | | | | | | | | | | | |
| `PROCESS_FOLLOW` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `PROCESS_VIEW_CONFIDENTIAL_BUDGET` | | ✔ | | ✔ | ✔ | | ✔ | ✔ | ✔ | ✔ | | | ✔ | | |
| `PROCESS_SET_CONFIDENTIAL_BUDGET` | | ✔ | | | | | | | | ✔ | | | | | |
| `PROCESS_EXPORT` | | ✔ | | | | | | | ✔ | | | | ✔ | | |
| `TAG_MANAGE` | ✔ | ✔ | | | | | | | | | | | | | |
| `DOCUMENT_CREATE` | | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | | ✔ | | | |
| `DOCUMENT_UPDATE` | | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | | ✔ | | | ✔ |
| `DOCUMENT_SUBMIT` | | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | | ✔ | | | |
| `DOCUMENT_REOPEN` | | ✔ | | | | | | | | ✔ | | | | | |
| `DOCUMENT_CANCEL` | | ✔ | ✔ | ✔ | ✔ | ✔ | | | | | | | | | |
| `ATTACHMENT_UPLOAD` | | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | | ✔ | | | ✔ |
| `ATTACHMENT_DELETE` | | ✔ | | | | | | | | | | | | | |
| `SUPPLIER_VIEW` | | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `SUPPLIER_MANAGE` | | ✔ | | | ✔ | ✔ | | | | | | | | | |
| `TEMPLATE_VIEW` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | | ✔ | ✔ | | | | ✔ | | |
| `TEMPLATE_MANAGE` | ✔ | ✔ | | | | | | | | | | | | | |
| `TEMPLATE_PUBLISH` | ✔ | ✔ | | | | | | | | | | | | | |
| `DOCUMENT_TYPE_MANAGE` | ✔ | | | | | | | | | | | | | | |
| `DFD_CREATE` | | ✔ | ✔ | ✔ | | | | | | | | ✔ | | | |
| `DFD_UPDATE` | | ✔ | ✔ | ✔ | | | | | | | | ✔ | | | ✔ |
| `DFD_SUBMIT` | | ✔ | ✔ | ✔ | | | | | | | | ✔ | | | |
| `ETP_CREATE` | | ✔ | ✔ | ✔ | | | | | | | | | | | |
| `ETP_UPDATE` | | ✔ | ✔ | ✔ | | | | | | | | | | | ✔ |
| `ETP_SUBMIT` | | ✔ | ✔ | ✔ | | | | | | | | | | | |
| `PRICE_RESEARCH_CREATE` | | ✔ | | ✔ | ✔ | | | | | | | | | | |
| `PRICE_RESEARCH_UPDATE` | | ✔ | | ✔ | ✔ | | | | | | | | | | ✔ |
| `PRICE_RESEARCH_EXCLUDE_QUOTATION` | | ✔ | | ✔ | ✔ | | | | | | | | | | |
| `PRICE_RESEARCH_COMPLETE` | | ✔ | | ✔ | ✔ | | | | | | | | | | |
| `RISK_MANAGE` | | ✔ | ✔ | ✔ | | | | | | | | | | | ✔ |
| `RISK_MAP_SUBMIT` | | ✔ | ✔ | ✔ | | | | | | | | | | | |
| `TERM_CREATE` | | ✔ | ✔ | ✔ | ✔ | | | | | | | | | | |
| `TERM_UPDATE` | | ✔ | ✔ | ✔ | ✔ | | | | | | | | | | ✔ |
| `TERM_SUBMIT` | | ✔ | ✔ | ✔ | ✔ | | | | | | | | | | |
| `WORKFLOW_VIEW` | ✔ | ✔ | | ✔ | ✔ | ✔ | | | ✔ | ✔ | | | ✔ | | |
| `WORKFLOW_MANAGE` | ✔ | ✔ | | | | | | | | | | | | | |
| `WORKFLOW_PUBLISH` | ✔ | | | | | | | | | | | | | | |
| `APPROVAL_VIEW` | | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `APPROVAL_DECIDE` | | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | | | | | |
| `APPROVAL_REASSIGN` | | ✔ | | | | | | | | ✔ | | | | | |
| `COMMENT_CREATE` | | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | | | ✔ |
| `COMMENT_MODERATE` | ✔ | ✔ | | | | | | | | | | | | | |
| `INBOX_VIEW` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `DASHBOARD_VIEW` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `AUDIT_VIEW` | ✔ | | | | | | | | ✔ | | | | ✔ | | |
| `AUDIT_EXPORT` | ✔ | | | | | | | | | | | | ✔ | | |
| `USER_VIEW` | ✔ | ✔ | | | | | | | | | | | | | |
| `USER_INVITE` | ✔ | | | | | | | | | | | | | | |
| `USER_MANAGE` | ✔ | | | | | | | | | | | | | | |
| `ROLE_VIEW` | ✔ | | | | | | | | | | | | ✔ | | |
| `ROLE_MANAGE` | ✔ | | | | | | | | | | | | | | |
| `ROLE_ASSIGN` | ✔ | | | | | | | | | | | | | | |
| `ORGANIZATION_MANAGE` | ✔ | | | | | | | | | | | | | | |
| `DEPARTMENT_MANAGE` | ✔ | | | | | | | | | | | | | | |
| `CATALOG_MANAGE` | ✔ | ✔ | | | | | | | | | | | | | |
| `CALENDAR_MANAGE` | ✔ | | | | | | | | | | | | | | |
| `SETTINGS_MANAGE` | ✔ | | | | | | | | | | | | | | |
| `AI_GENERATE` | | ✔ | ✔ | ✔ | ✔ | | | | | | | ✔ | | | |

> Para o `CONSULTOR_EXTERNO`, as permissões marcadas só têm efeito em processos onde ele é participante ativo (o escopo `OWN_DEPARTMENTS` sem lotação não cobre nenhum processo). Vínculos `EXTERNAL` só recebem perfis com `allowExternalAssignment` (POL-15), por isso o EXT não recebe `*_SUBMIT`, `APPROVAL_DECIDE` etc.
>
> `AI_GENERATE` acompanha os perfis que elaboram DFD, ETP, riscos e TR; não é concedida ao `CONSULTOR_EXTERNO` nem pela participação no processo (§4), e só tem efeito com a IA ligada no órgão (`ai.enabled` — US-116).
>
> `PROCESS_VIEW_CONFIDENTIAL_BUDGET` está em `CONTROLE_INTERNO` e `AUDITOR` por padrão porque o sigilo do orçamento não prevalece para os órgãos de controle interno e externo (Lei 14.133, art. 24, I).

---

## 4. Permissões por participação no processo

Participantes ativos (`ProcessParticipant`, não revogados e não expirados) recebem, **apenas naquele processo**, o conjunto fixo abaixo, somado ao que já tiverem por perfil:

| Papel | Permissões efetivas no processo |
|---|---|
| `OBSERVER` | `PROCESS_VIEW`, `PROCESS_FOLLOW`, `COMMENT_CREATE`, `APPROVAL_VIEW` |
| `COLLABORATOR` | `OBSERVER` + `ATTACHMENT_UPLOAD`, `DOCUMENT_UPDATE`, `DFD_UPDATE`, `ETP_UPDATE`, `PRICE_RESEARCH_UPDATE`, `RISK_MANAGE`, `TERM_UPDATE` (somente documentos em `DRAFT`/`RETURNED`, POL-02) |
| `CONSULTANT` | Igual a `COLLABORATOR`, obrigatoriamente com `expiresAt` (≤ validade do vínculo) |

Participantes **nunca** encaminham, devolvem, assumem, concluem, cancelam, decidem aprovações, geram conteúdo com IA (`AI_GENERATE`) ou veem orçamento sigiloso por força da participação. Aplicar conteúdo de IA é exclusivo de quem o gerou (RN-AI-13); revisar conteúdo de IA já aplicado segue a permissão de edição do tipo + POL-02, que a participação `COLLABORATOR`/`CONSULTANT` concede (US-122).

---

## 5. Visibilidade de processos

Implementa DEC-024. Predicado SQL de referência (aplicado em toda listagem/consulta de processos e recursos filhos):

```sql
-- :userId, :tenantWide, :orgIds[], :deptIds[] (escopos de PROCESS_VIEW já expandidos com subárvore e lotação)
p.tenant_id = current_setting('app.tenant_id')::uuid
AND p.deleted_at IS NULL
AND (
      :tenantWide
   OR p.organization_id = ANY(:orgIds)
   OR EXISTS (SELECT 1 FROM process_access pa
              WHERE pa.tenant_id = p.tenant_id AND pa.process_id = p.id AND pa.revoked_at IS NULL
                AND (   (pa.principal_type = 'DEPARTMENT' AND pa.department_id = ANY(:deptIds)
                         AND pa.reason IN ('REQUESTING','CURRENT','HISTORICAL','PARTICIPANT'))
                     OR (pa.principal_type = 'USER' AND pa.user_id = :userId
                         -- RN-PROC-135: consultor vencido perde a visibilidade antes do job
                         AND NOT (pa.reason = 'PARTICIPANT' AND EXISTS (
                               SELECT 1 FROM process_participants pp
                                WHERE pp.tenant_id = pa.tenant_id AND pp.id = pa.source_id
                                  AND pp.expires_at IS NOT NULL AND pp.expires_at <= now())))))
)
```

- **Unidade participante (US-012):** a concessão `DEPARTMENT/PARTICIPANT` dá visibilidade a quem tem `PROCESS_VIEW` com escopo que cubra a unidade (como `REQUESTING`/`CURRENT`) e, para a §4, as permissões do papel valem para os usuários **lotados** na unidade participante. Ela não entra no escopo de unidade do perfil (§1.1): permissões de perfil com escopo de unidade não passam a cobrir o processo por força da participação (RN-PROC-131).

| Evento | Concessões `ProcessAccess` mantidas (mesma transação) |
|---|---|
| Criação | `DEPARTMENT/REQUESTING` (secretaria e setor solicitantes); `DEPARTMENT/CURRENT` (unidade da etapa inicial); `USER/CREATOR` |
| Tramitação para outra unidade | `CURRENT` anterior → `HISTORICAL`; novo `CURRENT` para a unidade de destino |
| Atribuição/assunção | `USER/RESPONSIBLE` para o novo responsável (mantido como histórico) |
| Participante adicionado/removido | `USER|DEPARTMENT/PARTICIPANT` concedido/revogado (`revokedAt`) |
| Aprovação solicitada | `USER/APPROVER` para o aprovador resolvido (e substituto, se `allowDeputy`) ou `DEPARTMENT/CURRENT` quando o aprovador for perfil |
| Expiração de participação | Job `maintenance` revoga a concessão |

Regras complementares:
- Recurso inexistente, de outro tenant ou não visível → **404** (`PROCESS_NOT_FOUND`/`<RESOURCE>_NOT_FOUND`).
- Visível, mas sem permissão para a ação → **403** (`PERMISSION_DENIED` ou código da política).
- Documentos `RESTRICTED` (orçamento sigiloso) aparecem na lista com título e status, mas o conteúdo e o PDF exigem POL-09.

---

## 6. Políticas contextuais

| ID | Política | Regra |
|---|---|---|
| POL-01 | **Custódia** | `PROCESS_UPDATE`, `PROCESS_FORWARD`, `PROCESS_RETURN`, edição de documentos e conclusão exigem que o usuário seja o `currentResponsibleId` **ou**, se não houver responsável, lotado na `currentDepartmentId`. Status deve ser `DRAFT`, `IN_PROGRESS` ou `RETURNED` (nunca `SUSPENDED`, `CANCELED`, `COMPLETED`, `PUBLISHED`; em `AWAITING_APPROVAL` somente devolver por quem detém a custódia da etapa de aprovação). Código de erro: `NOT_PROCESS_CUSTODIAN` (403) / `INVALID_PROCESS_STATUS` (409) |
| POL-02 | **Edição de documento** | Permissão de edição do tipo + (custódia **ou** participação `COLLABORATOR`/`CONSULTANT`) + documento em `DRAFT`/`RETURNED` + tipo permitido na etapa atual (`WorkflowStage.documentTypeCodes` vazio ou contendo o tipo) + processo em `DRAFT`/`IN_PROGRESS`/`RETURNED`. Vale também para as **coleções dos documentos tipados** (`DocumentItem`, `EtpAlternative`, `PriceItem`, `Quotation`, `Risk`, `RiskTreatment`): a condição de status recai sobre o documento dono; enquanto o documento dono ainda não existir (ex.: riscos registrados antes do `RISK_MAP`), verificam-se a custódia/participação, a etapa e o status do processo. Erros: `DOCUMENT_NOT_EDITABLE` (409), `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` (422) |
| POL-03 | **Decisão de aprovação** | `APPROVAL_DECIDE` + designação: `approverUserId = usuário`; ou `approverType = ROLE` e o usuário possui o perfil com atribuição que cubra a **unidade solicitante** do processo (`TENANT`, `ORGANIZATION` do processo, ou `DEPARTMENT`/`OWN_DEPARTMENTS` contendo `requestingSecretariatId`/`requestingDepartmentId` — concessões `CURRENT`/`HISTORICAL` não contam; DEC-022); ou `DEPARTMENT_HEAD` e o usuário é titular — ou substituto com `allowDeputy` — de `approverDepartmentId`. Aprovação `PENDING`, processo não `SUSPENDED`. Segregação: se `approval.preventSelfApproval`, o usuário não pode ser `createdById` de nenhum documento coberto nem autor da versão em análise. Erros: `NOT_DESIGNATED_APPROVER` (403), `SELF_APPROVAL_FORBIDDEN` (403), `APPROVAL_NOT_PENDING` (409) |
| POL-04 | **Assumir** | `PROCESS_CLAIM` + lotado na unidade atual + processo sem responsável. Se já houver responsável: `PROCESS_ALREADY_ASSIGNED` (409) |
| POL-05 | **Atribuir** | `PROCESS_ASSIGN` com escopo `TENANT`/`ORGANIZATION` que cubra o processo, **ou** ser titular/substituto da unidade atual (§7). O novo responsável deve ter vínculo ativo, lotação na unidade atual e `PROCESS_VIEW`. Motivo obrigatório na reatribuição |
| POL-06 | **Cancelar** | `PROCESS_CANCEL` cobrindo o processo; status não final; justificativa ≥ 20 caracteres; aprovações pendentes são canceladas na mesma transação |
| POL-07 | **Suspender/retomar** | `PROCESS_SUSPEND` cobrindo o processo; suspender a partir de `IN_PROGRESS`, `AWAITING_APPROVAL` ou `RETURNED`; motivo obrigatório; retomar restaura `statusBeforeSuspension` e estende prazos |
| POL-08 | **Concluir** | `PROCESS_COMPLETE` + custódia + existe transição `COMPLETE` disponível (ou etapa atual `END`) e regras `BLOCKING` satisfeitas |
| POL-09 | **Orçamento sigiloso** | Com `isBudgetConfidential = true`, valores estimados só são exibidos a quem tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo **ou** detém a custódia atual. Demais: valor `null` + `"masked": true`. Aplicado no serializador central (`ConfidentialFieldsInterceptor`), em PDFs/renditions, exportações, timeline (`BUDGET_RESTRICTED`) e notificações. Editar valores de processo sigiloso (pesquisa de preços, valor estimado) exige a mesma condição: 403 `PERMISSION_DENIED`, `reasonCode = POL-09` (RN-PRICE-12). Agregados (dashboard): somam só os valores visíveis ao usuário; o grupo com valores excluídos traz `confidentialExcluded: true` (US-076). Renditions de documento `RESTRICTED` e anexos cujo alvo pertence a documento `RESTRICTED` (ex.: evidência de `PriceSource` em pesquisa sigilosa) exigem a mesma condição (US-067, US-069; storage.md §6) |
| POL-10 | **Participantes** | `PROCESS_MANAGE_PARTICIPANTS` cobrindo o processo; `CONSULTANT` somente para vínculos `EXTERNAL` ativos e com `expiresAt` ≤ validade do vínculo; não é possível adicionar a si mesmo como `COLLABORATOR` |
| POL-11 | **Reabrir documento** | `DOCUMENT_REOPEN` + custódia + processo em status editável + tipo permitido na etapa; justificativa obrigatória; não reabre documento coberto por aprovação `PENDING` |
| POL-12 | **Anti-bloqueio** | O tenant deve manter ≥ 1 vínculo `ACTIVE` com `ADMIN_ORGAO` vigente; operações que violem isso retornam `LAST_ADMIN_REQUIRED` (409) |
| POL-13 | **Anti-escalonamento** | `ROLE_ASSIGN`/`ROLE_MANAGE`: um usuário só pode atribuir perfis (ou adicionar a perfis permissões) que já possua com escopo igual ou mais amplo — exceto `ADMIN_ORGAO`. Erro `PRIVILEGE_ESCALATION_FORBIDDEN` (403) |
| POL-14 | **MFA** | Permissão `HIGH` + `security.mfaPolicy` `ADMINS` (perfis com alguma permissão `HIGH`) ou `ALL` → exige sessão com MFA; senão `MFA_REQUIRED` (403). **Exceção — desmascaramento em leituras (US-002 · FA-12):** `PROCESS_VIEW_CONFIDENTIAL_BUDGET` usada só para desmascarar valores em listas/consultas sem MFA exigido **não é considerada** (valores mascarados, sem 403); a resposta sinaliza `meta.confidentialStepUpAvailable` e a UI oferece o step-up |
| POL-15 | **Externos** | Vínculos `EXTERNAL` só recebem perfis com `allowExternalAssignment = true` (semeado em `AUDITOR` e `CONSULTOR_EXTERNO`); fora desses, perfis com permissões `HIGH` não podem ser atribuídos a externos (`EXTERNAL_HIGH_RISK_ROLE`). O caso típico de `AUDITOR` externo é o **órgão de controle externo** (TCE), a quem o sigilo do orçamento não se aplica (Lei 14.133, art. 24, I). Acesso expira automaticamente em `expiresAt` |
| POL-16 | **Autoproteção** | Usuário não pode suspender/revogar o próprio vínculo nem remover de si o último perfil administrativo |
| POL-17 | **Retirar solicitação de aprovação** | `APV-04`: `PROCESS_FORWARD` + ser o solicitante (`Approval.requestedById`) **ou** pertencer à unidade de origem do movimento que levou o processo à etapa `APPROVAL` atual (custódia anterior), com escopo sobre essa unidade; `Approval` em `PENDING`. Retirada de submissão avulsa (`DOC-11`): permissão de submissão do tipo do documento (US-053) |
| POL-18 | **Gerar com IA** | `AI-01`: `AI_GENERATE` cobrindo o processo + permissão de edição do tipo do documento alvo (`DFD_UPDATE`, `ETP_UPDATE`, `RISK_MANAGE`, `TERM_UPDATE`) + POL-02 sobre o alvo + IA ligada no órgão (`ai.enabled`) + provedor disponível + limites mensal do órgão e diário do usuário (US-116). Revalidada no worker antes da chamada ao provedor (falhou → geração `CANCELED`). Aplicar (`DOC-26`, `RSK-11`) e descartar (`AI-04`) são exclusivos do solicitante; revisar (`DOC-27`, `RSK-12`) exige a permissão de edição do tipo + POL-02. Erros: `AI_DISABLED` (403), `AI_PROVIDER_UNAVAILABLE` (503), `AI_USAGE_LIMIT_REACHED` / `AI_USER_DAILY_LIMIT_REACHED` (422), `AI_GENERATION_NOT_OWNED` (403) |

**Ator das operações de perfil (POL-13 · ROL-02..08):** as permissões do ator são as efetivas da requisição (§1.2 — atribuições vigentes de perfis ativos, em qualquer escopo; a ponte pelas chaves do vínculo só vale para vínculo sem nenhuma atribuição gravada), nunca as chaves do registro do vínculo. A isenção do `ADMIN_ORGAO` exige atribuição vigente dele com escopo `TENANT`, como na atribuição de perfis (ROL-09..12, que também confere o escopo de cada concessão).

---

## 7. Capacidades implícitas

Não dependem de perfil (somente de vínculo ativo):
- Ver e editar o próprio perfil e preferências (`/me`), ver as próprias notificações, sessões e permissões.
- Titular (`headUserId`) e substituto (`deputyUserId`) de uma unidade podem **atribuir/reatribuir** processos sob custódia da sua unidade (POL-05) e veem a fila da unidade na caixa de tarefas.
- Buscar usuários e unidades para seletores (`GET /users/lookup`, `GET /departments/lookup`) — retorna apenas nome, cargo, unidade e id de vínculos ativos.
- Ver processos em que possui concessão `USER` (criador, responsável, aprovador, participante). Na lista (PRC-01 · US-002), basta `PROCESS_VIEW` em algum escopo **ou** ao menos uma concessão `USER` ativa; sem nenhum dos dois → 403 `PERMISSION_DENIED` (`access.denied`, `reasonCode = PROCESS_VIEW`).

---

## 8. Permissões de plataforma

Não fazem parte de perfis de tenant; concedidas a `User.isPlatformOperator` com MFA obrigatório e auditoria `actorType = PLATFORM_OPERATOR`:

| Código | Uso |
|---|---|
| `PLATFORM_TENANT_MANAGE` | Provisionar, ativar, suspender, desativar tenants |
| `PLATFORM_SUPPORT_ACCESS` | Solicitar vínculo temporário de suporte (DEC-139) |
| `PLATFORM_QUEUE_ADMIN` | Bull Board, reprocessar dead-letter |
| `PLATFORM_AUDIT_VIEW` | Auditoria de plataforma |

---

## 9. Uso no frontend

- `GET /api/v1/me/permissions` retorna `{ permissions: [{ code, scopes: [{ type, organizationId?, departmentId?, includeSubtree }] }], implicit: { headOfDepartmentIds: [], ownDepartmentIds: [] } }` (`ownDepartmentIds` = lotações do vínculo, base do escopo `OWN_DEPARTMENTS` — US-001).
- Hooks `usePermission(code)` (tem em algum escopo) e `useProcessCapabilities(processId)` (usa `GET /processes/{id}/available-actions`, que já aplica escopo + políticas e retorna os motivos de indisponibilidade para tooltip).
- Itens de menu/rotas protegidos:

| Área | Requer |
|---|---|
| Dashboard | `DASHBOARD_VIEW` |
| Processos / Novo processo | `PROCESS_VIEW` / `PROCESS_CREATE` |
| Caixa de tarefas / Aprovações | `INBOX_VIEW` / `APPROVAL_VIEW` |
| Fornecedores | `SUPPLIER_VIEW` |
| Administração › Usuários | `USER_VIEW` |
| Administração › Perfis e permissões | `ROLE_VIEW` |
| Administração › Estrutura (órgãos, secretarias) | `ORGANIZATION_MANAGE` ou `DEPARTMENT_MANAGE` |
| Administração › Templates / Tipos de documento | `TEMPLATE_VIEW` / `DOCUMENT_TYPE_MANAGE` |
| Administração › Workflows e regras | `WORKFLOW_VIEW` |
| Administração › Catálogos / Calendário / Configurações | `CATALOG_MANAGE` / `CALENDAR_MANAGE` / `SETTINGS_MANAGE` |
| Auditoria | `AUDIT_VIEW` |

Botões indisponíveis são **ocultados** quando o usuário nunca poderia executá-los e **desabilitados com explicação** quando a indisponibilidade é contextual (ex.: "Encaminhar — há 2 pendências na etapa").

---

## 10. Testes de autorização

- **Matriz gerada:** teste table-driven que percorre todas as rotas (metadados `@RequirePermission`) × perfis padrão × escopos, comparando com esta matriz (fonte: `packages/types`).
- **Meta-teste:** toda rota mutável deve declarar permissão e política (`@RequirePermission`, `@Policy`) ou estar na lista explícita de rotas públicas/implícitas; o build falha caso contrário.
- **Visibilidade:** cenários com processo em unidade A, usuário de B com `OWN_DEPARTMENTS`, histórico de tramitação, participação expirada, aprovador designado.
- **Políticas:** um teste por POL (sucesso e violação), incluindo segregação de funções, anti-escalonamento e anti-bloqueio.
- **Multi-tenant:** toda rota com ID de outro tenant → 404 (suíte "tenant leak", ver [tests.md](tests.md)).
