import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 16, ...rest }: P) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...rest,
  };
}

export function IconBolt(p: P) {
  return (
    <svg {...base(p)} fill="currentColor" stroke="none">
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
    </svg>
  );
}

export function IconCheck(p: P) {
  return (
    <svg {...base(p)} strokeWidth={3}>
      <path d="m5 12 4.5 4.5L19 7" />
    </svg>
  );
}

export function IconCopy(p: P) {
  return (
    <svg {...base(p)}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

export function IconQr(p: P) {
  return (
    <svg {...base(p)}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h4v4h-4zM20 14v4M14 20h3M18 18h3v3" />
    </svg>
  );
}

export function IconCandles(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M7 4v3M7 17v3" />
      <rect x="5" y="7" width="4" height="10" rx="1" />
      <path d="M17 6v2M17 16v3" />
      <rect x="15" y="8" width="4" height="8" rx="1" />
    </svg>
  );
}

export function IconLineChart(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M3 17c3-1.5 4.5-7 7.5-7s3 8 6 8S21 7 21 7" />
    </svg>
  );
}

export function IconApp(p: P) {
  return (
    <svg {...base(p)}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </svg>
  );
}

export function IconRocket(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2" />
      <path d="M12 15 9 12l4.5-6.5A6 6 0 0 1 20 3a6 6 0 0 1-2.5 6.5L12 15z" />
      <path d="M9 12 6 11l3-3M12 15l1 3-3 3" />
    </svg>
  );
}

export function IconCoin(p: P) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10M9.5 9.5h3.5a1.75 1.75 0 0 1 0 3.5H9.5h4a1.75 1.75 0 0 1 0 3.5H9.5" />
    </svg>
  );
}

export function IconWallet(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M3 7a2 2 0 0 1 2-2h13v4H5a2 2 0 0 1-2-2z" />
      <path d="M3 7v10a2 2 0 0 0 2 2h15V9H5" />
      <circle cx="16" cy="14" r="1" fill="currentColor" />
    </svg>
  );
}

export function IconMail(p: P) {
  return (
    <svg {...base(p)}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </svg>
  );
}

export function IconCash(p: P) {
  return (
    <svg {...base(p)}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 10v4M18 10v4" />
    </svg>
  );
}

export function IconChart(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M4 19h16" />
      <path d="M7 15V9M12 15V5M17 15v-4" />
    </svg>
  );
}

export function IconShare(p: P) {
  return (
    <svg {...base(p)}>
      <circle cx="18" cy="5" r="2.4" />
      <circle cx="6" cy="12" r="2.4" />
      <circle cx="18" cy="19" r="2.4" />
      <path d="M8.2 13.1 15.8 17.4M15.8 6.6 8.2 10.9" />
    </svg>
  );
}

export function IconOrders(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <circle cx="4" cy="6" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconPercent(p: P) {
  return (
    <svg {...base(p)}>
      <circle cx="7.5" cy="7.5" r="2.5" />
      <circle cx="16.5" cy="16.5" r="2.5" />
      <path d="M17 6 7 18" />
    </svg>
  );
}

export function IconPencil(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
    </svg>
  );
}

export function IconUsers(p: P) {
  return (
    <svg {...base(p)}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 19c0-3 2.5-5 6-5s6 2 6 5" />
      <circle cx="17" cy="9" r="2.2" />
      <path d="M16.2 14.2c2.2.4 3.8 2 3.8 4.8" />
    </svg>
  );
}

export function IconToken(p: P) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
    </svg>
  );
}

export function IconBuyback(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M4 12a8 8 0 0 1 13.2-6L20 8" />
      <path d="M20 4v4h-4" />
      <path d="M20 12a8 8 0 0 1-13.2 6L4 16" />
      <path d="M4 20v-4h4" />
    </svg>
  );
}

