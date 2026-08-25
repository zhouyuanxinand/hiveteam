// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { Topbar } from '../../web/src/layout/Topbar.js'

afterEach(() => {
  cleanup()
})

describe('Topbar local version display', () => {
  test('shows the local version without an official update badge', () => {
    render(<Topbar hideActions version="1.4.0" />)

    expect(screen.getByTestId('topbar-logo')).toHaveAttribute('src', '/logo.png')
    expect(screen.getByText('v1.4.0')).toBeInTheDocument()
    expect(screen.queryByTestId('topbar-update-badge')).not.toBeInTheDocument()
  })
})
