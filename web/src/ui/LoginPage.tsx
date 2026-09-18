import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { stashLoginReturn, takeLoginReturn, useWebAuth } from '../lib/auth';
import { PRIVY_APP_ID } from '../lib/config';
import { useTenantBrand } from '../lib/useTenantBrand';
import googleIcon from '../assets/images/google-icon-g.webp';
import privyProtected from '../assets/images/privy-protected.webp';

export function LoginPage() {
  const {
    authenticated,
    login,
    loginWithGoogle,
    googleBusy,
    loginError,
    ready,
    hydrating,
    privyConfigured,
  } = useWebAuth();
  const navigate = useNavigate();
  const brand = useTenantBrand();

  useEffect(() => {
    stashLoginReturn();
  }, []);

  useEffect(() => {
    if (authenticated) navigate(takeLoginReturn(), { replace: true });
  }, [authenticated, navigate]);

  if (hydrating || authenticated) {
    return <p className="text-sm text-[var(--text-3)]">Signing you in…</p>;
  }

  return (
    <div className="card-pop mx-auto mt-6 max-w-md p-8">
      {brand?.logo_url ? (
        <img src={brand.logo_url} alt="" className="mb-4 h-12 w-12 rounded-2xl object-cover" />
      ) : null}
      <h1 className="display text-4xl">
        Log in to <span className="text-hype">{brand?.app_name ?? 'BuilderPad'}</span>.
      </h1>
      <p className="mt-3 text-sm leading-6 text-fg-muted">
        {brand
          ? '1-click login. Free self-custody wallet on creation.'
          : 'Your app, your token, your identity.'}
      </p>
      {!privyConfigured || !PRIVY_APP_ID ? (
        <p className="mt-6 rounded-xl bg-[var(--bg-2)] p-3 text-sm text-[var(--text-2)]">
          Set <code>VITE_PRIVY_APP_ID</code> in <code>web/.env</code> (same App ID as
          mobile), restart Vite, and add <code>http://localhost:5173</code> to Privy
          allowed origins. Leave <code>VITE_PRIVY_CLIENT_ID</code> unset — that is the
          Expo client and it blocks the web modal.
        </p>
      ) : (
        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            disabled={!ready || googleBusy}
            onClick={() => login()}
            className="btn-ghost w-full py-3 text-sm"
          >
            Continue with email or wallet
          </button>
          <p className="text-center text-[11px] font-black uppercase tracking-[0.12em] text-[var(--text-3)]">
            or
          </p>
          <button
            type="button"
            disabled={!ready || googleBusy}
            onClick={() => {
              void loginWithGoogle().catch(() => undefined);
            }}
            className="btn-primary flex w-full items-center justify-center gap-2 py-3 text-sm"
          >
            {googleBusy ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black" />
            ) : (
              <img src={googleIcon} alt="" className="h-[18px] w-[18px] object-contain" />
            )}
            Continue with Google
          </button>
          {loginError ? (
            <p className="rounded-xl bg-[#2a1216] px-3 py-2 text-xs text-[var(--danger)]">{loginError}</p>
          ) : null}
        </div>
      )}
      <div className="mt-8 flex justify-center">
        <img
          src={privyProtected}
          alt="Protected by Privy"
          className="h-2.5 w-auto object-contain opacity-70 sm:h-3"
        />
      </div>
    </div>
  );
}
