# Módulo Cadastro de Motorista

> **⚠ Status (2026-05-27):** a **página React `/cadastro`** (`CadastroDocumentos.tsx`)
> foi **removida** do app — o cadastro do motorista agora acontece pelo **wizard de
> candidatura / cadastro v2** (`frontend/src/components/driver/cadastro-v2/`), seja a
> partir de uma carga ou pelo botão "Cadastro" (cadastro avulso). **O backend
> FastAPI deste módulo (`:8765`) continua ATIVO e em uso** — é o sidecar de **OCR +
> consultas externas** que o wizard chama via `/api/consulta/*`. Ou seja: o frontend
> deste módulo é legado; o backend é infraestrutura viva.

Originalmente uma tela pública `/cadastro` (Portal PJ) com 5 etapas — **Motorista →
Cavalo → Carreta → Operacional → Proprietário** — onde o motorista anexa seus
documentos (CNH, CRLV, comprovante, cartão CNPJ ou CNH do proprietário PF) e o
sistema preenche o cadastro automaticamente via OCR + consultas a APIs externas
(Infosimples, Receita Federal, ANTT, DENATRAN, ViaCEP).

O backend FastAPI é **fechado em si mesmo** — independente do `backend/` Node.js do
monorepo Cargas Lamonica.

## Estrutura

```
modules/cadastro-motorista/
├── CadastroDocumentos.tsx    ← página React (rota /cadastro)
├── cadastroApi.ts            ← cliente HTTP do FastAPI
├── cadastroApi.test.ts       ← testes unitários
├── index.ts                  ← barrel exports
├── DOCUMENTACAO.md           ← documentação operacional completa (ver lá)
├── README.md                 ← este arquivo
└── backend/                  ← FastAPI Python dedicado (porta 8765)
    ├── backend/              ← código-fonte Python
    ├── run.py                ← entrypoint dev
    ├── iniciar.bat           ← wrapper Windows
    ├── requirements.txt      ← deps base
    ├── requirements-ocr.txt  ← EasyOCR (opcional, ~600 MB)
    ├── .env.example          ← template
    └── README.md             ← detalhes do backend
```

## Frontend (legado — rota removida)

A rota `/cadastro` (`CadastroDocumentos.tsx`) **não está mais registrada** em
`frontend/src/App.tsx` — foi removida quando o cadastro passou a ser feito só pelo
wizard de candidatura/cadastro v2. O componente pode permanecer no repositório como
referência histórica, mas **não é roteável**.

Cadastro do motorista hoje: `frontend/src/components/driver/cadastro-v2/DriverRegistrationWizard.tsx`
(aberto pela candidatura a uma carga **ou** pelo botão "Cadastro" do `/motorista`, que
abre o `StandaloneCadastroDialog` → wizard sem carga).

## Backend

FastAPI Python na porta `:8765`. **Independente** do `backend/` Node.js do monorepo. Veja [backend/README.md](./backend/README.md) e [DOCUMENTACAO.md](./DOCUMENTACAO.md).

Subir em dev:

```bash
cd modules/cadastro-motorista/backend
python run.py
# OU duplo-clique em iniciar.bat (Windows)
```

## Documentação completa

Para fluxo passo-a-passo, custos por API, endpoints e troubleshooting, ver [DOCUMENTACAO.md](./DOCUMENTACAO.md).
