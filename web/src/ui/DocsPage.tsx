import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PONS, robinhoodAddressUrl, ROBINHOOD_CHAIN_ID } from '../lib/pons/chain';

const LAST_UPDATED = 'September 14, 2026';

/** Distance from viewport top used to pick the active section while scrolling. */
const SCROLL_SPY_OFFSET_PX = 120;

type NavItem = { id: string; label: string };

const NAV: NavItem[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'lifecycle', label: 'Launch lifecycle' },
  { id: 'curve', label: 'Bonding curve' },
  { id: 'graduation', label: 'Graduation' },
  { id: 'pairs', label: 'Custom pairs' },
  { id: 'snipe', label: 'Snipe protection' },
  { id: 'fees', label: 'Fees' },
  { id: 'payouts', label: 'Payouts' },
  { id: 'buyback', label: 'Buyback and vesting' },
  { id: 'controls', label: 'Creator controls' },
  { id: 'safety', label: 'Safety and recovery' },
  { id: 'risks', label: 'Risk disclosures' },
  { id: 'contracts', label: 'Contracts' },
];

function sectionIdAtScroll(): string {
  // Short last section often never reaches the spy offset before the page ends.
  const fromBottom =
    document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
  if (fromBottom <= 120) return NAV[NAV.length - 1].id;

  const lastId = NAV[NAV.length - 1].id;
  const marker = SCROLL_SPY_OFFSET_PX;
  let current = NAV[0].id;
  for (const item of NAV) {
    const el = document.getElementById(item.id);
    if (!el) continue;
    // Looser threshold for the final section so it can light up while still on-screen.
    const threshold = item.id === lastId ? Math.max(marker, window.innerHeight * 0.45) : marker;
    if (el.getBoundingClientRect().top <= threshold) current = item.id;
  }
  return current;
}

const CONTRACTS: { label: string; address: string }[] = [
  { label: 'Factory', address: PONS.factory },
  { label: 'Meme hook', address: PONS.memeHook },
  { label: 'Fee escrow', address: PONS.feeEscrow },
  { label: 'Buyback vault', address: PONS.buybackVault },
  { label: 'Launch locker', address: PONS.launchLocker },
  { label: 'Launch and buy', address: PONS.launchAndBuy },
  { label: 'Launch deployer', address: PONS.launchDeployer },
  { label: 'Graduation executor', address: PONS.graduationExecutor },
  { label: 'Graduation guard', address: PONS.graduationGuard },
];

function DocSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 border-t border-stroke-weak pt-10 first:border-t-0 first:pt-0">
      <h2 className="text-xl font-extrabold tracking-tight sm:text-2xl">{title}</h2>
      <div className="mt-4 space-y-3 text-sm leading-relaxed text-fg-muted">{children}</div>
    </section>
  );
}

