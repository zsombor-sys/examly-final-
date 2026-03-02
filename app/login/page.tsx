"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

function safeNext(next: string | null) {
  const n = next || "/plan";
  if (!n.startsWith("/")) return "/plan";
  if (n.startsWith("//")) return "/plan";
  if (n.startsWith("/login") || n.startsWith("/signup") || n.startsWith("/register")) return "/plan";
  return n;
}

function LoginInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const target = safeNext(sp.get("next"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<string>("idle");
  const [error, setError] = useState<string | null>(null);

  const doLogin = async () => {
    setError(null);
    setStatus("CLICK_OK");

    const { data: before } = await supabase.auth.getSession();
    console.log("LOGIN: session BEFORE?", !!before?.session);

    setStatus("SIGNING_IN");

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    console.log("LOGIN: signInError", signInError);

    if (signInError) {
      setError(signInError.message);
      setStatus("ERROR");
      return;
    }

    const { data: after } = await supabase.auth.getSession();
    console.log("LOGIN: session AFTER?", !!after?.session);

    setStatus("NAVIGATING");
    router.replace(target);
    window.location.assign(target);
  };

  return (
    <div style={{ padding: 24 }}>
      <h1>Login (DEBUG)</h1>
      <p>
        Status: <b>{status}</b>
      </p>
      <p>
        Target: <b>{target}</b>
      </p>

      <input
        name="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={{ display: "block", marginBottom: 8, width: 320 }}
      />
      <input
        name="password"
        placeholder="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        style={{ display: "block", marginBottom: 8, width: 320 }}
      />

      <button type="button" onClick={doLogin} style={{ padding: "8px 16px" }}>
        LOG IN (DEBUG)
      </button>

      {error && (
        <p style={{ marginTop: 12 }}>
          <b>Error:</b> {error}
        </p>
      )}
      <p style={{ marginTop: 12, opacity: 0.8 }}>
        If Status never changes from idle, the button click is not firing (overlay/pointer-events issue).
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}>Loading...</div>}>
      <LoginInner />
    </Suspense>
  );
}
