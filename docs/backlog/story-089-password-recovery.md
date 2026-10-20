---
id: US-089
title: "Recuperar senha"
epic: EP-016
feature: FT-051
mvp: 1
priority: P0
estimate: S
status: Especificada
depends_on: [US-087]
modules: [identity, platform]
screens: [SCR-001, SCR-002]
endpoints: []          # rota do BFF (/api/auth/forgot-password — api.md §3.1)
permissions: []        # capacidade pública/implícita, como o login (US-087)
events: []              # fluxo ocorre inteiramente no Authentik; nenhum evento de domínio do ContrataFlow
---

# US-089 — Recuperar senha

## Título
Recuperar senha

## Descrição
**Como** usuário que esqueceu a senha da conta Authentik, **quero** solicitar a redefinição a partir da página de entrada, **para** voltar a acessar o ContrataFlow sem suporte manual e sem que a plataforma veja ou guarde minha senha.

A recuperação é um fluxo hospedado inteiramente no Authentik, com identidade visual do ContrataFlow (DEC-130): o ContrataFlow apenas encaminha o usuário e o recebe de volta no login ao final. Nenhuma senha ou token de redefinição transita ou é persistido pela aplicação ou pela API.

## Contexto
- O ContrataFlow não guarda senhas: identidade e credenciais são geridas pelo Authentik (DEC-053, DEC-130). A US-087 estabeleceu o login e o princípio de que nenhum token chega ao navegador; esta story estende o mesmo princípio ao esquecimento de senha.
- Hoje, nos órgãos, "esqueci a senha" costuma significar ligar para o suporte — não escala e expõe senhas a terceiros. Delegar ao Authentik elimina esse atrito.
- Mensagens que não revelam a existência de uma conta seguem o mesmo princípio de RN-IAM-18 (US-087). Story relacionada: US-090 (segundo fator), fora do escopo aqui.

## Objetivo
Permitir que qualquer usuário redefina a própria senha sem intervenção humana, em até 3 interações a partir da página de entrada, sem que nenhuma mensagem revele se um e-mail está cadastrado, e sem qualquer persistência de senha ou token pela aplicação.

## Persona
- **Principal:** Usuário com conta no Authentik que esqueceu a senha.
- **Secundárias:** Administrador do órgão (apenas orienta; não participa da redefinição).

## Pré-condições
- Authentik com *flow* de recuperação publicado, identidade visual do ContrataFlow e política de senha (RN-IAM-36) — configurado por *blueprint* (US-078).
- Usuário possui conta no Authentik (criada no primeiro login — US-087 — ou no convite — US-091).
- Página de entrada (SCR-001) disponível (US-086, US-087).

## Fluxo principal
1. Em SCR-001, o usuário clica em **"Esqueci minha senha"**.
2. O navegador acessa `GET /api/auth/forgot-password`; o BFF monta a URL do *flow* de recuperação do Authentik (sem dados do usuário), confere que o IdP responde e responde **302** (DEC-074).
3. O Authentik exibe, com a identidade visual do ContrataFlow, o formulário "Esqueceu sua senha?" e pede o e-mail.
4. Exista ou não o e-mail, o Authentik mostra a mesma mensagem genérica (RN-IAM-35) e, se existir conta, envia o próprio e-mail de redefinição (sem notificação do ContrataFlow).
5. O usuário abre o link (uso único, validade limitada — RN-IAM-37) e define a nova senha; o Authentik valida força e vazamento (RN-IAM-36).
6. Após redefinir, o Authentik invalida as sessões anteriores do usuário no IdP e revoga os refresh tokens emitidos — sessões abertas do ContrataFlow terminam na renovação seguinte (US-088) — e redireciona para `/entrar?motivo=senha-redefinida` (DEC-074).
7. SCR-001 exibe "Senha redefinida. Entre com sua nova senha."; nenhuma sessão é criada automaticamente — segue o login normal (US-087).

## Fluxos alternativos
- **FA-01 — E-mail não cadastrado:** idêntico ao passo 4; nada diferencia do caso de sucesso.
- **FA-02 — Link expirado ou já usado:** "Este link não é mais válido. Solicite uma nova recuperação.", com atalho para reiniciar. No Authentik, o link reaberto (usado ou vencido) recomeça o pedido pelo e-mail, sem etapa de nova senha; o texto é o do próprio IdP.
- **FA-03 — Senha fora da política:** o Authentik exibe o motivo (curta, comum ou vazada) e mantém o formulário.
- **FA-04 — Usuário bloqueado pela plataforma:** a redefinição é concluída normalmente no Authentik; ao tentar entrar depois, recebe o bloqueio de sempre (US-087 FA-06) — a senha nova não concede acesso.
- **FA-05 — `returnTo` presente:** preservado e devolvido ao `/entrar` ao final, com as validações de RN-IAM-03 (US-087). O BFF guarda o destino validado num cookie próprio (o Authentik não o recebe); se a recuperação partiu do formulário do Authentik, vale o destino do login em curso (DEC-074).

