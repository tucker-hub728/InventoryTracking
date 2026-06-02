# IMS — Inventory Management System

A production-grade frontend for cell-therapy inventory operations: master inventory ledger, LN2 cryogenic tank mapping, Kanban procurement workflow, RBAC user management, and 21 CFR Part 11 e-signatures.

Refactored from a runtime-Babel prototype into a typed, modular Next.js application.

---

## Stack

| Concern | Choice |
| --- | --- |
| Framework | **Next.js 14** App Router, React 18, **TypeScript strict** |
| Styling | **Tailwind CSS** + CSS variables (light/dark/density) |
| Components | **shadcn/ui** primitives (Radix-backed, Tailwind-themed) |
| State | **Zustand** slices with `persist` middleware |
| Forms | **react-hook-form** + **zod** |
| Toasts | **Sonner** |
| Icons | **lucide-react** |
| Linting | ESLint (Next config + Prettier) |
| Formatting | Prettier + `prettier-plugin-tailwindcss` |

---

## Folder architecture

```
app/                          Next.js App Router
├── (auth)/                   Auth route group (no app shell)
│   ├── layout.tsx
│   ├── login/page.tsx
│   └── accept-invite/[token]/page.tsx
├── (app)/                    Authed route group (AppShell + AuthGuard)
│   ├── layout.tsx
│   ├── inventory/
│   │   ├── page.tsx
│   │   └── [id]/page.tsx
│   ├── ln2/page.tsx
│   ├── kanban/page.tsx
│   └── users/page.tsx
├── layout.tsx                root layout, providers, fonts
├── error.tsx                 global error boundary
├── not-found.tsx             404
└── globals.css               Tailwind + CSS variable tokens

src/
├── components/
│   ├── ui/                   shadcn primitives
│   ├── providers/            AppProviders, ThemeApplier, ThemeScript
│   ├── layout/               AppShell, Sidebar, Topbar, NotificationsPanel
│   ├── shared/               ErrorBoundary, EmptyState, PageHeader,
│   │                         StatusBadge, ConfirmDialog, ESignDialog,
│   │                         SignaturePad
│   ├── auth/                 AuthShell, AuthGuard, LoginForm,
│   │                         AcceptInviteForm
│   ├── inventory/            list, table, filters, KPIs, pagination,
│   │                         detail, ledger, sign-offs, dialogs
│   ├── ln2/                  tank-map-client, rack-tile, position-sheet
│   ├── kanban/               board, column, card, item-sheet
│   └── users/                table, sheet, invite dialog, roles matrix,
│                             audit log
├── stores/                   Zustand slices (ui, auth, inventory, notifications)
├── hooks/                    use-mounted, use-debounced-value,
│                             use-permission, use-notifications-feed
├── lib/                      utils, permissions, password, inventory-helpers,
│                             seeded-random, mock-data, data/
├── config/                   site, nav, theme, inventory (statuses + stages)
├── types/                    auth, inventory, kanban, ln2, notification, ui
└── env.ts                    central env access
```

### Why route groups?

`app/(auth)` and `app/(app)` use Next.js route groups so the **app shell + auth guard** only wrap authed routes, while `/login` and `/accept-invite` render standalone. The shell renders `<Sidebar />` + `<Topbar />` once and `AuthGuard` redirects anonymous users to `/login`.

---

## State management (Zustand)

| Slice | Responsibility | Persisted? |
| --- | --- | --- |
| `useUIStore` | theme, accent, density, sidebar variant, login variant | ✅ `ims:ui` |
| `useAuthStore` | current user, role id, login/logout, role switch | ✅ `ims:auth` |
| `useInventoryStore` | filter state (query, status, category, sort, page, pageSize) | ✅ `ims:inventory-filters` |
| `useNotificationsStore` | derived alert items, read set, delivery toggles | ❌ |

Selectors (`selectUser`, `selectUnreadCount`, `selectAccentSoft`, …) live with each store so feature components subscribe to minimal slices.

---

## Theming

The CSS variable system from the prototype is preserved (`--bg`, `--accent`, `--text-2`, …) and surfaced through Tailwind's theme so utilities like `bg-bg-elev`, `text-text-2`, `text-accent` work natively. Two attributes drive the look:

- `<html data-theme="light|dark">` — flips the variable set
- `<html data-density="compact|regular">` — pads tables/controls

