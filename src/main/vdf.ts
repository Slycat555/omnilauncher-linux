/**
 * Minimal parser for Valve's text KeyValues (VDF) format, used by
 * libraryfolders.vdf, appmanifest_*.acf and loginusers.vdf. Read-only.
 */
export type VdfNode = { [key: string]: VdfNode | string }

export function parseVdf(text: string): VdfNode {
  let i = 0
  const n = text.length

  function skipWhitespaceAndComments(): void {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++
      if (text[i] === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++
        continue
      }
      break
    }
  }

  function readQuoted(): string {
    // assumes text[i] === '"'
    i++
    let out = ''
    while (i < n && text[i] !== '"') {
      if (text[i] === '\\' && i + 1 < n) {
        out += text[i + 1]
        i += 2
      } else {
        out += text[i]
        i++
      }
    }
    i++ // closing quote
    return out
  }

  function readToken(): string {
    let out = ''
    while (i < n && !/\s/.test(text[i])) {
      out += text[i]
      i++
    }
    return out
  }

  function readValueOrKey(): string {
    skipWhitespaceAndComments()
    if (text[i] === '"') return readQuoted()
    return readToken()
  }

  function parseObject(): VdfNode {
    const obj: VdfNode = {}
    for (;;) {
      skipWhitespaceAndComments()
      if (i >= n || text[i] === '}') {
        i++
        return obj
      }
      const key = readValueOrKey()
      skipWhitespaceAndComments()
      if (text[i] === '{') {
        i++
        obj[key] = parseObject()
      } else {
        obj[key] = readValueOrKey()
      }
    }
  }

  skipWhitespaceAndComments()
  // top-level: "RootKey" { ... }
  const rootKey = readValueOrKey()
  skipWhitespaceAndComments()
  if (text[i] === '{') {
    i++
    return { [rootKey]: parseObject() }
  }
  return {}
}

export function isVdfObject(v: VdfNode | string | undefined): v is VdfNode {
  return typeof v === 'object' && v !== null
}
