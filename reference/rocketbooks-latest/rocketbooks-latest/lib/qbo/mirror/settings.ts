import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { qboMirrorSettings } from '@/db/schema/schema';

export interface MirrorSettings {
  mirrorAccounts: boolean;
  mirrorCustomers: boolean;
  mirrorVendors: boolean;
  mirrorInvoices: boolean;
  mirrorBills: boolean;
  mirrorPayments: boolean;
  mirrorBillPayments: boolean;
  mirrorItems: boolean;
  defaultAccountId: string | null;
}

const DEFAULT_SETTINGS: MirrorSettings = {
  mirrorAccounts: true,
  mirrorCustomers: true,
  mirrorVendors: true,
  mirrorInvoices: true,
  mirrorBills: true,
  mirrorPayments: true,
  mirrorBillPayments: true,
  mirrorItems: true,
  defaultAccountId: null,
};

/**
 * Load the (org, realm) mirror toggles. When no row exists yet — the user
 * just unlocked mirroring and hasn't visited the settings page — return
 * "all enabled" so the connection starts useful. The settings UI will
 * write a row the first time the user customizes anything.
 */
export async function loadMirrorSettings(organizationId: string, realmId: string): Promise<MirrorSettings> {
  const [row] = await db
    .select({
      mirrorAccounts: qboMirrorSettings.mirrorAccounts,
      mirrorCustomers: qboMirrorSettings.mirrorCustomers,
      mirrorVendors: qboMirrorSettings.mirrorVendors,
      mirrorInvoices: qboMirrorSettings.mirrorInvoices,
      mirrorBills: qboMirrorSettings.mirrorBills,
      mirrorPayments: qboMirrorSettings.mirrorPayments,
      mirrorBillPayments: qboMirrorSettings.mirrorBillPayments,
      mirrorItems: qboMirrorSettings.mirrorItems,
      defaultAccountId: qboMirrorSettings.defaultAccountId,
    })
    .from(qboMirrorSettings)
    .where(and(
      eq(qboMirrorSettings.organizationId, organizationId),
      eq(qboMirrorSettings.realmId, realmId),
    ))
    .limit(1);
  return row ?? DEFAULT_SETTINGS;
}

export type EntityKind =
  | 'account' | 'customer' | 'vendor'
  | 'invoice' | 'bill' | 'payment' | 'billPayment'
  | 'item';

const ENTITY_TO_SETTING: Record<EntityKind, keyof MirrorSettings> = {
  account: 'mirrorAccounts',
  customer: 'mirrorCustomers',
  vendor: 'mirrorVendors',
  invoice: 'mirrorInvoices',
  bill: 'mirrorBills',
  payment: 'mirrorPayments',
  billPayment: 'mirrorBillPayments',
  item: 'mirrorItems',
};

export function isEntityEnabled(settings: MirrorSettings, entity: EntityKind): boolean {
  return Boolean(settings[ENTITY_TO_SETTING[entity]]);
}

/**
 * Map Intuit's PascalCase entity names (as sent in webhook payloads) to our
 * lowercase kind. Returns null for entity types we don't handle — caller
 * should skip and mark the event as unsupported rather than fail.
 */
export function normalizeEntityName(qboName: string): EntityKind | null {
  switch (qboName) {
    case 'Account':     return 'account';
    case 'Customer':    return 'customer';
    case 'Vendor':      return 'vendor';
    case 'Invoice':     return 'invoice';
    case 'Bill':        return 'bill';
    case 'Payment':     return 'payment';
    case 'BillPayment': return 'billPayment';
    case 'Item':        return 'item';
    default:            return null;
  }
}
