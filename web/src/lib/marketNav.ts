import type { ComponentType, SVGProps } from 'react';
import {
  IconChart,
  IconCoin,
  IconCommodity,
  IconLayers,
  IconSpot,
  IconStar,
  IconStock,
} from '../ui/icons';

export type SymbolPickerTab =
  | 'favorites'
  | 'all'
  | 'spot'
  | 'crypto'
  | 'stocks'
  | 'commodities'
  | 'index';

export type MarketNavId = SymbolPickerTab;

type IconComp = ComponentType<SVGProps<SVGSVGElement> & { size?: number; filled?: boolean }>;

export const MARKET_NAV: { id: MarketNavId; label: string; Icon: IconComp }[] = [
  { id: 'favorites', label: 'Favorites', Icon: IconStar },
  { id: 'spot', label: 'Spot', Icon: IconSpot },
  { id: 'crypto', label: 'Crypto', Icon: IconCoin },
  { id: 'stocks', label: 'Stocks', Icon: IconStock },
  { id: 'commodities', label: 'Commodities', Icon: IconCommodity },
  { id: 'index', label: 'Index', Icon: IconLayers },
];

export const PICKER_TABS: { id: SymbolPickerTab; label: string; Icon: IconComp }[] = [
  { id: 'favorites', label: 'Favorites', Icon: IconStar },
  { id: 'all', label: 'All', Icon: IconChart },
  { id: 'spot', label: 'Spot', Icon: IconSpot },
  { id: 'crypto', label: 'Crypto', Icon: IconCoin },
  { id: 'stocks', label: 'Stocks', Icon: IconStock },
  { id: 'commodities', label: 'Commodities', Icon: IconCommodity },
  { id: 'index', label: 'Index', Icon: IconLayers },
];
