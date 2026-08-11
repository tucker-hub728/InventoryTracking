import { SuppliersShell } from '@/components/admin/suppliers/suppliers-shell';

export default function SuppliersLayout({ children }: { children: React.ReactNode }) {
  return <SuppliersShell>{children}</SuppliersShell>;
}
