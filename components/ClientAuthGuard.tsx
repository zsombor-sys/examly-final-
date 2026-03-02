"use client";

import { Suspense, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

function GuardInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const sp = useSearchParams();
  const [state, setState] = useState("CHECKING");

  useEffect(() => {
    (async () => {
      const search = sp.toString();
      const current = `${pathname}${search ? `?${search}` : ""}`;

      const { data } = await supabase.auth.getSession();
      const ok = !!data?.session;

      console.log("GUARD:", pathname, "session?", ok);
      setState(ok ? "OK" : "NO_SESSION");

      if (!ok) {
        window.location.assign(`/login?next=${encodeURIComponent(current)}`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state !== "OK") {
    return (
      <div style={{ padding: 24 }}>
        AuthGuard: <b>{state}</b>
      </div>
    );
  }

  return <>{children}</>;
}

export default function ClientAuthGuard({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}>AuthGuard: <b>CHECKING</b></div>}>
      <GuardInner>{children}</GuardInner>
    </Suspense>
  );
}
