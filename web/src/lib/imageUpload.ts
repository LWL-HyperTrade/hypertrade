/** Client-side first filter. Server still sniffs magic bytes + re-encodes. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp';

export function sniffImageKind(data: Uint8Array): 'jpeg' | 'png' | 'webp' | null {
  if (data.length < 12) return null;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png';
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

export async function readLogoFile(file: File): Promise<string> {
  if (file.size > LOGO_MAX_BYTES) throw new Error('Image must be 2 MB or smaller');
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!sniffImageKind(buf)) throw new Error('Use a PNG, JPG, or WebP image');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const comma = text.indexOf(',');
      resolve(comma >= 0 ? text.slice(comma + 1) : text);
    };
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });
}
