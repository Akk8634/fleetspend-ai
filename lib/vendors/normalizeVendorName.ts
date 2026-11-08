/**
 * Normalize a vendor name so that small spelling differences on bills
 * ("City Lube Stn.", "CITY LUBE STATION") match the same vendor.
 *
 * Order matters: "stn" is expanded to "station" BEFORE suffixes are stripped.
 */
export function normalizeVendorName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')                        // remove punctuation
    .replace(/\bstn\b/g, 'station')                 // "stn" -> "station"
    .replace(/\b(co|company|inc|ltd|llc)\b/g, '')   // strip legal/common suffixes
    .replace(/\s+/g, ' ')                           // collapse whitespace
    .trim();
}