function Addr({ address }: { address: string }) {
  return (
    <a
      href={robinhoodAddressUrl(address)}
      target="_blank"
      rel="noreferrer"
      className="break-all font-mono text-[12px] font-semibold text-brand hover:underline"
    >
      {address}
    </a>
  );
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function DocsPage() {
  const [activeId, setActiveId] = useState(NAV[0].id);

  useEffect(() => {
    // Footer links land with the previous page's scroll offset; force the top.
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    setActiveId(NAV[0].id);
  }, []);

  useEffect(() => {
    const onScroll = () => setActiveId(sectionIdAtScroll());
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 pb-12 lg:flex-row lg:items-start lg:gap-14">
      <aside className="lg:sticky lg:top-24 lg:w-56 lg:shrink-0 lg:self-start">
        <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-fg-subtle">Docs</p>
        <nav className="mt-3 flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0 lg:border-l lg:border-stroke-weak">
          {NAV.map((item) => {
            const active = item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveId(item.id);
                  scrollToSection(item.id);
                }}
                aria-current={active ? 'location' : undefined}
                className={`shrink-0 rounded-md px-2.5 py-1.5 text-left text-[12px] font-bold transition-colors lg:w-full lg:-ml-px lg:rounded-l-none lg:rounded-r-md lg:border-l-2 ${
                  active
                    ? 'border-brand bg-brand-soft text-fg lg:border-brand'
                    : 'border-transparent text-fg-muted hover:bg-fill-weaker hover:text-fg lg:border-transparent'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
      </aside>

      <article className="min-w-0 flex-1">
        <h1 className="display text-3xl sm:text-4xl">BuilderPad docs</h1>
        <p className="mt-2 text-sm text-fg-subtle">Last updated: {LAST_UPDATED}</p>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-fg-muted">
          How BuilderPad apps and creator coins work — including the launch protocol on Robinhood Chain.
        </p>

        <div className="mt-10 space-y-10">
          <DocSection id="overview" title="Overview">
            <p>
              BuilderPad lets creators publish a branded Hyperliquid trading app, optionally activate their own
              builder wallet so fills pay them, and optionally launch a creator coin on Robinhood Chain.
            </p>
            <p>
              Creator coins use the <code className="rounded bg-fill-weaker px-1 py-0.5 font-mono text-[12px] text-fg">BuilderPad*</code>{' '}
              contract stack. A creator deploys a token, the public buys it from a bonding curve, and once the curve
              sells out the launch graduates into a Uniswap v4 pool whose liquidity is locked permanently. Every step
              is a transaction your wallet signs. BuilderPad does not take custody of tokens or funds.
            </p>
            <p>
              Perps and spot trade on Hyperliquid. The creator coin is a separate market on Robinhood Chain. Product
              links (builder-fee pledges, desk buybacks, socials) do not merge the two chains or custody models.
            </p>
          </DocSection>

          <DocSection id="lifecycle" title="Launch lifecycle">
            <p>Every creator coin follows the same four steps. There is no mid-flight rewrite of the terms.</p>
            <ol className="list-decimal space-y-3 pl-5">
              <li>
                <strong className="font-extrabold text-fg">Create.</strong> Name, symbol, image, description, links,
                quote asset, optional creator tax / buyback / team wallets. Pay the launch fee (0.00025 ETH). The
                entire supply is minted to the curve — nobody, including the creator, holds a pre-allocated bag before
                trading opens.
              </li>
              <li>
                <strong className="font-extrabold text-fg">Trade the curve.</strong> Anyone can buy and sell. Price rises
                with buys and falls with sells. You can always sell back to the curve until it sells out.
              </li>
              <li>
                <strong className="font-extrabold text-fg">Graduate.</strong> When the curve sells out, it closes.
                Collected reserves seed the Uniswap v4 pool together with the reserved supply held back for liquidity.
              </li>
              <li>
                <strong className="font-extrabold text-fg">Pool.</strong> Liquidity is locked permanently. Trading
                continues in the pool under the same fee policy snapshotted at launch.
              </li>
            </ol>
            <p>
              Graduation usually runs inside the purchase that finishes the curve. If that step stalls, anyone can
              push the launch forward — it does not need the creator or BuilderPad. In the product you launch from the
              create wizard or “Launch token” later; claiming fees and desk trading are separate from those on-chain
              steps.
            </p>
          </DocSection>

          <DocSection id="curve" title="Bonding curve">
            <p>
              The curve holds the whole circulating supply from creation and always stands ready to buy or sell at a
              price derived from how much supply has already been bought. Large orders move price more than small
              ones. Fees are charged in the pairing asset, never as an extra bill in the launch token.
            </p>
            <p>
              You cannot sell into the curve after it has sold out: those reserves are what the pool is about to be
              built from. Selling reopens in the pool once graduation completes, usually in the same transaction that
              finished the curve.
            </p>
            <p>
              Default launch config (ETH pair) uses a fixed supply of 1e9 tokens, a graduation threshold of 4.2 ETH of
              real quote reserve, and a phantom quote of 1.68 ETH. Every launch on those settings graduates into a pool
              of the same size at the same price.
            </p>
          </DocSection>

          <DocSection id="graduation" title="Graduation">
            <p>
              Graduation is the moment a launch leaves the curve and becomes a normal Uniswap v4 pool. A fixed share of
              supply is reserved at creation for that liquidity. Nobody can change it later, and the creator cannot
              under-provide liquidity at the end.
            </p>
            <p>
              If your buy is larger than what remains on the curve, you receive what is left, pay only for what you
              got, and the unused quote is returned in the same transaction. Slippage protection still applies: you may
              get fewer tokens than requested, but not at a worse price per token than you agreed to.
            </p>
          </DocSection>

          <DocSection id="pairs" title="Custom pairs">
            <p>
              Most launches are priced in ETH. A launch can instead be paired against a quote asset our factory has
              approved — typically Robinhood Chain stock tokens and related assets shown in the launch UI. That asset
              becomes the currency of the whole launch: buys, sells, graduation target, graduated pool, and creator
              fee claims.
            </p>
            <p>
              Only factory-approved assets can be used. Approval is suitability for pairing, not an endorsement. New
              launches against an asset can be stopped later without affecting launches already trading against it.
            </p>
            <p>
              A non-ETH pair carries that asset’s risk on top of the launch token’s. Dollar value can move even when the
              launch/quote price is flat.
            </p>
          </DocSection>

          <DocSection id="snipe" title="Snipe protection">
            <p>
              Every launch opens with a decaying buy tax so racing the first blocks is rarely profitable. It applies
              only to buys. Selling is not taxed by it. What is collected joins the launch’s trading fee and is shared
              the same way.
            </p>
            <p>
              The tax starts near 99% and decays to zero across roughly the first three seconds (read{' '}
              <code className="rounded bg-fill-weaker px-1 py-0.5 font-mono text-[12px]">snipeTaxSeconds()</code> and{' '}
              <code className="rounded bg-fill-weaker px-1 py-0.5 font-mono text-[12px]">snipeTaxStartBps()</code> on
              the factory for live values). Each launch snapshots those terms at creation.
            </p>
            <p>
              The launching wallet and the creator fee recipient are exempt automatically. Creators can name additional
              team wallets at creation (max 32). Exemptions cannot be added later.
            </p>
          </DocSection>

          <DocSection id="fees" title="Fees">
            <p>Two charges can apply on a creator-coin trade:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong className="font-extrabold text-fg">Trading fee</strong> — 75 bps, same on the curve and in the
                graduated pool. The Uniswap pool itself is configured with zero pool fee, so you are not charged a
                second Uniswap fee on top.
              </li>
              <li>
                <strong className="font-extrabold text-fg">Creator tax</strong> — optional, set at launch, capped by the
                factory (UI chips respect the live max). 100% of this tax goes to the creator. It cannot be raised
                later.
              </li>
            </ul>
            <p>Of the standard trading fee:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>Protocol: 10%</li>
              <li>Creator bucket: 90%</li>
              <li>
                If buybacks are on: 25% of that creator bucket is spent buying the launch token; the rest stays with
                the creator
              </li>
            </ul>
            <p>
              Hyperliquid builder fees on the trading app are separate. Those are set in the BuilderPad wizard (0–10
              bps) and may be pledged toward product buybacks of the creator coin. They are not the same as the on-chain
              trading-fee split above.
            </p>
          </DocSection>

          <DocSection id="payouts" title="Payouts">
            <p>
              Creators are paid in the pairing asset. Fees accrue in the fee escrow and are withdrawn when claimed —
              they are not pushed automatically, so one broken recipient cannot jam payouts for everyone.
            </p>
            <p>
              After graduation, fees may temporarily land in the launch token depending on swap direction. Before
              payout, that side is converted back into the pairing asset when it can be done without moving price too
              far; otherwise it waits.
            </p>
            <p>
              Claim actions live on My Projects for the app that owns the coin. Separate balances exist per pairing
              asset if you launch against more than one.
            </p>
          </DocSection>

          <DocSection id="buyback" title="Buyback and vesting">
            <p>
              On-chain buybacks are optional and default off in the launch UI. When enabled, they come out of the
              creator’s fee share, not from traders as an extra tax. Bought-back tokens are locked in the buyback vault
              and released gradually over five years, split between creator and protocol — not dumped as a lump sum.
            </p>
            <p>
              If a buyback cannot be done sensibly (liquidity or price impact), that slice goes to the creator as
              normal fees instead. A failed buyback cannot hold up other fee distribution.
            </p>
            <p>
              Separately, creators can pledge a percentage of their Hyperliquid builder fee toward buying or burning
              their coin in the product. That pledge is append-only and public on the app card; it is not the same
              mechanism as the on-chain buyback vault toggle.
            </p>
          </DocSection>

          <DocSection id="controls" title="Creator controls">
            <p>
              After launch, almost nothing about the token is adjustable. Supply, pricing math, pairing asset,
              creator tax, and graduation terms are fixed. Two things stay movable on-chain:
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong className="font-extrabold text-fg">Fee recipient</strong> — where future creator fees (and
                buyback share) go.
              </li>
              <li>
                <strong className="font-extrabold text-fg">Buyback on/off</strong> — the fee recipient can change this;
                the protocol may turn buybacks off but never on for a launch.
              </li>
            </ul>
            <p>
              There is no mint, freeze, blacklist, or post-launch tax increase, and no way for anyone to pull locked
              liquidity after graduation.
            </p>
          </DocSection>

          <DocSection id="safety" title="Safety and recovery">
            <p>
              After graduation, liquidity is locked with no unlock path for the creator or BuilderPad. Rug pulls that
              depend on removing LP are not available as a function on these contracts.
            </p>
            <p>
              Graduation is two steps. If a launch is stuck between them for a full week because the pool cannot be
              seeded (for example the pairing asset changed in a way that breaks graduation), a rescue path can return
              collected reserves rather than leave them stranded. That wait is intentional so rescue cannot interrupt a
              graduation that was going to succeed. Rescued launches are permanently marked.
            </p>
            <p>
              Locked liquidity, supply locked at graduation, and tokens sent to a contract by mistake are not
              recoverable.
            </p>
          </DocSection>

          <DocSection id="risks" title="Risk disclosures">
            <ul className="list-disc space-y-2 pl-5">
              <li>Launch tokens are volatile and can go to zero.</li>
              <li>
                Anyone can create a launch with any name, symbol, or image. Names are not unique. Always verify the
                token address.
              </li>
              <li>Creator tax is set at launch within the protocol cap — read it before trading.</li>
              <li>Graduation only means the curve sold out. It is not a quality signal.</li>
              <li>Custom pairs inherit the pairing asset’s risk and liquidity.</li>
              <li>Hyperliquid trading and creator-coin trading are separate markets with separate risks.</li>
              <li>
                Transactions your wallet submits are typically irreversible. BuilderPad is a software interface, not
                a broker or custodian. See also{' '}
                <Link to="/terms" className="font-bold text-brand hover:underline">
                  Terms
                </Link>{' '}
                and{' '}
                <Link to="/privacy" className="font-bold text-brand hover:underline">
                  Privacy
                </Link>
                .
              </li>
            </ul>
          </DocSection>

          <DocSection id="contracts" title="Contracts">
            <p>
              Live on Robinhood Chain, chain id {ROBINHOOD_CHAIN_ID}. Resolve each launch’s curve and token from the
              factory — those are created per launch. Contract identifiers use the{' '}
              <code className="rounded bg-fill-weaker px-1 py-0.5 font-mono text-[12px]">BuilderPad*</code> prefix.
            </p>
            <ul className="mt-2 space-y-2">
              {CONTRACTS.map((c) => (
                <li key={c.address} className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                  <span className="w-40 shrink-0 text-[12px] font-extrabold text-fg">{c.label}</span>
                  <Addr address={c.address} />
                </li>
              ))}
            </ul>
          </DocSection>
        </div>
      </article>
    </div>
  );
}
