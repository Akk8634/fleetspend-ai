export const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 20;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

const MB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Batch-level limits (Requirement 1.1). Returns an error message or null. */
export function validateBatch(files: { size: number }[]): string | null {
  if (files.length === 0) return 'No files were uploaded.';
  if (files.length > MAX_FILES) return `You can upload at most ${MAX_FILES} files at once (got ${files.length}).`;
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_TOTAL_BYTES) return `Files are ${MB(total)} in total; the limit is ${MB(MAX_TOTAL_BYTES)}.`;
  return null;
}

/** Per-file type and size checks (Requirements 1.2, 1.3). Returns an error message or null. */
export function validateFile(file: { name: string; type: string; size: number }): string | null {
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return `${file.name}: unsupported file type ${file.type || 'unknown'} (use JPG, PNG or PDF).`;
  }
  if (file.size === 0) return `${file.name}: the file is empty.`;
  if (file.size > MAX_FILE_BYTES) return `${file.name}: ${MB(file.size)} is larger than the 10 MB limit.`;
  return null;
}

/** Make a file name safe for a storage path while keeping it recognizable. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-100);
  return cleaned || 'bill';
}
