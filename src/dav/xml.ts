/**
 * Minimal, dependency-free XML parser and serializer for CalDAV/WebDAV
 * bodies. Namespaces are handled conservatively: element names keep their
 * prefix ("D:response", "C:calendar-query") and are matched by local name
 * when reading; requests are written with explicit xmlns declarations.
 */

export interface XmlNode {
  /** qualified name as written, e.g. "D:multistatus" or "multistatus" */
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (Number.isFinite(code)) return String.fromCodePoint(code)
      return m
    }
    return ENTITIES[body] ?? m
  })
}

export function parseXml(input: string): XmlNode {
  let i = 0
  const len = input.length

  const skipMisc = (): void => {
    for (;;) {
      if (input.startsWith('<?', i)) {
        const end = input.indexOf('?>', i)
        i = end === -1 ? len : end + 2
      } else if (input.startsWith('<!--', i)) {
        const end = input.indexOf('-->', i)
        i = end === -1 ? len : end + 3
      } else if (input.slice(i, i + 2).match(/^\s/) || input[i] === '\n' || input[i] === '\r' || input[i] === '\t' || input[i] === ' ') {
        i++
      } else {
        break
      }
    }
  }

  const readName = (): string => {
    let j = i
    while (j < len && /[A-Za-z0-9_:\-.]/.test(input[j])) j++
    const name = input.slice(i, j)
    i = j
    return name
  }

  const readAttributes = (): Record<string, string> => {
    const attrs: Record<string, string> = {}
    for (;;) {
      while (i < len && /\s/.test(input[i])) i++
      if (i >= len || input[i] === '>' || input[i] === '/') break
      const name = readName()
      while (i < len && /\s/.test(input[i])) i++
      let value = ''
      if (input[i] === '=') {
        i++
        while (i < len && /\s/.test(input[i])) i++
        const quote = input[i]
        i++
        let v = ''
        while (i < len && input[i] !== quote) {
          if (input.startsWith('&', i)) {
            const semi = input.indexOf(';', i)
            v += input.slice(i, semi + 1)
            i = semi + 1
          } else {
            v += input[i++]
          }
        }
        i++ // closing quote
        value = decodeEntities(v)
      }
      attrs[name] = value
    }
    return attrs
  }

  const parseElement = (): XmlNode => {
    while (i < len && /\s/.test(input[i])) i++
    if (input[i] !== '<') throw new Error(`expected '<' at offset ${i}`)
    i++
    const name = readName()
    const attrs = readAttributes()
    let selfClose = false
    if (input[i] === '/') { selfClose = true; i++ }
    if (input[i] !== '>') throw new Error(`expected '>' for <${name}> at offset ${i}`)
    i++
    const node: XmlNode = { name, attrs, children: [], text: '' }
    if (selfClose) return node
    let text = ''
    for (;;) {
      if (i >= len) throw new Error(`unterminated <${name}>`)
      if (input.startsWith('</', i)) {
        const end = input.indexOf('>', i)
        i = end === -1 ? len : end + 1
        break
      }
      if (input[i] === '<') {
        if (input.startsWith('<!--', i)) {
          const end = input.indexOf('-->', i)
          i = end === -1 ? len : end + 3
          continue
        }
        node.children.push(parseElement())
        continue
      }
      text += input[i++]
    }
    node.text = decodeEntities(text.trim())
    return node
  }

  skipMisc()
  if (input.startsWith('<', i) === false) throw new Error('no root element')
  const root = parseElement()
  return root
}

/** All descendant-or-self nodes whose local element name equals `local`. */
export function findByLocal(root: XmlNode, local: string): XmlNode[] {
  const out: XmlNode[] = []
  const walk = (n: XmlNode) => {
    const name = n.name.includes(':') ? n.name.slice(n.name.indexOf(':') + 1) : n.name
    if (name === local) out.push(n)
    for (const c of n.children) walk(c)
  }
  walk(root)
  return out
}

/** First descendant-or-self match of a local name. */
export function findLocal(root: XmlNode, local: string): XmlNode | undefined {
  return findByLocal(root, local)[0]
}

export function childLocal(node: XmlNode, local: string): XmlNode | undefined {
  return node.children.find((c) => (c.name.includes(':') ? c.name.slice(c.name.indexOf(':') + 1) : c.name) === local)
}

export function childLocalAll(node: XmlNode, local: string): XmlNode[] {
  return node.children.filter((c) => (c.name.includes(':') ? c.name.slice(c.name.indexOf(':') + 1) : c.name) === local)
}

export function textOf(node: XmlNode | undefined): string {
  return node?.text ?? ''
}

/** Element name without its namespace prefix. */
export function localName(name: string): string {
  return name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
}

/** Text content of a node merged over any nested children (e.g. escaped ICS). */
export function cellChildrenText(node: XmlNode): string {
  const parts: string[] = []
  const walk = (n: XmlNode) => {
    if (n.children.length === 0) parts.push(n.text)
    else for (const c of n.children) walk(c)
  }
  walk(node)
  return parts.join('')
}

/* ------------------------------------------------------------------ */
/* Serializer                                                           */
/* ------------------------------------------------------------------ */

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface Elem {
  prefix?: string
  local: string
  attrs?: Record<string, string>
  children?: Array<Elem | string>
}

/** Render an element tree to an XML string. */
export function renderXml(e: Elem): string {
  const name = e.prefix ? `${e.prefix}:${e.local}` : e.local
  const attrs = e.attrs
    ? Object.entries(e.attrs).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('')
    : ''
  if (!e.children || e.children.length === 0) return `<${name}${attrs}/>`
  const inner = e.children.map((c) => (typeof c === 'string' ? escapeXml(c) : renderXml(c))).join('')
  return `<${name}${attrs}>${inner}</${name}>`
}
