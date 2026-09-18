import builderpadIcon from '../../assets/images/builderpad-icon.webp';

export type ChartWatermarkBrand = {
  name?: string | null;
  logoUrl?: string | null;
};

/** Same ink for creator marks and the BuilderPad fallback — neon assets need extra dimming. */
const GHOST = 0.045;

/**
 * Ghost logo + name behind candles.
 * A passed `brand` never swaps in the BuilderPad B; missing creator logos just omit the image.
 */
export function ChartWatermark({ brand }: { brand?: ChartWatermarkBrand | null }) {
  const branded = brand != null;
  const name = branded ? brand.name?.trim() || '' : 'BuilderPad';
  const logoSrc = branded ? brand.logoUrl?.trim() || '' : builderpadIcon;

  if (!name && !logoSrc) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center" aria-hidden>
      <div className="flex max-w-[70%] items-center gap-3 text-fg" style={{ opacity: GHOST }}>
        {logoSrc ? (
          <img
            src={logoSrc}
            alt=""
            className="h-14 w-14 shrink-0 rounded-2xl object-cover sm:h-16 sm:w-16"
            style={branded ? undefined : { filter: 'brightness(0.55)' }}
          />
        ) : null}
        {name ? (
          <span className="truncate text-3xl font-black tracking-tight sm:text-4xl">{name}</span>
        ) : null}
      </div>
    </div>
  );
}
