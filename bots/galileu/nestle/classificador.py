def classificar(carga: dict) -> str:
    leilao = str(carga.get("leilao", "")).lower().strip() == "t"
    broadcast = str(carga.get("broadcast", "")).lower().strip() == "t"

    if leilao:
        return "LEILAO"
    if broadcast:
        return "ADICIONAL"
    return "CONTRATO"
