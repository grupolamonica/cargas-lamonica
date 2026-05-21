import { Component, type ErrorInfo, type ReactNode } from "react";

import { DriverAlert } from "@/components/driver/ui/DriverAlert";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export interface RegistrationWizardShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  ariaLabel?: string;
}

/** WhatsApp do suporte ao motorista — replicado do DriverPortal para fallback de crash. */
const DRIVER_SUPPORT_WHATSAPP_NUMBER = "557139950665";
const WIZARD_CRASH_WHATSAPP_MESSAGE =
  "Olá! Tive um problema no cadastro de motorista e precisaria de ajuda.";
const wizardCrashWhatsAppUrl = `https://wa.me/${DRIVER_SUPPORT_WHATSAPP_NUMBER}?text=${encodeURIComponent(
  WIZARD_CRASH_WHATSAPP_MESSAGE,
)}`;

interface WizardErrorBoundaryProps {
  children: ReactNode;
}

interface WizardErrorBoundaryState {
  hasError: boolean;
}

/**
 * ErrorBoundary local do wizard de cadastro v2 (E-01 P0).
 *
 * Captura crashes em qualquer step e renderiza fallback amigável com
 * orientação ao motorista (recarregar ou contatar suporte via WhatsApp),
 * evitando "tela branca" dentro do Drawer/Dialog.
 */
class WizardErrorBoundary extends Component<
  WizardErrorBoundaryProps,
  WizardErrorBoundaryState
> {
  constructor(props: WizardErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): WizardErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[cadastro-v2] WizardErrorBoundary capturou erro:", error, info);
  }

  private handleReload = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  private handleWhatsApp = () => {
    if (typeof window !== "undefined") {
      window.open(wizardCrashWhatsAppUrl, "_blank", "noopener,noreferrer");
    }
  };

  override render() {
    if (this.state.hasError) {
      return (
        <div className="p-2">
          <DriverAlert
            variant="danger"
            title="Algo deu errado por aqui"
            description="Deu um problema do nosso lado. Tenta fechar e abrir de novo, ou nos chama no WhatsApp."
            primaryAction={{
              label: "Recarregar",
              onClick: this.handleReload,
            }}
            secondaryAction={{
              label: "Falar no WhatsApp",
              onClick: this.handleWhatsApp,
            }}
          />
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Container responsivo do wizard de cadastro v2.
 *
 * - Mobile (<768px): renderiza um Drawer (bottom-sheet) com drag handle.
 * - Desktop (>=768px): renderiza um Dialog centralizado (max-w-2xl).
 * - Em ambos os casos o conteúdo é envolvido em `.driver-theme` (convenção do projeto).
 * - Wrapped em WizardErrorBoundary para capturar crashes dos steps.
 */
export function RegistrationWizardShell({
  open,
  onOpenChange,
  children,
  ariaLabel,
}: RegistrationWizardShellProps) {
  const isMobile = useIsMobile();
  const title = ariaLabel ?? "Cadastro de motorista";

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent
          className={cn(
            "driver-theme max-h-[92vh] rounded-t-[28px] border-none bg-background p-0",
          )}
        >
          <div className="h-1 w-12 rounded-full bg-muted mx-auto mt-2" />
          <DrawerTitle className="sr-only">{title}</DrawerTitle>
          <div className="driver-theme flex-1 overflow-y-auto px-4 pb-5 pt-3">
            <WizardErrorBoundary>{children}</WizardErrorBoundary>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="bg-[hsl(223_56%_10%/0.76)] backdrop-blur-[2px]"
        className={cn(
          // 2026-05-20 responsividade: max-w cresce em breakpoints maiores
          // para usar a tela larga sem perder a respiracao do conteudo.
          "driver-theme max-h-[88vh] max-w-2xl gap-0 overflow-hidden rounded-[28px] border bg-background p-0 lg:max-w-3xl xl:max-w-4xl",
        )}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <div className="driver-theme flex max-h-[88vh] flex-col overflow-y-auto px-5 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-7">
          <WizardErrorBoundary>{children}</WizardErrorBoundary>
        </div>
      </DialogContent>
    </Dialog>
  );
}
