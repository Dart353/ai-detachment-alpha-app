/** Shell-quote a path so it can be woven into a command line. POSIX single
 *  quotes: everything inside is literal, and an embedded quote is closed,
 *  escaped and reopened. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
