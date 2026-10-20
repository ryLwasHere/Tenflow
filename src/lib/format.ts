const pad = (n: number) => String(n).padStart(2, '0');
export const hhmm = (min: number) => { const m = Math.floor(((min % 1440) + 1440) % 1440); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
export const dmy = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export const dur = (m: number) => `${Math.floor(m / 60)}j ${Math.round(m % 60)}m`;
/** 'HH:mm' (from <input type="time">) -> minutes; null when malformed. */
export const parseHm = (s: string) => { const m = s.match(/^(\d{1,2}):(\d{2})$/); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };
