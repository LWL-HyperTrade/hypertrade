import { useCallback, useEffect, useState } from 'react';

const KEY = 'ht-pad-market-favorites';

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string' && !!x.trim());
  } catch {
    return [];
  }
}

function write(coins: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(coins));
  } catch {
    /* private mode */
  }
}

/** Per-browser starred markets for the trade terminal picker. */
export function useMarketFavorites() {
  const [favs, setFavs] = useState<string[]>(() => (typeof window === 'undefined' ? [] : read()));

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setFavs(read());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const set = useCallback((coins: string[]) => {
    write(coins);
    setFavs(coins);
  }, []);

  const isFavorite = useCallback((coin: string) => favs.includes(coin), [favs]);

  const toggleFavorite = useCallback(
    (coin: string) => {
      set(favs.includes(coin) ? favs.filter((c) => c !== coin) : [...favs, coin]);
    },
    [favs, set],
  );

  return { favorites: favs, isFavorite, toggleFavorite };
}
