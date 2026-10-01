/**
 * My Apps → "AI resident" (docs/RESIDENTS.md §5). Owner-only, flag-gated.
 *
 * One dialog, five steps, all reusing what exists:
 *   1. Resident wallet  — Privy HD 2 (`useResidentWallet`)
 *   2. Fund             — Bridge2 into HD 2 (relayer pays gas). `usdSend` only
 *                        from a Standard builder wallet; unified HD 0 cannot.
 *   3. Agent            — ported mobile form → POST /ai-agents (mode=resident)
 *   4. Approve + live   — HD 2 signs approveAgent + approveBuilderFee, attach, activate
 *   5. Character        — persona + avatar preset → PATCH /tenants/{slug}
 *
 * Trading logic is the backend's / worker's. Nothing here sizes or places orders.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activateAiAgent,
  revokeAiAgent,
  stopAiAgent,
  attachTenantResident,
  createResidentAgent,
  detachTenantResident,
  deleteAiAgent,
  fetchCatalogAssets,
  fetchTenantResident,
  depositWithPermit,
  listAiAgents,
  listMyTenants,
  patchTenant,
  renameAiAgent,
} from '../../lib/api';
import { fetchArbUsdc, MIN_BRIDGE2_USDC, signBridge2Permit } from '../../lib/arbUsdc';
import { decimalsTyped } from '../../lib/amounts';
import { useWebAuth } from '../../lib/auth';
import { BUILDERPAD_RESIDENTS_ENABLED } from '../../lib/config';
import { fetchClearinghouse, formatUsd } from '../../lib/hlMarket';
import { isWalletUserRejectedRequest, sendPerpUsdc, type Hex } from '../../lib/hlTrade';
import {
  approveResidentAgent,
  resolveApprovedResidentBuilder,
  revokeResidentAgent,
  ensureResidentBuilderApproved,
  ensureResidentUnified,
  fetchResidentEquity,
  type ResidentEquity,
} from '../../lib/hlTrade/resident';
import {
  ACCUMULATE_LEVERAGE_WARN_ABOVE,
  AI_AGENT_LIMITS,
  AI_MODEL_OPTIONS,
  SHIPPED_AVATAR_PRESETS,
  CAPITAL_CAP_INFO,
  DIRECTION_OPTIONS,
  EMPTY_AGENT_FORM,
  HORIZON_OPTIONS,
  INVESTOR_LEVERAGE_WARN_ABOVE,
  MANDATE_OPTIONS,
  MARGIN_MODE_INFO,
  SWING_LEVERAGE_WARN_ABOVE,
  agentConfigFromForm,
  agentFormError,
  canonicalPresetId,
  presetPosterUrl,
  type AiAgentView,
  type ResidentAgentForm,
  type ResidentAvatar,
  type ResidentPersona,
} from '../../lib/residents';
import { isAiAgentMarketAllowed } from '../../lib/aiAgentHip3Exclude';
import { quoteLogoSrc } from '../../lib/quoteLogos';
import { filterAssetsForTenant, type BuilderWallets, type TenantPublic } from '../../lib/tenants';
import { useEnsureBuilderWallets } from '../../lib/useEnsureBuilderWallets';
import { useResidentWallet } from '../../lib/useResidentWallet';
import { IconAlert, IconBot, IconCheck, IconClose, IconCopy, IconPause, IconPencil, IconPlay } from '../icons';
import chatgptLogo from '../../assets/images/chatgpt.webp';
import chatgptLogoActive from '../../assets/images/chatgpt-black.webp';
import claudeLogo from '../../assets/images/claude.webp';
import deepseekLogo from '../../assets/images/deepseek.webp';
import geminiLogo from '../../assets/images/gemini.webp';
import xaiLogo from '../../assets/images/xai.webp';
import xaiLogoActive from '../../assets/images/xai-black.webp';

/** Same marks as the mobile model pills. Active variants are the dark logos — white marks wash out on the gold chip. */
const MODEL_LOGOS: Record<string, { logo: string; active?: string }> = {
  openai: { logo: chatgptLogo, active: chatgptLogoActive },
  gemini: { logo: geminiLogo },
  xai: { logo: xaiLogo, active: xaiLogoActive },
  deepseek: { logo: deepseekLogo },
  claude: { logo: claudeLogo },
};

/** Same 2-dp USDC wire as the wallet widget's Hyperliquid send. */
const HL_USD_DECIMALS = 2;
/** `usdSend` to an address that has never held L1 USDC costs 1 USDC to activate it. */
const HL_USD_SEND_NEW_USER_FEE_USDC = 1;

function parseUsdAmount(raw: string): number | null {
  const amt = Number(raw.trim());
  if (!Number.isFinite(amt)) return null;
  return amt;
}

/** A resident agent belongs to one project. An older draft with no project yet
 *  only shows on a project that already has a character, never on a blank one. */
function agentBelongsToApp(
  agent: AiAgentView,
  slug: string,
  attachedHere: Set<string>,
  thisAppStarted: boolean,
): boolean {
  const bound = (agent.residentSlug || '').trim().toLowerCase();
  if (bound) return bound === slug.trim().toLowerCase();
  if (attachedHere.has(agent.id)) return true;
  return thisAppStarted && agent.status === 'draft';
}

type ResidentProvider = NonNullable<
  Awaited<ReturnType<ReturnType<typeof useWebAuth>['getResidentEthereumProvider']>>
>;

