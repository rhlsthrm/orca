import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { NativeChatOmpRpcCardShell } from './NativeChatOmpRpcCardShell'
import type {
  OmpRpcInteractiveCardChoice,
  OmpRpcInteractiveCardModel
} from './omp-rpc-interactive-command-registry'

/** What the pane knows about the open card right now. `failure` is a REFUSED
 *  apply: the card stays usable so the choice can be retried or abandoned,
 *  unlike a failed load, which has no model to act on. */
export type NativeChatOmpRpcCommandCardView =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | {
      phase: 'ready'
      model: OmpRpcInteractiveCardModel
      pending: boolean
      failure?: string
    }

export type NativeChatOmpRpcCommandCardProps = {
  /** The invocation this card answers, rendered so the user can see which
   *  command they are looking at (`/switch`). */
  command: string
  title: string
  destructive?: boolean
  view: NativeChatOmpRpcCommandCardView
  onChoose: (choice: OmpRpcInteractiveCardChoice) => void
  onDismiss: () => void
}

/**
 * An Orca-originated interactive command card, docked above the composer in
 * the same chrome as the child's `extension_ui_request` prompts. It is NOT one
 * of those: the child is not blocked on it, so the composer stays usable and
 * Escape always backs out.
 *
 * Everything rendered here comes from the card's model. A select with no
 * `current` row means OMP reported no current value — the model's `note` says
 * so — and this component never picks a row to mark instead.
 */
export function NativeChatOmpRpcCommandCard({
  command,
  title,
  destructive = false,
  view,
  onChoose,
  onDismiss
}: NativeChatOmpRpcCommandCardProps): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={title}
      data-omp-rpc-command-card={command}
      onKeyDown={(event) => {
        // Escape backs out of any phase, including a load still in flight.
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onDismiss()
        }
      }}
    >
      <NativeChatOmpRpcCardShell
        title={title}
        message={`/${command}`}
        icon={
          destructive ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          ) : undefined
        }
        footer={<CardFooterNote view={view} />}
      >
        <CardBody view={view} destructive={destructive} onChoose={onChoose} onDismiss={onDismiss} />
      </NativeChatOmpRpcCardShell>
    </div>
  )
}

function CardFooterNote({ view }: { view: NativeChatOmpRpcCommandCardView }): React.JSX.Element {
  const note = view.phase === 'ready' ? view.model.note : undefined
  return (
    <>
      {note ? <p className="mt-1 text-[11px] text-muted-foreground">{note}</p> : null}
      {view.phase === 'ready' && view.failure ? (
        <p className="mt-1 text-[11px] text-destructive">{view.failure}</p>
      ) : null}
    </>
  )
}

function CardBody({
  view,
  destructive,
  onChoose,
  onDismiss
}: {
  view: NativeChatOmpRpcCommandCardView
  destructive: boolean
  onChoose: (choice: OmpRpcInteractiveCardChoice) => void
  onDismiss: () => void
}): React.JSX.Element {
  if (view.phase === 'loading') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {translate('components.native-chat.ompRpcCommandCard.loading', 'Reading agent state…')}
      </div>
    )
  }
  if (view.phase === 'error') {
    return (
      <div className="flex flex-col gap-2">
        <p className="break-words text-xs text-destructive">{view.message}</p>
        <div className="flex">
          <DismissButton autoFocus onDismiss={onDismiss} />
        </div>
      </div>
    )
  }
  const { model, pending } = view
  if (model.kind === 'select') {
    return (
      <SelectBody
        options={model.options}
        pending={pending}
        onChoose={onChoose}
        onDismiss={onDismiss}
      />
    )
  }
  if (model.kind === 'confirm') {
    return (
      <div className="flex flex-col gap-2">
        <p className="break-words text-xs text-foreground">{model.prompt}</p>
        <div className="flex items-center gap-2">
          <Button
            autoFocus
            type="button"
            size="sm"
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending}
            onClick={() => onChoose({ kind: 'confirm' })}
          >
            {model.confirmLabel ??
              translate('components.native-chat.ompRpcCommandCard.confirm', 'Confirm')}
          </Button>
          <DismissButton onDismiss={onDismiss} />
          <PendingHint pending={pending} />
        </div>
      </div>
    )
  }
  if (model.kind === 'input') {
    return (
      <InputBody
        label={model.label}
        placeholder={model.placeholder}
        initialValue={model.initialValue}
        submitLabel={model.submitLabel}
        pending={pending}
        onChoose={onChoose}
        onDismiss={onDismiss}
      />
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {model.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'components.native-chat.ompRpcCommandCard.noRows',
            'The agent reported nothing for this command.'
          )}
        </p>
      ) : (
        <dl className="flex max-h-64 flex-col gap-1 overflow-y-auto scrollbar-sleek">
          {model.rows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-3">
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd className="text-xs font-medium text-foreground tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex">
        <DismissButton
          autoFocus
          onDismiss={onDismiss}
          label={translate('components.native-chat.ompRpcCommandCard.close', 'Close')}
        />
      </div>
    </div>
  )
}

