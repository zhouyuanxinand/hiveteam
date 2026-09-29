import { describe, expect, test } from 'vitest'
import {
  isTerminalGrillCompletionPrefix,
  parseTerminalGrill,
  readTerminalGrillComposer,
  TerminalGrillInput,
} from '../../src/server/terminal-grill-input.js'

const feed = (editor: TerminalGrillInput, chunks: string[]) => {
  const tokens = chunks.flatMap((chunk) => editor.tokenize(chunk))
  for (const token of tokens) editor.observe(token)
  return tokens
}

describe('explicit interview input', () => {
  test.each([
    'grill',
    'grilling',
    'grill-me',
    'grill-with-docs',
    'matt/grill-with-docs',
  ])('recognizes the %s skill with an optional brief', (skill) => {
    expect(parseTerminalGrill(`$${skill}`)).toEqual({ skill, brief: '' })
    expect(parseTerminalGrill(`$${skill} clarify this plan`)).toEqual({
      skill,
      brief: 'clarify this plan',
    })
  })
  test.each([
    'echo $grill',
    'Please discuss $grill',
    '$grill-extra',
    '$grill\nsecond line',
    'grilling',
  ])('preserves ordinary or multiline input: %s', (text) => {
    expect(parseTerminalGrill(text)).toBeNull()
  })
  test('uses the final composer rather than an earlier user message', () => {
    expect(
      readTerminalGrillComposer('› $grill\nresult\n› Ask Codex to do anything\nGPT-6 medium')?.text
    ).toBe('Ask Codex to do anything')
    expect(readTerminalGrillComposer('› $grill\n$second-draft-line\nGPT-6 medium')).toBeNull()
    expect(readTerminalGrillComposer('› $grill\nanother draft line\nGPT-6 medium')).toBeNull()
  })
  test('reports blockers and exact paste size without treating the placeholder as a trigger', () => {
    const paste = readTerminalGrillComposer('› [Pasted Content 1,234 chars]\nGPT-6 medium')
    expect(paste).toMatchObject({ pastedCharacters: 1234, busy: false, blocked: false })
    expect(parseTerminalGrill(paste?.text ?? '')).toBeNull()
    expect(
      readTerminalGrillComposer('Working · esc to interrupt\n› $grill\nGPT-6 medium')?.busy
    ).toBe(true)
    expect(
      readTerminalGrillComposer('This conversation is open in another app\n› $grill\nGPT-6 medium')
        ?.blocked
    ).toBe(true)
  })
})

