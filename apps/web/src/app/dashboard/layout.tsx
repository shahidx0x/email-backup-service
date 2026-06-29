import Link from 'next/link';

const links = [
  ['Overview', '/dashboard'],
  ['Messages', '/dashboard/messages'],
  ['Exports', '/dashboard/exports'],
  ['Jobs', '/dashboard/jobs'],
  ['Audit logs', '/dashboard/audit'],
  ['Users', '/dashboard/users'],
] as const;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <Link href="/dashboard" className="font-bold tracking-tight">Email Backup</Link>
          <nav aria-label="Administration" className="flex flex-wrap gap-2 text-sm">
            {links.map(([label, href]) => (
              <Link key={href} href={href} className="rounded-lg px-3 py-2 text-slate-300 hover:bg-slate-800 hover:text-white">
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}
