// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatExtensionUiCard } from './NativeChatExtensionUiCard'
import type { OmpRpcExtensionUiRequestFrame } from '../../../../shared/omp-rpc-protocol'

afterEach(() => cleanup())

describe('NativeChatExtensionUiCard', () => {
  it('lists select options with their details and answers with the chosen option string', () => {
    const onAnswer = vi.fn()
    render(
      <NativeChatExtensionUiCard
        request={{
          type: 'extension_ui_request',
          id: 'req-1',
          method: 'select',
          title: 'Allow tool?',
          options: ['Approve', 'Deny'],
          optionDetails: [{ description: 'Run the command' }, { description: 'Reject it' }]
        }}
        onAnswer={onAnswer}
      />
    )

    const approve = screen.getByRole('option', { name: /Approve/ })
    // The detail is readable copy now, not a hover-only title attribute.
    expect(approve).toHaveTextContent('Run the command')
    fireEvent.click(approve)

    expect(onAnswer).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'req-1',
      value: 'Approve'
    })
  })

  it('renders a confirm/cancel pair and answers with confirmed:true/false', () => {
    const onAnswer = vi.fn()
    render(
      <NativeChatExtensionUiCard
        request={{
          type: 'extension_ui_request',
          id: 'req-2',
          method: 'confirm',
          message: 'Proceed?'
        }}
        onAnswer={onAnswer}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onAnswer).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'req-2',
      confirmed: false
    })

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(onAnswer).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'req-2',
      confirmed: true
    })
  })

  it.each(['input', 'editor'] as const)(
    'renders a text field + submit for "%s" and answers with the typed value',
    (method) => {
      const onAnswer = vi.fn()
      render(
        <NativeChatExtensionUiCard
          request={{ type: 'extension_ui_request', id: 'req-3', method }}
          onAnswer={onAnswer}
        />
      )

      const submitButton = screen.getByRole('button', { name: 'Submit' })
      expect(submitButton).toBeDisabled()

      fireEvent.change(screen.getByPlaceholderText('Type your answer…'), {
        target: { value: 'my answer' }
      })
      fireEvent.click(submitButton)

      expect(onAnswer).toHaveBeenCalledWith({
        type: 'extension_ui_response',
        id: 'req-3',
        value: 'my answer'
      })
    }
  )

  it('submits an input answer on Enter and ignores blank input', () => {
    const onAnswer = vi.fn()
    render(
      <NativeChatExtensionUiCard
        request={{ type: 'extension_ui_request', id: 'req-4', method: 'input' }}
        onAnswer={onAnswer}
      />
    )
    const field = screen.getByPlaceholderText('Type your answer…')

    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onAnswer).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: '  reply  ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onAnswer).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'req-4',
      value: '  reply  '
    })
  })

  it('shows the auto-resolve notice only when the request carries a timeout', () => {
    const { rerender } = render(
      <NativeChatExtensionUiCard
        request={{ type: 'extension_ui_request', id: 'req-5', method: 'confirm' }}
        onAnswer={vi.fn()}
      />
    )
    expect(screen.queryByText(/resolves automatically/i)).not.toBeInTheDocument()

    rerender(
      <NativeChatExtensionUiCard
        request={{ type: 'extension_ui_request', id: 'req-5', method: 'confirm', timeout: 5000 }}
        onAnswer={vi.fn()}
      />
    )
    expect(screen.getByText(/resolves automatically/i)).toBeInTheDocument()
  })

  // F6 (HIGH): the pane's only input while a request is pending must always
  // offer a decline path — a select's options list (even a legitimately
  // empty one) must never be the only way out.
  it("answers cancelled:true from the select branch's Cancel button", () => {
    const onAnswer = vi.fn()
    render(
      <NativeChatExtensionUiCard
        request={{
          type: 'extension_ui_request',
          id: 'req-6',
          method: 'select',
          options: ['Approve', 'Deny']
        }}
        onAnswer={onAnswer}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onAnswer).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'req-6',
      cancelled: true
    })
  })

  it.each(['input', 'editor'] as const)(
    'answers cancelled:true from the "%s" branch\'s Cancel button without requiring text',
    (method) => {
      const onAnswer = vi.fn()
      render(
        <NativeChatExtensionUiCard
          request={{ type: 'extension_ui_request', id: 'req-7', method }}
          onAnswer={onAnswer}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onAnswer).toHaveBeenCalledWith({
        type: 'extension_ui_response',
        id: 'req-7',
        cancelled: true
      })
    }
  )
})

/** A long `select` with per-option details — an OMP builtin picker relayed
 *  through `extension_ui_request`, which is where filtering starts to matter. */
