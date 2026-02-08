export function throwIfMissingTable(error: any, table: string) {
  const message = String(error?.message ?? '')
  if (!message.includes(`Could not find table public.${table} in schema cache`)) return
  console.error('supabase.schema_cache_missing', { table, message })
  const err: any = new Error(`Supabase schema cache missing table "${table}". Reload schema and retry.`)
  err.status = 500
  throw err
}