function SelectBody({
  options,
  pending,
  onChoose,
  onDismiss
}: {
  options: readonly {
    id: string
    label: string
    description?: string
    current?: boolean
    disabled?: boolean
  }[]
  pending: boolean
  onChoose: (choice: OmpRpcInteractiveCardChoice) => void
  onDismiss: () => void
}): React.JSX.Element {
  // Default focus lands on the row OMP reported as current so Enter commits
  // the obvious choice; with no reported current row it lands on the first
  // selectable one, which asserts nothing about the child's state.
  const focusIndex = useMemo(() => {
    const current = options.findIndex((option) => option.current === true && !option.disabled)
    return current === -1 ? options.findIndex((option) => !option.disabled) : current
  }, [options])
  return (
    <div className="flex flex-col gap-2">
      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'components.native-chat.ompRpcCommandCard.noOptions',
            'The agent reported no options for this command.'
          )}
        </p>
      ) : (
        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto scrollbar-sleek">
          {options.map((option, index) => (
            <button
              key={option.id}
              autoFocus={index === focusIndex}
              type="button"
              disabled={pending || option.disabled === true}
              data-current={option.current === true ? 'true' : undefined}
              onClick={() => onChoose({ kind: 'select', optionId: option.id })}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 data-[current=true]:bg-accent"
            >
              <Check
                aria-hidden
                className={`size-3.5 shrink-0 ${option.current === true ? '' : 'invisible'}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-foreground">{option.label}</span>
                {option.description ? (
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <DismissButton onDismiss={onDismiss} />
        <PendingHint pending={pending} />
      </div>
    </div>
  )
}

function InputBody({
  label,
  placeholder,
  initialValue,
  submitLabel,
  pending,
  onChoose,
  onDismiss
}: {
  label: string
  placeholder?: string
  initialValue?: string
  submitLabel?: string
  pending: boolean
  onChoose: (choice: OmpRpcInteractiveCardChoice) => void
  onDismiss: () => void
}): React.JSX.Element {
  const [text, setText] = useState(initialValue ?? '')
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={text}
          disabled={pending}
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              if (!pending) {
                onChoose({ kind: 'input', text })
              }
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() => onChoose({ kind: 'input', text })}
        >
          {submitLabel ?? translate('components.native-chat.ompRpcCommandCard.submit', 'Submit')}
        </Button>
        <DismissButton onDismiss={onDismiss} />
      </div>
      <PendingHint pending={pending} />
    </div>
  )
}

function DismissButton({
  onDismiss,
  autoFocus = false,
  label
}: {
  onDismiss: () => void
  autoFocus?: boolean
  label?: string
}): React.JSX.Element {
  return (
    <Button autoFocus={autoFocus} type="button" variant="ghost" size="sm" onClick={onDismiss}>
      {label ?? translate('components.native-chat.ompRpcCommandCard.cancel', 'Cancel')}
    </Button>
  )
}

function PendingHint({ pending }: { pending: boolean }): React.JSX.Element | null {
  if (!pending) {
    return null
  }
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      {translate('components.native-chat.ompRpcCommandCard.working', 'Working…')}
    </span>
  )
}
