/**
 * Glyphs for the "Remote files" tab.
 *
 * The sidebar's own tree draws file-type icons through
 * `@deepseek-ai/dsh-client-ui-primitives`, which belongs to that plugin and is
 * not a dependency of this one — importing it would make an unrelated package
 * load-bearing for a cosmetic detail, and the module is not resolvable in a
 * profile that has the sidebar installed without it.
 *
 * These are therefore drawn here: one 14px outline per file family, all riding
 * `currentColor` so a theme or skin repaints them with the row's label colour.
 * `fileGlyph` answers a family, not a single extension, because the tree only
 * needs enough difference to scan a directory — a distinct emblem per
 * extension would be noise at this size.
 *
 * @module dsh-waypoint/client/remote-tree-icons
 */

/** Every glyph is drawn on the same 16-unit grid so rows line up. */
const GRID = 16

/** The icon size the sidebar's own rows use. */
export const GLYPH_SIZE = 14

function svg(children: JSX.Element): JSX.Element {
  return (
    <svg
      width={GLYPH_SIZE}
      height={GLYPH_SIZE}
      viewBox={`0 0 ${GRID} ${GRID}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flex: 'none' }}
    >
      {children}
    </svg>
  )
}

/** A plain document outline, shared by every family that has no better glyph. */
function document(extra?: JSX.Element): JSX.Element {
  return svg(
    <>
      <path d="M4.2 2.2h4.4l3.2 3.2v8.4H4.2z" />
      <path d="M8.6 2.2v3.2h3.2" />
      {extra}
    </>,
  )
}

/** A folder outline; `open` slants the lid so expansion reads at a glance. */
function folder(open: boolean): JSX.Element {
  return open
    ? svg(
      <>
        <path d="M2.2 6.4V4.2h3.1l1.2 1.3h5.1v1" />
        <path d="M2.2 6.4h11.6l-1.3 6.2H3.5z" />
      </>,
    )
    : svg(
      <>
        <path d="M2.2 4.2h3.1l1.2 1.3h7.3v7.3H2.2z" />
      </>,
    )
}

/** Family of a file name, from its extension (case-insensitive). */
export function fileFamilyOf(name: string): string {
  const dot = name.lastIndexOf('.')
  // A leading dot is a hidden file (`.env`), not an extension.
  if (dot <= 0) return 'plain'
  const extension = name.slice(dot + 1).toLowerCase()
  if (['ts', 'tsx', 'mts', 'cts'].includes(extension)) return 'typescript'
  if (['js', 'jsx', 'mjs', 'cjs'].includes(extension)) return 'javascript'
  if (['json', 'jsonc', 'json5'].includes(extension)) return 'json'
  if (['md', 'mdx', 'markdown', 'txt', 'rst'].includes(extension)) return 'prose'
  if (['css', 'scss', 'sass', 'less'].includes(extension)) return 'style'
  if (['html', 'htm', 'xml', 'vue', 'svelte'].includes(extension)) return 'markup'
  if (['py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'php'].includes(extension)) return 'code'
  if (['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat'].includes(extension)) return 'shell'
  if (['yml', 'yaml', 'toml', 'ini', 'conf', 'env'].includes(extension)) return 'config'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(extension)) return 'image'
  if (['lock', 'log'].includes(extension)) return 'lock'
  return 'plain'
}

/** The glyph for one file name. */
export function fileGlyph(name: string): JSX.Element {
  switch (fileFamilyOf(name)) {
    case 'typescript':
    case 'javascript':
      return document(<path d="M6 11.4l2-2.6M8 8.8l.1 2.6M6.4 8.6h2.4" />)
    case 'json':
      return document(<path d="M6.2 8.4c-.7 0-.8.5-.8 1s-.3 1-1 1c.7 0 1 .5 1 1s.1 1 .8 1M9.4 8.4c.7 0 .8.5.8 1s.3 1 1 1c-.7 0-1 .5-1 1s-.1 1-.8 1" />)
    case 'prose':
      return document(<><path d="M5.8 8.6h4.4M5.8 10.4h4.4M5.8 12.2h3" /></>)
    case 'style':
      return document(<path d="M5.4 11.6l1.8 1.6 3.4-3.6" />)
    case 'markup':
      return document(<path d="M6.4 9l-1.2 1.6 1.2 1.6M9.2 9l1.2 1.6-1.2 1.6" />)
    case 'code':
      return document(<path d="M6.2 12.6l1.6-3.8M8.2 12.6l1.6-3.8" />)
    case 'shell':
      return document(<><path d="M5.6 9.6l1.4 1.2-1.4 1.2M8.4 12.2h2" /></>)
    case 'config':
      return document(<><circle cx="8" cy="11" r="1.1" /><path d="M8 8.6v1.3M8 12.1v1.3" /></>)
    case 'image':
      return document(<><path d="M5.2 9.6l1.6 1.5 1.3-1.4 2.5 2.6" /><circle cx="6.4" cy="8.6" r=".7" /></>)
    case 'lock':
      return document(<><path d="M6.4 11.6h3.2v2.2H6.4z" /><path d="M7 11.6v-.9a1 1 0 012 0v.9" /></>)
    default:
      return document()
  }
}

/** The glyph for a directory row; `open` reflects its expanded state. */
export function folderGlyph(open: boolean): JSX.Element {
  return folder(open)
}

/** Whether a name is hidden by POSIX convention (a leading dot). */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.')
}
