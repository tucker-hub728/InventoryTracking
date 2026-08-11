import { UsersShell } from '@/components/admin/users-shell';

export default function UsersLayout({ children }: { children: React.ReactNode }) {
  return <UsersShell>{children}</UsersShell>;
}
