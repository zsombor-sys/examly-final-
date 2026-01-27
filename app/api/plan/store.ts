export type StoredPlan = {
  id: string
  userId: string
  title: string
  created_at: string
  result: any
}

function getStore(): Map<string, StoredPlan> {
  const g = globalThis as any
  if (!g.__planStore) g.__planStore = new Map<string, StoredPlan>()
  return g.__planStore as Map<string, StoredPlan>
}

export function savePlan(userId: string, title: string, result: any) {
  const store = getStore()
  const id = crypto.randomUUID()
  const created_at = new Date().toISOString()
  const row: StoredPlan = { id, userId, title, created_at, result }
  store.set(id, row)
  return row
}

export function listPlans(userId: string) {
  const store = getStore()
  return Array.from(store.values())
    .filter((x) => x.userId === userId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map((x) => ({ id: x.id, title: x.title, created_at: x.created_at }))
}

export function getPlan(userId: string, id: string) {
  const store = getStore()
  const row = store.get(id)
  if (!row || row.userId !== userId) return null
  return row
}

export function clearPlans(userId: string) {
  const store = getStore()
  for (const [id, row] of store.entries()) {
    if (row.userId === userId) store.delete(id)
  }
}
