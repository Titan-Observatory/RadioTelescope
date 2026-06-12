// Full-width data explorer rendered below the sky-map/side-panel grid once
// the GOES downlink reaches frame lock (or whenever archived products
// exist). Breaks the decoded stream out into something explorable: link
// statistics, per-virtual-channel activity, and a gallery of decoded
// products (imagery, bulletins, DCS blobs).

import { Activity, FileText, Image as ImageIcon, Package, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, goesProductFileUrl } from '../../api';
import { formatAge, formatBytes, formatKbps, VC_NAMES } from '../../lib/goes';
import type { GoesFrame, GoesProduct, GoesProductKind } from '../../types';

const PRODUCTS_POLL_MS = 8000;

type KindFilter = 'all' | GoesProductKind;

interface GoesDataExplorerProps {
  frame: GoesFrame | null;
  isLocked: boolean;
}

export function GoesDataExplorer({ frame, isLocked }: GoesDataExplorerProps) {
  const [products, setProducts] = useState<GoesProduct[]>([]);
  const [totalProducts, setTotalProducts] = useState(0);
  const [filter, setFilter] = useState<KindFilter>('all');
  const [lightbox, setLightbox] = useState<GoesProduct | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const listing = await api.goesProducts(60);
      setProducts(listing.products);
      setTotalProducts(listing.total);
    } catch { /* gateway blip — next poll retries */ }
    finally { setRefreshing(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, PRODUCTS_POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Close the lightbox on Escape.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  const visible = useMemo(
    () => (filter === 'all' ? products : products.filter((p) => p.kind === filter)),
    [products, filter],
  );

  const vcRows = useMemo(() => {
    const counts = frame?.vcdu_counts ?? {};
    const entries = Object.entries(counts).sort(([a], [b]) => Number(a) - Number(b));
    const max = Math.max(1, ...entries.map(([, n]) => n));
    return entries.map(([vcid, count]) => ({
      vcid,
      label: VC_NAMES[vcid] ?? `Channel ${vcid}`,
      count,
      pct: (count / max) * 100,
    }));
  }, [frame?.vcdu_counts]);

  if (!isLocked && totalProducts === 0) return null;

  const frameErrPct = frame && frame.frames_total > 0
    ? (frame.frames_bad / frame.frames_total) * 100
    : null;

  return (
    <section className="panel goes-explorer" aria-label="GOES data explorer">
      <header className="goes-explorer-head">
        <div>
          <h2 className="panel-header head-amber">
            <Activity size={15} /> Downlink data explorer
          </h2>
          <p className="spectrum-subtitle">
            {isLocked
              ? 'Live decode of the satellite broadcast — every image and bulletin below arrived over your dish.'
              : 'Archive of previously decoded products. Re-acquire the satellite to resume live decoding.'}
          </p>
        </div>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => void refresh()}
          disabled={refreshing}
          title="Refresh product list"
        >
          <RefreshCw size={12} className={refreshing ? 'goes-spin' : undefined} /> Refresh
        </button>
      </header>

      {/* ── Link statistics ──────────────────────────────────────────── */}
      {frame && (
        <div className="goes-stats-strip" aria-label="Link statistics">
          <Stat label="Data rate" value={formatKbps(frame.data_rate_kbps)} />
          <Stat label="Frames" value={frame.frames_total.toLocaleString()} sub={frameErrPct != null ? `${frameErrPct.toFixed(1)}% bad` : undefined} />
          <Stat label="RS corrections" value={frame.rs_corrected.toLocaleString()} sub="symbols repaired" />
          <Stat label="VCDUs" value={frame.vcdu_total.toLocaleString()} sub={`${frame.vcdu_fill.toLocaleString()} fill`} />
          <Stat label="Packets" value={frame.packets_total.toLocaleString()} sub={frame.packets_crc_err > 0 ? `${frame.packets_crc_err} CRC errors` : 'all CRCs clean'} />
          <Stat label="Products" value={String(totalProducts)} sub={frame.last_product_at != null ? formatAge(frame.last_product_at) : undefined} />
        </div>
      )}

      <div className="goes-explorer-grid">
        {/* ── Virtual channel activity ───────────────────────────────── */}
        <div className="goes-vc-panel">
          <h3 className="goes-section-title">Virtual channels</h3>
          {vcRows.length === 0 ? (
            <p className="goes-muted">No channel traffic decoded yet.</p>
          ) : (
            <ul className="goes-vc-list">
              {vcRows.map((row) => (
                <li key={row.vcid} className="goes-vc-row">
                  <span className="goes-vc-label">
                    <strong>VC {row.vcid}</strong> {row.label}
                  </span>
                  <span className="goes-vc-bar">
                    <span className="goes-vc-fill" style={{ width: `${row.pct}%` }} />
                  </span>
                  <span className="goes-vc-count">{row.count.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Product gallery ───────────────────────────────────────── */}
        <div className="goes-products-panel">
          <div className="goes-products-head">
            <h3 className="goes-section-title">Decoded products</h3>
            <div className="goes-filter-chips" role="group" aria-label="Filter products">
              {(['all', 'image', 'text', 'dcs'] as KindFilter[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={`goes-chip${filter === kind ? ' is-active' : ''}`}
                  onClick={() => setFilter(kind)}
                >
                  {kind === 'all' ? 'All' : kind === 'dcs' ? 'DCS' : `${kind[0].toUpperCase()}${kind.slice(1)}s`}
                </button>
              ))}
            </div>
          </div>
          {visible.length === 0 ? (
            <p className="goes-muted">
              {isLocked
                ? 'Nothing decoded yet — full files take a little while to assemble.'
                : 'No products in the archive.'}
            </p>
          ) : (
            <ul className="goes-product-grid">
              {visible.map((product) => (
                <ProductCard key={product.id} product={product} onOpen={setLightbox} />
              ))}
            </ul>
          )}
        </div>
      </div>

      {lightbox && (
        <div className="goes-lightbox" role="dialog" aria-modal="true" onClick={() => setLightbox(null)}>
          <div className="goes-lightbox-body" onClick={(e) => e.stopPropagation()}>
            <header className="goes-lightbox-head">
              <span className="goes-lightbox-title">{lightbox.name}</span>
              <button type="button" className="ghost-btn" onClick={() => setLightbox(null)} aria-label="Close">
                <X size={14} />
              </button>
            </header>
            {lightbox.kind === 'image' ? (
              <img className="goes-lightbox-img" src={goesProductFileUrl(lightbox.id)} alt={lightbox.name} />
            ) : (
              <TextProductBody product={lightbox} />
            )}
            <footer className="goes-lightbox-meta">
              {lightbox.vcid != null && <span>VC {lightbox.vcid}</span>}
              {lightbox.apid != null && <span>APID {lightbox.apid}</span>}
              {lightbox.columns != null && lightbox.lines != null && (
                <span>{lightbox.columns}×{lightbox.lines}px</span>
              )}
              <span>{formatBytes(lightbox.size_bytes)}</span>
              <span>{formatAge(lightbox.created_at)}</span>
              <a href={goesProductFileUrl(lightbox.id)} download={lightbox.name} className="goes-download-link">
                Download
              </a>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="goes-stat">
      <span className="spectrum-readout-label">{label}</span>
      <span className="goes-stat-value">{value}</span>
      {sub && <span className="goes-stat-sub">{sub}</span>}
    </div>
  );
}

function ProductCard({ product, onOpen }: { product: GoesProduct; onOpen: (p: GoesProduct) => void }) {
  const icon = product.kind === 'image'
    ? <ImageIcon size={13} />
    : product.kind === 'text'
      ? <FileText size={13} />
      : <Package size={13} />;
  return (
    <li className="goes-product-card">
      <button type="button" className="goes-product-open" onClick={() => onOpen(product)}>
        {product.kind === 'image' ? (
          <img
            className="goes-product-thumb"
            src={goesProductFileUrl(product.id)}
            alt={product.name}
            loading="lazy"
          />
        ) : (
          <span className="goes-product-preview">
            {product.preview ?? `${product.kind.toUpperCase()} · ${formatBytes(product.size_bytes)}`}
          </span>
        )}
      </button>
      <div className="goes-product-meta">
        <span className="goes-product-kind">{icon}</span>
        <span className="goes-product-name" title={product.name}>{product.name}</span>
        <span className="goes-product-age">{formatAge(product.created_at)}</span>
      </div>
    </li>
  );
}

function TextProductBody({ product }: { product: GoesProduct }) {
  const [text, setText] = useState<string | null>(product.preview);
  useEffect(() => {
    let cancelled = false;
    fetch(goesProductFileUrl(product.id))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((body) => { if (!cancelled) setText(body); })
      .catch(() => { /* keep the preview */ });
    return () => { cancelled = true; };
  }, [product.id]);
  return <pre className="goes-lightbox-text">{text ?? 'No preview available.'}</pre>;
}
