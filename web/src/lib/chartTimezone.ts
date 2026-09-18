/** Curated city list for the chart timezone picker (HL-style). */

export type ChartZone = { id: string; city: string };

export const CHART_TIMEZONES: ChartZone[] = [
  { id: 'Pacific/Midway', city: 'Midway' },
  { id: 'Pacific/Honolulu', city: 'Honolulu' },
  { id: 'America/Anchorage', city: 'Anchorage' },
  { id: 'America/Los_Angeles', city: 'Los Angeles' },
  { id: 'America/Vancouver', city: 'Vancouver' },
  { id: 'America/Denver', city: 'Denver' },
  { id: 'America/Phoenix', city: 'Phoenix' },
  { id: 'America/Chicago', city: 'Chicago' },
  { id: 'America/Mexico_City', city: 'Mexico City' },
  { id: 'America/New_York', city: 'New York' },
  { id: 'America/Toronto', city: 'Toronto' },
  { id: 'America/Bogota', city: 'Bogota' },
  { id: 'America/Lima', city: 'Lima' },
  { id: 'America/Caracas', city: 'Caracas' },
  { id: 'America/Santiago', city: 'Santiago' },
  { id: 'America/Sao_Paulo', city: 'Sao Paulo' },
  { id: 'America/Argentina/Buenos_Aires', city: 'Buenos Aires' },
  { id: 'Atlantic/Azores', city: 'Azores' },
  { id: 'UTC', city: 'UTC' },
  { id: 'Europe/London', city: 'London' },
  { id: 'Europe/Dublin', city: 'Dublin' },
  { id: 'Europe/Lisbon', city: 'Lisbon' },
  { id: 'Africa/Casablanca', city: 'Casablanca' },
  { id: 'Europe/Paris', city: 'Paris' },
  { id: 'Europe/Berlin', city: 'Berlin' },
  { id: 'Europe/Amsterdam', city: 'Amsterdam' },
  { id: 'Europe/Brussels', city: 'Brussels' },
  { id: 'Europe/Madrid', city: 'Madrid' },
  { id: 'Europe/Rome', city: 'Rome' },
  { id: 'Europe/Stockholm', city: 'Stockholm' },
  { id: 'Europe/Vienna', city: 'Vienna' },
  { id: 'Africa/Lagos', city: 'Lagos' },
  { id: 'Europe/Warsaw', city: 'Warsaw' },
  { id: 'Europe/Zurich', city: 'Zurich' },
  { id: 'Africa/Johannesburg', city: 'Johannesburg' },
  { id: 'Europe/Athens', city: 'Athens' },
  { id: 'Europe/Bucharest', city: 'Bucharest' },
  { id: 'Europe/Helsinki', city: 'Helsinki' },
  { id: 'Africa/Cairo', city: 'Cairo' },
  { id: 'Asia/Qatar', city: 'Bahrain' },
  { id: 'Europe/Istanbul', city: 'Istanbul' },
  { id: 'Asia/Jerusalem', city: 'Jerusalem' },
  { id: 'Asia/Kuwait', city: 'Kuwait' },
  { id: 'Europe/Moscow', city: 'Moscow' },
  { id: 'Africa/Nairobi', city: 'Nairobi' },
  { id: 'Europe/Nicosia', city: 'Nicosia' },
  { id: 'Asia/Dubai', city: 'Dubai' },
  { id: 'Asia/Tehran', city: 'Tehran' },
  { id: 'Asia/Karachi', city: 'Karachi' },
  { id: 'Asia/Kolkata', city: 'Kolkata' },
  { id: 'Asia/Dhaka', city: 'Dhaka' },
  { id: 'Asia/Yangon', city: 'Yangon' },
  { id: 'Asia/Bangkok', city: 'Bangkok' },
  { id: 'Asia/Jakarta', city: 'Jakarta' },
  { id: 'Asia/Shanghai', city: 'Shanghai' },
  { id: 'Asia/Hong_Kong', city: 'Hong Kong' },
  { id: 'Asia/Singapore', city: 'Singapore' },
  { id: 'Asia/Taipei', city: 'Taipei' },
  { id: 'Australia/Perth', city: 'Perth' },
  { id: 'Asia/Seoul', city: 'Seoul' },
  { id: 'Asia/Tokyo', city: 'Tokyo' },
  { id: 'Australia/Sydney', city: 'Sydney' },
  { id: 'Pacific/Guadalcanal', city: 'Guadalcanal' },
  { id: 'Pacific/Auckland', city: 'Auckland' },
  { id: 'Pacific/Tongatapu', city: 'Tongatapu' },
];

export function isValidTimeZone(id: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: id }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function detectLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function resolveChartTimezone(saved: string): string {
  if (saved && isValidTimeZone(saved)) return saved;
  const local = detectLocalTimezone();
  return isValidTimeZone(local) ? local : 'UTC';
}

function cityFromIana(id: string): string {
  const last = id.split('/').pop() || id;
  return last.replace(/_/g, ' ');
}

export function zoneOffsetMinutes(timeZone: string, at = Date.now()): number {
  try {
    const name =
      new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
        .formatToParts(new Date(at))
        .find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = name.match(/([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return 0;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
  } catch {
    return 0;
  }
}

export function formatUtcOffset(timeZone: string, at = Date.now()): string {
  const mins = zoneOffsetMinutes(timeZone, at);
  const sign = mins >= 0 ? '+' : '-';
  const abs = Math.abs(mins);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m ? `UTC${sign}${h}:${String(m).padStart(2, '0')}` : `UTC${sign}${h}`;
}

export function formatZoneClock(timeZone: string, at = Date.now()): string {
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(at));
  return `${clock} (${formatUtcOffset(timeZone, at)})`;
}

export function formatZoneRow(zone: ChartZone, at = Date.now()): string {
  return `(${formatUtcOffset(zone.id, at)}) ${zone.city}`;
}

export function zonesForPicker(selected: string, at = Date.now()): ChartZone[] {
  const list = CHART_TIMEZONES.filter((z) => isValidTimeZone(z.id));
  if (selected && isValidTimeZone(selected) && !list.some((z) => z.id === selected)) {
    list.push({ id: selected, city: cityFromIana(selected) });
  }
  return list.sort((a, b) => {
    const d = zoneOffsetMinutes(a.id, at) - zoneOffsetMinutes(b.id, at);
    return d !== 0 ? d : a.city.localeCompare(b.city);
  });
}
