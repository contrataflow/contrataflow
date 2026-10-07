---
id: US-NNN
title: "<Título da story>"
epic: EP-NNN
feature: FT-NNN
mvp: 1
priority: P0          # P0 | P1 | P2 | P3
estimate: M           # XS | S | M | L | XL
status: Especificada  # Especificada | Pronta para desenvolvimento | Em desenvolvimento | Concluída | Cancelada
depends_on: [US-NNN]
modules: [process]                 # módulos de DEC-040
screens: [SCR-NNN]                 # inventário em mvp-01/features.md (Apêndice A)
endpoints: [PRC-NN]                # catálogo em mvp-01/api.md §3
permissions: [PROCESS_CREATE]      # catálogo em mvp-01/permissions.md
events: [ProcessCreated]           # catálogo em mvp-01/events.md
---

# US-NNN — <Título da story>

<!--
REGRAS DO PADRÃO DE CARD (não remover seções; manter a ordem exata das 28 seções abaixo):
- Use SOMENTE nomes existentes nas fontes canônicas: entities.md, permissions.md, events.md, api.md, decisions.md.
  Se precisar de algo novo, registre em "Dependências > Lacunas nas fontes canônicas" — não invente silenciosamente.
- Gherkin com palavras-chave em inglês e texto em pt-BR. Obrigatório ter cenários marcados com:
  [Sucesso] [Validação] [Permissão] [Tenant incorreto] [Duplicidade] [Concorrência] [Falha de banco] [Falha de integração]
  Quando uma categoria não se aplica literalmente, adapte (ex.: duplicidade = reenvio/idempotência; integração = Redis/S3/fila/Authentik/SMTP/Gotenberg).
- Mensagens ao usuário em pt-BR, claras e com ação de recuperação.
- Este bloco de comentário deve ser removido do card final.
-->

## Título
<Título curto, verbo no infinitivo>

## Descrição
**Como** <persona>, **quero** <capacidade>, **para** <benefício>.

<Parágrafo com o resumo do comportamento esperado.>

## Contexto
<Por que existe; situação atual nos órgãos; base legal quando houver; decisões (DEC-xxx) e stories relacionadas.>

## Objetivo
<Resultado mensurável que a story entrega.>

## Persona
- **Principal:** <persona> (perfil `<ROLE_KEY>`)
- **Secundárias:** <…>

## Pré-condições
- <estado do sistema/usuário necessário>

## Fluxo principal
1. <passo do usuário>
2. <resposta do sistema>
…

## Fluxos alternativos
- **FA-01 — <nome>:** <descrição>
- **FA-02 — <nome>:** <descrição>

## Regras de negócio
- **RN-<ÁREA>-01** — <regra objetiva e testável>
- **RN-<ÁREA>-02** — <…> (configurável por `<chave de configuração>` quando aplicável)

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| | | | | | |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | | Front + API (Zod) | | `VALIDATION_ERROR` |

## Permissões
- **Permissão:** `<CODE>` com escopo que cubra <…>
- **Políticas:** POL-NN (<resumo>)
- **MFA:** <exigido ou não, conforme riskLevel e política>
- **Sem permissão:** <comportamento na UI e na API>

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| | | | |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| | | | |

## Critérios de aceite em Gherkin
```gherkin
Feature: <nome>

  Background:
    Given que o usuário está autenticado no tenant "Prefeitura A"
    And possui vínculo ativo

  Scenario: [Sucesso] <…>
    Given …
    When …
    Then …
    And deve gerar registro de auditoria "<ação>"
    And deve gerar o evento <Evento>

  Scenario: [Validação] <…>
  Scenario: [Permissão] <…>
  Scenario: [Tenant incorreto] <…>
  Scenario: [Duplicidade] <…>
  Scenario: [Concorrência] <…>
  Scenario: [Falha de banco] <…>
  Scenario: [Falha de integração] <…>
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| | | | | |

## Dependências
- **Stories:** US-NNN (<motivo>)
- **Decisões/ADRs:** DEC-NNN, ADR-NNN
- **Configurações:** `<chave>`
- **Lacunas nas fontes canônicas:** <nenhuma | descrição>

## Impacto técnico
<Riscos, padrões estabelecidos, performance, migrações, compatibilidade.>

## Backend
- **Módulo(s):** `<módulo>`
- **Casos de uso:** `<Command/Query>`
- **Domínio:** <entidades/value objects/regras>
- **Integrações internas:** <fachadas de outros módulos>
- **Transação:** <o que acontece atomicamente>

## Frontend
- **Tela(s):** SCR-NNN (`/rota`)
- **Componentes:** <…>
- **Estados:** loading (skeleton), vazio, erro, sucesso
- **Acessibilidade e responsividade:** <…>

## Banco de dados
- **Tabelas:** <…>
- **Migrações:** <…>
- **Índices/constraints relevantes:** <…>

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| | | | | | |

## Logs
- `info` <evento de log> com <campos>
- `warn` <…>
- `error` <…>
- Nunca logar: <dados proibidos>

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| | | | |

## Testes necessários
- **Unitários:** <…>
- **Integração (Testcontainers):** <…>
- **API/contrato:** <…>
- **RBAC e multi-tenant:** <…>
- **Concorrência:** <…>
- **E2E (Playwright):** <…>
- **Acessibilidade/performance:** <…>

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI atualizado e compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**<XS|S|M|L|XL>** — <justificativa>

## Prioridade
**<P0|P1|P2|P3>** — <justificativa>
