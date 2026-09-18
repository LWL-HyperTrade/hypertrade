import type { TenantPublic } from '../lib/tenants';
import { normalizeWebsiteUrl } from '../lib/tenants';
import {
  IconDiscord,
  IconGlobe,
  IconInstagram,
  IconTelegram,
  IconTikTok,
  IconTwitch,
  IconX,
  IconYouTube,
} from './icons';

export function socialItems(tenant: TenantPublic) {
  const s = tenant.socials;
  const items: { href: string; title: string; Icon: typeof IconX }[] = [];
  if (s?.twitter) items.push({ href: `https://x.com/${s.twitter}`, title: `@${s.twitter}`, Icon: IconX });
  if (s?.tiktok) items.push({ href: `https://www.tiktok.com/@${s.tiktok}`, title: `@${s.tiktok}`, Icon: IconTikTok });
  if (s?.instagram) items.push({ href: `https://www.instagram.com/${s.instagram}`, title: `@${s.instagram}`, Icon: IconInstagram });
  if (s?.youtube) items.push({ href: `https://www.youtube.com/@${s.youtube}`, title: s.youtube, Icon: IconYouTube });
  if (s?.twitch) items.push({ href: `https://www.twitch.tv/${s.twitch}`, title: s.twitch, Icon: IconTwitch });
  if (s?.discord) items.push({ href: `https://discord.com/users/${s.discord}`, title: s.discord, Icon: IconDiscord });
  if (s?.telegram) items.push({ href: `https://t.me/${s.telegram}`, title: `@${s.telegram}`, Icon: IconTelegram });
  if (s?.website) {
    try {
      const href = normalizeWebsiteUrl(s.website);
      if (href) items.push({ href, title: href, Icon: IconGlobe });
    } catch {
      /* skip unsafe legacy values */
    }
  }
  return items;
}
