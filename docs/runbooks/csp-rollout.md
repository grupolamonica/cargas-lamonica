# Runbook — Sair da CSP em modo relatório para bloqueante (DC-283 / MED-3)

A Content-Security-Policy entra **em modo relatório**: ela não bloqueia nada, apenas reporta em `POST /api/csp-report` o que bloquearia se estivesse valendo. Este runbook é o caminho de report-only até enforce.

## Por que não já entra bloqueando

Subir CSP direto em enforce numa SPA com dezenas de telas é apagar a luz e mandar todo mundo andar: a primeira coisa quebrada só aparece quando um operador reclama que um botão parou. Em modo relatório, a lista de ajustes chega antes de alguém ser afetado.

## Por que essa política vale a pena

O build do Vite não gera **nenhum** script inline — conferido em `dist/index.html`, que tem só um `<script type="module">` externo. Isso permite `script-src 'self'` **sem** `'unsafe-inline'`, e é exatamente o `'unsafe-inline'` em `script-src` que costuma esvaziar uma CSP na prática.

Isso importa porque token de sessão e o rascunho do cadastro (CNH, CPF, endereço, dados bancários) vivem em `localStorage`: qualquer JS que execute na página lê tudo. Enquanto a migração para cookie httpOnly não acontece, a CSP é a principal defesa contra exfiltração via XSS ou dependência comprometida.

## As diretivas e o porquê de cada uma

| Diretiva | Valor | Motivo |
|---|---|---|
| `script-src` | `'self'` | Sem inline no build — o ponto forte da política |
| `style-src` | `'self' 'unsafe-inline' fonts.googleapis.com` | Radix/shadcn escrevem o atributo `style`. Injeção de estilo é risco muito menor que de script, e `style-src-attr` ainda não tem suporte uniforme |
| `font-src` | `'self' fonts.gstatic.com data:` | `index.css` faz `@import` do Google Fonts, que busca os arquivos no gstatic |
| `connect-src` | `'self' https://*.supabase.co wss://*.supabase.co` | Auth/PostgREST + Realtime |
| `img-src` | `'self' data: blob:` | Logo de cliente é **proxiada** por `/api/client-logo`, então não é preciso liberar host externo; `data:`/`blob:` cobrem preview de upload e QR |
| `frame-ancestors` | `'self'` | Substitui `X-Frame-Options` nos navegadores atuais; os dois convivem porque o antigo ainda vale em cliente velho |
| `object-src` | `'none'` | Não há plugin/embed no produto |

## Passo a passo

1. **Deploy com report-only** (o estado deste PR). Nada quebra.

2. **Colete por alguns dias.** No log do backend:

   ```bash
   docker logs lamonica-backend-1 2>&1 | grep '"csp.violation"'
   ```

   Cada linha traz `diretiva`, `bloqueado` e `documento` (só o *caminho*, sem query string). Cobrir o fim de semana e um fechamento de mês ajuda: telas pouco usadas só aparecem aí.

3. **Classifique cada violação.**

   | O que é | O que fazer |
   |---|---|
   | Recurso legítimo que esqueci | Adicionar a origem na diretiva |
   | Extensão do navegador do usuário | Ignorar — não dá para controlar e não é risco do produto |
   | Recurso que ninguém sabe explicar | **Investigar** — é o tipo de coisa que a CSP existe para achar |

4. **Ajuste e repita** até o volume estabilizar perto de zero (fora ruído de extensão).

5. **Vire bloqueante:** em `frontend/security-headers.conf`, troque o nome do cabeçalho de `Content-Security-Policy-Report-Only` para `Content-Security-Policy`. Mantenha o `report-uri` — em enforce ele continua avisando o que foi efetivamente bloqueado.

6. **Acompanhe as primeiras horas** depois do enforce. Se algo escapar, voltar para report-only é trocar uma palavra e redeployar.

## Sobre o coletor

`POST /api/csp-report` é **público de propósito**: o navegador manda o relatório sozinho, sem credencial, inclusive na tela de login. Exigir sessão cegaria justamente as páginas públicas (portal do motorista, wizard de cadastro).

Sendo público, tem contenção: teto de 60 relatórios/min/IP e recorte do que é registrado. O relatório do navegador traz `script-sample` e a URL completa da página — que numa SPA pode carregar id de recurso e, em tela pública, o CPF do fluxo. **Nada disso entra no log:** só diretiva, URI bloqueada e o *caminho* do documento.

Também **não gera evento de auditoria**: violação de CSP é sinal operacional de rollout, não fato de segurança sobre um titular. Poluir `security_audit_logs` com isso atrapalharia quem for investigar de verdade.

## O que este trabalho não resolve

Os tokens de sessão continuam em `localStorage` (`lamonica-operator-auth` / `lamonica-driver-auth`), legíveis por qualquer script que rode na página. Tirar de lá exige cookie httpOnly/SameSite, o que muda o fluxo de autenticação inteiro — trabalho próprio, ainda em aberto no MED-4.