## Regras de negócio
- **RN-IAM-34** — `GET /api/auth/forgot-password` é rota pública do BFF que apenas redireciona (302) ao *flow* de recuperação do Authentik; não recebe nem repassa e-mail, senha ou identificador do usuário.
- **RN-IAM-35** — Toda mensagem do fluxo é genérica quanto à existência da conta (RN-IAM-18); a página não exibe nome nem dado de nenhuma instituição (DEC-012).
- **RN-IAM-36** — A política do Authentik exige senha com no mínimo 12 caracteres e rejeita senhas presentes em bases de vazamentos conhecidos, em toda redefinição ou troca futura. O ContrataFlow não define, valida nem armazena senhas (DEC-130); a conformidade é responsabilidade exclusiva da configuração do Authentik (US-078).
- **RN-IAM-37** — O link de redefinição é de uso único, expira conforme a configuração do *flow*, e sua posse não autentica no ContrataFlow — só permite trocar a senha no IdP.
- **RN-IAM-38** — `GET /api/auth/forgot-password` segue o limite de 20 req/min por IP dos demais endpoints de `/api/auth/*` (RN-IAM-15, US-087) e responde com `Cache-Control: no-store` (RN-IAM-19).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Link "Esqueci minha senha" | — | ação | — | Sempre visível e habilitado em SCR-001 | — |
| E-mail | `email` | texto | Sim | Coletado e validado só pelo Authentik; nunca chega ao ContrataFlow | — |
| Nova senha | — | senha | Sim | Coletada e validada só pelo Authentik (RN-IAM-36); nunca chega ao ContrataFlow | — |
| *(técnico)* Motivo de retorno | `motivo` (query de `/entrar`) | texto curto | Não | `senha-redefinida` | gerado pelo Authentik/BFF |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Força/vazamento da senha (RN-IAM-36) | Authentik | "Escolha uma senha com pelo menos 12 caracteres, que não tenha sido exposta em vazamentos conhecidos." | — |
| V-02 | Link expirado ou já usado | Authentik | "Este link não é mais válido. Solicite uma nova recuperação." | — |
| V-03 | `returnTo` fora do padrão aceito | BFF (RN-IAM-03) | — (substituído por `/painel` silenciosamente) | — |

## Permissões
- **Permissão:** nenhuma — rota pública, como o login (US-087).
- **Políticas:** nenhuma.
- **MFA:** não se aplica (a troca de senha não autentica; o segundo fator volta a ser exigido no login seguinte, conforme a política vigente — US-090).
- **Sem permissão:** não se aplica (acessível a qualquer visitante).

## Eventos gerados
Nenhum. O fluxo ocorre inteiramente no Authentik; o ContrataFlow não participa de nenhuma transação de domínio.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma do ContrataFlow. O e-mail de redefinição é enviado pelo próprio Authentik (template com identidade visual do ContrataFlow, configurado no IdP). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Recuperar senha

  Background:
    Given que a instituição "Prefeitura de São José" está ativa
    And o fluxo de recuperação de senha está publicado no Authentik

  Scenario: [Sucesso] Redefinir a senha e entrar novamente
    Given que "Cláudia" possui conta no Authentik com e-mail "claudia@pmsj.gov.br"
    When "Cláudia" clicar em "Esqueci minha senha", seguir o fluxo do Authentik e definir uma nova senha válida
    Then "Cláudia" deve ser levada a "/entrar?motivo=senha-redefinida" e conseguir entrar com a nova senha

  Scenario: [Validação] Senha nova não atende à política
    When "Cláudia" tentar definir a senha "123456789012"
    Then o Authentik deve recusá-la e manter a senha anterior válida

  Scenario: [Permissão] Usuário bloqueado pela plataforma redefine a senha mas continua sem acesso
    Given que o usuário de "Bruno" está com status "BLOCKED"
    When "Bruno" concluir a redefinição e tentar entrar no ContrataFlow
    Then "Bruno" deve ver a página de erro 403 "Seu acesso ao ContrataFlow está bloqueado"

  Scenario: [Tenant incorreto] Página de recuperação não revela nenhuma instituição
    When qualquer usuário acessar "/api/auth/forgot-password"
    Then a página do Authentik não deve citar nome nem permitir inferir nenhuma instituição vinculada ao e-mail

  Scenario: [Duplicidade] E-mail não cadastrado recebe a mesma mensagem genérica
    When alguém informar um e-mail inexistente no formulário de recuperação
    Then o Authentik deve exibir a mensagem genérica de sempre, sem indicar que o e-mail não existe

  Scenario: [Concorrência] Reutilização do link já usado
    Given que "Cláudia" já redefiniu a senha usando um link de recuperação
    When alguém tentar abrir o mesmo link novamente
    Then o Authentik deve recusar o link e a senha já definida deve permanecer válida

  Scenario: [Falha de banco] PostgreSQL do ContrataFlow indisponível durante a recuperação
    Given que o PostgreSQL do ContrataFlow está indisponível
    When "Cláudia" concluir a recuperação inteiramente no Authentik
    Then a senha deve ser redefinida com sucesso, pois o fluxo não depende do banco do ContrataFlow

  Scenario: [Falha de integração] Authentik indisponível
    Given que o Authentik está fora do ar
    When "Cláudia" clicar em "Esqueci minha senha"
    Then o ContrataFlow deve exibir "O serviço de autenticação está indisponível. Tente novamente em instantes."
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Authentik indisponível (ou *flow* não publicado) | 302 → SCR-002 (`/recuperar-senha?motivo=indisponivel`) | — | "O serviço de autenticação está indisponível. Tente novamente em instantes." | Componente de erro de SCR-001; mantém `returnTo`; botão "Tentar novamente" (DEC-074) |
| `returnTo` inválido | 302 | — | — (silencioso) | Redireciona para `/painel` |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |
| Link/token inválido ou expirado (no Authentik) | — | — | "Este link não é mais válido. Solicite uma nova recuperação." | Tela do Authentik; atalho para reiniciar |
| Erro inesperado no BFF | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-087 (mensagens genéricas e `returnTo`: RN-IAM-03, RN-IAM-18, RN-IAM-19). US-078 (Authentik por *blueprint*, inclui o *flow* de recuperação e a política de senha).
- **Decisões/ADRs:** DEC-012, DEC-053, DEC-130, DEC-135, DEC-137, DEC-138; ADR-003.
- **Configurações:** nenhuma por tenant (política de senha e *flow* são globais do Authentik).
- **Lacunas nas fontes canônicas:** nenhuma (rota registrada na lista do BFF em api.md §3.1).

