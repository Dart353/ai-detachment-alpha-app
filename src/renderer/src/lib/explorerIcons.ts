/**
 * The explorer's file/folder glyph resolver — the ONE seam between file names and
 * their Lucide icons. Everything visual about "what does a `.tsx` look like" is
 * decided here and nowhere else, so a later upgrade to per-language art is a swap
 * of this module's internals with no change to ExplorerPanel.
 *
 * Icons are the typed `File*` family plus `Folder`/`FolderOpen`; they draw as a
 * `currentColor` stroke, so they follow whatever the row's text colour is.
 */
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileKey,
  FileLock,
  FileSliders,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  type LucideIcon
} from 'lucide-react'

// Extension (lower-case, no dot) → glyph. Grouped by kind for readability; the
// lookup is a flat map so a new extension is a one-line addition.
const BY_EXT: Record<string, LucideIcon> = {
  // code
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  ts: FileCode,
  tsx: FileCode,
  py: FileCode,
  rb: FileCode,
  go: FileCode,
  rs: FileCode,
  java: FileCode,
  c: FileCode,
  cpp: FileCode,
  h: FileCode,
  cs: FileCode,
  php: FileCode,
  swift: FileCode,
  kt: FileCode,
  html: FileCode,
  css: FileCode,
  scss: FileCode,
  sass: FileCode,
  vue: FileCode,
  svelte: FileCode,
  sql: FileCode,
  // shells
  sh: FileTerminal,
  bash: FileTerminal,
  zsh: FileTerminal,
  fish: FileTerminal,
  // config / data
  json: FileJson,
  yaml: FileSliders,
  yml: FileSliders,
  toml: FileSliders,
  ini: FileSliders,
  conf: FileSliders,
  xml: FileCode,
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  // docs
  md: FileText,
  mdx: FileText,
  txt: FileText,
  pdf: FileText,
  // images
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  svg: FileImage,
  webp: FileImage,
  ico: FileImage,
  avif: FileImage,
  // media
  mp4: FileVideo,
  mov: FileVideo,
  webm: FileVideo,
  mkv: FileVideo,
  mp3: FileAudio,
  wav: FileAudio,
  ogg: FileAudio,
  flac: FileAudio,
  // archives
  zip: FileArchive,
  tar: FileArchive,
  gz: FileArchive,
  tgz: FileArchive,
  rar: FileArchive,
  '7z': FileArchive,
  // locks / secrets
  lock: FileLock,
  pem: FileKey,
  key: FileKey
}

// A handful of extension-less files carry a strong identity by their exact name.
const BY_NAME: Record<string, LucideIcon> = {
  dockerfile: FileCode,
  makefile: FileCog,
  license: FileText,
  readme: FileText,
  '.env': FileLock,
  '.gitignore': FileSliders,
  '.npmrc': FileSliders
}

/** The Lucide glyph for a file, by exact name first, then extension, else `File`. */
export function iconForFile(name: string): LucideIcon {
  const lower = name.toLowerCase()
  const exact = BY_NAME[lower]
  if (exact) return exact
  // dotenv variants (.env.local, .env.production) share the lock glyph
  if (lower.startsWith('.env')) return FileLock
  const dot = lower.lastIndexOf('.')
  const ext = dot > 0 ? lower.slice(dot + 1) : ''
  return BY_EXT[ext] ?? File
}

/** Folder glyph, open or closed — the twist of the disclosure, mirrored in art. */
export function iconForFolder(open: boolean): LucideIcon {
  return open ? FolderOpen : Folder
}
