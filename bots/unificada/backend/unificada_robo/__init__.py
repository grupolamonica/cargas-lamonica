"""unificada_robo — gerador de Dossie/PDF unificado AngelLira via API.

Consulta endpoints publicos do AngelLira (api.angellira.com.br/profile/query)
para motorista (CPF), cavalo (placa) e carreta (placa) e gera um PDF unico
com layout proprio via ReportLab.

Sem Selenium. Tempo medio: 3-5s vs ~60-90s da versao Selenium printToPDF.
"""

__version__ = "1.0.0"
