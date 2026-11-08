import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeVendorName } from './normalizeVendorName';

const UNIQUE_VIOLATION = '23505';

export class VendorNameError extends Error {
  constructor(name: string) {
    super(`Vendor name "${name}" is empty after normalization`);
    this.name = 'VendorNameError';
  }
}

/**
 * Find the vendor whose normalized name matches, or create a new one.
 * Safe under concurrent calls: if another request inserts the same vendor
 * first, the unique constraint fires and we read that row instead.
 */
export async function matchOrCreateVendor(
  extractedName: string,
  supabase: SupabaseClient,
): Promise<{ vendorId: string; created: boolean }> {
  const normalizedName = normalizeVendorName(extractedName);
  if (!normalizedName) {
    throw new VendorNameError(extractedName);
  }

  const existing = await findVendorId(normalizedName, supabase);
  if (existing) {
    return { vendorId: existing, created: false };
  }

  const { data, error } = await supabase
    .from('vendors')
    .insert({
      name: extractedName.trim().slice(0, 255),
      normalized_name: normalizedName,
      category: null,
      paypal_email: null,
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      const raced = await findVendorId(normalizedName, supabase);
      if (raced) return { vendorId: raced, created: false };
    }
    throw new Error(`Could not create vendor: ${error.message}`);
  }

  return { vendorId: data.id as string, created: true };
}

async function findVendorId(normalizedName: string, supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase
    .from('vendors')
    .select('id')
    .eq('normalized_name', normalizedName)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not look up vendor: ${error.message}`);
  }
  return (data?.id as string | undefined) ?? null;
}
