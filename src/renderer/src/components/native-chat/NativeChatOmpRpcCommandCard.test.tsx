// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

    expect(screen.getByRole('button', { name: /GPT-6 Astra/ })).not.toHaveAttribute('data-current')
    expect(screen.getByRole('button', { name: /Opus 5/ })).toHaveAttribute('data-current', 'true')

    fireEvent.click(screen.getByRole('button', { name: /GPT-6 Astra/ }))
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

  it('disables the rows while an answer is in flight so one choice cannot be dispatched twice', () => {
    render(
      <NativeChatOmpRpcCommandCard
        command="switch"
        title="Model"
        view={{
          phase: 'ready',
          pending: true,
          model: { kind: 'select', options: [{ id: 'a', label: 'GPT-6 Astra' }] }
        }}
        onChoose={vi.fn()}
        onDismiss={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: /GPT-6 Astra/ })).toBeDisabled()
    expect(screen.getByText('Working…')).toBeInTheDocument()
  })
})
