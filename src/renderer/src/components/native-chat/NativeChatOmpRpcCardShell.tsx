import { HelpCircle } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Docked card chrome for the RPC-owned chat pane, shared by the two card
 * families so they read as one surface: child-originated
 * `extension_ui_request` prompts (NativeChatExtensionUiCard) and
 * Orca-originated interactive command cards
 * (NativeChatOmpRpcCommandCard). Extracted rather than copied — a second
 * chrome would drift in border, radius and spacing the moment either side
 * changed.
 */
export function NativeChatOmpRpcCardShell({
  title,
  message,
  footer,
  icon,
  children
}: {
  title?: string
  message?: string
  footer?: ReactNode
  /** Defaults to the prompt icon; a destructive card passes its own. */
  icon?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="shrink-0 bg-background">
      <div className="mx-auto w-full max-w-4xl px-3 pt-2 pb-1 sm:px-4">
        <div className="flex w-full flex-col gap-2 rounded-lg border border-input bg-card px-4 py-3 shadow-xs">
          <div className="flex items-start gap-2">
            {icon ?? <HelpCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
            <div className="min-w-0">
              {title ? <p className="text-sm font-semibold text-foreground">{title}</p> : null}
              {message ? (
                <p className="mt-0.5 break-words text-xs text-muted-foreground">{message}</p>
              ) : null}
            </div>
          </div>
          {children}
          {footer}
        </div>
      </div>
    </div>
  )
}
