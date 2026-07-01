# Monitor → Planilha (write-back em tempo real)

Por padrão o sistema **lê** a planilha (export CSV) e grava a alocação só no banco
(`cargas.alloc_*`). O write-back é **opcional** e, quando ligado, espelha cada
edição do Monitor (combobox inline, modal e arrastar) **de volta** na planilha,
em tempo real.

## Como funciona

- `backend/src/application/google-sheets/sheet-writeback.js` →
  `writeAllocationsToSheet(updates)` faz um POST best-effort pra um endpoint
  (Apps Script web app). **Nunca lança**: o banco é a fonte da verdade; se a
  planilha falhar, a edição já está salva e só logamos um aviso.
- Ligado **apenas** se `GOOGLE_SHEET_WRITEBACK_URL` estiver setado (senão no-op).
- Escreve o valor **efetivo** (`alloc_* ?? sheet_*`) nas colunas Motoristas/CAVALO/CARRETA
  (E/F/G) da linha do LH. `""` limpa a célula.
- Wired em `update-monitor-allocation.js` (inline/modal) e
  `reassign-monitor-allocations.js` (arrastar), **após** o commit no banco.

## Latência / não-bloqueante (importante)

O Apps Script é **lento** (~1–20s por chamada, variável; cold start + execução
no Google). Por isso o write-back é **fire-and-forget**: o backend grava no banco,
**responde na hora** e dispara o POST pra planilha **em background** (sem `await`).
O operador nunca espera o Google — a edição é instantânea e a planilha espelha
alguns segundos depois.

O Apps Script abaixo usa **busca indexada** (`TextFinder` escopado na coluna A)
em vez de ler a coluna inteira (`getValues` de milhares de linhas) — isso derruba
a execução de ~20s pra ~1–2s. **Se você ainda tem a versão antiga (com `getValues`/
`indexOf`), recole a versão abaixo e reimplante** (Nova versão).

## Env (backend)

```
GOOGLE_SHEET_WRITEBACK_URL="https://script.google.com/macros/s/.../exec"
GOOGLE_SHEET_WRITEBACK_SECRET="um-segredo"
```

## Setup do endpoint (Apps Script — usado no staging/teste)

Na planilha alvo: **Extensões → Apps Script**, cole o script abaixo (troque o
`SECRET` e o `DATA_GID` pela aba de dados), salve, e **Implantar → App da Web**
(*Executar como:* Eu · *Acesso:* Qualquer pessoa). Pegue a URL `.../exec`.

> Importante: ao editar o código, reimplante com **"Nova versão"** (editar não
> atualiza o app publicado).

```javascript
const DATA_GID = 438306494;             // gid da aba de dados
const SECRET   = "TROQUE-ESTE-SEGREDO"; // == GOOGLE_SHEET_WRITEBACK_SECRET

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SECRET) return out_({ ok:false, error:"forbidden" });
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheets().filter(s => s.getSheetId() === DATA_GID)[0];
    if (!sheet) return out_({ ok:false, error:"aba (gid) nao encontrada" });
    const lhRange = sheet.getRange(1, 1, sheet.getLastRow(), 1); // coluna A (LH)
    let updated = 0;
    (body.updates || []).forEach(u => {
      const lh = String(u.lh || "").trim();
      if (!lh) return;
      // Busca indexada server-side (NÃO lê a coluna inteira) — ~10x mais rápido.
      const cell = lhRange.createTextFinder(lh).matchEntireCell(true).findNext();
      if (!cell) return;
      sheet.getRange(cell.getRow(), 5, 1, 3).setValues([[u.motorista || "", u.cavalo || "", u.carreta || ""]]); // E,F,G
      updated++;
    });
    return out_({ ok:true, updated });
  } catch (err) { return out_({ ok:false, error:String(err) }); }
}
function out_(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
```

## Produção

Para prod, prefira uma **service account** (Sheets API) no lugar do Apps Script
com acesso "qualquer pessoa", ou um Apps Script protegido por segredo forte +
deploy dedicado na planilha de produção. O transporte é trocável (só muda como
`writeAllocationsToSheet` envia); a lógica de "quais linhas mudaram" é a mesma.

> Trade-off: o write-back **re-acopla** o sistema à planilha (o oposto de
> "abandonar a planilha"). Use de forma consciente — em geral só na transição.
