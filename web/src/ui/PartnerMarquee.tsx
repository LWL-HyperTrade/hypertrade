import { useEffect, useRef, useState, type CSSProperties, type Ref } from 'react';
import hyperliquid from '../assets/images/Hyperliquid_Logo.png';
import uniswap from '../assets/images/uniswap-logo.webp';
import outcome from '../assets/images/outcome-logo.jpg';
import xyz from '../assets/images/tradexyz-logo.jpg';
import robinhood from '../assets/images/robinhoodcrypto-logo.png';
import pons from '../assets/images/pons-icon.png';
import builderpad from '../assets/images/builderpad-small.png';
import { TENANT_PUBLIC_ORIGIN } from '../lib/config';

type Tone = 'invert' | 'plain';

type Partner = {
  name: string;
  src: string;
  href: string;
  tone: Tone;
  mark?: boolean;
};

const PARTNERS: Partner[] = [
  { name: 'Hyperliquid', src: hyperliquid, href: 'https://hyperliquid.xyz', tone: 'invert' },
  { name: 'Uniswap', src: uniswap, href: 'https://uniswap.org', tone: 'invert' },
  { name: 'Outcome', src: outcome, href: 'https://outcome.xyz', tone: 'plain' },
  { name: 'trade.xyz', src: xyz, href: 'https://trade.xyz', tone: 'plain' },
  { name: 'Robinhood Crypto', src: robinhood, href: 'https://robinhood.com/crypto', tone: 'invert' },
  { name: 'Pons', src: pons, href: 'https://www.ponsfamily.com', tone: 'plain', mark: true },
  { name: 'BuilderPad', src: builderpad, href: TENANT_PUBLIC_ORIGIN, tone: 'plain' },
];

function LogoSet({
  hidden,
  setRef,
}: {
  hidden?: boolean;
  setRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div ref={setRef} className="creator-partners-set" aria-hidden={hidden || undefined}>
      {PARTNERS.map((p) => (
        <a
          key={p.name}
          href={p.href}
          target="_blank"
          rel="noreferrer"
          title={p.name}
          tabIndex={hidden ? -1 : undefined}
          className="creator-partners-item"
        >
          <img
            src={p.src}
            alt={hidden ? '' : p.name}
            className={`creator-partners-logo${p.mark ? ' creator-partners-logo--mark' : ''}`}
            data-tone={p.tone}
          />
        </a>
      ))}
    </div>
  );
}

/** Slow ticker of muted partner marks, sits under the creator hero. */
export function PartnerMarquee() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const setRef = useRef<HTMLDivElement>(null);
  const [copies, setCopies] = useState(4);

  useEffect(() => {
    const wrap = wrapRef.current;
    const set = setRef.current;
    if (!wrap || !set) return;

    const layout = () => {
      const setW = set.scrollWidth;
      const viewW = wrap.clientWidth;
      if (setW <= 0 || viewW <= 0) return;
      // Keep (copies - 1) sets on screen so the wrap never shows empty track.
      setCopies(Math.max(3, Math.ceil(viewW / setW) + 1));
    };

    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(wrap);
    ro.observe(set);
    const imgs = [...set.querySelectorAll('img')];
    imgs.forEach((img) => img.addEventListener('load', layout));
    return () => {
      ro.disconnect();
      imgs.forEach((img) => img.removeEventListener('load', layout));
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className="creator-partners"
      aria-label="Partners"
      style={{ '--creator-partners-copies': copies } as CSSProperties}
    >
      <div className="creator-partners-track">
        {Array.from({ length: copies }, (_, i) => (
          <LogoSet key={i} hidden={i > 0} setRef={i === 0 ? setRef : undefined} />
        ))}
      </div>
    </div>
  );
}
