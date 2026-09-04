import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { RealtimeProvider } from '@/components/providers/realtime-provider';

export default function AppGroupLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      {/* Inside AuthGuard so the notification stream only opens once the user
          is known, and outside AppShell so it survives every navigation within
          this route group. */}
      <RealtimeProvider>
        <AppShell>{children}</AppShell>
      </RealtimeProvider>
    </AuthGuard>
  );
}
