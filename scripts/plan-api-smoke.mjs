const baseUrl = process.env.BASE_URL || 'http://localhost:3000'
const token = process.env.SUPABASE_TEST_TOKEN || ''

async function readJson(res) {
  const text = await res.text()
  try {
    return { json: JSON.parse(text), text }
  } catch (err) {
    throw new Error(`Non-JSON response from ${res.url} (status ${res.status}): ${text.slice(0, 200)}`)
  }
}

async function checkHistoryNoAuth() {
  const res = await fetch(`${baseUrl}/api/plan/history`)
  const { json } = await readJson(res)
  if (res.status !== 401) {
    throw new Error(`Expected 401 for unauthenticated history, got ${res.status}`)
  }
  if (json?.error !== 'UNAUTHORIZED') {
    throw new Error(`Expected UNAUTHORIZED error, got ${JSON.stringify(json)}`)
  }
  console.log('OK: GET /api/plan/history returns 401 without auth')
}

async function checkHistoryWithAuth() {
  if (!token) {
    console.log('SKIP: set SUPABASE_TEST_TOKEN to test authenticated history')
    return
  }
  const res = await fetch(`${baseUrl}/api/plan/history`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const { json } = await readJson(res)
  if (!res.ok) {
    throw new Error(`Expected 200 for authenticated history, got ${res.status}: ${JSON.stringify(json)}`)
  }
  if (!Array.isArray(json?.items)) {
    throw new Error(`Expected items[] array, got ${JSON.stringify(json)}`)
  }
  console.log('OK: GET /api/plan/history returns 200 with auth')
}

async function checkPlanPostJson() {
  if (!token) {
    console.log('SKIP: set SUPABASE_TEST_TOKEN to test POST /api/plan')
    return
  }
  const form = new FormData()
  form.append('prompt', 'Smoke test prompt for JSON response')
  form.append('planId', crypto.randomUUID())
  const res = await fetch(`${baseUrl}/api/plan`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  const { json } = await readJson(res)
  if (!json) {
    throw new Error('Expected JSON response from POST /api/plan')
  }
  console.log(`OK: POST /api/plan returns JSON (status ${res.status})`)
}

async function main() {
  console.log(`Base URL: ${baseUrl}`)
  console.log('Tip: to simulate OpenAI failure, run the server with an invalid OPENAI_API_KEY and re-run this script.')
  await checkHistoryNoAuth()
  await checkHistoryWithAuth()
  await checkPlanPostJson()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
