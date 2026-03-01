"use server";

import { cookies } from 'next/headers'
import { createServerClient, type CookieOptions } from '@supabase/ssr'

type SignupResult =
  | { ok: true; needsEmailVerification?: boolean }
  | { ok: false; message: string }

function normalizePhoneDigits(raw: string) {
  return raw.replace(/\D/g, '')
}

function isEmailNotConfirmedError(message: string) {
  const msg = String(message || '').toLowerCase()
  return msg.includes('email not confirmed') || msg.includes('confirm your email')
}

export async function signupAndSignInAction(formData: FormData): Promise<SignupResult> {
  const email = String(formData.get('email') || '').trim().toLowerCase()
  const password = String(formData.get('password') || '')
  const fullName = String(formData.get('fullName') || '').trim()
  const phone = String(formData.get('phone') || '').trim()

  if (!email || !password) return { ok: false, message: 'Email and password are required.' }
  if (fullName.length < 2) return { ok: false, message: 'Full name is required' }
  if (phone.length < 6) return { ok: false, message: 'Phone number is required' }

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

  const signupResult = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
        phone,
        phone_normalized: normalizePhoneDigits(phone),
      },
    },
  })
  if (signupResult.error) {
    return { ok: false, message: signupResult.error.message || 'Signup failed' }
  }

  if (signupResult.data.session) {
    return { ok: true }
  }

  const signInResult = await supabase.auth.signInWithPassword({ email, password })
  if (signInResult.error) {
    if (isEmailNotConfirmedError(signInResult.error.message)) {
      return { ok: true, needsEmailVerification: true }
    }
    return { ok: false, message: signInResult.error.message || 'Signup failed' }
  }

  return { ok: true }
}
