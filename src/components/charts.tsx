import { BIN_COUNT, BIN_WIDTH, type TrendPoint } from '../lib/dashboard';
import { pct, periodShort } from './ui';

export const BIN_LABELS = Array.from({ length: BIN_COUNT }, (_, i) => (i === BIN_COUNT - 1 ? `${Math.round(i * BIN_WIDTH * 100)}+` : `${Math.round(i * BIN_WIDTH * 100)}–${Math.round((i + 1) * BIN_WIDTH * 100)}`));

/** Bars from `warnFrom` (the bin that starts at the remark threshold) are tinted so threshold breaches stand out. */
export function Histogram({ bins, warnFrom, unit = 'karyawan' }: { bins: number[]; warnFrom?: number; unit?: string }) {
  const max = Math.max(1, ...bins);
  return (
    <div className="chart">
      <div className="hist" role="img" aria-label={`Distribusi per rentang 5%: ${bins.map((b, i) => `${BIN_LABELS[i]}%: ${b} ${unit}`).join(', ')}`}>
        {bins.map((b, i) => (
          <div key={i} className="col"><div className={`bar${warnFrom != null && i >= warnFrom ? ' warn' : ''}`} style={{ height: `${(b / max) * 100}%`, opacity: b ? 1 : 0.15 }}>{b > 0 && <span className="cnt num">{b}</span>}</div></div>
        ))}
      </div>
      <div className="hist-x" aria-hidden="true">{BIN_LABELS.map((l) => <span key={l}>{l}</span>)}</div>
      <p className="hint" style={{ textAlign: 'center', marginTop: 4 }}>Rentang (%) · jumlah {unit}{warnFrom != null ? ' · warna kuning = di atas ambang' : ''}</p>
      <details className="alt"><summary>Tampilkan sebagai tabel</summary>
        <table><thead><tr><th>Rentang</th><th className="r">{unit}</th></tr></thead><tbody>{bins.map((b, i) => <tr key={i}><td>{BIN_LABELS[i]}%</td><td className="r num">{b}</td></tr>)}</tbody></table>
      </details>
    </div>
  );
}

export function HBars({ items, max }: { items: { label: string; value: number | null; n: number }[]; max: number }) {
  return (
    <div className="chart">
      {items.map((it) => (
        <div className="hbar" key={it.label}>
          <span title={it.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label} <span className="muted">({it.n})</span></span>
          <div className="track" role="img" aria-label={`${it.label}: ${pct(it.value)}`}><div className="fill" style={{ width: `${Math.min(1, (it.value ?? 0) / max) * 100}%` }} /></div>
          <b className="num" style={{ textAlign: 'right' }}>{pct(it.value)}</b>
        </div>
      ))}
    </div>
  );
}

/** Monthly average of one metric; months without a file are dashed gaps, not interpolated (FR-33). */
export function LineChart({ points, get, label }: { points: TrendPoint[]; get: (p: TrendPoint) => number | null; label: string }) {
  const W = 720, H = 220, L = 44, R = 12, T = 12, B = 30;
  const vals = points.map(get).filter((v): v is number => v != null);
  const top = Math.max(0.1, Math.ceil(Math.max(0, ...vals) * 1.15 * 20) / 20);
  const x = (i: number) => (points.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (points.length - 1));
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const segs: { p: TrendPoint; i: number }[][] = [];
  let cur: { p: TrendPoint; i: number }[] = [];
  points.forEach((p, i) => { if (get(p) == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push({ p, i }); });
  if (cur.length) segs.push(cur);
  const step = Math.ceil(points.length / 6);
  return (
    <div className="chart">
      <svg className="line-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: ${points.map((p) => `${periodShort(p.period)} ${get(p) == null ? 'tidak ada data' : pct(get(p))}`).join(', ')}`}>
        {[0, 0.25, 0.5, 0.75, 1].map((g) => <g key={g}><line className="grid" x1={L} x2={W - R} y1={y(g * top)} y2={y(g * top)} /><text x={L - 8} y={y(g * top) + 4} textAnchor="end">{(g * top * 100).toFixed(top < 0.2 ? 1 : 0)}%</text></g>)}
        {points.map((p, i) => (
          <g key={p.period}>
            {get(p) == null && <line className="gap" x1={x(i)} x2={x(i)} y1={T} y2={H - B} />}
            {i % step === 0 && <text x={x(i)} y={H - 8} textAnchor="middle">{periodShort(p.period)}</text>}
          </g>
        ))}
        {segs.map((s, k) => s.length > 1 && <polyline key={k} className="ln" points={s.map(({ p, i }) => `${x(i)},${y(get(p)!)}`).join(' ')} />)}
        {segs.flat().map(({ p, i }) => <circle key={p.period} className="dot" cx={x(i)} cy={y(get(p)!)} r={4}><title>{`${periodShort(p.period)}: ${pct(get(p))} (${p.n} karyawan)`}</title></circle>)}
      </svg>
    </div>
  );
}
