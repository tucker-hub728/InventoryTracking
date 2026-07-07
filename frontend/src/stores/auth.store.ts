'use client';

import { create } from 'zustand';

import type { AuthedUser, RoleId } from '@/types/auth';
import type { SessionUser } from '@/lib/auth/types';
import { buildAuthedUser, ROLES } from '@/lib/permissions';

/**
 * Auth store.
 *
 * Tokens live in httpOnly cookies set by the BFF route handlers and are
 * NEVER touched by this code. The store only holds the projected
 * ``AuthedUser`` we display in the UI. Hydration runs once on mount via
 * ``hydrate()`` which calls ``GET /api/auth/me``.
 */

interface AuthState {
  user: AuthedUser | null;
  roleId: RoleId;
  /** True after the first /me round-trip completes (success or failure). */
  hydrated: boolean;

  /** Fetch /api/auth/me and seed user state. Safe to call repeatedly. */
  hydrate: () => Promise<void>;
  /** Replace state from a server-confirmed login response. */
  setSession: (user: SessionUser) => void;
  /** Demo affordance — swap perms locally without changing identity. */
  switchRole: (roleId: RoleId) => void;
  /** Clears local state. Call after a successful POST /api/auth/logout. */
  clear: () => void;
}

const DEFAULT_ROLE: RoleId = 'operator';

function authedUserFromSession(session: SessionUser, roleId: RoleId): AuthedUser {
  const role = ROLES[roleId] ?? ROLES[DEFAULT_ROLE];
  return buildAuthedUser(
    {
      id: session.sub,
      name: session.fullName,
      email: session.email,
      role: roleId,
      status: 'active',
      lastActive: 'now',
      initials: session.initials,
    },
    role,
  );
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  user: null,
  roleId: DEFAULT_ROLE,
  hydrated: false,

  hydrate: async () => {
    try {
      const resp = await fetch('/api/auth/me', {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
      });
      if (!resp.ok) {
        set({ user: null, hydrated: true });
        return;
      }
      const body = (await resp.json()) as { user: SessionUser | null };
      if (body.user) {
        set({
          user: authedUserFromSession(body.user, body.user.roleId),
          roleId: body.user.roleId,
          hydrated: true,
        });
      } else {
        set({ user: null, hydrated: true });
      }
    } catch {
      // Network / parse failure — treat as logged out so the guard kicks in.
      set({ user: null, hydrated: true });
    }
  },

  setSession: (session) =>
    set({
      user: authedUserFromSession(session, session.roleId),
      roleId: session.roleId,
      hydrated: true,
    }),

  switchRole: (roleId) => {
    const current = get().user;
    if (!current) return;
    const role = ROLES[roleId] ?? ROLES[DEFAULT_ROLE];
    set({
      user: buildAuthedUser({ ...current, role: roleId }, role),
      roleId,
    });
  },

  clear: () => set({ user: null, roleId: DEFAULT_ROLE }),
}));

export const selectUser = (s: AuthState) => s.user;
export const selectIsAuthed = (s: AuthState) => s.user !== null;
