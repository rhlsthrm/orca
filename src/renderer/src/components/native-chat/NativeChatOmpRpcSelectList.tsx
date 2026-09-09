import { Check } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

/**
 * One row. Deliberately the shape BOTH card families collapse into: an Orca
 * card's `OmpRpcInteractiveCardOption`, and OMP's own `extension_ui_request`
 * `select` (`options[i]` + `optionDetails[i].description`, index as the id).
 */
export type NativeChatOmpRpcSelectOption = {
  id: string
  label: string
  description?: string
  /** The row the SENDER reported as active — never synthesized here. */
  current?: boolean
  disabled?: boolean
}

/** The list caps at 16rem and a labelled row with a description is ~40px, so
 *  six rows are the most the card shows at once. The seventh is the first the
 *  user cannot reach without scrolling, which is where a filter starts earning
 *  the row of chrome it costs. */
const FILTER_ROW_THRESHOLD = 7

/** Matches label and description only: the id is an opaque handle (a list
 *  index, a model slug) and must never silently match what the user typed. */
function scoreOptionAgainstQuery(_value: string, search: string, keywords?: string[]): number {
  const query = search.trim().toLowerCase()
  if (!query) {
    return 1
  }
  return keywords?.some((keyword) => keyword.toLowerCase().includes(query)) === true ? 1 : 0
}

/**
 * The chat pane's one option picker, shared by the Orca-originated command
 * cards and the child's `extension_ui_request` selects so both behave like
 * OMP's TUI selector: type to filter, arrows to move, Enter to choose, Escape
 * to back out.
 *
 * Presentational and family-agnostic on purpose — it reports the chosen row's
 * id and nothing else, so each family keeps its own answer path (an Orca card
 * resolves `{kind:'select', optionId}`; an extension select answers with the
 * option STRING and the request id) and answering one can never resolve the
 * other.
 */
export function NativeChatOmpRpcSelectList({
  options,
  disabled = false,
  onChoose,
  onCancel
}: {
  /** Callers render their own copy for an empty list; this never draws one. */
  options: readonly NativeChatOmpRpcSelectOption[]
  /** Every row is unchoosable while an answer is in flight. */
  disabled?: boolean
  onChoose: (optionId: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  // Enter lands on the reported current row, so the obvious choice needs no
  // navigation; with nothing reported it lands on the first choosable row,
  // which asserts nothing about the sender's state.
  const initialOptionId = useMemo(() => {
    const choosable = options.filter((option) => option.disabled !== true)
    return (choosable.find((option) => option.current === true) ?? choosable[0])?.id ?? ''
  }, [options])
  // Short lists are scannable at a glance, so the field stays hidden — but it
  // stays MOUNTED and focused, so typing filters immediately and reveals it.
  const filterVisible = options.length >= FILTER_ROW_THRESHOLD || query !== ''
  return (
    <Command
      loop
      defaultValue={initialOptionId}
      filter={scoreOptionAgainstQuery}
      className="h-auto rounded-none bg-transparent text-foreground"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          // The Orca card's chrome also backs out on Escape; stop here so one
          // keypress is one cancel.
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <CommandInput
        autoFocus
        value={query}
        disabled={disabled}
        onValueChange={setQuery}
        aria-label={translate('components.native-chat.ompRpcSelect.filterLabel', 'Filter options')}
        placeholder={translate('components.native-chat.ompRpcSelect.filterPlaceholder', 'Filter…')}
        wrapperClassName={
          filterVisible ? 'rounded-md border border-input bg-transparent px-2 py-0' : 'sr-only'
        }
        iconClassName="size-3.5"
        className="h-8 py-1 text-xs"
      />
      <CommandList className="mt-1 max-h-64">
        <CommandEmpty className="py-3 text-xs">
          {translate('components.native-chat.ompRpcSelect.noMatches', 'No options match.')}
        </CommandEmpty>
        {options.map((option) => (
          <CommandItem
            key={option.id}
            value={option.id}
            keywords={option.description ? [option.label, option.description] : [option.label]}
            disabled={disabled || option.disabled === true}
            data-current={option.current === true ? 'true' : undefined}
            onSelect={() => onChoose(option.id)}
            className="jump-palette-item items-start data-[current=true]:bg-accent"
          >
            <Check
              aria-hidden
              className={cn('mt-0.5 size-3.5 shrink-0', option.current !== true && 'invisible')}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-foreground">{option.label}</span>
              {option.description ? (
                <span className="block truncate text-[11px] text-muted-foreground">
                  {option.description}
                </span>
              ) : null}
            </span>
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  )
}
