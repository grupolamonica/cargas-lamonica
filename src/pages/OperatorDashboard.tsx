import { useDeferredValue, useState } from "react";
import {
  ArrowLeft,
  Building2,
  CalendarClock,
  ClipboardList,
  Copy,
  ExternalLink,
  Hash,
  Link2,
  MapPinned,
  Package,
  Search,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cargasDetalhadas, getCargaPath, getCargaShareUrl } from "@/data/cargas";
import { formatEstimatedTime } from "@/lib/estimated-time";

const formatOperationalDate = (value: string) =>
  format(parseISO(value), "dd/MM/yyyy HH:mm", { locale: ptBR });

const OperatorDashboard = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const publicOrigin =
    typeof window === "undefined" ? "http://localhost:8080" : window.location.origin;

  const normalizedQuery = deferredSearchTerm.trim().toLowerCase();

  const filteredCargas = cargasDetalhadas.filter((carga) => {
    if (!normalizedQuery) {
      return true;
    }

    return [
      carga.id,
      carga.cliente.nome,
      carga.cliente.cnpj,
      carga.origemCidade,
      carga.destinoCidade,
      carga.produto,
      carga.tipoVeiculo,
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  });

  const totalClientes = new Set(cargasDetalhadas.map((carga) => carga.cliente.id)).size;
  const totalEstados = new Set(
    cargasDetalhadas.flatMap((carga) => [carga.origemEstado, carga.destinoEstado]),
  ).size;

  const copyText = async (value: string, successMessage: string) => {
    try {
      if (!navigator.clipboard) {
        throw new Error("clipboard-unavailable");
      }

      await navigator.clipboard.writeText(value);
      toast.success(successMessage);
    } catch {
      toast.error("Nao foi possivel copiar.");
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,hsl(var(--accent)/0.20),transparent_55%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_right,hsl(var(--primary)/0.26),transparent_48%)]" />

        <div className="relative mx-auto max-w-7xl px-4 pb-10 pt-8 sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <Button
              asChild
              variant="ghost"
              className="w-fit rounded-2xl bg-white/8 text-white hover:bg-white/12 hover:text-white"
            >
              <Link to="/">
                <ArrowLeft className="h-4 w-4" />
                Voltar para painel publico
              </Link>
            </Button>

            <Button
              variant="outline"
              className="w-fit rounded-2xl border-white/15 bg-white/8 text-white hover:bg-white/12 hover:text-white"
              onClick={() => copyText(publicOrigin, "Endereco base copiado.")}
            >
              <Link2 className="h-4 w-4" />
              Copiar base dos links
            </Button>
          </div>

          <div className="mt-8 grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
            <section className="rounded-[32px] border border-white/10 bg-white/[0.08] p-6 backdrop-blur-xl sm:p-8">
              <p className="text-[11px] font-extrabold uppercase tracking-[0.28em] text-white/55">
                Operacao interna
              </p>
              <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-white sm:text-5xl">
                Painel do operador para gerenciar links das cargas
              </h1>
              <p className="mt-4 max-w-3xl text-base leading-7 text-white/72 sm:text-lg">
                Area dedicada para localizar IDs, copiar o link individual de cada carga e revisar
                rapidamente as novas informacoes de cliente, produto e operacao.
              </p>
            </section>

            <section className="rounded-[32px] border border-white/10 bg-black/15 p-6 backdrop-blur-xl sm:p-8">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/55">
                    Cargas
                  </p>
                  <p className="mt-2 text-3xl font-extrabold text-white">{cargasDetalhadas.length}</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/55">
                    Clientes
                  </p>
                  <p className="mt-2 text-3xl font-extrabold text-white">{totalClientes}</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/55">
                    Links ativos
                  </p>
                  <p className="mt-2 text-3xl font-extrabold text-white">{cargasDetalhadas.length}</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/55">
                    Estados
                  </p>
                  <p className="mt-2 text-3xl font-extrabold text-white">{totalEstados}</p>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <section className="rounded-[30px] border border-border/50 bg-card p-5 sm:p-6 premium-shadow">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-[11px] font-extrabold uppercase tracking-[0.25em] text-muted-foreground">
                Controle de links
              </p>
              <h2 className="mt-2 text-2xl font-extrabold tracking-tight text-card-foreground">
                Buscar carga, copiar link e revisar dados
              </h2>
            </div>

            <div className="relative w-full lg:max-w-md">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Buscar por ID, cliente, cidade ou produto"
                className="h-12 rounded-2xl border-border/60 bg-background pl-10"
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="rounded-full px-3 py-1 text-xs">
              {filteredCargas.length} cargas visiveis
            </Badge>
            <Badge variant="outline" className="rounded-full px-3 py-1 text-xs">
              IDs e links individuais prontos
            </Badge>
            <Badge variant="outline" className="rounded-full px-3 py-1 text-xs">
              Informacoes de cliente e operacao centralizadas
            </Badge>
          </div>
        </section>

        <div className="mt-6 space-y-5">
          {filteredCargas.map((carga) => {
            const tempoEstimado = formatEstimatedTime(carga.dataCarregamento, carga.dataDescarga);
            const relativePath = getCargaPath(carga.id);
            const shareUrl = getCargaShareUrl(publicOrigin, carga.id);

            return (
              <article
                key={carga.id}
                className="rounded-[30px] border border-border/50 bg-card p-5 sm:p-6 premium-shadow"
              >
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className="rounded-full bg-primary text-primary-foreground">
                        ID {carga.id}
                      </Badge>
                      <Badge variant="outline" className="rounded-full">
                        {carga.status}
                      </Badge>
                      <Badge variant="outline" className="rounded-full">
                        Cliente {carga.cliente.id}
                      </Badge>
                    </div>

                    <h3 className="mt-4 text-2xl font-extrabold tracking-tight text-card-foreground">
                      {carga.origemCidade}, {carga.origemEstado} para {carga.destinoCidade},{" "}
                      {carga.destinoEstado}
                    </h3>
                    <p className="mt-2 text-base text-muted-foreground">
                      {carga.cliente.nome} • {carga.produto}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      className="rounded-2xl"
                      onClick={() => copyText(carga.id, `ID ${carga.id} copiado.`)}
                    >
                      <Hash className="h-4 w-4" />
                      Copiar ID
                    </Button>
                    <Button
                      variant="outline"
                      className="rounded-2xl"
                      onClick={() => copyText(shareUrl, `Link da carga ${carga.id} copiado.`)}
                    >
                      <Copy className="h-4 w-4" />
                      Copiar link
                    </Button>
                    <Button asChild variant="cta" className="rounded-2xl">
                      <Link to={relativePath}>
                        <ExternalLink className="h-4 w-4" />
                        Abrir carga
                      </Link>
                    </Button>
                  </div>
                </div>

                <div className="mt-5 grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <section className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                      <div className="flex items-center gap-2">
                        <MapPinned className="h-4 w-4 text-primary" />
                        <p className="text-sm font-extrabold uppercase tracking-[0.18em] text-card-foreground">
                          Rota e janela
                        </p>
                      </div>
                      <p className="mt-3 text-sm leading-6 text-muted-foreground">
                        {carga.origemEndereco}
                      </p>
                      <p className="mt-2 text-sm font-semibold text-card-foreground">
                        {carga.destinoEndereco}
                      </p>
                      <p className="mt-3 text-sm text-muted-foreground">{carga.prazoAgendamento}</p>
                    </section>

                    <section className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-primary" />
                        <p className="text-sm font-extrabold uppercase tracking-[0.18em] text-card-foreground">
                          Cliente
                        </p>
                      </div>
                      <p className="mt-3 text-base font-extrabold text-card-foreground">
                        {carga.cliente.nome}
                      </p>
                      <p className="mt-2 text-sm text-muted-foreground">{carga.cliente.cnpj}</p>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {carga.cliente.contato} • {carga.cliente.telefone}
                      </p>
                    </section>

                    <section className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                      <div className="flex items-center gap-2">
                        <Package className="h-4 w-4 text-primary" />
                        <p className="text-sm font-extrabold uppercase tracking-[0.18em] text-card-foreground">
                          Novas informacoes
                        </p>
                      </div>
                      <div className="mt-3 grid gap-2 text-sm text-muted-foreground">
                        <p>Produto: <span className="font-semibold text-card-foreground">{carga.produto}</span></p>
                        <p>Tipo: <span className="font-semibold text-card-foreground">{carga.tipoCarga}</span></p>
                        <p>Peso: <span className="font-semibold text-card-foreground">{carga.peso}</span></p>
                        <p>Volume: <span className="font-semibold text-card-foreground">{carga.volume}</span></p>
                      </div>
                    </section>

                    <section className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-primary" />
                        <p className="text-sm font-extrabold uppercase tracking-[0.18em] text-card-foreground">
                          Compliance
                        </p>
                      </div>
                      <div className="mt-3 grid gap-2 text-sm text-muted-foreground">
                        <p>Documentos: <span className="font-semibold text-card-foreground">{carga.documentos.length}</span></p>
                        <p>Exigencias: <span className="font-semibold text-card-foreground">{carga.exigencias.length}</span></p>
                        <p>Observacoes: <span className="font-semibold text-card-foreground">{carga.observacoes.length}</span></p>
                        <p>Veiculo: <span className="font-semibold text-card-foreground">{carga.tipoVeiculo}</span></p>
                      </div>
                    </section>
                  </div>

                  <section className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                    <div className="flex items-center gap-2">
                      <ClipboardList className="h-4 w-4 text-primary" />
                      <p className="text-sm font-extrabold uppercase tracking-[0.18em] text-card-foreground">
                        Gestao do link
                      </p>
                    </div>

                    <div className="mt-4 space-y-4">
                      <div className="rounded-2xl border border-border/50 bg-background px-4 py-3">
                        <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                          Caminho
                        </p>
                        <p className="mt-2 break-all font-mono text-sm text-card-foreground">
                          {relativePath}
                        </p>
                      </div>

                      <div className="rounded-2xl border border-border/50 bg-background px-4 py-3">
                        <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                          Link publico
                        </p>
                        <p className="mt-2 break-all font-mono text-sm text-card-foreground">
                          {shareUrl}
                        </p>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="rounded-2xl border border-border/50 bg-background px-4 py-3">
                          <div className="flex items-center gap-2">
                            <CalendarClock className="h-4 w-4 text-primary" />
                            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                              Carregamento
                            </p>
                          </div>
                          <p className="mt-2 text-sm font-semibold text-card-foreground">
                            {formatOperationalDate(carga.dataCarregamento)}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-border/50 bg-background px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Truck className="h-4 w-4 text-primary" />
                            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                              Descarga
                            </p>
                          </div>
                          <p className="mt-2 text-sm font-semibold text-card-foreground">
                            {formatOperationalDate(carga.dataDescarga)}
                          </p>
                        </div>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-3">
                        <div className="rounded-2xl border border-border/50 bg-background px-4 py-3">
                          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                            Tempo
                          </p>
                          <p className="mt-2 text-lg font-extrabold text-card-foreground">
                            {tempoEstimado}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-border/50 bg-background px-4 py-3">
                          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                            Distancia
                          </p>
                          <p className="mt-2 text-lg font-extrabold text-card-foreground">
                            {carga.distancia}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-border/50 bg-background px-4 py-3">
                          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                            Pagamento
                          </p>
                          <p className="mt-2 text-lg font-extrabold text-card-foreground">
                            {carga.pagamento}
                          </p>
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              </article>
            );
          })}

          {filteredCargas.length === 0 ? (
            <section className="rounded-[30px] border border-border/50 bg-card p-10 text-center premium-shadow">
              <p className="text-2xl font-extrabold tracking-tight text-card-foreground">
                Nenhuma carga encontrada
              </p>
              <p className="mt-3 text-base text-muted-foreground">
                Ajuste a busca para localizar outro ID, cliente, cidade ou produto.
              </p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default OperatorDashboard;