/** Same activate path as the mobile app: builder fee, attach, approve agent, then activate. */
async function activateResidentAgent(args: {
  agent: AiAgentView;
  token: string;
  resident: Hex;
  tenant: TenantPublic;
  provider: ResidentProvider;
  /** This login's builder wallet. Unapproved → credit BuilderPad, don't block go-live. */
  ownBuilder?: string | null;
  onStep?: (label: string) => void;
}): Promise<void> {
  const { agent, token, resident, tenant, provider, ownBuilder, onStep } = args;
  onStep?.('Approving builder fee');
  const builder = await resolveApprovedResidentBuilder({
    tenantBuilder: tenant.builder_address,
    user: resident,
    requiredFeeTenths: tenant.builder_fee_tenths,
    ownBuilder,
  });
  await ensureResidentBuilderApproved({
    provider,
    residentAddress: resident,
    builderAddress: builder,
    requiredFeeTenths: tenant.builder_fee_tenths,
  });
  if (agent.config.symbols.some((s) => s.includes(':'))) {
    onStep?.('Enabling unified account');
    await ensureResidentUnified({ provider, residentAddress: resident });
  }
  onStep?.('Attaching to app');
  await attachTenantResident(tenant.slug, agent.id, token);
  onStep?.('Approving trading agent');
  await approveResidentAgent({
    provider,
    residentAddress: resident,
    agentAddress: agent.hlAgentAddress as Hex,
    agentName: agent.hlAgentName,
  });
  onStep?.('Activating');
  let lastErr: unknown = null;
  for (let i = 0; i < 8; i += 1) {
    try {
      await activateAiAgent(agent.id, token);
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/not approved|approve/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Activation did not confirm');
}

/** Footer row on the app card. Hidden unless the console flag is on. */
export function ResidentCard({ tenant }: { tenant: TenantPublic }) {
  const enabled = BUILDERPAD_RESIDENTS_ENABLED && tenant.status === 'live';
  const [open, setOpen] = useState(false);
  const [goingLive, setGoingLive] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [control, setControl] = useState<null | 'stop' | 'revoke'>(null);
  const [controlling, setControlling] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const { getAccessToken, getResidentEthereumProvider, builderAddress } = useWebAuth();
  const qc = useQueryClient();
  const pairQ = useEnsureBuilderWallets();
  const wallet = useResidentWallet(enabled ? pairQ.data ?? null : null);
  const resident = wallet.residentAddress as Hex | null;
  const agentsQ = useQuery({
    queryKey: ['ai-agents', 'mine'],
    enabled,
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      return listAiAgents(token, { includeResident: true });
    },
  });
  const mineQ = useQuery({
    queryKey: ['my-tenants'],
    enabled,
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      return listMyTenants(token);
    },
  });
  const attachedQ = useQuery({
    queryKey: ['tenant-resident', tenant.slug],
    enabled,
    queryFn: () => fetchTenantResident(tenant.slug).catch(() => null),
  });
  const equityQ = useQuery({
    queryKey: ['resident-equity', resident],
    enabled: enabled && !!resident && wallet.residentReady,
    queryFn: () => fetchResidentEquity(resident as Hex),
    refetchInterval: 15_000,
  });
  if (!enabled) return null;
  const attachedHere = new Set((attachedQ.data?.agents ?? []).map((a) => String(a.id)));
  const thisAppStarted = !!tenant.resident;
  const onThisApp = (agentsQ.data ?? []).filter(
    (a) =>
      a.mode === 'resident' &&
      a.status !== 'revoked' &&
      (!resident || a.hlMasterAddress.toLowerCase() === resident) &&
      agentBelongsToApp(a, tenant.slug, attachedHere, thisAppStarted),
  );
  const draft = onThisApp.find((a) => a.status === 'draft');
  const liveAgent = onThisApp.find((a) => a.status === 'active');
  const restingAgent = onThisApp.find((a) => a.status === 'stopped' || a.status === 'paused');
  const namedAgent = liveAgent ?? restingAgent ?? draft;
  const started = !!tenant.resident || onThisApp.length > 0;
  const heldElsewhere = (agentsQ.data ?? []).filter(
    (a) =>
      a.mode === 'resident' &&
      a.status !== 'revoked' &&
      !!resident &&
      a.hlMasterAddress.toLowerCase() === resident &&
      !agentBelongsToApp(a, tenant.slug, attachedHere, thisAppStarted),
  );
  const blocked = !started && heldElsewhere.length > 0;
  const ownerSlug = heldElsewhere.find((a) => a.residentSlug)?.residentSlug;
  const ownerName =
    (mineQ.data ?? []).find((t) => t.slug === ownerSlug)?.app_name || (ownerSlug ? ownerSlug : 'another app');
  const showGoLive = !!draft && started;
  const funded = (equityQ.data?.totalUsd ?? 0) >= AI_AGENT_LIMITS.minHlBalanceUsd;
  const goLive = async () => {
    if (!draft || !resident) return;
    setLiveError(null);
    setGoingLive(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      const provider = await getResidentEthereumProvider(resident);
      if (!provider) throw new Error('Resident wallet is not ready in this session');
      await activateResidentAgent({
        agent: draft,
        token,
        resident,
        tenant,
        provider,
        ownBuilder: builderAddress,
      });
      void qc.invalidateQueries({ queryKey: ['my-tenants'] });
      void qc.invalidateQueries({ queryKey: ['ai-agents', 'mine'] });
      void qc.invalidateQueries({ queryKey: ['tenant-resident', tenant.slug] });
    } catch (err) {
      setLiveError(err instanceof Error ? err.message : 'Could not go live');
    } finally {
      setGoingLive(false);
    }
  };
  const removeDraft = async () => {
    if (!draft) return;
    setLiveError(null);
    setRemoving(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      await deleteAiAgent(draft.id, token);
      setConfirmRemove(false);
      void qc.invalidateQueries({ queryKey: ['my-tenants'] });
      void qc.invalidateQueries({ queryKey: ['ai-agents', 'mine'] });
      void qc.invalidateQueries({ queryKey: ['tenant-resident', tenant.slug] });
    } catch (err) {
      setLiveError(err instanceof Error ? err.message : 'Could not remove the draft');
    } finally {
      setRemoving(false);
    }
  };
  const refreshAgents = () => {
    void qc.invalidateQueries({ queryKey: ['my-tenants'] });
    void qc.invalidateQueries({ queryKey: ['ai-agents', 'mine'] });
    void qc.invalidateQueries({ queryKey: ['tenant-resident', tenant.slug] });
  };
  const commitRename = async () => {
    if (!namedAgent) return;
    const next = renameDraft.trim();
    if (!next) {
      setLiveError('Name is required');
      return;
    }
    if (next === namedAgent.name) {
      setRenaming(false);
      return;
    }
    setRenameSaving(true);
    setLiveError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      await renameAiAgent(namedAgent.id, next, token);
      const persona = {
        ...(tenant.resident?.persona ?? {}),
        display_name: next,
      };
      await patchTenant(tenant.slug, { persona }, token).catch(() => undefined);
      setRenaming(false);
      refreshAgents();
    } catch (err) {
      setLiveError(err instanceof Error ? err.message : 'Could not rename');
    } finally {
      setRenameSaving(false);
    }
  };
  const runControl = async (kind: 'stop' | 'resume' | 'revoke') => {
    const agent = kind === 'resume' ? restingAgent : liveAgent ?? restingAgent;
    if (!agent || !resident) return;
    setLiveError(null);
    setControlling(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      if (kind === 'stop') {
        await stopAiAgent(agent.id, token);
      } else if (kind === 'resume') {
        await activateAiAgent(agent.id, token);
      } else {
        const provider = await getResidentEthereumProvider(resident);
        if (!provider) throw new Error('Resident wallet is not ready in this session');
        await revokeResidentAgent({
          provider,
          residentAddress: resident,
          agentName: agent.hlAgentName,
        });
        await revokeAiAgent(agent.id, token);
        await detachTenantResident(tenant.slug, agent.id, token).catch(() => undefined);
      }
      setControl(null);
      refreshAgents();
    } catch (err) {
      setLiveError(err instanceof Error ? err.message : 'Could not update the agent');
    } finally {
      setControlling(false);
    }
  };
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 border-t border-stroke-weak px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[12px] font-extrabold text-fg">
          <IconBot size={14} className="shrink-0 text-brand" />
          {renaming && namedAgent ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void commitRename();
              }}
            >
              <input
                className="field h-7 min-w-0 flex-1 py-0 text-[12px]"
                value={renameDraft}
                maxLength={64}
                disabled={renameSaving}
                autoFocus
                onChange={(e) => setRenameDraft(e.target.value)}
              />
              <button type="submit" className="inline-flex h-7 w-7 items-center justify-center text-brand" disabled={renameSaving} aria-label="Save name">
                <IconCheck size={14} />
              </button>
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center text-fg-subtle"
                disabled={renameSaving}
                aria-label="Cancel rename"
                onClick={() => setRenaming(false)}
              >
                <IconClose size={14} />
              </button>
            </form>
          ) : (
            <>
              <span className="truncate">{namedAgent ? namedAgent.name : 'AI resident'}</span>
              {namedAgent ? (
                <button
                  type="button"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-subtle hover:text-fg"
                  aria-label="Rename"
                  title="Rename"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setRenameDraft(namedAgent.name);
                    setRenaming(true);
                    setLiveError(null);
                  }}
                >
                  <IconPencil size={12} />
                </button>
              ) : null}
            </>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-fg-subtle">
          {blocked
            ? 'One AI resident per login. It trades from its own wallet, separate from your trade balance.'
            : liveAgent
              ? 'Live. It decides about once an hour.'
              : restingAgent
                ? 'Stopped. Play resumes it. Revoke frees this login for another.'
              : draft || started
                ? 'Draft. It will not trade until you go live.'
                : 'One AI resident per login. It trades from its own wallet, separate from your trade balance.'}
        </p>
        {liveError ? <p className="mt-1 text-[11px] font-semibold text-error">{liveError}</p> : null}
      </div>
      <div className="flex h-8 shrink-0 items-center gap-1.5">
        {control && (liveAgent || restingAgent) ? (
          <span className="inline-flex items-center gap-1">
            <button
              type="button"
              className="btn-primary btn-sm px-2.5 py-1 text-[11px]"
              disabled={controlling}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void runControl(control === 'stop' ? 'stop' : 'revoke');
              }}
            >
              {controlling ? 'Confirming' : control === 'stop' ? 'Stop' : 'Revoke'}
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm px-2 py-1 text-[11px]"
              disabled={controlling}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setControl(null);
              }}
            >
              Back
            </button>
          </span>
        ) : liveAgent ? (
          <span className="inline-flex items-center gap-1">
            <span className="inline-flex items-center gap-1 rounded-full bg-market-up/15 px-2 py-1 text-[10px] font-extrabold uppercase tracking-[0.04em] text-market-up">
              <span className="h-1.5 w-1.5 rounded-full bg-market-up" />
              Live
            </span>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-brand hover:bg-fill-weak"
              title="Stop"
              aria-label="Stop"
              disabled={controlling}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setLiveError(null);
                setControl('stop');
              }}
            >
              <IconPause size={14} />
            </button>
          </span>
        ) : restingAgent ? (
          <span className="inline-flex items-center gap-1">
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-brand hover:bg-fill-weak"
              title="Play"
              aria-label="Play"
              disabled={controlling}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void runControl('resume');
              }}
            >
              <IconPlay size={14} />
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm px-2 py-1 text-[11px]"
              disabled={controlling}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setLiveError(null);
                setControl('revoke');
              }}
            >
              Revoke
            </button>
          </span>
        ) : showGoLive ? (
          <button
            type="button"
            className="btn-primary btn-sm min-w-[5.75rem] px-3 py-1.5 text-xs"
            disabled={goingLive || !funded}
            title={funded ? 'Approve and activate this draft' : 'Fund the resident wallet with at least $100 first'}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void goLive();
            }}
          >
            {goingLive ? 'Going live…' : 'Go live'}
          </button>
        ) : null}
        {draft && started ? (
          <button
            type="button"
            className="btn-ghost btn-sm px-3 py-1.5 text-xs"
            disabled={removing || goingLive}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setConfirmRemove(true);
            }}
          >
            {removing ? 'Removing…' : 'Remove'}
          </button>
        ) : null}
        {blocked ? (
          <span
            className="inline-flex cursor-not-allowed"
            title={`You already have an AI resident on ${ownerName}. Only 1 at a time.`}
          >
            <button
              type="button"
              disabled
              className="btn-primary btn-sm pointer-events-none shrink-0 px-3 py-1.5 text-xs"
            >
              Add AI resident
            </button>
          </span>
        ) : (
        <button
          type="button"
          className={`${started ? 'btn-ghost' : 'btn-primary'} btn-sm shrink-0 px-3 py-1.5 text-xs`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }}
        >
          {started ? 'Manage' : 'Add AI resident'}
        </button>
        )}
      </div>
      {open ? <ResidentDialog tenant={tenant} onClose={() => setOpen(false)} /> : null}
      {confirmRemove && draft ? (
        <div
          className="fixed inset-0 z-[80] flex items-end justify-center bg-sunken/70 px-3 pb-6 sm:items-center sm:p-6"
          onClick={() => {
            if (!removing) setConfirmRemove(false);
          }}
          role="presentation"
        >
          <div
            role="dialog"
            aria-labelledby="remove-resident-title"
            className="card-pop w-full max-w-sm p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="remove-resident-title" className="text-[15px] font-extrabold">
              Remove this resident?
            </h2>
            <p className="mt-2 text-[13px] leading-5 text-fg-muted">
              {draft.name} is deleted. This app can start another, or another app can have the one resident.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="btn-ghost px-4 py-2 text-sm"
                disabled={removing}
                onClick={() => setConfirmRemove(false)}
              >
                Keep
              </button>
              <button
                type="button"
                className="btn-primary px-4 py-2 text-sm"
                disabled={removing}
                onClick={() => void removeDraft()}
              >
                {removing ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

type Step = 'wallet' | 'fund' | 'agent' | 'character';

function ResidentDialog({ tenant, onClose }: { tenant: TenantPublic; onClose: () => void }) {
  const { getAccessToken, getResidentEthereumProvider, builderAddress } = useWebAuth();
  const qc = useQueryClient();
  const pairQ = useEnsureBuilderWallets();
  const pair: BuilderWallets | null = pairQ.data ?? null;
  const wallet = useResidentWallet(pair);
  const resident = wallet.residentAddress as Hex | null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const equityQ = useQuery({
    queryKey: ['resident-equity', resident],
    enabled: !!resident && wallet.residentReady,
    queryFn: () => fetchResidentEquity(resident as Hex),
    refetchInterval: 15_000,
  });
  const agentsQ = useQuery({
    queryKey: ['ai-agents', 'mine'],
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      return listAiAgents(token, { includeResident: true });
    },
  });
  const attachedQ = useQuery({
    queryKey: ['tenant-resident', tenant.slug],
    queryFn: () => fetchTenantResident(tenant.slug).catch(() => null),
  });
  const attachedIds = useMemo(
    () => new Set((attachedQ.data?.agents ?? []).map((a) => String(a.id))),
    [attachedQ.data],
  );
  const myResidentAgents = useMemo(
    () =>
      (agentsQ.data ?? []).filter(
        (a) => a.mode === 'resident' && (!resident || a.hlMasterAddress.toLowerCase() === resident),
      ),
    [agentsQ.data, resident],
  );
  const houseAgents = useMemo(
    () =>
      (agentsQ.data ?? []).filter(
        (a) => a.showcase && a.mode !== 'resident' && a.status !== 'revoked',
      ),
    [agentsQ.data],
  );

  const funded = (equityQ.data?.totalUsd ?? 0) >= AI_AGENT_LIMITS.minHlBalanceUsd;
  const thisAppStarted = !!tenant.resident;
  const agentsHere = useMemo(
    () =>
      myResidentAgents.filter((a) => agentBelongsToApp(a, tenant.slug, attachedIds, thisAppStarted)),
    [myResidentAgents, attachedIds, thisAppStarted],
  );
  const initialStep: Step = !thisAppStarted ? 'wallet' : agentsHere.length ? 'agent' : 'character';
  const [step, setStep] = useState<Step>(initialStep);
  const [walletPassed, setWalletPassed] = useState(false);
  const [fundPassed, setFundPassed] = useState(false);
  const [characterSaved, setCharacterSaved] = useState(
    () => !!(tenant.resident?.persona?.display_name || (tenant.resident?.avatar && 'kind' in tenant.resident.avatar)),
  );
  const walletDone = thisAppStarted || walletPassed;
  const fundDone = thisAppStarted || fundPassed;
  const agentDone = agentsHere.some((a) => a.status !== 'revoked');
  const goTo = useCallback((next: Step) => {
    if (next !== 'wallet') setWalletPassed(true);
    if (next === 'agent' || next === 'character') setFundPassed(true);
    setStep(next);
  }, []);
  const walletWasReady = useRef(wallet.residentReady);
  useEffect(() => {
    const justCreated = wallet.residentReady && !walletWasReady.current;
    walletWasReady.current = wallet.residentReady;
    if (justCreated && step === 'wallet') goTo('fund');
  }, [wallet.residentReady, step, goTo]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['my-tenants'] });
    void qc.invalidateQueries({ queryKey: ['tenant', tenant.slug] });
    void qc.invalidateQueries({ queryKey: ['tenant-resident', tenant.slug] });
    void qc.invalidateQueries({ queryKey: ['ai-agents', 'mine'] });
  };

  return (
    <Overlay title={`AI resident · ${tenant.app_name}`} onClose={onClose}>
      <Steps
        current={step}
        onPick={goTo}
        walletReady={walletDone}
        fundDone={fundDone}
        agentDone={agentDone}
        characterDone={characterSaved}
        canAgent={walletDone && !!wallet.residentReady}
      />

      {step === 'wallet' ? (
        <WalletStep
          pair={pair}
          wallet={wallet}
          onNext={() => goTo('fund')}
        />
      ) : null}

      {step === 'fund' && resident ? (
        <FundStep
          resident={resident}
          equity={equityQ.data ?? null}
          builderAddress={
            pair?.live === 'own' &&
            pair.builder_wallet &&
            pair.builder_wallet.toLowerCase() !== resident.toLowerCase()
              ? (pair.builder_wallet as Hex)
              : null
          }
          builderImported={pair?.source === 'imported'}
          onBridged={() => {
            void equityQ.refetch();
          }}
          onNext={() => goTo('agent')}
        />
      ) : null}

      {step === 'agent' && walletDone && wallet.residentReady ? (
        <AgentStep
          tenant={tenant}
          resident={resident}
          agents={agentsHere}
          houseAgents={houseAgents}
          attachedIds={attachedIds}
          slotsUsed={myResidentAgents.filter((a) => a.status !== 'revoked').length}
          funded={funded}
          onChanged={invalidate}
          getToken={getAccessToken}
          getResidentProvider={() => (resident ? getResidentEthereumProvider(resident) : Promise.resolve(null))}
          ownBuilder={builderAddress}
          onCharacter={() => goTo('character')}
        />
      ) : null}

      {step === 'character' ? (
        <CharacterStep
          tenant={tenant}
          funded={funded}
          hasDraft={agentsHere.some((a) => a.status === 'draft')}
          getToken={getAccessToken}
          onSaved={() => {
            invalidate();
            setCharacterSaved(true);
          }}
          onClose={onClose}
          onFund={() => goTo('fund')}
        />
      ) : null}
    </Overlay>
  );
}

