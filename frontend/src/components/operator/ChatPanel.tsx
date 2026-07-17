import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Search, Send } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  fetchChatConversations,
  fetchChatMessages,
  sendChatMessage,
  type ChatConversation,
  type ChatMessage,
} from "@/services/readModels";

const CONV_KEY = ["operator", "chat", "conversations"];
const MSGS_KEY = (phone: string) => ["operator", "chat", "messages", phone];

function fmtRelative(iso: string | null | undefined) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "agora";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}min`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}
function fmtTime(iso: string) {
  const t = new Date(iso);
  return Number.isNaN(t.getTime())
    ? ""
    : t.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}
function fmtPhone(digits: string) {
  const d = String(digits || "").replace(/\D/g, "");
  if (d.length >= 12 && d.startsWith("55")) {
    const ddd = d.slice(2, 4);
    const rest = d.slice(4);
    const p1 = rest.length > 8 ? rest.slice(0, 5) : rest.slice(0, 4);
    const p2 = rest.length > 8 ? rest.slice(5) : rest.slice(4);
    return `(${ddd}) ${p1}-${p2}`;
  }
  return digits;
}

export default function ChatPanel() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [activePhone, setActivePhone] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const { data: convData, isLoading: loadingConvs } = useQuery({
    queryKey: [...CONV_KEY, search],
    queryFn: () => fetchChatConversations({ search: search || undefined }),
    refetchInterval: 20_000,
  });
  const conversations = useMemo<ChatConversation[]>(() => convData?.items ?? [], [convData?.items]);

  const { data: msgsData, isFetching: loadingMsgs } = useQuery({
    queryKey: MSGS_KEY(activePhone || ""),
    queryFn: () => fetchChatMessages(activePhone as string),
    enabled: Boolean(activePhone),
    refetchInterval: activePhone ? 8_000 : false,
  });
  const messages = useMemo<ChatMessage[]>(() => msgsData?.items ?? [], [msgsData?.items]);

  const sendMut = useMutation({
    mutationFn: (payload: { phone: string; text: string }) => sendChatMessage(payload),
    onSuccess: () => {
      setDraft("");
      if (activePhone) {
        queryClient.invalidateQueries({ queryKey: MSGS_KEY(activePhone) });
        queryClient.invalidateQueries({ queryKey: [...CONV_KEY, search] });
      }
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao enviar."),
  });

  // Auto-scroll ao final quando mensagens carregam ou chegam novas.
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, activePhone]);

  // Seleciona automaticamente a primeira conversa quando ainda não há seleção.
  useEffect(() => {
    if (!activePhone && conversations.length) setActivePhone(conversations[0].phone);
  }, [activePhone, conversations]);

  const activeConv = conversations.find((c) => c.phone === activePhone);

  return (
    <section className="admin-card-surface flex h-[70vh] min-h-[500px] overflow-hidden rounded-[20px] border">
      {/* Sidebar de conversas */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-border/60">
        <div className="border-b border-border/60 p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por número ou CPF"
              className="pl-8"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loadingConvs && !conversations.length ? (
            <p className="p-4 text-sm text-muted-foreground">Carregando…</p>
          ) : conversations.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Nenhuma conversa ainda.</p>
          ) : (
            <ul>
              {conversations.map((c) => {
                const active = c.phone === activePhone;
                return (
                  <li key={c.phone}>
                    <button
                      type="button"
                      onClick={() => setActivePhone(c.phone)}
                      className={cn(
                        "flex w-full items-start gap-3 border-b border-border/40 px-3 py-2.5 text-left transition hover:bg-muted/40",
                        active && "bg-primary/5",
                      )}
                    >
                      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-indigo-600 text-xs font-bold text-white">
                        {(c.driver_name || fmtPhone(c.phone))
                          .split(/\s+/)
                          .slice(0, 2)
                          .map((s) => s[0]?.toUpperCase())
                          .join("") || "?"}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="truncate text-sm font-semibold">{c.driver_name || fmtPhone(c.phone)}</p>
                          <span className="shrink-0 text-[10px] text-muted-foreground">{fmtRelative(c.last_ts)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <p className={cn("truncate text-xs text-muted-foreground", c.last_direction === "in" && "font-medium text-foreground")}>
                            {c.last_direction === null
                              ? <span className="italic text-primary">Iniciar conversa</span>
                              : (
                                <>
                                  {c.last_direction === "out" ? "Você: " : ""}
                                  {c.last_text || `(${c.last_type ?? ""})`}
                                </>
                              )}
                          </p>
                          {c.unread_count > 0 ? (
                            <span className="ml-auto shrink-0 rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                              {c.unread_count}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Chat */}
      <div className="flex min-w-0 flex-1 flex-col">
        {activeConv ? (
          <>
            <header className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-indigo-600 text-xs font-bold text-white">
                {(activeConv.driver_name || fmtPhone(activeConv.phone))
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((s) => s[0]?.toUpperCase())
                  .join("") || "?"}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{activeConv.driver_name || fmtPhone(activeConv.phone)}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {fmtPhone(activeConv.phone)}
                  {activeConv.driver_key ? ` · CPF ${activeConv.driver_key}` : ""}
                </p>
              </div>
            </header>

            <div
              className="flex-1 overflow-y-auto p-4"
              style={{ background: "repeating-linear-gradient(45deg,rgba(120,120,120,0.03) 0 6px,transparent 6px 12px)" }}
            >
              {loadingMsgs && !messages.length ? (
                <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
              ) : messages.length === 0 ? (
                <p className="text-center text-sm text-muted-foreground">Sem mensagens ainda.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      className={cn(
                        "max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-sm",
                        m.direction === "out"
                          ? "self-end bg-emerald-500/95 text-white"
                          : "self-start bg-background border border-border/60",
                      )}
                    >
                      <p className="whitespace-pre-wrap break-words leading-snug">{m.text}</p>
                      <p
                        className={cn(
                          "mt-0.5 text-right text-[10px] opacity-70",
                          m.direction === "out" ? "text-white/80" : "text-muted-foreground",
                        )}
                      >
                        {fmtTime(m.timestamp)}
                      </p>
                    </div>
                  ))}
                  <div ref={bottomRef} />
                </div>
              )}
            </div>

            <footer className="border-t border-border/60 p-3">
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const text = draft.trim();
                  if (!text || !activePhone) return;
                  sendMut.mutate({ phone: activePhone, text });
                }}
              >
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      const text = draft.trim();
                      if (text && activePhone) sendMut.mutate({ phone: activePhone, text });
                    }
                  }}
                  placeholder="Digite a mensagem…"
                  rows={2}
                  className="max-h-32 min-h-[40px] flex-1 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed"
                />
                <Button type="submit" disabled={!draft.trim() || sendMut.isPending} className="gap-1.5">
                  {sendMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Enviar
                </Button>
              </form>
              <p className="mt-1 text-[10px] text-muted-foreground">Enter envia · Shift+Enter quebra linha</p>
            </footer>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Selecione uma conversa à esquerda.
          </div>
        )}
      </div>
    </section>
  );
}
