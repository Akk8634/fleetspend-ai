import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExistingBill, Flag } from '../checks/checkDuplicate';
import { getBillById, getBillsForDuplicateCheck, getOverchargeHistory, getPaidVendorIds } from '../db/bills';
import type { BillWithDetails, Vendor } from '../db/types';
import { getVendorById, getVendorByNormalizedName } from '../db/vendors';
import { matchOrCreateVendor } from '../vendors/matchOrCreateVendor';

export type ExtractionFields = {
  vendor_name?: string;
  amount_text?: string;
  amount_minor_units?: number;
  currency_code?: string;
  bill_date?: string;
  invoice_number?: string | null;
  payee_email?: string | null;
  category?: string;
  confidence?: Record<string, number | undefined>;
};

/** Column-named corrections accepted by the save_field_corrections RPC. */
export type Corrections = {
  vendor_name_raw?: string;
  vendor_id?: string;
  amount_text?: string;
  amount_minor_units?: number;
  currency_code?: string;
  bill_date?: string;
  invoice_number?: string;
  payee_email?: string;
};

/** Everything the bill pipeline needs from storage. Faked in tests. */
export interface PipelineStore {
  getBill(id: string): Promise<BillWithDetails>;
  downloadBillFile(storagePath: string): Promise<{ buffer: Buffer; mimeType: string }>;
  saveExtraction(args: {
    billId: string;
    fields: ExtractionFields;
    vendorId: string | null;
    status: 'extracted' | 'needs_review';
    lowConfidenceFields: string[];
    message: string | null;
  }): Promise<void>;
  findVendorByNormalizedName(normalizedName: string): Promise<Vendor | null>;
  getVendor(id: string): Promise<Vendor | null>;
  matchOrCreateVendor(name: string): Promise<{ vendorId: string; created: boolean }>;
  setVendorEmailIfMissing(vendorId: string, email: string): Promise<void>;
  getBillsForDuplicateCheck(vendorId: string): Promise<ExistingBill[]>;
  getOverchargeHistory(vendorId: string, currencyCode: string): Promise<{ count: number; sum: number }>;
  getPaidVendorIds(): Promise<Set<string>>;
  completeChecks(billId: string, flags: Flag[]): Promise<void>;
  saveCorrections(billId: string, corrections: Corrections, actor: string): Promise<void>;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  pdf: 'application/pdf',
};

export function createSupabaseStore(supabase: SupabaseClient): PipelineStore {
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { error } = await supabase.rpc(fn, args);
    if (error) throw new Error(`${fn} failed: ${error.message}`);
  };

  return {
    getBill: (id) => getBillById(id, supabase),

    async downloadBillFile(storagePath) {
      const { data, error } = await supabase.storage.from('bills').download(storagePath);
      if (error || !data) throw new Error(`Could not download bill file: ${error?.message ?? 'empty file'}`);
      const ext = storagePath.split('.').pop()?.toLowerCase() ?? '';
      const mimeType = MIME_BY_EXTENSION[ext] ?? (data.type || 'application/octet-stream');
      return { buffer: Buffer.from(await data.arrayBuffer()), mimeType };
    },

    saveExtraction: ({ billId, fields, vendorId, status, lowConfidenceFields, message }) =>
      rpc('save_extraction', {
        p_bill_id: billId,
        p_fields: fields,
        p_vendor_id: vendorId,
        p_new_status: status,
        p_low_confidence_fields: lowConfidenceFields,
        p_message: message,
      }),

    findVendorByNormalizedName: (name) => getVendorByNormalizedName(name, supabase),
    getVendor: (id) => getVendorById(id, supabase),
    matchOrCreateVendor: (name) => matchOrCreateVendor(name, supabase),

    async setVendorEmailIfMissing(vendorId, email) {
      const { error } = await supabase
        .from('vendors')
        .update({ paypal_email: email })
        .eq('id', vendorId)
        .is('paypal_email', null);
      if (error) throw new Error(`Could not save vendor email: ${error.message}`);
    },

    getBillsForDuplicateCheck: (vendorId) => getBillsForDuplicateCheck(vendorId, supabase),
    getOverchargeHistory: (vendorId, currency) => getOverchargeHistory(vendorId, currency, supabase),
    getPaidVendorIds: () => getPaidVendorIds(supabase),

    completeChecks: (billId, flags) => rpc('complete_checks', { p_bill_id: billId, p_flags: flags }),

    saveCorrections: (billId, corrections, actor) =>
      rpc('save_field_corrections', { p_bill_id: billId, p_corrections: corrections, p_actor: actor }),
  };
}
