"use server";

import { cookies } from 'next/headers'
import { createServerClient, type CookieOptions } from '@supabase/ssr'

type SignInResult = { ok: true } | { ok: false; message: string }

export async function signInWithPasswordAction(formData: FormData): Promise<SignInResult> {
  const email = String(formData.get('email') || '').trim().toLowerCase()
  const password = String(formData.get('password') || '')

  if (!email || !password) {
    return { ok: false, message: 'Email and password are required.' }
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) {
    return { ok: false, message: 'Auth misconfigured: missing Supabase public environment variables.' }
  }

  const cookieStore = await cookies()
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return cookieStore.getAll().map((c) => ({ name: c.name, value: c.value }))
      },
      setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
        cookiesToSet.forEach(({ name, value, options }) => {
          cookieStore.set(name, value, options)
        })
      },
    },
  })

  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) return { ok: false, message: error.message || 'Login failed.' }
  return { ok: true }
}
