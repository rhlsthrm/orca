// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatOmpRpcCommandCard } from './NativeChatOmpRpcCommandCard'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(() => cleanup())

describe('NativeChatOmpRpcCommandCard', () => {
  it('marks only the row the model reports as current and answers with that row id', () => {
    const onChoose = vi.fn()
    render(
      <NativeChatOmpRpcCommandCard
        command="switch"
        title="Model"
        view={{
          phase: 'ready',
          pending: false,
          model: {
            kind: 'select',
            options: [
              { id: 'a', label: 'GPT-6 Astra', description: 'openai-codex' },
              { id: 'b', label: 'Opus 5', description: 'anthropic', current: true }
            ]
          }
        }}
        onChoose={onChoose}
        onDismiss={vi.fn()}
      />
    )

    expect(screen.getByRole('option', { name: /GPT-6 Astra/ })).not.toHaveAttribute('data-current')
    expect(screen.getByRole('option', { name: /Opus 5/ })).toHaveAttribute('data-current', 'true')
    // The reported current row is also where Enter would land.
    expect(screen.getByRole('option', { name: /Opus 5/ })).toHaveAttribute('data-selected', 'true')

    fireEvent.click(screen.getByRole('option', { name: /GPT-6 Astra/ }))
    expect(onChoose).toHaveBeenCalledWith({ kind: 'select', optionId: 'a' })
  })

  it('shows a failed load as text with no rows to pick from', () => {
    render(
      <NativeChatOmpRpcCommandCard
        command="switch"
        title="Model"
        view={{ phase: 'error', message: 'OMP could not list its models: refused' }}
        onChoose={vi.fn()}
        onDismiss={vi.fn()}
      />
    )

    expect(screen.getByText('OMP could not list its models: refused')).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('backs out on Escape from any phase', () => {
    const onDismiss = vi.fn()
    render(
      <NativeChatOmpRpcCommandCard
        command="switch"
        title="Model"
        view={{ phase: 'loading' }}
        onChoose={vi.fn()}
        onDismiss={onDismiss}
      />
    )

    fireEvent.keyDown(screen.getByRole('group', { name: 'Model' }), { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('submits an input card on Enter with the text as typed', () => {
    const onChoose = vi.fn()
    render(
      <NativeChatOmpRpcCommandCard
        command="compact"
        title="Compact context"
        view={{
          phase: 'ready',
          pending: false,
          model: { kind: 'input', label: 'Summary instructions (optional)' }
        }}
        onChoose={onChoose}
        onDismiss={vi.fn()}
      />
    )

    const field = screen.getByRole('textbox')
    fireEvent.change(field, { target: { value: 'keep the API decisions' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    expect(onChoose).toHaveBeenCalledWith({ kind: 'input', text: 'keep the API decisions' })
  })

  it('never answers a destructive confirm from its back-out path', () => {
    const onChoose = vi.fn()
    const onDismiss = vi.fn()
    render(
      <NativeChatOmpRpcCommandCard
        command="session delete"
        title="Delete session"
        destructive
        view={{
          phase: 'ready',
          pending: false,
          model: { kind: 'confirm', prompt: 'Permanently delete session s-1?' }
        }}
        onChoose={onChoose}
        onDismiss={onDismiss}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onChoose).not.toHaveBeenCalled()
    expect(onDismiss).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(onChoose).toHaveBeenCalledWith({ kind: 'confirm' })
  })

  it('cannot dispatch a choice while an answer is already in flight', () => {
    const onChoose = vi.fn()
    render(
      <NativeChatOmpRpcCommandCard
        command="switch"
        title="Model"
        view={{
          phase: 'ready',
          pending: true,
          model: { kind: 'select', options: [{ id: 'a', label: 'GPT-6 Astra' }] }
        }}
        onChoose={onChoose}
        onDismiss={vi.fn()}
      />
    )

    const row = screen.getByRole('option', { name: /GPT-6 Astra/ })
    expect(row).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onChoose).not.toHaveBeenCalled()
    expect(screen.getByText('Working…')).toBeInTheDocument()
  })
})

/** Eight models with provider detail lines: the live `/switch` list, and past
 *  the point where the card shows its filter field. */
const MODEL_OPTIONS = [
  { id: 'astra', label: 'GPT-6 Astra', description: 'openai-codex · 400k context' },
  { id: 'opus', label: 'Opus 5', description: 'anthropic · 200k context', current: true },
  { id: 'sonnet', label: 'Sonnet 5', description: 'anthropic · 200k context' },
  { id: 'haiku', label: 'Haiku 4.5', description: 'anthropic · 200k context' },
  { id: 'gemini', label: 'Gemini 3 Pro', description: 'google · 1m context' },
  { id: 'grok', label: 'Grok 5', description: 'xai · 256k context' },
  { id: 'kimi', label: 'Kimi K2', description: 'moonshot · 256k context' },
  { id: 'local', label: 'Qwen 3 Coder', description: 'ollama · not signed in', disabled: true }
] as const

function renderModelCard(overrides: {
  onChoose?: (choice: unknown) => void
  onDismiss?: () => void
}): void {
  render(
    <NativeChatOmpRpcCommandCard
      command="switch"
      title="Model"
      view={{
        phase: 'ready',
        pending: false,
        model: { kind: 'select', options: MODEL_OPTIONS }
      }}
      onChoose={overrides.onChoose ?? vi.fn()}
      onDismiss={overrides.onDismiss ?? vi.fn()}
    />
  )
}

describe('NativeChatOmpRpcCommandCard select list', () => {
  it('filters the rows by label and by description as the user types', async () => {
    renderModelCard({})
    const filter = screen.getByPlaceholderText('Filter…')

    fireEvent.change(filter, { target: { value: 'gemini' } })
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
    expect(screen.getByRole('option', { name: /Gemini 3 Pro/ })).toBeInTheDocument()

    // 'moonshot' appears only in a description, never in a label.
    fireEvent.change(filter, { target: { value: 'MOONSHOT' } })
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
    expect(screen.getByRole('option', { name: /Kimi K2/ })).toBeInTheDocument()
  })

  it('says so honestly when the query matches nothing', async () => {
    renderModelCard({})

    fireEvent.change(screen.getByPlaceholderText('Filter…'), { target: { value: 'zzz' } })
    await waitFor(() => expect(screen.getByText('No options match.')).toBeInTheDocument())
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('chooses the arrow-key highlight on Enter and dispatches that row id', () => {
    const onChoose = vi.fn()
    renderModelCard({ onChoose })
    const filter = screen.getByPlaceholderText('Filter…')

    // Highlight starts on the current row (Opus 5, index 1).
    fireEvent.keyDown(filter, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /Sonnet 5/ })).toHaveAttribute(
      'data-selected',
      'true'
    )
    fireEvent.keyDown(filter, { key: 'ArrowUp' })
    fireEvent.keyDown(filter, { key: 'ArrowUp' })
    expect(screen.getByRole('option', { name: /GPT-6 Astra/ })).toHaveAttribute(
      'data-selected',
      'true'
    )

    fireEvent.keyDown(filter, { key: 'Enter' })
    expect(onChoose).toHaveBeenCalledWith({ kind: 'select', optionId: 'astra' })
  })

  it('moves the highlight onto the first match when the query changes', async () => {
    const onChoose = vi.fn()
    renderModelCard({ onChoose })
    const filter = screen.getByPlaceholderText('Filter…')

    fireEvent.change(filter, { target: { value: 'grok' } })
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /Grok 5/ })).toHaveAttribute(
        'data-selected',
        'true'
      )
    )
    fireEvent.keyDown(filter, { key: 'Enter' })
    expect(onChoose).toHaveBeenCalledWith({ kind: 'select', optionId: 'grok' })
  })

  it('skips a disabled row with the keyboard and refuses to choose it on click', () => {
    const onChoose = vi.fn()
    renderModelCard({ onChoose })
    const filter = screen.getByPlaceholderText('Filter…')

    // Kimi K2 is the last enabled row; ArrowDown must wrap past the disabled
    // Qwen row back to the top rather than landing on it.
    for (let step = 0; step < 5; step += 1) {
      fireEvent.keyDown(filter, { key: 'ArrowDown' })
    }
    expect(screen.getByRole('option', { name: /Kimi K2/ })).toHaveAttribute('data-selected', 'true')
    fireEvent.keyDown(filter, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /GPT-6 Astra/ })).toHaveAttribute(
      'data-selected',
      'true'
    )

    fireEvent.click(screen.getByRole('option', { name: /Qwen 3 Coder/ }))
    expect(onChoose).not.toHaveBeenCalledWith({ kind: 'select', optionId: 'local' })
  })

  it('backs out on Escape from the list without answering, exactly once', () => {
    const onChoose = vi.fn()
    const onDismiss = vi.fn()
    renderModelCard({ onChoose, onDismiss })

    fireEvent.keyDown(screen.getByPlaceholderText('Filter…'), { key: 'Escape' })
    expect(onChoose).not.toHaveBeenCalled()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('hides the filter field for a short list but still filters what the user types', async () => {
    render(
      <NativeChatOmpRpcCommandCard
        command="switch"
        title="Model"
        view={{
          phase: 'ready',
          pending: false,
          model: { kind: 'select', options: MODEL_OPTIONS.slice(0, 3) }
        }}
        onChoose={vi.fn()}
        onDismiss={vi.fn()}
      />
    )

    const filter = screen.getByPlaceholderText('Filter…')
    expect(filter.closest('[data-cmdk-input-wrapper]')).toHaveClass('sr-only')

    fireEvent.change(filter, { target: { value: 'sonnet' } })
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
    expect(filter.closest('[data-cmdk-input-wrapper]')).not.toHaveClass('sr-only')
  })
})
