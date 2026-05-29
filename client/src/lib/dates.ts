function parseIso(iso: string): Date {
  const s = iso.trim().replace(' ', 'T')
  if (!/Z$|[+-]\d{2}:\d{2}$/.test(s) && /\d{2}:\d{2}/.test(s)) {
    return new Date(s + 'Z')
  }
  return new Date(s)
}

export function formatDateTime(iso: string): string {
  const d = parseIso(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatTime(iso: string): string {
  return parseIso(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function formatDate(iso: string): string {
  return parseIso(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
