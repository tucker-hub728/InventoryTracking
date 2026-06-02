export type RoleId = 'admin' | 'editor' | 'viewer';
export type UserStatus = 'active' | 'suspended' | 'invited';
export type ResourceKey = 'inventory' | 'users' | 'audit';
export type InventoryAction = 'view' | 'create' | 'edit' | 'delete' | 'sign';
export type UsersAction = 'view' | 'create' | 'edit' | 'delete';
export type AuditAction = 'view' | 'export';

export interface InventoryPerms {
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  sign: boolean;
}

export interface UsersPerms {
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
}

export interface AuditPerms {
  view: boolean;
  export: boolean;
}

export interface RolePerms {
  inventory: InventoryPerms;
  users: UsersPerms;
  audit: AuditPerms;
}

export interface Role {
  id: RoleId;
  name: string;
  description: string;
  userCount: number;
  perms: RolePerms;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: RoleId;
  status: UserStatus;
  lastActive: string;
  initials: string;
}

export interface AuthedUser extends User {
  roleName: string;
  perms: RolePerms;
}

export interface AuditEvent {
  ts: string;
  user: string;
  action: string;
  target: string;
  detail: string;
  severity: 'info' | 'warning' | 'danger';
}
