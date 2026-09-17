import type { ITheme } from '@xterm/xterm'

const dark: ITheme = {
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#cba6f7',
  cyan: '#94e2d5',
  white: '#cdd6f4',
  brightBlack: '#9399b2',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#b4befe',
  brightMagenta: '#f5c2e7',
  brightCyan: '#89dceb',
  brightWhite: '#ffffff',
}
const light: ITheme = {
  black: '#17202a',
  red: '#a31d2b',
  green: '#176138',
  yellow: '#805500',
  blue: '#2348a5',
  magenta: '#8b267f',
  cyan: '#086775',
  white: '#526072',
  brightBlack: '#596779',
  brightRed: '#b42318',
  brightGreen: '#246b39',
  brightYellow: '#765900',
  brightBlue: '#3358d4',
  brightMagenta: '#843da4',
  brightCyan: '#006a73',
  brightWhite: '#17202a',
}

export const readTerminalAppearance = () => {
  const isLight = document.documentElement.dataset.hiveTheme === 'light'
  const styles = getComputedStyle(document.documentElement)
  const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback
  const foreground = color('--text-primary', isLight ? '#17202a' : '#ebebeb')
  const inputForeground = isLight ? color('--accent', '#3358d4') : '#93c5fd'
  return {
    inputBackground: color('--bg-2', isLight ? '#eef1f5' : '#1d1d1d'),
    inputForeground,
    theme: {
      ...(isLight ? light : dark),
      background: color('--bg-crust', isLight ? '#e9edf2' : '#0e0e0e'),
      foreground,
      cursor: foreground,
      selectionBackground: isLight ? '#b9c9ef' : '#30466a',
    } satisfies ITheme,
  }
}