const PROVIDER_REQUEST: OmpRpcExtensionUiRequestFrame = {
  type: 'extension_ui_request',
  id: 'req-8',
  method: 'select',
  title: 'Pick a provider',
  options: ['Astra', 'Opus', 'Sonnet', 'Haiku', 'Gemini', 'Grok', 'Kimi'],
  optionDetails: [
    { description: 'openai-codex' },
    { description: 'anthropic' },
    { description: 'anthropic' },
    { description: 'anthropic' },
    { description: 'google' },
    { description: 'xai' },
    { description: 'moonshot' }
  ]
}

describe('NativeChatExtensionUiCard select list', () => {
  it('filters the options by label and by description as the user types', async () => {
    render(<NativeChatExtensionUiCard request={{ ...PROVIDER_REQUEST }} onAnswer={vi.fn()} />)
    const filter = screen.getByPlaceholderText('Filter…')

    fireEvent.change(filter, { target: { value: 'gem' } })
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
    expect(screen.getByRole('option', { name: /Gemini/ })).toBeInTheDocument()

    // 'moonshot' only ever appears in an optionDetails description.
    fireEvent.change(filter, { target: { value: 'MoonShot' } })
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
    expect(screen.getByRole('option', { name: /Kimi/ })).toBeInTheDocument()
  })

  it('says so honestly when the query matches nothing', async () => {
    render(<NativeChatExtensionUiCard request={{ ...PROVIDER_REQUEST }} onAnswer={vi.fn()} />)

    fireEvent.change(screen.getByPlaceholderText('Filter…'), { target: { value: 'zzz' } })
    await waitFor(() => expect(screen.getByText('No options match.')).toBeInTheDocument())
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('answers with the option string under the arrow-key highlight on Enter', () => {
    const onAnswer = vi.fn()
    render(<NativeChatExtensionUiCard request={{ ...PROVIDER_REQUEST }} onAnswer={onAnswer} />)
    const filter = screen.getByPlaceholderText('Filter…')

    // No `current` in an extension select, so the highlight starts on the
    // first option — the one the button list used to emphasise.
    expect(screen.getByRole('option', { name: /Astra/ })).toHaveAttribute('data-selected', 'true')
    fireEvent.keyDown(filter, { key: 'ArrowDown' })
    fireEvent.keyDown(filter, { key: 'ArrowDown' })
    fireEvent.keyDown(filter, { key: 'Enter' })

    expect(onAnswer).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'req-8',
      value: 'Sonnet'
    })
  })

  it('answers the filtered highlight, mapping the row back to its own option string', async () => {
    const onAnswer = vi.fn()
    render(<NativeChatExtensionUiCard request={{ ...PROVIDER_REQUEST }} onAnswer={onAnswer} />)
    const filter = screen.getByPlaceholderText('Filter…')

    fireEvent.change(filter, { target: { value: 'grok' } })
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /Grok/ })).toHaveAttribute('data-selected', 'true')
    )
    fireEvent.keyDown(filter, { key: 'Enter' })

    expect(onAnswer).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'req-8',
      value: 'Grok'
    })
  })

  it('keeps duplicate option strings separately choosable by row', () => {
    const onAnswer = vi.fn()
    render(
      <NativeChatExtensionUiCard
        request={{
          type: 'extension_ui_request',
          id: 'req-9',
          method: 'select',
          options: ['Retry', 'Retry'],
          optionDetails: [{ description: 'with the same tool' }, { description: 'with a new tool' }]
        }}
        onAnswer={onAnswer}
      />
    )

    expect(screen.getAllByRole('option')).toHaveLength(2)
    fireEvent.click(screen.getByRole('option', { name: /with a new tool/ }))
    expect(onAnswer).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'req-9',
      value: 'Retry'
    })
  })

  it('declines on Escape from the list instead of answering with an option', () => {
    const onAnswer = vi.fn()
    render(<NativeChatExtensionUiCard request={{ ...PROVIDER_REQUEST }} onAnswer={onAnswer} />)

    fireEvent.keyDown(screen.getByPlaceholderText('Filter…'), { key: 'Escape' })
    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(onAnswer).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'req-8',
      cancelled: true
    })
  })

  it('hides the filter field for a short list but still filters what the user types', async () => {
    render(
      <NativeChatExtensionUiCard
        request={{
          type: 'extension_ui_request',
          id: 'req-10',
          method: 'select',
          options: ['Approve', 'Deny']
        }}
        onAnswer={vi.fn()}
      />
    )

    const filter = screen.getByPlaceholderText('Filter…')
    expect(filter.closest('[data-cmdk-input-wrapper]')).toHaveClass('sr-only')

    fireEvent.change(filter, { target: { value: 'deny' } })
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
    expect(filter.closest('[data-cmdk-input-wrapper]')).not.toHaveClass('sr-only')
  })
})