## Impacto técnico
Nenhuma tabela nova nem transação de domínio: a rota do BFF é um redirecionamento sem estado. Risco principal é de configuração (URL do *flow* do Authentik incorreta) — mitigado por *blueprint* versionado (US-078) e teste E2E contra Authentik real. Reaproveita a infraestrutura de `returnTo` e cabeçalhos de segurança de US-087.

## Backend
- **Módulo(s):** `identity` (BFF); sem uso da API NestJS.
- **Casos de uso:** nenhum comando/consulta de domínio; apenas `BuildAuthentikRecoveryUrl` (utilitário do BFF).
- **Integrações internas:** configuração do cliente Authentik já usada por US-087.
- **Transação:** não há; nenhuma escrita em banco.

## Frontend
- **Tela(s):** SCR-001 (`/entrar`) com o link "Esqueci minha senha"; SCR-002 (`/recuperar-senha`) apenas aciona `GET /api/auth/forgot-password` e redireciona.
- **Componentes:** link de texto em SCR-001; nenhum formulário novo no ContrataFlow.
- **Estados:** redirecionamento imediato (sem loading relevante); erro de indisponibilidade reaproveita o componente de erro de SCR-001.
- **Acessibilidade e responsividade:** o link segue o padrão de foco e contraste de SCR-001; a experiência de redefinição é renderizada pelo Authentik.

## Banco de dados
- **Tabelas:** nenhuma. **Migrações:** nenhuma. **Índices/constraints relevantes:** não se aplica.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| BFF | GET | `/api/auth/forgot-password` | `returnTo?` | `302` → *flow* de recuperação do Authentik | 302, 429, 503 |

## Logs
- `info` `auth.recovery_redirect` — `correlationId`, IP mascarado, `returnToAccepted` (sem e-mail, sem dados do usuário).
- `warn` `auth.recovery_unavailable` — quando o Authentik não responde (`providerStatus`: status HTTP ou nulo).
- **Nunca logar:** e-mail informado, senha, token/link de redefinição.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | — | Nenhum registro do ContrataFlow: a ação ocorre fora do seu perímetro transacional. O Authentik mantém o próprio registro de eventos de identidade. |

## Testes necessários
- **Unitários/Integração:** construção da URL de redirecionamento (parâmetros, ausência de PII); validação de `returnTo` (RN-IAM-03); sem banco envolvido.
- **API/contrato:** `GET /api/auth/forgot-password` sempre 302 com `Location` para o Authentik e `Cache-Control: no-store`.
- **RBAC e multi-tenant/Concorrência:** rota não aceita nem expõe `X-Tenant-Id`; reenvio/reuso do mesmo link (comportamento do Authentik, cobrir via E2E).
- **E2E (Playwright + Authentik real):** jornada completa "esqueci minha senha" → e-mail → redefinição → login com a nova senha.
- **Acessibilidade/performance:** axe no link de SCR-001; redirecionamento do BFF < 100 ms.

## Definition of Done
- [ ] Cenários Gherkin automatizados (contrato + E2E) e passando no CI
- [ ] Nenhuma mensagem revela a existência de uma conta; rota do BFF documentada e lacuna de `api.md` registrada
- [ ] Logs sem dados sensíveis (e-mail, senha, token); acessibilidade (axe) do link em SCR-001
- [ ] Revisão de segurança aprovada; documentação (este card) atualizada

## Estimativa
**S** — fluxo majoritariamente delegado ao Authentik; o ContrataFlow só adiciona um link e uma rota de redirecionamento sem estado.

## Prioridade
**P0** — sem recuperação de senha, qualquer usuário que a esqueça fica bloqueado fora de um canal de suporte manual; é parte essencial da jornada de autenticação do MVP 1.
