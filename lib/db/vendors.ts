import type { SupabaseClient } from '@supabase/supabase-js';
import type { Vendor } from './types';

export type NewVendor = Pick<Vendor, 'name' | 'normalized_name'> & Partial<Pick<Vendor, 'paypal_email' | 'category'>>;

export async function getVendorByNormalizedName(normalizedName: string, supabase: SupabaseClient): Promise<Vendor | null> {
  const { data, error } = await supabase.from('vendors').select('*').eq('normalized_name', normalizedName).maybeSingle();
  if (error) throw new Error(`Could not look up vendor: ${error.message}`);
  return (data as Vendor | null) ?? null;
}

export async function getVendorById(id: string, supabase: SupabaseClient): Promise<Vendor | null> {
  const { data, error } = await supabase.from('vendors').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`Could not load vendor: ${error.message}`);
  return (data as Vendor | null) ?? null;
}

export async function listVendors(supabase: SupabaseClient): Promise<Vendor[]> {
  const { data, error } = await supabase.from('vendors').select('*').order('name');
  if (error) throw new Error(`Could not load vendors: ${error.message}`);
  return data as Vendor[];
}

export async function createVendor(fields: NewVendor, supabase: SupabaseClient): Promise<Vendor> {
  const { data, error } = await supabase
    .from('vendors')
    .insert({ paypal_email: null, category: null, ...fields })
    .select('*')
    .single();
  if (error) throw new Error(`Could not create vendor: ${error.message}`);
  return data as Vendor;
}
