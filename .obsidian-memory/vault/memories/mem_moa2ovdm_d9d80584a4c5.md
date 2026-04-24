---
id: "mem_moa2ovdm_d9d80584a4c5"
type: "fact"
created: "2026-04-22T13:12:47.576Z"
updated: "2026-04-22T13:12:47.576Z"
strength: 7
version: 1
concepts: ["windows", "powershell", "hooks"]
files: []
---

# npx no Windows e um shim .cmd, Start-Process com FilePath npx falha InvalidOpera

npx no Windows e um shim .cmd, Start-Process com FilePath npx falha InvalidOperation. Fix: (Get-Command npx.cmd).Source resolve caminho absoluto antes de invocar.

## Concepts
#windows #powershell #hooks