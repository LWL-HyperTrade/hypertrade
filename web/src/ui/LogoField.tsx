import { useRef, useState } from 'react';
import { uploadTenantLogo } from '../lib/api';
import { LOGO_ACCEPT, readLogoFile } from '../lib/imageUpload';

/**
 * Upload-only logo. Pasted URLs were removed so Pons always gets a short
 * https://…/tenant-logos/… WebP we control (on-chain logo string length).
 */
export function LogoField({
  url,
  onUrl,
  fallback,
  getAccessToken,
}: {
  url: string;
  onUrl: (v: string) => void;
  fallback: string;
  getAccessToken: () => Promise<string | null>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLogo = !!url.trim();

  const pick = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    setBusy(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      const b64 = await readLogoFile(file);
      onUrl(await uploadTenantLogo(b64, token));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="sm:col-span-2">
      <span className="label req">Logo</span>
      <div className="mt-1.5 flex items-center gap-3">
        {hasLogo ? (
          <img src={url.trim()} alt="" className="h-10 w-10 shrink-0 rounded-xl object-cover" />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-fill-weak text-sm font-black text-fg-subtle">
            {fallback}
          </div>
        )}
        <div className="min-w-0 flex-1 text-[13px] font-semibold text-fg-muted">
          {hasLogo ? 'Logo ready for the app and token.' : 'PNG, JPG, or WebP · max 2 MB'}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={LOGO_ACCEPT}
          className="hidden"
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        <button
          type="button"
          className="btn-ghost btn-sm shrink-0 px-3 py-2 text-[12px]"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? 'Uploading…' : hasLogo ? 'Replace' : 'Upload'}
        </button>
        {hasLogo ? (
          <button
            type="button"
            className="btn-ghost btn-sm shrink-0 px-3 py-2 text-[12px] text-fg-subtle"
            disabled={busy}
            onClick={() => {
              setError(null);
              onUrl('');
            }}
          >
            Remove
          </button>
        ) : null}
      </div>
      {error ? <p className="mt-1 text-[12px] font-semibold text-error">{error}</p> : null}
    </div>
  );
}
