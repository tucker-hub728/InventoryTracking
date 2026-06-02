import type {
  AuditEvent,
  InventoryItem,
  LedgerMap,
  Role,
  Signoff,
  User,
} from '@/types';

/** Shape of the imported seed (matches the runtime object). */
export interface MockSeed {
  roles: Role[];
  users: User[];
  auditEvents: AuditEvent[];
  items: InventoryItem[];
  ledgers: LedgerMap;
  signoffs: Signoff[];
}
