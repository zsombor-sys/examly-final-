"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { signInWithPasswordAction } from "./actions";

export default function LoginClient() {
  const router = useRouter();
  const sp = useSearchParams();
  const next = sp.get("next") || "/plan";

  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <form
      action={async (fd) => {
        setErr(null);
        setLoading(true);

        const res = await signInWithPasswordAction(fd);

        setLoading(false);

        if (!res.ok) {
          setErr(res.message || "Login failed");
          return;
        }

        router.replace(next);
        router.refresh();
      }}
    >
      <input name="email" type="email" placeholder="Email" required />
      <input name="password" type="password" placeholder="Password" required />
      <button type="submit" disabled={loading}>
        {loading ? "Logging in..." : "Log in"}
      </button>
      {err && <p>{err}</p>}
    </form>
  );
}