describe('terminal byte tracking', () => {
  test('recognizes a submission split across transport frames and preserves every byte', () => {
    const editor = new TerminalGrillInput()
    const tokens = feed(editor, ['$gri', 'll-with-docs', '\r'])
    expect(editor.text).toBe('$grill-with-docs')
    expect(tokens.filter((token) => token.submit)).toHaveLength(1)
    expect(tokens.map((token) => token.data).join('')).toBe('$grill-with-docs\r')
  })
  test('forwards a standalone Escape immediately, without requiring a later key', () => {
    const editor = new TerminalGrillInput()
    expect(
      editor
        .tokenize('\u001b')
        .map((token) => token.data)
        .join('')
    ).toBe('\u001b')
    const remaining = editor.tokenize('\r')
    expect(remaining.map((token) => token.data).join('')).toBe('\r')
    expect(remaining.filter((token) => token.submit)).toHaveLength(1)
  })
  test('tracks arrow edits even when the escape is split between frames', () => {
    const editor = new TerminalGrillInput()
    const tokens = feed(editor, ['$grillx', '\u001b', '[', 'D', '\u001b[3~'])
    expect(editor.text).toBe('$grill')
    expect(tokens.map((token) => token.data).join('')).toBe('$grillx\u001b[D\u001b[3~')
  })
  test('tracks backspace, cursor movement, replacement, and Unicode characters', () => {
    const editor = new TerminalGrillInput()
    feed(editor, ['$grillx', '\u007f', ' 确认😀', '\b', '\u0001', '\u000b', '$grilling'])
    expect(editor.text).toBe('$grilling')
    feed(editor, ['\u0005\u0015'])
    expect(editor.text).toBe('')
  })
  test('does not interpret a newline inside a split bracketed paste as Enter', () => {
    const editor = new TerminalGrillInput()
    const chunks = ['\u001b', '[20', '0~$grill\n', 'another line\u001b[20', '1', '~', '\r']
    const tokens = feed(editor, chunks)
    expect(tokens.map((token) => token.data).join('')).toBe(chunks.join(''))
    expect(tokens.filter((token) => token.submit)).toHaveLength(1)
    expect(editor.text).toBe('$grill\nanother line')
  })
  test('tracks ordinary bracketed paste and does not count terminal replies as edits', () => {
    const editor = new TerminalGrillInput()
    feed(editor, ['\u001b[200~$grill-with-docs\u001b[201~', '\u001b[12;4R', '\u001b[I'])
    expect(editor.text).toBe('$grill-with-docs')
  })
  test('invalidates unknown editing operations until a new confirmed composer', () => {
    const editor = new TerminalGrillInput()
    feed(editor, ['$grill', '\u001b[A'])
    expect(editor.text).toBeNull()
    editor.reset()
    feed(editor, ['$grill'])
    expect(editor.text).toBe('$grill')
  })
  test('keeps the draft when Escape closes a completion menu before Enter', () => {
    const editor = new TerminalGrillInput()
    feed(editor, ['$grill', '\u001b', '\r'])
    expect(editor.text).toBe('$grill')
  })
  test('allows a new interview command after a separately pressed Escape', () => {
    const editor = new TerminalGrillInput()
    const tokens = feed(editor, ['\u001b', '$grill-with-docs', '\r'])
    expect(editor.text).toBe('$grill-with-docs')
    expect(tokens.map((token) => token.data).join('')).toBe('\u001b$grill-with-docs\r')
    expect(tokens.filter((token) => token.submit)).toHaveLength(1)
  })
  test('can recover known input after clearing an unknown draft', () => {
    const editor = new TerminalGrillInput()
    feed(editor, ['$gri', '\t', '\u0005\u0015', '$grill-with-docs'])
    expect(editor.text).toBe('$grill-with-docs')
  })
  test('handles SS3 Home and End key encodings without inserting their letters', () => {
    const editor = new TerminalGrillInput()
    feed(editor, ['$grillx', '\u001b', 'O', 'H', '\u001bOF', '\b'])
    expect(editor.text).toBe('$grill')
  })
  test('tracks only a native completion of an explicitly typed skill prefix', () => {
    const editor = new TerminalGrillInput()
    feed(editor, ['$grill-with', '\t'])
    expect(editor.completionPrefix).toBe('$grill-with')
    expect(editor.text).toBeNull()
    editor.reset('$grill-with-docs')
    expect(editor.completionPrefix).toBeNull()
    expect(editor.text).toBe('$grill-with-docs')
    expect(isTerminalGrillCompletionPrefix('$grill-w')).toBe(true)
    expect(isTerminalGrillCompletionPrefix('echo $grill')).toBe(false)
    expect(isTerminalGrillCompletionPrefix('$git')).toBe(false)
    editor.expectCompletion('$grill-with')
    editor.invalidate()
    expect(editor.completionPrefix).toBeNull()
  })
  test('retains the draft across complete and fragmented OSC/DCS terminal replies', () => {
    const editor = new TerminalGrillInput()
    const chunks = [
      '$grill',
      '\u001b]11;rgb:0000/0000/0000\u0007',
      '\u001b]',
      '10;rgb:ffff/',
      'ffff/ffff\u001b',
      '\\',
      '\u001bP',
      '1$r0m',
      '\u001b',
      '\\',
    ]
    const tokens = feed(editor, chunks)
    expect(editor.text).toBe('$grill')
    expect(tokens.map((token) => token.data).join('')).toBe(chunks.join(''))
    expect(tokens.filter((token) => token.submit)).toEqual([])
  })
})
