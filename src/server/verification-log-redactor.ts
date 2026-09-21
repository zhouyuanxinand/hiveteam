import { redactVerificationLog } from './verification-logs.js'

/** Keep recognisable prefixes across process chunks without buffering an unbounded line. */
export const createVerificationLogRedactor = () => {
  let pending = ''
  let mode: 'text' | 'value' | 'key' | 'url' = 'text'
  let valueStarted = false
  let authority = ''
  let authorityHidden = false
  const marker =
    /authorization[ \t]*:[ \t]*(?:bearer|basic)[ \t]+|(?:api[_-]?key|token|password|secret)[ \t]*[=:][ \t]*|-----BEGIN [^-\r\n]*PRIVATE KEY-----|https?:\/\//iu
  const drain = (final: boolean) => {
    let output = ''
    while (pending) {
      if (mode === 'value') {
        if (!valueStarted) pending = pending.replace(/^[ \t]+/u, '')
        const end = pending.search(/[\s,;]/u)
        if (end < 0) {
          valueStarted ||= pending.length > 0
          pending = ''
          break
        }
        pending = pending.slice(end)
        mode = 'text'
        continue
      }
      if (mode === 'key') {
        const end = /-----END [^-\r\n]*PRIVATE KEY-----/u.exec(pending)
        if (!end) {
          pending = final ? '' : pending.slice(-128)
          break
        }
        pending = pending.slice(end.index + end[0].length)
        mode = 'text'
        continue
      }
      if (mode === 'url') {
        const end = pending.search(/[\s/?#]/u)
        const part = end < 0 ? pending : pending.slice(0, end)
        if (!authorityHidden) {
          authority += part
          if (authority.length > 8192) {
            authority = '[REDACTED AUTHORITY]'
            authorityHidden = true
          }
        }
        pending = end < 0 ? '' : pending.slice(end)
        if (end < 0 && !final) break
        output += authorityHidden ? authority : authority.replace(/^.*@/u, '[REDACTED]@')
        authority = ''
        authorityHidden = false
        mode = 'text'
        continue
      }
      const match = marker.exec(pending)
      if (!match) {
        const size = final
          ? pending.length
          : Math.max(pending.lastIndexOf('\n') + 1, pending.length - 256, 0)
        output += redactVerificationLog(pending.slice(0, size))
        pending = pending.slice(size)
        break
      }
      output += redactVerificationLog(pending.slice(0, match.index))
      pending = pending.slice(match.index + match[0].length)
      if (match[0].startsWith('-----')) {
        output += '[REDACTED PRIVATE KEY]'
        mode = 'key'
      } else if (/^https?:/iu.test(match[0])) {
        output += match[0]
        mode = 'url'
      } else {
        output += `${match[0]}[REDACTED]`
        mode = 'value'
        valueStarted = false
      }
    }
    if (final && mode === 'url') {
      output += authorityHidden ? authority : authority.replace(/^.*@/u, '[REDACTED]@')
      authority = ''
      mode = 'text'
    }
    return output
  }
  return {
    push(text: string) {
      pending += text
      return drain(false)
    },
    finish() {
      return drain(true)
    },
  }
}