export function IconBurn(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M12 3c1.6 3.2-.4 4.8.4 8 2.2-.8 4.6 1.4 4.6 4.4A5 5 0 0 1 7 15.4c0-3.2 3.2-4.8 3.2-8.2C11.2 6.4 11.6 4.8 12 3z" />
    </svg>
  );
}

export function IconGlobe(p: P) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

export function IconArrow(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

/** Vertical swap / flip between two sides of a ticket. */
export function IconSwap(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M7 7v10M7 7l-3 3M7 7l3 3" />
      <path d="M17 17V7M17 17l-3-3M17 17l3-3" />
    </svg>
  );
}

export function IconExternal(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M10 5H5.5A1.5 1.5 0 0 0 4 6.5v12A1.5 1.5 0 0 0 5.5 20h12a1.5 1.5 0 0 0 1.5-1.5V14" />
      <path d="M12 4h8v8M20 4l-9 9" />
    </svg>
  );
}

export function IconGear(p: P) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function IconAlert(p: P) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" strokeLinecap="round" />
      <circle cx="12" cy="16.2" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconLock(p: P) {
  return (
    <svg {...base(p)}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function IconUnlock(p: P) {
  return (
    <svg {...base(p)}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M16 10V7a4 4 0 0 0-8 0" />
    </svg>
  );
}

export function IconX(p: P) {
  return (
    <svg {...base(p)} fill="currentColor" stroke="none">
      <path d="M17.5 3h3.1l-6.8 7.8L21.8 21h-6.3l-4.9-6.4L5 21H1.9l7.3-8.3L1.5 3h6.4l4.4 5.9L17.5 3zm-1.1 16.2h1.7L6.9 4.7H5.1l11.3 14.5z" />
    </svg>
  );
}

export function IconTelegram(p: P) {
  return (
    <svg {...base(p)} fill="currentColor" stroke="none">
      <path d="M21.9 4.6 18.7 19.7c-.2 1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.4-5 9.1-8.2c.4-.4-.1-.5-.6-.2L6.2 13.4 1.4 11.9c-1-.3-1.1-1 .2-1.5L20.5 3c.9-.3 1.6.2 1.4 1.6z" />
    </svg>
  );
}

export function IconDiscord(p: P) {
  return (
    <svg {...base(p)} fill="currentColor" stroke="none">
      <path d="M19.6 5.6A17 17 0 0 0 15.4 4.3l-.5 1.1a15.7 15.7 0 0 0-5.8 0l-.5-1.1a17 17 0 0 0-4.2 1.3C1.7 9.6 1 13.5 1.3 17.4a17 17 0 0 0 5.2 2.6l1.1-1.8c-.6-.2-1.2-.5-1.7-.9l.4-.3a12.2 12.2 0 0 0 11.4 0l.4.3c-.5.4-1.1.7-1.7.9l1.1 1.8a17 17 0 0 0 5.2-2.6c.4-4.5-.7-8.4-3.1-11.8zM8.7 15c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1S9.8 15 8.7 15zm6.6 0c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1z" />
    </svg>
  );
}

export function IconTikTok(p: P) {
  return (
    <svg {...base(p)} fill="currentColor" stroke="none">
      <path d="M14.2 3c.4 2.5 1.8 4.2 4.3 4.5v3c-1.5 0-2.9-.5-4.3-1.4v6.6c0 3.3-2.6 5.8-6.1 5.3A5.2 5.2 0 0 1 4 16.2c.6-2.6 3.2-4.2 5.7-3.5v3.2c-.6-.2-1.3 0-1.8.4a2 2 0 0 0 1.9 3.4c1.1 0 2-.9 2-2V3h2.4z" />
    </svg>
  );
}

export function IconInstagram(p: P) {
  return (
    <svg {...base(p)}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.2" cy="6.8" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconYouTube(p: P) {
  return (
    <svg {...base(p)} fill="currentColor" stroke="none">
      <path d="M23 12.2s-.2-3.2-1-4.6c-.9-1.2-1.9-1.2-2.4-1.3C16.3 6 12 6 12 6s-4.3 0-7.6.3c-.5.1-1.5.1-2.4 1.3-.8 1.4-1 4.6-1 4.6S.8 16 .8 17.4c.2 1.5 1.1 2.7 2.6 2.9C5.8 20.7 12 20.8 12 20.8s4.3 0 7.6-.3c1.6-.2 2.4-1.4 2.6-2.9.3-1.4.8-5.2.8-5.2zM9.8 15.6V8.9l6.2 3.4-6.2 3.3z" />
    </svg>
  );
}

export function IconTwitch(p: P) {
  return (
    <svg {...base(p)} fill="currentColor" stroke="none">
      <path d="M4 3 3 6.5V19h4.2v3l2.3-3H13l6.2-6.2V3H4zm13.5 8.8L14.7 14.6h-3.2L9.2 16.9v-2.3H6.2V5h11.3v6.8zM15 7.3h-1.6v4.6H15V7.3zm-4.2 0H9.2v4.6h1.6V7.3z" />
    </svg>
  );
}

export function IconChevron(p: P) {
  return (
    <svg {...base(p)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function IconLayers(p: P) {
  return (
    <svg {...base(p)}>
      <path d="m12 2 9 5-9 5-9-5 9-5z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </svg>
  );
}

export function IconCommodity(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M12 3v3" />
      <ellipse cx="12" cy="8" rx="7" ry="3" />
      <path d="M5 8v8c0 1.7 3.1 3 7 3s7-1.3 7-3V8" />
    </svg>
  );
}

export function IconStock(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M4 19V9" />
      <path d="M10 19V5" />
      <path d="M16 19v-7" />
      <path d="M22 19V8" />
    </svg>
  );
}

export function IconSpot(p: P) {
  return (
    <svg {...base(p)}>
      <circle cx="9" cy="12" r="5" />
      <circle cx="15" cy="12" r="5" />
    </svg>
  );
}

export function IconMenu(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export function IconSearch(p: P) {
  return (
    <svg {...base(p)}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

export function IconClose(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function IconStar(p: P & { filled?: boolean }) {
  const { filled, ...rest } = p;
  return (
    <svg {...base(rest)} fill={filled ? 'currentColor' : 'none'} strokeWidth={filled ? 0 : 2}>
      <path d="m12 3.2 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 15.6 7.2 18.1l.9-5.4-3.9-3.8 5.4-.8L12 3.2z" />
    </svg>
  );
}

/** TradingView-style chart tools (stroke icons, not labels). */
export function IconTrendLine(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M4 18 20 6" />
      <circle cx="4" cy="18" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="20" cy="6" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconHorizLine(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M3 12h18" />
    </svg>
  );
}

export function IconFib(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M4 5h16M4 10h16M4 14h16M4 19h16" />
    </svg>
  );
}

export function IconTrash(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M5 7h14M10 7V5h4v2M8 7v12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7" />
    </svg>
  );
}

export function IconEye(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function IconEyeOff(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
      <path d="M9.9 5.1A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17.4 17.4 0 0 1-3.2 3.6" />
      <path d="M6.1 6.1C3.7 7.8 2 12 2 12s3.5 7 10 7a10.3 10.3 0 0 0 4.4-1" />
    </svg>
  );
}

export function IconFx(p: P) {
  const { size = 16, className, ...rest } = p;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
      {...rest}
    >
      <text
        x="2"
        y="17.5"
        fontFamily="Georgia, 'Times New Roman', Times, serif"
        fontStyle="italic"
        fontSize="17"
        fontWeight="500"
      >
        f
      </text>
      <text
        x="12"
        y="20.5"
        fontFamily="Georgia, 'Times New Roman', Times, serif"
        fontStyle="italic"
        fontSize="11"
      >
        x
      </text>
    </svg>
  );
}

