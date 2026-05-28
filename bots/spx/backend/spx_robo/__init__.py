"""spx_robo: cliente HTTP da API interna do portal SPX (Shopee Express BR).

Estrutura:
  - client.SPXClient      cliente HTTP autenticado (cookies + headers)
  - auth                  load/save de cookies, validacao de sessao
  - constants             retcodes, enums (transport_type, gender, cnh_type)
  - lookups               vehicle_types, cities, stations, attributes
  - uploads               multipart de fotos/docs (CNH, RG, CRLV+OCR, selfie)
  - drivers               validate/draft/submit do driver-request
  - flow_motorista        orquestra cadastro end-to-end

Sidecar FastAPI em backend/main.py expoe POST /spx/motorista pro painel Node.
"""

__version__ = "0.1.0"
