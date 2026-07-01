# Módulo Cadastro de Motorista

Tela pública `/cadastro` (Portal PJ) com 5 etapas — **Motorista → Cavalo → Carreta → Operacional → Proprietário** — onde o motorista anexa seus documentos (CNH, CRLV, comprovante, cartão CNPJ ou CNH do proprietário PF) e o sistema preenche o cadastro automaticamente via OCR + consultas a APIs externas (Infosimples, Receita Federal, ANTT, DENATRAN, ViaCEP).

O módulo é **fechado em si mesmo** — frontend React e backend FastAPI ficam isolados juntos do resto do monorepo Cargas Lamonica.

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

## Frontend

Rota registrada em `frontend/src/App.tsx`:

```tsx
const CadastroDocumentos = lazy(() => import("./modules/cadastro-motorista/CadastroDocumentos"));
// ...
<Route path="/cadastro" element={<CadastroDocumentos />} />
```

Importações internas usam paths relativos (`./cadastroApi`) — o módulo é um agregado fechado.

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
