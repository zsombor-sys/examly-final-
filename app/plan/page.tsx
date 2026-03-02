import ClientAuthGuard from "@/components/ClientAuthGuard";

export default function PlanPage() {
  return (
    <ClientAuthGuard>
      <div style={{ padding: 24 }}>
        <h1>PLAN (DEBUG)</h1>
        <p>If you see this, navigation worked and guard saw a session.</p>
      </div>
    </ClientAuthGuard>
  );
}
