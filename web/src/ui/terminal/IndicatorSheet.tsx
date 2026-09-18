import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CHART_COLOR_PRESETS,
  DEFAULT_BOLL_COLORS,
  DEFAULT_EMA_ROWS,
  DEFAULT_INDICATOR_PREFS,
  DEFAULT_MA_ROWS,
  MA_BAND_SLOT_COUNT,
  MA_SOURCE_OPTIONS,
  type MaBandRow,
  type WebIndicatorPrefs,
} from '../../lib/indicatorPrefs';
import { IconCheck, IconChevron, IconClose } from '../icons';

type Section = 'main' | 'sub';
type MainId = 'ma' | 'ema' | 'boll' | 'vwap';
type SubId = 'vol' | 'macd' | 'rsi';
type ColorPick =
  | { kind: 'ma' | 'ema'; index: number }
  | { kind: 'vwap' }
  | { kind: 'boll'; index: number }
  | null;

const MAIN_ITEMS: { id: MainId; label: string }[] = [
  { id: 'ma', label: 'MA' },
  { id: 'ema', label: 'EMA' },
  { id: 'boll', label: 'BOLL' },
  { id: 'vwap', label: 'VWAP' },
];

const SUB_ITEMS: { id: SubId; label: string }[] = [
  { id: 'vol', label: 'VOL' },
  { id: 'macd', label: 'MACD' },
  { id: 'rsi', label: 'RSI' },
];