/* ------------------------------ steps ------------------------------ */

function Steps({
  current,
  onPick,
  walletReady,
  fundDone,
  agentDone,
  characterDone,
  canAgent,
}: {
  current: Step;
  onPick: (s: Step) => void;
  walletReady: boolean;
  fundDone: boolean;
  agentDone: boolean;
  characterDone: boolean;
  canAgent: boolean;
}) {
  const items: Array<{ id: Step; label: string; done: boolean; locked: boolean }> = [
    { id: 'wallet', label: 'Wallet', done: walletReady, locked: false },
    { id: 'fund', label: 'Fund', done: fundDone, locked: !walletReady },
    { id: 'agent', label: 'Agent', done: agentDone, locked: !canAgent },
    { id: 'character', label: 'Character', done: characterDone, locked: !agentDone && !characterDone },
  ];
  return (
    <ol className="mb-4 flex flex-wrap gap-1.5">
      {items.map((it) => (
        <li key={it.id}>
          <button
            type="button"
            disabled={it.locked}
            onClick={() => onPick(it.id)}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-extrabold ${
              current === it.id
                ? 'bg-brand text-black'
                : it.done
                  ? 'bg-success/15 text-success'
                  : 'bg-fill-weak text-fg-muted'
            } disabled:opacity-40`}
          >
            {it.done ? <IconCheck size={10} strokeWidth={4} /> : null}
            {it.label}
          </button>
        </li>
      ))}
    </ol>
  );
}

function WalletStep({
  pair,
  wallet,
  onNext,
}: {
  pair: BuilderWallets | null;
  wallet: ReturnType<typeof useResidentWallet>;
  onNext: () => void;
}) {
  const err = wallet.provision.error;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const addr = wallet.residentAddress;
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <div>
      <p className="text-[13px] leading-5 text-fg-muted">
        The AI resident trades from its own embedded wallet. You will be able to fund the wallet in the next step.
      </p>
      {!pair ? (
        <p className="mt-3 text-[12px] font-semibold text-error">Set up your builder wallets first (Home → Activate).</p>
      ) : wallet.residentAddress ? (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-fill-weak px-3 py-2">
          <div className="min-w-0 flex-1 break-all font-mono text-[12px] font-bold">
            {wallet.residentAddress}
            {!wallet.residentReady ? (
              <span className="ml-2 text-[10px] font-extrabold uppercase text-fg-subtle">saving…</span>
            ) : null}
          </div>
          <button
            type="button"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-fill-hover hover:text-fg"
            aria-label={copied ? 'Copied' : 'Copy address'}
            onClick={() => void copy()}
          >
            {copied ? <IconCheck size={14} className="text-success" /> : <IconCopy size={14} />}
          </button>
        </div>
      ) : null}
      {err ? <p className="mt-2 text-[12px] font-semibold text-error">{err instanceof Error ? err.message : 'Could not create the wallet'}</p> : null}
      {!wallet.residentReady ? (
        <button
          type="button"
          className="btn-primary btn-sm mt-4 px-3 py-1.5 text-xs"
          disabled={!pair || wallet.provision.isPending}
          onClick={() => wallet.provision.mutate()}
        >
          {wallet.provision.isPending ? 'Creating…' : 'Create AI resident wallet'}
        </button>
      ) : (
        <div className="mt-4 flex justify-end">
          <button type="button" className="btn-primary btn-sm px-3 py-1.5 text-xs" onClick={onNext}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function FundStep({
  resident,
  equity,
  builderAddress,
  builderImported = false,
  onBridged,
  onNext,
}: {
  resident: Hex;
  equity: ResidentEquity | null;
  /** Standard builder wallet. Unified trade wallets cannot usdSend. */
  builderAddress: Hex | null;
  /** Imported builder (MetaMask) must confirm in that wallet. Embedded signs itself. */
  builderImported?: boolean;
  onBridged: () => void;
  onNext: () => void;
}) {
  const { getAccessToken, getResidentEthereumProvider, getBuilderEthereumProvider } = useWebAuth();
  const qc = useQueryClient();
  const [usd, setUsd] = useState('');
  const [depositUsd, setDepositUsd] = useState('');
  const [depositTouched, setDepositTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bridging, setBridging] = useState(false);
  const [bridgeNote, setBridgeNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amountTouched, setAmountTouched] = useState(false);
  const total = equity?.totalUsd ?? 0;
  const ok = total >= AI_AGENT_LIMITS.minHlBalanceUsd;
  const destNew = total < 0.01;
  const feeUsd = destNew ? HL_USD_SEND_NEW_USER_FEE_USDC : 0;

  const builderQ = useQuery({
    queryKey: ['hl', 'clearinghouse', builderAddress],
    enabled: !!builderAddress,
    queryFn: () => fetchClearinghouse(builderAddress!),
    refetchInterval: 8_000,
  });
  const residentArbQ = useQuery({
    queryKey: ['arb-usdc', resident],
    enabled: !!resident,
    queryFn: () => fetchArbUsdc(resident),
    refetchInterval: 15_000,
  });

  const builderMode = builderQ.data?.abstractionMode ?? null;
  const builderIsUnified = builderMode === 'unifiedAccount' || builderMode === 'portfolioMargin';
  const canSendFromBuilder = !!builderAddress && builderQ.isSuccess && !builderIsUnified;
  const withdrawableUsd = builderQ.data?.withdrawable ?? 0;
  const withdrawableCents = Number.isFinite(withdrawableUsd)
    ? Math.max(0, Math.floor(withdrawableUsd * 100 + 1e-6))
    : 0;
  const builderAvailable = builderQ.isLoading ? '—' : (withdrawableCents / 100).toFixed(2);
  const residentArb = residentArbQ.data?.formatted ?? 0;
  const residentArbCents = Math.max(0, Math.floor(residentArb * 100 + 1e-6));
  const depositAmt = parseUsdAmount(depositUsd);
  const depositCents = depositAmt != null ? Math.round(depositAmt * 100) : null;
  const depositBlank = !depositUsd.trim();
  const depositTooMany = decimalsTyped(depositUsd) > HL_USD_DECIMALS;
  const depositTooLow = depositAmt != null && depositAmt > 0 && depositAmt + 1e-9 < MIN_BRIDGE2_USDC;
  const depositOver = depositCents != null && depositCents > residentArbCents;
  const depositError = !depositTouched
    ? null
    : depositBlank
      ? null
      : depositTooMany
        ? `Up to ${HL_USD_DECIMALS} decimals`
        : depositAmt == null || depositAmt <= 0
          ? 'Enter a valid amount'
          : depositTooLow
            ? `Minimum is $${MIN_BRIDGE2_USDC}`
            : depositOver
              ? 'Not enough wallet balance'
              : null;
  const canDeposit =
    !bridging &&
    !busy &&
    depositAmt != null &&
    depositAmt + 1e-9 >= MIN_BRIDGE2_USDC &&
    !depositTooMany &&
    !depositOver;

  const amt = parseUsdAmount(usd);
  const amountBlank = !usd.trim();
  const tooManyDecimals = decimalsTyped(usd) > HL_USD_DECIMALS;
  const amountCents = amt != null ? Math.round(amt * 100) : null;
  const overTrade = amountCents != null && amountCents > withdrawableCents;
  /** New HD 2: Hyperliquid keeps $1, so $1 sent lands $0. Need $1 more than the fee. */
  const minSendUsd = destNew ? HL_USD_SEND_NEW_USER_FEE_USDC + 1 : 1;
  const liveNeedUsd = Math.max(0, AI_AGENT_LIMITS.minHlBalanceUsd + feeUsd - total);
  const amountTooLow = amt != null && amt > 0 && amt + 1e-9 < minSendUsd;
  const amountInvalid =
    amountTouched &&
    !amountBlank &&
    (amt == null || amt <= 0 || tooManyDecimals || overTrade || amountTooLow);
  const amountError = !amountTouched
    ? null
    : amountBlank
      ? null
      : tooManyDecimals
        ? `Up to ${HL_USD_DECIMALS} decimals`
        : amt == null || amt <= 0
          ? 'Enter a valid amount'
          : amountTooLow
            ? destNew
              ? `Minimum is $${minSendUsd} — $${HL_USD_SEND_NEW_USER_FEE_USDC} activates this new address, so $${minSendUsd} is the smallest send that lands USDC.`
              : `Minimum is $${minSendUsd}`
            : overTrade
              ? 'Not enough builder balance'
              : null;
  const receiveUsd = amt != null && amt > 0 ? Math.max(0, amt - feeUsd) : null;
  const landShort =
    destNew && receiveUsd != null
      ? receiveUsd + total < AI_AGENT_LIMITS.minHlBalanceUsd
      : false;

  const canSubmit =
    canSendFromBuilder &&
    !busy &&
    !bridging &&
    amt != null &&
    amt > 0 &&
    !tooManyDecimals &&
    !overTrade &&
    !amountTooLow &&
    withdrawableCents > 0;

  const fillMax = () => {
    if (withdrawableCents <= 0) return;
    setUsd((withdrawableCents / 100).toFixed(2));
    setAmountTouched(true);
    setError(null);
  };

  const bridgeResident = async () => {
    setError(null);
    setBridgeNote(null);
    setDepositTouched(true);
    if (!canDeposit || depositCents == null) {
      if (depositBlank || depositAmt == null || depositAmt <= 0) setError('Enter an amount');
      return;
    }
    setBridging(true);
    try {
      const provider = await getResidentEthereumProvider(resident);
      if (!provider) throw new Error('Resident wallet is not ready');
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      const amountUsdc = (depositCents / 100).toFixed(2);
      const permit = await signBridge2Permit({ provider, user: resident, amountUsdc });
      const res = await depositWithPermit({ user: resident, ...permit }, token);
      if (!res?.txHash) throw new Error('Deposit did not return a transaction');
      setDepositUsd('');
      setDepositTouched(false);
      setBridgeNote('Deposit submitted. Trade balance updates shortly.');
      void residentArbQ.refetch();
      onBridged();
      void qc.invalidateQueries({ queryKey: ['resident-equity', resident] });
    } catch (err) {
      setError(
        isWalletUserRejectedRequest(err)
          ? 'Wallet request was rejected.'
          : err instanceof Error
            ? err.message
            : 'Deposit failed',
      );
    } finally {
      setBridging(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setAmountTouched(true);
    setError(null);
    if (!canSubmit || amountCents == null) {
      if (amountBlank || amt == null || amt <= 0) setError('Enter an amount');
      return;
    }
    if (!builderAddress) return;
    setBusy(true);
    try {
      const provider = await getBuilderEthereumProvider(builderAddress);
      if (!provider) throw new Error('Builder wallet is not ready');
      await sendPerpUsdc({
        provider,
        userAddress: builderAddress,
        destination: resident,
        amountUsd: (amountCents / 100).toFixed(2),
      });
      setUsd('');
      setAmountTouched(false);
      onBridged();
      void qc.invalidateQueries({ queryKey: ['hl', 'clearinghouse', builderAddress] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transfer failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="text-[13px] leading-5 text-fg-muted">
        Agents need at least <b>${AI_AGENT_LIMITS.minHlBalanceUsd}</b> on the AI resident wallet to go live, and
        they auto-pause below it. Wallet Balance is USDC on Arbitrum at this address. Trade balance is what
        the agent can use to trade.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Field label="Trade balance">
          <span className={`font-mono text-[15px] font-black tabular ${ok ? 'text-success' : ''}`}>
            {formatUsd(total)}
          </span>
        </Field>
        <Field label="Wallet Balance">
          <span className="font-mono text-[15px] font-black tabular">{formatUsd(residentArb)}</span>
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-2 rounded-xl border border-stroke-weak bg-fill-weaker px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-bold">{resident}</span>
        <button
          type="button"
          className="btn-ghost btn-sm shrink-0 px-2 py-1 text-[11px]"
          aria-label={copied ? 'Copied' : 'Copy address'}
          onClick={() => {
            void navigator.clipboard.writeText(resident).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
        </button>
      </div>
      <div className="mt-3">
        <span className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">
          Deposit amount (USDC)
        </span>
        <div className="mt-1 flex gap-2">
          <input
            className="field min-w-0 flex-1 py-1.5 text-[13px] tabular"
            inputMode="decimal"
            value={depositUsd}
            placeholder={`${MIN_BRIDGE2_USDC}`}
            disabled={bridging || busy}
            aria-invalid={!!depositError || undefined}
            onChange={(e) => {
              setDepositUsd(e.target.value);
              setDepositTouched(true);
              setError(null);
            }}
            onBlur={() => setDepositTouched(true)}
          />
          <button
            type="button"
            className="btn-ghost btn-sm shrink-0 px-3 text-[11px]"
            disabled={bridging || busy || residentArbCents <= 0}
            onClick={() => {
              if (residentArbCents <= 0) return;
              setDepositUsd((residentArbCents / 100).toFixed(2));
              setDepositTouched(true);
              setError(null);
            }}
          >
            Max
          </button>
        </div>
      </div>
      {depositError ? <p className="mt-1 text-[11px] text-market-down">{depositError}</p> : null}
      <p className="mt-1 text-[11px] leading-4 text-fg-subtle">Minimum deposit is ${MIN_BRIDGE2_USDC}.</p>
      <button
        type="button"
        className="btn-primary btn-sm mt-2 w-full py-2.5 text-[13px]"
        disabled={!canDeposit}
        onClick={() => void bridgeResident()}
      >
        {bridging ? 'Confirming' : 'Deposit to AI resident trade balance'}
      </button>
      {bridgeNote ? <p className="mt-2 text-[12px] font-semibold text-success">{bridgeNote}</p> : null}
      {error && error !== amountError ? <p className="mt-2 text-[12px] font-semibold text-error">{error}</p> : null}
      {canSendFromBuilder ? (
        <form onSubmit={submit} className="mt-4 border-t border-stroke-weak pt-3">
          <div>
            <span className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">
              Send from builder wallet (USDC)
            </span>
            <div className="mt-1 flex gap-2">
              <input
                className="field min-w-0 flex-1 py-1.5 text-[13px] tabular"
                inputMode="decimal"
                value={usd}
                placeholder={`${Math.max(minSendUsd, liveNeedUsd || minSendUsd)}`}
                disabled={busy}
                aria-invalid={amountInvalid || undefined}
                onChange={(e) => {
                  setUsd(e.target.value);
                  setAmountTouched(true);
                  setError(null);
                }}
                onBlur={() => setAmountTouched(true)}
              />
              <button
                type="button"
                className="btn-ghost btn-sm shrink-0 px-3 text-[11px]"
                disabled={busy || withdrawableCents <= 0}
                onClick={fillMax}
              >
                Max
              </button>
            </div>
          </div>
          <p className="mt-1 text-[11px] leading-4 text-fg-subtle">
            Available: <span className="font-bold tabular text-fg">{builderAvailable}</span> USDC
          </p>
          {amountError ? <p className="mt-1 text-[11px] text-market-down">{amountError}</p> : null}
          <p className="mt-1 text-[11px] leading-4 text-fg-subtle">
            {destNew
              ? `Fee: ${HL_USD_SEND_NEW_USER_FEE_USDC} USDC to activate this new wallet. Minimum send is $${minSendUsd}.`
              : `Fee: Free · Minimum send is $${minSendUsd}`}
          </p>
          {destNew && receiveUsd != null ? (
            <p className="mt-1 text-[11px] leading-4 text-fg-muted">
              They receive {formatUsd(receiveUsd)} after the fee.
              {landShort
                ? ` Send at least ${formatUsd(AI_AGENT_LIMITS.minHlBalanceUsd + feeUsd)} so ${formatUsd(AI_AGENT_LIMITS.minHlBalanceUsd)} lands and the agent can go live.`
                : ''}
            </p>
          ) : null}
          <button type="submit" className="btn-ghost btn-sm mt-2 w-full py-2.5 text-[13px]" disabled={!canSubmit}>
            {busy ? (builderImported ? 'Confirm in wallet…' : 'Confirming') : 'Send to AI resident'}
          </button>
        </form>
      ) : null}
      <div className="mt-4 flex justify-end">
        <button type="button" className="btn-ghost btn-sm px-3 py-1.5 text-xs" onClick={onNext}>
          {ok ? 'Next: agent' : 'Skip for now'}
        </button>
      </div>
    </div>
  );
}

function AgentStep({
  tenant,
  resident,
  agents,
  houseAgents,
  attachedIds,
  slotsUsed,
  funded,
  onChanged,
  getToken,
  getResidentProvider,
  ownBuilder,
  onCharacter,
}: {
  tenant: TenantPublic;
  resident: Hex | null;
  agents: AiAgentView[];
  houseAgents: AiAgentView[];
  attachedIds: Set<string>;
  slotsUsed: number;
  funded: boolean;
  onChanged: () => void;
  getToken: () => Promise<string | null>;
  getResidentProvider: () => Promise<Awaited<ReturnType<ReturnType<typeof useWebAuth>['getResidentEthereumProvider']>>>;
  ownBuilder?: string | null;
  onCharacter: () => void;
}) {
  const [form, setForm] = useState<ResidentAgentForm>(EMPTY_AGENT_FORM);
  const [creating, setCreating] = useState(false);
  const [stepLabel, setStepLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: fetchCatalogAssets, staleTime: 60_000 });
  const perps = useMemo(
    () =>
      filterAssetsForTenant(catalog.data ?? [], tenant.catalog).filter(
        (a) => !a.isSpotOnly && isAiAgentMarketAllowed(a.coin, { isPreIpo: a.isPreIpo }),
      ),
    [catalog.data, tenant.catalog],
  );
  const asset = perps.find((a) => a.coin.toUpperCase() === form.symbol.toUpperCase());
  const taken = agents.filter((a) => a.status !== 'revoked').flatMap((a) => a.config.symbols);
  const formErr = agentFormError(form, { assetMaxLeverage: asset?.maxLeverage ?? null, takenSymbols: taken });
  const budgetInvalid =
    !Number.isFinite(form.maxCapitalUsd) ||
    form.maxCapitalUsd < AI_AGENT_LIMITS.minCapitalUsd ||
    form.maxCapitalUsd > AI_AGENT_LIMITS.maxCapitalUsd;
  const slotsLeft = AI_AGENT_LIMITS.maxAgentSlotsResident - slotsUsed;

  /** Backend-first activate; on "not approved" sign with HD 2, then poll. Same as mobile. */
  const goLive = async (agent: AiAgentView, token: string) => {
    if (!resident) throw new Error('Resident wallet is not ready');
    const provider = await getResidentProvider();
    if (!provider) throw new Error('Resident wallet is not ready in this session');
    await activateResidentAgent({
      agent,
      token,
      resident,
      tenant,
      provider,
      ownBuilder,
      onStep: setStepLabel,
    });
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!resident) return;
    if (formErr) {
      setError(formErr);
      return;
    }
    setError(null);
    setCreating(true);
    try {
      const token = await getToken();
      if (!token) throw new Error('Sign in again');
      setStepLabel('Creating agent');
      const agent = await createResidentAgent(
        { name: form.name.trim(), hlMasterAddress: resident, config: agentConfigFromForm(form) },
        token,
      );
      await attachTenantResident(tenant.slug, agent.id, token);
      onChanged();
      if (funded) await goLive(agent, token);
      onChanged();
      setForm(EMPTY_AGENT_FORM);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the agent');
    } finally {
      setCreating(false);
      setStepLabel(null);
    }
  };

  const act = async (agent: AiAgentView, what: 'live' | 'stop' | 'detach' | 'attach') => {
    setError(null);
    setCreating(true);
    try {
      const token = await getToken();
      if (!token) throw new Error('Sign in again');
      if (what === 'attach') await attachTenantResident(tenant.slug, agent.id, token);
      if (what === 'live') await goLive(agent, token);
      if (what === 'stop') await stopAiAgent(agent.id, token);
      if (what === 'detach') await detachTenantResident(tenant.slug, agent.id, token);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setCreating(false);
      setStepLabel(null);
    }
  };

  return (
    <div>
      {houseAgents.length ? (
        <div className="mb-4">
          <p className="mb-1.5 text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">
            House showcase
          </p>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {houseAgents.map((a) => {
              const attached = attachedIds.has(a.id);
              return (
                <li key={a.id} className="flex items-center justify-between gap-2 px-3 py-2 text-[12px]">
                  <div className="min-w-0">
                    <div className="truncate font-extrabold">
                      {a.name} <span className="text-fg-subtle">· {a.config.symbols.join(', ')}</span>
                    </div>
                    <div className="text-[10px] font-extrabold uppercase tracking-[0.06em] text-fg-subtle">
                      {a.status}
                      {attached ? ' · on this app' : ' · live on HyperTrade'}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {attached ? (
                      <button type="button" className="btn-ghost btn-sm px-2 py-1 text-[11px]" disabled={creating} onClick={() => void act(a, 'detach')}>
                        Detach
                      </button>
                    ) : (
                      <button type="button" className="btn-primary btn-sm px-2 py-1 text-[11px]" disabled={creating} onClick={() => void act(a, 'attach')}>
                        Live here
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {agents.length ? (
        <>
        <ul className="resident-agent-in mb-4 divide-y divide-line rounded-xl border border-line">
          {agents.map((a) => {
            const symbolRaw = a.config.symbols[0] || '';
            const market = symbolRaw.split(':').pop() || symbolRaw;
            const assetLogo = market ? quoteLogoSrc(market) : null;
            const model = a.config.models?.opening;
            const modelOption = AI_MODEL_OPTIONS.find(
              (m) => m.choice.provider === model?.provider && m.choice.model === model?.model,
            );
            const modelLogo = model ? MODEL_LOGOS[model.provider]?.logo : null;
            const modelLabel = modelOption?.label || model?.model || 'Model';
            return (
              <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-3 text-[13px]">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-fg">{a.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 rounded-full border border-stroke-weak bg-fill-weaker px-1.5 py-0.5 text-[11px] font-bold text-fg">
                      {assetLogo ? (
                        <img src={assetLogo} alt="" className="h-3.5 w-3.5 rounded-full object-cover" />
                      ) : (
                        <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-fill-weak text-[8px]">
                          {(market || '?').slice(0, 1)}
                        </span>
                      )}
                      {market || '—'}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-stroke-weak bg-fill-weaker px-1.5 py-0.5 text-[11px] font-bold text-fg">
                      {modelLogo ? <img src={modelLogo} alt="" className="h-3.5 w-3.5 object-contain" /> : null}
                      {modelLabel}
                    </span>
                  </div>
                  <div className="mt-1 text-[12px] text-fg-subtle">
                    {a.status === 'draft'
                      ? 'Draft. It will not trade until you go live.'
                      : a.status === 'active'
                        ? 'Live. Its orders pay the builder fee.'
                        : a.status === 'stopped' || a.status === 'paused'
                          ? 'Stopped. Play on the project card to resume.'
                          : a.status}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  {a.status === 'active' ? (
                    <button type="button" className="btn-ghost btn-sm px-2 py-1 text-[11px]" disabled={creating} onClick={() => void act(a, 'stop')}>
                      Stop
                    </button>
                  ) : a.status !== 'revoked' ? (
                    <button type="button" className="btn-primary btn-sm px-2 py-1 text-[11px]" disabled={creating || !funded} onClick={() => void act(a, 'live')}>
                      {creating ? stepLabel ?? 'Confirming' : 'Go live'}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {error ? <p className="mt-2 text-[12px] font-semibold text-error">{error}</p> : null}
        </>
      ) : null}

      {resident && slotsLeft > 0 ? (
        <form onSubmit={create} className="grid gap-3">
          <label className="block">
            <span className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">Agent name *</span>
            <input
              className="field mt-1 w-full"
              value={form.name}
              maxLength={AI_AGENT_LIMITS.maxNameLen}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="My AI Agent"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">Asset to trade *</span>
            <select
              className="field mt-1 w-full"
              value={form.symbol}
              onChange={(e) => setForm({ ...form, symbol: e.target.value })}
            >
              <option value="">Search asset (e.g. BTC)</option>
              {perps.map((a) => (
                <option key={a.coin} value={a.coin}>
                  {a.coin}
                  {a.maxLeverage ? ` · ${a.maxLeverage}x` : ''}
                </option>
              ))}
            </select>
          </label>

          <ChipRow
            label="AI model"
            required
            options={AI_MODEL_OPTIONS.map((m) => ({
              id: m.choice.model,
              label: m.label,
              logo: MODEL_LOGOS[m.choice.provider]?.logo,
              logoActive: MODEL_LOGOS[m.choice.provider]?.active,
              disabled: m.unavailable,
              badge: m.unavailable ? 'Soon' : undefined,
            }))}
            value={form.model.model}
            onPick={(id) => {
              const m = AI_MODEL_OPTIONS.find((o) => o.choice.model === id && !o.unavailable);
              if (m) setForm({ ...form, model: m.choice });
            }}
          />
          <p className="font-mono text-[11px] leading-4 text-fg-subtle">{form.model.model}</p>

          <ChipRow
            label="Margin mode"
            required
            info={MARGIN_MODE_INFO}
            options={[
              { id: 'cross', label: 'Cross' },
              { id: 'isolated', label: 'Isolated' },
            ]}
            value={form.marginMode}
            onPick={(id) => setForm({ ...form, marginMode: id as 'cross' | 'isolated' })}
          />

          <ChipRow
            label="Trading Horizon"
            required
            info={HORIZON_OPTIONS.map((h) => `${h.label}: ${h.hint}`).join('\n\n')}
            options={HORIZON_OPTIONS.map((h) => ({ id: h.value, label: h.label }))}
            value={form.horizon}
            onPick={(id) => setForm({ ...form, horizon: id as ResidentAgentForm['horizon'] })}
          />
          {form.horizon === 'swing' && form.leverageCap > SWING_LEVERAGE_WARN_ABOVE ? (
            <p className="text-[11px] leading-4 text-market-down">
              Swing agents use wide stops — leverage above {SWING_LEVERAGE_WARN_ABOVE}x risks liquidation before the
              stop can do its job. Consider lowering it.
            </p>
          ) : null}
          {form.horizon === 'investor' && form.leverageCap > INVESTOR_LEVERAGE_WARN_ABOVE ? (
            <p className="text-[11px] leading-4 text-market-down">
              Investor horizon works best with lower leverage — above {INVESTOR_LEVERAGE_WARN_ABOVE}x, wide stops can
              hit liquidation before they protect you. Consider lowering it.
            </p>
          ) : null}

          <ChipRow
            label="Trading style"
            required
            info={DIRECTION_OPTIONS.map((d) => `${d.label}: ${d.hint}`).join('\n\n')}
            options={DIRECTION_OPTIONS.map((d) => ({ id: d.value, label: d.label }))}
            value={form.direction}
            onPick={(id) =>
              setForm({
                ...form,
                direction: id as ResidentAgentForm['direction'],
                mandate: id === 'long_short' ? 'active' : form.mandate,
              })
            }
          />
          {form.direction !== 'long_short' ? (
            <>
              <ChipRow
                label="Goal"
                info={MANDATE_OPTIONS.map((m) => {
                  const body = m.value === 'accumulate' && form.direction === 'short_only' ? m.shortHint : m.hint;
                  return `${m.label}: ${body}`;
                }).join('\n\n')}
                options={MANDATE_OPTIONS.map((m) => ({ id: m.value, label: m.label }))}
                value={form.mandate}
                onPick={(id) => setForm({ ...form, mandate: id as ResidentAgentForm['mandate'] })}
              />
              {form.mandate === 'accumulate' && form.leverageCap > ACCUMULATE_LEVERAGE_WARN_ABOVE ? (
                <p className="text-[11px] leading-4 text-market-down">
                  Accumulation is a long-term campaign — above {ACCUMULATE_LEVERAGE_WARN_ABOVE}x, funding costs and
                  liquidation risk compound against you. Consider lowering it.
                </p>
              ) : null}
            </>
          ) : null}

          <div>
            <FieldInfoLabel label="Max total notional (USDC)" required info={CAPITAL_CAP_INFO} />
            <div className="mt-1 grid grid-cols-2 gap-2">
              <label className="min-w-0">
                <span className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">
                  Notional (USDC) *
                </span>
                <input
                  className="field mt-1 w-full"
                  inputMode="numeric"
                  min={AI_AGENT_LIMITS.minCapitalUsd}
                  max={AI_AGENT_LIMITS.maxCapitalUsd}
                  placeholder="e.g. 100 notional"
                  aria-invalid={budgetInvalid || undefined}
                  value={form.maxCapitalUsd || ''}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    setForm({ ...form, maxCapitalUsd: raw === '' ? 0 : Number(raw) });
                  }}
                />
                <p className={`mt-1 text-[11px] leading-4 ${budgetInvalid ? 'text-market-down' : 'text-fg-subtle'}`}>
                  Minimum ${AI_AGENT_LIMITS.minCapitalUsd} notional
                </p>
              </label>
              <label className="min-w-0">
                <span className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">Max leverage *</span>
                <input
                  className="field mt-1 w-full"
                  inputMode="numeric"
                  placeholder="Max leverage"
                  value={form.leverageCap}
                  onChange={(e) => setForm({ ...form, leverageCap: Number(e.target.value) || 1 })}
                />
                {asset?.maxLeverage ? (
                  <p className="mt-1 text-[11px] leading-4 text-fg-subtle">
                    {form.symbol} allows up to {asset.maxLeverage}x.
                  </p>
                ) : null}
              </label>
            </div>
          </div>

          {error ? <p className="text-[12px] font-semibold text-error">{error}</p> : formErr && form.symbol ? <p className="text-[11px] font-semibold text-fg-subtle">{formErr}</p> : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-fg-subtle">
              {funded
                ? 'Creates the agent, approves the builder fee from the AI resident wallet, then activates. A login that is not a funded builder credits the BuilderPad builder.'
                : 'Creates a draft. Fund the AI resident wallet to go live.'}
            </p>
            <button type="submit" className="btn-primary btn-sm px-3 py-1.5 text-xs" disabled={creating || !!formErr}>
              {creating ? stepLabel ?? 'Working…' : funded ? 'Create & go live' : 'Create draft'}
            </button>
          </div>
        </form>
      ) : null}

      {error && !resident ? <p className="mt-2 text-[12px] font-semibold text-error">{error}</p> : null}

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          className="btn-ghost btn-sm px-3 py-1.5 text-xs disabled:cursor-not-allowed"
          disabled={!agents.some((a) => a.status !== 'revoked')}
          title={agents.some((a) => a.status !== 'revoked') ? 'Look, name, and about stay editable' : 'Add an agent name and a market first'}
          onClick={onCharacter}
        >
          Next: character
        </button>
      </div>
    </div>
  );
}

function CharacterStep({
  tenant,
  funded,
  hasDraft,
  getToken,
  onSaved,
  onClose,
  onFund,
}: {
  tenant: TenantPublic;
  funded: boolean;
  hasDraft: boolean;
  getToken: () => Promise<string | null>;
  onSaved: () => void;
  onClose: () => void;
  onFund: () => void;
}) {
  const persona0: ResidentPersona = tenant.resident?.persona ?? {};
  const avatar0 = tenant.resident?.avatar;
  const savedQ = useQuery({
    queryKey: ['tenant-resident', tenant.slug],
    queryFn: () => fetchTenantResident(tenant.slug).catch(() => null),
  });
  const [name, setName] = useState(persona0.display_name ?? '');
  const [bio, setBio] = useState(persona0.bio_voice ?? '');
  const [preset, setPreset] = useState(
    avatar0 && 'kind' in avatar0 && avatar0.kind === 'preset'
      ? canonicalPresetId(avatar0.preset_id)
      : SHIPPED_AVATAR_PRESETS[0].id,
  );
  const hydrated = useRef(false);
  useEffect(() => {
    const persona = savedQ.data?.persona ?? tenant.resident?.persona;
    const avatar = savedQ.data?.avatar ?? tenant.resident?.avatar;
    if (!persona && !avatar) return;
    if (hydrated.current) return;
    hydrated.current = true;
    setName(
      (savedQ.data?.agents?.find((a) => a.status === 'active')?.name ||
        savedQ.data?.agents?.find((a) => a.status !== 'revoked')?.name ||
        persona?.display_name ||
        ''
      ).trim(),
    );
    setBio((persona?.bio_voice ?? '').trim());
    if (avatar && 'kind' in avatar && avatar.kind === 'preset' && avatar.preset_id) {
      setPreset(canonicalPresetId(avatar.preset_id));
    }
  }, [savedQ.data, tenant.resident]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error('Sign in again');
      const persona: ResidentPersona = {
        display_name: name.trim(),
        bio_voice: bio.trim(),
        tone: persona0.tone ?? [],
        catchphrases: persona0.catchphrases ?? [],
        ...(persona0.show_hour_utc != null ? { show_hour_utc: persona0.show_hour_utc } : {}),
      };
      const avatar: ResidentAvatar = { kind: 'preset', preset_id: preset };
      await patchTenant(tenant.slug, { persona: persona as Record<string, unknown>, avatar: avatar as unknown as Record<string, unknown> }, token);
      const agent =
        savedQ.data?.agents?.find((a) => a.status === 'active') ||
        savedQ.data?.agents?.find((a) => a.status !== 'revoked');
      if (agent && name.trim() && name.trim() !== agent.name) {
        await renameAiAgent(agent.id, name.trim(), token);
      }
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="grid gap-4">
      <div>
        <FieldInfoLabel
          plain
          label="Look"
          info="The character visitors see on the app page and the desk."
        />
        <div className="mt-2 grid grid-cols-2 gap-2">
          {SHIPPED_AVATAR_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPreset(p.id)}
              className={`overflow-hidden rounded-xl border-2 bg-fill-weak ${preset === p.id ? 'border-brand' : 'border-transparent'}`}
            >
              <img src={presetPosterUrl(p.id)} alt={p.label} className="h-28 w-full object-contain object-bottom" onError={(e) => ((e.currentTarget.style.visibility = 'hidden'))} />
              <div className="py-1.5 text-center text-[13px] font-semibold">{p.label}</div>
            </button>
          ))}
        </div>
      </div>
      <div>
        <FieldInfoLabel
          plain
          label="Name"
          info="Shown on the app page and next to the character on the trading desk."
        />
        <input className="field mt-1.5 w-full" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={tenant.app_name} />
      </div>
      <div>
        <FieldInfoLabel
          plain
          label="About"
          aside={`${bio.trim().length}/280`}
          info="A short line under the character on the app page."
        />
        <textarea
          className="field mt-1.5 w-full"
          rows={3}
          maxLength={280}
          value={bio}
          placeholder="Watches this book and says what it sees."
          onChange={(e) => setBio(e.target.value)}
        />
      </div>
      {error ? <p className="text-[12px] font-semibold text-error">{error}</p> : null}
      {saved ? (
        <div className="rounded-xl bg-fill-weak px-3 py-3">
          <p className="text-[13px] font-semibold leading-5 text-fg">
            {hasDraft && !funded
              ? 'Saved. The agent is a draft, so it will not trade until you fund the resident wallet and go live.'
              : 'Saved.'}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            {hasDraft && !funded ? (
              <button type="button" className="btn-ghost btn-sm px-3 py-1.5 text-xs" onClick={onFund}>
                Fund
              </button>
            ) : null}
            <button type="button" className="btn-primary btn-sm px-3 py-1.5 text-xs" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          <button type="submit" className="btn-primary btn-sm px-3 py-1.5 text-xs" disabled={busy}>
            {busy ? 'Saving…' : 'Save character'}
          </button>
        </div>
      )}
    </form>
  );
}

/* ------------------------------ bits ------------------------------ */

function FieldInfoLabel({
  label,
  required,
  info,
  aside,
  plain,
}: {
  label: string;
  required?: boolean;
  info?: string;
  aside?: string;
  plain?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="flex items-center gap-1">
        <span
          className={
            plain
              ? 'text-[13px] font-semibold text-fg'
              : 'text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle'
          }
        >
          {label}
          {required ? ' *' : ''}
        </span>
        {info ? (
          <button
            type="button"
            className="inline-flex h-5 w-5 items-center justify-center rounded-full text-fg-subtle hover:bg-fill-hover hover:text-fg"
            aria-expanded={open}
            aria-label={`${label} info`}
            onClick={() => setOpen((v) => !v)}
          >
            <IconAlert size={14} />
          </button>
        ) : null}
        {aside ? <span className="ml-auto text-[12px] font-semibold tabular text-fg-subtle">{aside}</span> : null}
      </div>
      {open && info ? (
        <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-fill-weak px-2.5 py-2 text-[12px] leading-5 text-fg-muted">
          {info}
        </p>
      ) : null}
    </div>
  );
}

function ChipRow({
  label,
  required,
  info,
  options,
  value,
  onPick,
}: {
  label: string;
  required?: boolean;
  info?: string;
  options: Array<{
    id: string;
    label: string;
    logo?: string;
    logoActive?: string;
    disabled?: boolean;
    badge?: string;
  }>;
  value: string;
  onPick: (id: string) => void;
}) {
  return (
    <div>
      <FieldInfoLabel label={label} required={required} info={info} />
      <div className="mt-1 flex flex-wrap gap-1.5">
        {options.map((o) => {
          const active = value === o.id && !o.disabled;
          const logo = active && o.logoActive ? o.logoActive : o.logo;
          return (
            <button
              key={o.id}
              type="button"
              disabled={o.disabled}
              onClick={() => onPick(o.id)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-extrabold leading-none ${
                active
                  ? 'bg-brand text-black'
                  : o.disabled
                    ? 'cursor-not-allowed bg-fill-weak text-fg-subtle opacity-55'
                    : 'bg-fill-weak text-fg-muted hover:bg-fill-hover'
              }`}
            >
              {logo ? (
                <img
                  src={logo}
                  alt=""
                  className={`h-4 w-4 shrink-0 rounded object-contain ${o.disabled ? 'opacity-55' : ''}`}
                />
              ) : null}
              {o.label}
              {o.badge ? (
                <span className="rounded border border-stroke-strong px-1 py-px text-[8px] font-black uppercase tracking-[0.06em] text-fg-subtle">
                  {o.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-fill-weak px-3 py-2">
      <div className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-sunken/70 px-3 pb-6 sm:items-center sm:p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-labelledby="resident-dialog-title"
        className="card-pop max-h-[min(92dvh,46rem)] w-full max-w-lg overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="resident-dialog-title" className="text-[15px] font-extrabold">
            {title}
          </h2>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle hover:bg-fill-hover hover:text-fg"
            aria-label="Close"
            onClick={onClose}
          >
            <IconClose size={14} />
          </button>
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
