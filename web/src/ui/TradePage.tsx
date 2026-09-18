import { useParams } from 'react-router-dom';
import { useTenantSlug } from '../lib/brandedHost';
import { TenantApp } from './terminal/TenantApp';

export function TradePage() {
  const slug = useTenantSlug();
  const { coin: rawCoin = '' } = useParams();
  return <TenantApp slug={slug} coin={rawCoin} />;
}