export function IndicatorSheet({
  open,
  prefs,
  onChange,
  onClose,
}: {
  open: boolean;
  prefs: WebIndicatorPrefs;
  onChange: (next: WebIndicatorPrefs) => void;
  onClose: () => void;
}) {
  const [section, setSection] = useState<Section>('main');
  const [mainId, setMainId] = useState<MainId>('ma');
  const [subId, setSubId] = useState<SubId>('vol');
  const [colorPick, setColorPick] = useState<ColorPick>(null);

  useEffect(() => {
    if (!open) {
      setColorPick(null);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (colorPick) {
        setColorPick(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, colorPick]);

  if (!open) return null;

  const mainOn: Record<MainId, boolean> = {
    ma: prefs.maVisible,
    ema: prefs.emaVisible,
    boll: prefs.boll,
    vwap: prefs.vwap,
  };
  const subOn: Record<SubId, boolean> = {
    vol: prefs.vol,
    macd: prefs.macd,
    rsi: prefs.rsi,
  };

  const toggleMain = (id: MainId) => {
    if (id === 'ma') onChange({ ...prefs, maVisible: !prefs.maVisible });
    else if (id === 'ema') onChange({ ...prefs, emaVisible: !prefs.emaVisible });
    else if (id === 'boll') onChange({ ...prefs, boll: !prefs.boll });
    else onChange({ ...prefs, vwap: !prefs.vwap });
  };

  const toggleSub = (id: SubId) => {
    onChange({ ...prefs, [id]: !prefs[id] });
  };

  const colorValue = (() => {
    if (!colorPick) return '#4ef2bb';
    if (colorPick.kind === 'vwap') return prefs.vwapColor;
    if (colorPick.kind === 'boll') return prefs.bollColors[colorPick.index] ?? '#4ef2bb';
    const rows = colorPick.kind === 'ema' ? prefs.emaRows : prefs.maRows;
    return rows[colorPick.index]?.color ?? '#4ef2bb';
  })();

  const applyColor = (color: string) => {
    if (!colorPick) return;
    if (colorPick.kind === 'vwap') onChange({ ...prefs, vwapColor: color });
    else if (colorPick.kind === 'boll') {
      const next = [...prefs.bollColors] as [string, string, string];
      next[colorPick.index] = color;
      onChange({ ...prefs, bollColors: next });
    } else {
      const key = colorPick.kind === 'ema' ? 'emaRows' : 'maRows';
      const list = colorPick.kind === 'ema' ? prefs.emaRows : prefs.maRows;
      onChange({ ...prefs, [key]: list.map((r, i) => (i === colorPick.index ? { ...r, color } : r)) });
    }
    setColorPick(null);
  };

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/55"
        aria-label="Close"
        onClick={() => {
          if (colorPick) {
            setColorPick(null);
            return;
          }
          onClose();
        }}
      />
      <div className="relative flex max-h-[min(40rem,90vh)] w-full max-w-[44rem] flex-col overflow-hidden rounded-2xl border border-stroke-weak bg-background shadow-xl">
        <div className="flex shrink-0 items-center gap-4 border-b border-stroke-weak px-4">
          {(
            [
              { id: 'main', label: 'Main indicator' },
              { id: 'sub', label: 'Sub-indicators' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSection(tab.id)}
              className={`relative py-3 text-[13px] font-bold ${
                section === tab.id ? 'text-fg' : 'text-fg-subtle hover:text-fg'
              }`}
            >
              {tab.label}
              {section === tab.id ? <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-brand" /> : null}
            </button>
          ))}
          <button
            type="button"
            className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-fill-weak"
            aria-label="Close"
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="w-[8.5rem] shrink-0 overflow-y-auto border-r border-stroke-weak py-2">
            {section === 'main'
              ? MAIN_ITEMS.map((item) => (
                  <NavRow
                    key={item.id}
                    label={item.label}
                    on={mainOn[item.id]}
                    active={mainId === item.id}
                    onSelect={() => setMainId(item.id)}
                    onToggle={() => toggleMain(item.id)}
                  />
                ))
              : SUB_ITEMS.map((item) => (
                  <NavRow
                    key={item.id}
                    label={item.label}
                    on={subOn[item.id]}
                    active={subId === item.id}
                    onSelect={() => setSubId(item.id)}
                    onToggle={() => toggleSub(item.id)}
                  />
                ))}
          </div>

          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
            {section === 'main' ? (
              mainId === 'ma' || mainId === 'ema' ? (
                <AverageEditor
                  kind={mainId}
                  prefs={prefs}
                  onChange={onChange}
                  onClose={onClose}
                  onPickColor={(index) => setColorPick({ kind: mainId, index })}
                />
              ) : mainId === 'boll' ? (
                <BollEditor prefs={prefs} onChange={onChange} onClose={onClose} onPickColor={(index) => setColorPick({ kind: 'boll', index })} />
              ) : (
                <VwapEditor prefs={prefs} onChange={onChange} onClose={onClose} onPickColor={() => setColorPick({ kind: 'vwap' })} />
              )
            ) : subId === 'vol' ? (
              <SimpleEditor
                title="Volume"
                hint="Histogram under the candles"
                on={prefs.vol}
                onToggle={() => onChange({ ...prefs, vol: !prefs.vol })}
                onClose={onClose}
              />
            ) : subId === 'macd' ? (
              <MacdEditor prefs={prefs} onChange={onChange} onClose={onClose} />
            ) : (
              <RsiEditor prefs={prefs} onChange={onChange} onClose={onClose} />
            )}
          </div>
        </div>

        {colorPick ? <ColorPicker value={colorValue} onPick={applyColor} onClose={() => setColorPick(null)} /> : null}
      </div>
    </div>,
    document.body,
  );
}

function NavRow({
  label,
  on,
  active,
  onSelect,
  onToggle,
}: {
  label: string;
  on: boolean;
  active: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  return (
    <div className={`flex items-center gap-1.5 px-2 py-1.5 ${active ? 'bg-fill-weak' : 'hover:bg-fill-weaker'}`}>
      <Check on={on} onClick={onToggle} />
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center justify-between text-left">
        <span className={`truncate text-[12px] font-semibold ${active || on ? 'text-fg' : 'text-fg-subtle'}`}>{label}</span>
        <IconChevron size={12} className="-rotate-90 text-fg-subtle" />
      </button>
    </div>
  );
}

function AverageEditor({
  kind,
  prefs,
  onChange,
  onClose,
  onPickColor,
}: {
  kind: 'ma' | 'ema';
  prefs: WebIndicatorPrefs;
  onChange: (next: WebIndicatorPrefs) => void;
  onClose: () => void;
  onPickColor: (index: number) => void;
}) {
  const rows = (kind === 'ema' ? prefs.emaRows : prefs.maRows).slice(0, MA_BAND_SLOT_COUNT);
  const rowKey = kind === 'ema' ? 'emaRows' : 'maRows';
  const visible = kind === 'ema' ? prefs.emaVisible : prefs.maVisible;
  const patchRow = (index: number, patch: Partial<MaBandRow>) => {
    onChange({ ...prefs, [rowKey]: rows.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
  };
  return (
    <div>
      <h3 className="mb-3 text-[14px] font-bold">{kind === 'ema' ? 'EMA — Exponential MA' : 'MA — Moving Average'}</h3>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-semibold">Show on chart</span>
        <Check
          on={visible}
          onClick={() =>
            onChange({ ...prefs, ...(kind === 'ema' ? { emaVisible: !prefs.emaVisible } : { maVisible: !prefs.maVisible }) })
          }
        />
      </div>
      <div className="divide-y divide-stroke-weak">
        {rows.map((row, index) => (
          <div key={`${kind}-${index}`} className="flex items-center gap-2 py-2">
            <Check on={row.enabled} onClick={() => patchRow(index, { enabled: !row.enabled })} />
            <span className="w-11 shrink-0 text-[11px] font-bold text-fg-muted">
              {kind === 'ema' ? `EMA${index + 1}` : `MA${index + 1}`}
            </span>
            <input
              inputMode="numeric"
              maxLength={3}
              value={row.period === 0 ? '' : String(row.period)}
              onChange={(e) => {
                const cleaned = e.target.value.replace(/[^0-9]/g, '');
                patchRow(index, { period: cleaned === '' ? 0 : Number(cleaned) });
              }}
              className="h-8 w-14 rounded-md border border-stroke-weak bg-fill-weak px-1.5 text-center text-[12px] font-semibold text-fg outline-none focus:border-brand"
            />
            <select
              value={row.source}
              onChange={(e) => patchRow(index, { source: e.target.value as MaBandRow['source'] })}
              className="h-8 min-w-0 flex-1 rounded-md border border-stroke-weak bg-fill-weak px-1.5 text-[11px] font-semibold text-fg outline-none focus:border-brand"
            >
              {MA_SOURCE_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              title="Line color"
              onClick={() => onPickColor(index)}
              className="h-7 w-7 shrink-0 rounded-md border-2"
              style={{ borderColor: row.color, background: row.color }}
            />
          </div>
        ))}
      </div>
      <Footer
        onReset={() => {
          const defaults = kind === 'ema' ? DEFAULT_EMA_ROWS : DEFAULT_MA_ROWS;
          onChange({ ...prefs, [rowKey]: defaults.map((r) => ({ ...r })) });
        }}
        onDone={onClose}
      />
    </div>
  );
}

function BollEditor({
  prefs,
  onChange,
  onClose,
  onPickColor,
}: {
  prefs: WebIndicatorPrefs;
  onChange: (next: WebIndicatorPrefs) => void;
  onClose: () => void;
  onPickColor: (index: number) => void;
}) {
  const bands: { label: string; index: number }[] = [
    { label: 'UP', index: 0 },
    { label: 'MID', index: 1 },
    { label: 'DN', index: 2 },
  ];
  return (
    <div>
      <h3 className="mb-3 text-[14px] font-bold">BOLL — Bollinger Bands</h3>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[12px] font-semibold">Show on chart</span>
        <Check on={prefs.boll} onClick={() => onChange({ ...prefs, boll: !prefs.boll })} />
      </div>
      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-fg-subtle">Parameters</p>
      <div className="mb-4 grid grid-cols-2 gap-2">
        <NumField
          label="Length"
          value={prefs.bollLength}
          onChange={(n) => onChange({ ...prefs, bollLength: n })}
        />
        <label className="block">
          <span className="mb-1 block text-[11px] text-fg-subtle">Multiplier</span>
          <input
            inputMode="decimal"
            value={String(prefs.bollMult)}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange({ ...prefs, bollMult: Number.isFinite(n) ? n : prefs.bollMult });
            }}
            className="h-8 w-full rounded-md border border-stroke-weak bg-fill-weak px-2 text-[12px] font-semibold outline-none focus:border-brand"
          />
        </label>
      </div>
      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-fg-subtle">Display</p>
      <div className="divide-y divide-stroke-weak">
        {bands.map((b) => (
          <div key={b.label} className="flex items-center justify-between py-2">
            <span className="text-[12px] font-semibold">{b.label}</span>
            <button
              type="button"
              className="h-7 w-7 rounded-md border-2"
              style={{ borderColor: prefs.bollColors[b.index], background: prefs.bollColors[b.index] }}
              onClick={() => onPickColor(b.index)}
            />
          </div>
        ))}
      </div>
      <Footer
        onReset={() =>
          onChange({
            ...prefs,
            bollLength: 20,
            bollMult: 2,
            bollColors: DEFAULT_BOLL_COLORS,
          })
        }
        onDone={onClose}
      />
    </div>
  );
}

function VwapEditor({
  prefs,
  onChange,
  onClose,
  onPickColor,
}: {
  prefs: WebIndicatorPrefs;
  onChange: (next: WebIndicatorPrefs) => void;
  onClose: () => void;
  onPickColor: () => void;
}) {
  return (
    <div>
      <h3 className="mb-3 text-[14px] font-bold">VWAP</h3>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[12px] font-semibold">Show on chart</span>
        <Check on={prefs.vwap} onClick={() => onChange({ ...prefs, vwap: !prefs.vwap })} />
      </div>
      <div className="flex items-end gap-3">
        <NumField label="Length" value={prefs.vwapLength} onChange={(n) => onChange({ ...prefs, vwapLength: n })} />
        <button
          type="button"
          title="Line color"
          onClick={onPickColor}
          className="mb-0 h-8 w-8 rounded-md border-2"
          style={{ borderColor: prefs.vwapColor, background: prefs.vwapColor }}
        />
      </div>
      <p className="mb-1.5 mt-4 text-[10px] font-bold uppercase tracking-wide text-fg-subtle">Line width</p>
      <div className="flex gap-1">
        {([1, 2, 3, 4] as const).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => onChange({ ...prefs, vwapLineWidth: w })}
            className={`h-8 min-w-8 rounded-md px-2.5 text-[12px] font-bold ${
              (prefs.vwapLineWidth || 2) === w ? 'bg-brand-soft text-brand' : 'bg-fill-weak text-fg-subtle hover:text-fg'
            }`}
          >
            {w}
          </button>
        ))}
      </div>
      <Footer
        onReset={() =>
          onChange({
            ...prefs,
            vwapLength: 14,
            vwapColor: DEFAULT_INDICATOR_PREFS.vwapColor,
            vwapLineWidth: 2,
          })
        }
        onDone={onClose}
      />
    </div>
  );
}

function MacdEditor({
  prefs,
  onChange,
  onClose,
}: {
  prefs: WebIndicatorPrefs;
  onChange: (next: WebIndicatorPrefs) => void;
  onClose: () => void;
}) {
  const setParam = (i: 0 | 1 | 2, n: number) => {
    const next = [...prefs.macdParams] as [number, number, number];
    next[i] = n;
    onChange({ ...prefs, macdParams: next });
  };
  return (
    <div>
      <h3 className="mb-3 text-[14px] font-bold">MACD</h3>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[12px] font-semibold">Show on chart</span>
        <Check on={prefs.macd} onClick={() => onChange({ ...prefs, macd: !prefs.macd })} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <NumField label="Fast" value={prefs.macdParams[0]} onChange={(n) => setParam(0, n)} />
        <NumField label="Slow" value={prefs.macdParams[1]} onChange={(n) => setParam(1, n)} />
        <NumField label="Signal" value={prefs.macdParams[2]} onChange={(n) => setParam(2, n)} />
      </div>
      <Footer onReset={() => onChange({ ...prefs, macdParams: [12, 26, 9] })} onDone={onClose} />
    </div>
  );
}

function RsiEditor({
  prefs,
  onChange,
  onClose,
}: {
  prefs: WebIndicatorPrefs;
  onChange: (next: WebIndicatorPrefs) => void;
  onClose: () => void;
}) {
  return (
    <div>
      <h3 className="mb-3 text-[14px] font-bold">RSI</h3>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[12px] font-semibold">Show on chart</span>
        <Check on={prefs.rsi} onClick={() => onChange({ ...prefs, rsi: !prefs.rsi })} />
      </div>
      <NumField label="Period" value={prefs.rsiPeriod} onChange={(n) => onChange({ ...prefs, rsiPeriod: n })} />
      <Footer onReset={() => onChange({ ...prefs, rsiPeriod: 14 })} onDone={onClose} />
    </div>
  );
}

function SimpleEditor({
  title,
  hint,
  on,
  onToggle,
  onClose,
}: {
  title: string;
  hint: string;
  on: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  return (
    <div>
      <h3 className="mb-3 text-[14px] font-bold">{title}</h3>
      <p className="mb-4 text-[12px] text-fg-subtle">{hint}</p>
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold">Show on chart</span>
        <Check on={on} onClick={onToggle} />
      </div>
      <Footer onReset={onToggle} onDone={onClose} hideReset />
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[11px] text-fg-subtle">{label}</span>
      <input
        inputMode="numeric"
        maxLength={3}
        value={value === 0 ? '' : String(value)}
        onChange={(e) => {
          const cleaned = e.target.value.replace(/[^0-9]/g, '');
          onChange(cleaned === '' ? 0 : Number(cleaned));
        }}
        className="h-8 w-full rounded-md border border-stroke-weak bg-fill-weak px-2 text-[12px] font-semibold outline-none focus:border-brand"
      />
    </label>
  );
}

function Footer({ onReset, onDone, hideReset }: { onReset: () => void; onDone: () => void; hideReset?: boolean }) {
  return (
    <div className="mt-5 flex items-center justify-end gap-2">
      {hideReset ? null : (
        <button
          type="button"
          onClick={onReset}
          className="rounded-lg border border-stroke-weak px-4 py-1.5 text-[12px] font-semibold text-fg-subtle hover:bg-fill-hover hover:text-fg"
        >
          Reset
        </button>
      )}
      <button type="button" onClick={onDone} className="rounded-lg bg-brand px-5 py-1.5 text-[12px] font-bold text-[#0a0a0a]">
        Done
      </button>
    </div>
  );
}

function Check({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] border ${
        on ? 'border-brand bg-brand text-[#0a0a0a]' : 'border-stroke-weak bg-transparent text-transparent'
      }`}
    >
      <IconCheck size={11} />
    </button>
  );
}

function ColorPicker({
  value,
  onPick,
  onClose,
}: {
  value: string;
  onPick: (color: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 z-30 flex items-end justify-center bg-black/40 p-3 sm:items-center">
      <button type="button" className="absolute inset-0" aria-label="Close color picker" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-xl border border-stroke-weak bg-background p-3 shadow-lg">
        <p className="mb-2 text-[13px] font-bold">Line color</p>
        <div className="grid grid-cols-7 gap-2">
          {CHART_COLOR_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onPick(c)}
              className="h-7 w-7 rounded-full border border-white/20"
              style={{
                background: c,
                boxShadow: value.toLowerCase() === c.toLowerCase() ? '0 0 0 2px #4ef2bb' : undefined,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
