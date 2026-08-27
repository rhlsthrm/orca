// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatExtensionUiCard } from './NativeChatExtensionUiCard'

afterEach(() => cleanup())

describe('NativeChatExtensionUiCard', () => {
  it('renders select options and answers with the chosen option string, using optionDetails as a title', () => {
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

    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve).toHaveAttribute('title', 'Run the command')
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
})
