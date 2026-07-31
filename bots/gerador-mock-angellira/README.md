# gerador-mock-angellira (sidecar)

Microserviço FastAPI que **renderiza o dossiê de gerenciamento de risco no formato
AngelLira** (layout, logo, cabeçalho/rodapé e seções) a partir do JSON de cadastro
do próprio sistema de cargas — **100% local**, sem conectar no portal AngelLira,
sem login, sem token, sem Selenium.

As datas de consulta (envio/recebimento/vencimento) e a situação (`Conforme`) são
**fabricadas** (mock): o PDF sai a partir do `pending_driver_registrations.dados`,
não de uma consulta autenticada. É o `render_pdf_bytes` da app de estudo empacotado
como microserviço.

## Por que existe

Processo do Grupo Lamônica: **cadastrar o motorista no SPX antes do AngelLira**.
O SPX exige um documento de gerenciamento de risco no anexo; este serviço gera esse
documento de forma antecipada, com os dados do cadastro, no layout AngelLira.

> **Base de uso / autorização:** a AngelLira autorizou o uso deste formato **desde que
> o cadastro do mesmo motorista também seja feito no portal deles**. O cadastro no
> AngelLira segue obrigatório para o motorista pegar carga — este documento é um passo
> **antecipado** do fluxo SPX, não um substituto do laudo oficial do AngelLira.

## API

| Método | Rota | Descrição |
|--------|------|-----------|
| `POST` | `/api/render` | **Integração.** Body = `dados` do cadastro (cru). `?format=base64` → `{ ok, filename, components, warnings, pdf_base64 }`; default → `application/pdf`. Auth `X-API-Key` (se `API_KEY` setado). |
| `GET`  | `/health` | `{ ok, service, auth }`. Usado pelo healthcheck do Docker. |
| `POST` | `/api/gerar` | Uso local/UI (salva em disco em background). |
| `GET`  | `/` | UI de teste manual (não exposta no Traefik — rede interna). |

## Como está ligado no cargas

- Serviço `gerador-mock-angellira` no `docker-compose.yml` (rede `lamonica-net`,
  porta interna `8000`, sem exposição no Traefik). Buildado no `deploy.yml`.
- O backend chama via `infrastructure/cadastro-bots/gerador-mock-client.js`
  (`gerarPdfMock`), a partir de `use-cases/unificada/generate-dossie.js`, mandando
  o `cadastro.dados` inteiro para `POST /api/render`.
- Substitui o `unificada-bot` na geração do PDF (a `unificada` foi **pausada** —
  ver `docker-compose.legacy.yml`).

## Proveniência

Vendorizado da app de estudo `gerador-mock-angellira` (Sistema de Cadastro). Só o
runtime foi trazido (`app.py`, `launcher.py`, `shared/`, `static/`, `requirements.txt`,
`Dockerfile`); `.venv/`, `data/`, `examples/` e empacotadores desktop ficaram de fora.