`ThemeScript` runs synchronously in `<head>` to apply the persisted theme **before paint** (no flash). `ThemeApplier` keeps the document in sync after hydration.

---

## Authentication & RBAC

- `useAuthStore.login()` is the demo entrypoint; replace with a real `/api/auth/login` call.
- `AuthGuard` (client-side) redirects anonymous users to `/login` and shows nothing until hydrated — preventing flash of protected content.
- `usePermission('inventory', 'edit')` resolves a permission via `lib/permissions.ts#can`. Used to gate buttons, sheets, and routes.
- Three roles are defined in seed data: `admin`, `editor`, `viewer` — switchable from the topbar for demo purposes.

For real auth, swap `login()`/`logout()` to call your backend and read user from a session cookie via middleware.

---

## E-signatures (21 CFR Part 11)

The reusable `ESignDialog` enforces:

1. **Drawn signature** (canvas) **or** typed full name (accessibility fallback)
2. **Password** confirmation
3. **Intent acknowledgement** checkbox (legally binding statement)

It captures `signedBy`, `signedAt`, `signatureData` (base64 PNG) and posts to the parent `onSign` handler. The inventory `RecordMovementDialog` chains the movement form → sign step → toast.

---

## Forms

All forms use `react-hook-form` + zod resolvers. Pattern:

```tsx
const schema = z.object({ email: z.string().email() });
type Values = z.infer<typeof schema>;

const { register, handleSubmit, formState: { errors } } = useForm<Values>({
  resolver: zodResolver(schema),
});
```

Field errors render inline with `role="alert"`. Server submissions wrap in `try/finally` to clear pending state regardless of outcome.

---

## Mock data

The legacy `/public/data.js` (300+ items + ledgers + sign-offs) was converted into a typed module at `src/lib/data/seed.ts` and surfaced via `src/lib/mock-data.ts`. **All feature code goes through `mockData`** — when a real API is added, replace just this module (and add a fetch layer with TanStack Query if desired).

---

## Scripts

```bash
npm run dev         # next dev
npm run build       # next build
npm run start       # next start
npm run lint        # next lint
npm run lint:fix    # next lint --fix
npm run format      # prettier --write
npm run format:check
npm run typecheck   # tsc --noEmit
```

---

## Environment

Copy `.env.example` to `.env.local` and adjust:

```env
NEXT_PUBLIC_APP_NAME=IMS
NEXT_PUBLIC_APP_FULL_NAME="Inventory Management System"
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000/api
NEXT_PUBLIC_ENV_LABEL="21 CFR Part 11 environment · all actions are logged"
```

All env access goes through `src/env.ts` for a single audit point.

---

## Accessibility

- All icon buttons carry `aria-label`s; tooltips back them up.
- Forms use `<Label htmlFor>` + `aria-invalid` + `role="alert"` for errors.
- Tables expose `aria-sort` on sortable headers; rows are keyboard-activatable.
- Dialogs/sheets use Radix primitives — focus trap, Escape to close, focus return are handled.
- Color is not the only carrier of status: badges include text labels alongside tone, sortable headers show arrow icons.

---

## Performance

- Route-level code splitting via the App Router; shared bundle is ~87 kB.
- `useMemo` for derived collections (filtered inventory, tank stats, Kanban grouping).
- `React.memo` on heavy repeated components (`RackTile`, `KanbanCard`, `InventoryKPIs`).
- Debounced search inputs (`useDebouncedValue`) prevent re-renders during typing.
- Theme is restored via inline `<script>` so persisted preferences don't flicker on load.
- `optimizePackageImports: ['lucide-react']` keeps icon bundles tree-shaken.

---

## Production checklist (open items)

These are the obvious next steps to take this app from demo to production:

- [ ] Wire a real backend (replace `mockData` consumers with TanStack Query + REST/tRPC).
- [ ] Replace the demo `useAuthStore.login()` with a real session flow (HttpOnly cookies + middleware).
- [ ] Add Sentry (or equivalent) wired into the `ErrorBoundary` + Next.js `error.tsx`.
- [ ] Add Playwright/Vitest test suites; the current setup has no tests committed yet.
- [ ] Configure CSP + security headers via `next.config.mjs`.
- [ ] Add a CI workflow (typecheck + lint + build).
