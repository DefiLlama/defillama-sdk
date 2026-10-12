// a node that refuses a getLogs range says so in its error, and usually says what it would have
// accepted. these are the phrasings the rpcs in providers.json actually return.

// the node's message sits in different fields depending on who wrapped the error
const errorMessageFields = ['message', 'shortMessage', 'reason', 'data', '_underlyingError', 'error', 'info', 'response', 'errors']

export function getErrorText(e: any, depth = 0): string {
  if (typeof e === 'string') return e
  if (!e || typeof e !== 'object' || depth > 5) return ''
  if (Array.isArray(e)) return e.map((i) => getErrorText(i, depth + 1)).filter(Boolean).join(' ')
  return errorMessageFields
    .map((key) => getErrorText(e[key], depth + 1))
    .filter(Boolean)
    .join(' ')
}

const rangeComplaint = [
  /too many results/i,
  /max(?:imum)? results/i,
  /more than \d+ results/i,
  /result set too large/i,
  /response size/i,
  /block ?range/i,
  /range too (?:large|wide|big)/i,
  /must not exceed/i,
  /limited to/i,
  /too many blocks/i,
  /query (?:timed out|timeout)/i,
  /request timed out/i,
  /exceeds? the (?:maximum|limit)/i,
]

// retrying a narrower range cannot fix any of these
const notAboutRange = [
  /unauthor/i,
  /api ?key/i,
  /personal token/i,
  /forbidden/i,
  /authenticate/i,
  /payment required/i,
  /method (?:not|is not) (?:available|supported|found)/i,
  /unsupported method/i,
  /archive/i,
]

export function isRangeTooWideError(e: any): boolean {
  const text = getErrorText(e)
  if (!text) return false
  if (notAboutRange.some((p) => p.test(text))) return false
  return rangeComplaint.some((p) => p.test(text))
}

// a stated block count, as a count of blocks rather than a from/to delta
const spanHints = [
  /limited to\s+\d+\s*-\s*(\d+)\s*blocks?/i,
  /maximum allowed(?:\s+number of requested blocks)? is\s+(\d+)/i,
  /max(?:imum)?\s+block\s*range\s+(?:is\s+)?(\d+)/i,
  /must not exceed\s+(\d+)\s*blocks?/i,
  /limited to\s+(\d+)\s*blocks?/i,
  /up to\s+(\d+)\s*blocks?/i,
  /(\d+)\s*blocks?\s+max/i,
]

// "retry with the range 26174185-26174468" states a window rather than a width
const windowHint = /retry with the (?:block )?range\s+(\d+)\s*-\s*(\d+)/i

export function getHintedBlockSpan(e: any): number | undefined {
  const text = getErrorText(e)
  if (!text) return undefined

  const window = text.match(windowHint)
  if (window) {
    const span = Number(window[2]) - Number(window[1]) + 1
    if (span > 0) return span
  }

  const spans = spanHints
    .map((p) => text.match(p)?.[1])
    .filter(Boolean)
    .map(Number)
    .filter((n) => n > 0)
  return spans.length ? Math.min(...spans) : undefined
}
