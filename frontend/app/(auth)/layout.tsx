import { TierBanner } from '@/components/layout/tier-banner';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg">
      <TierBanner />
      {children}
    </div>
  );
}
