import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Segment, ViewState } from '../shared/contracts';
import { time } from './presentation';

export function Transcript({ segments, partials, empty, historical }: {
  segments: Segment[]; partials: ViewState['partials']; empty: { title: string; detail: string }; historical: boolean;
}) {
  const area = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const following = useRef(!historical);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [pageWidth, setPageWidth] = useState(0);
  const last = segments.at(-1);
  const previous = useRef(last?.id);
  const [announcement, setAnnouncement] = useState({ count: 0, text: '' });
  const partialEntries = Object.entries(partials || {}).filter(([, item]) => item?.text);
  useEffect(() => {
    if (last && last.id !== previous.current && !historical) setAnnouncement((old) => ({ count: old.count + 1, text: `de ${last.source === 'microphone' ? 'microfone' : 'computador'}, em ${time(last.startMs)}.` }));
    previous.current = last?.id;
  }, [segments, partials, historical, last]);
  useLayoutEffect(() => {
    const measure = () => {
      if (!area.current || !pages.current) return;
      const width = area.current.clientWidth;
      const count = Math.max(1, Math.ceil(pages.current.scrollWidth / Math.max(1, width)));
      setPageWidth(width);
      setPageCount(count);
      setPage((current) => following.current ? count - 1 : Math.min(current, count - 1));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (area.current) observer.observe(area.current);
    return () => observer.disconnect();
  }, [segments, partials, empty.title, empty.detail]);
  const changePage = (next: number) => { following.current = next === pageCount - 1; setPage(next); };
  return <>
    <div ref={area} className="transcript-content" tabIndex={0} aria-label="Texto da transcrição">
      <div ref={pages} className="transcript-pages" style={{ transform: `translateX(-${page * pageWidth}px)` }}>
      {!segments.length && !partialEntries.length && <div className="empty-state"><span className="audio-lines" aria-hidden="true">│ ┃ │ ┃ │</span><h3>{empty.title}</h3><p>{empty.detail}</p></div>}
      {segments.map((segment) => <article key={segment.id} className="segment">
        <div><span className={`source-label ${segment.source}`}>{segment.source === 'microphone' ? 'Microfone' : 'Computador'}</span><time dateTime={`PT${segment.startMs / 1000}S`}>{time(segment.startMs)}</time><span className="segment-kind">Confirmado</span></div><p>{segment.text}</p>
      </article>)}
      {partialEntries.map(([source, partial]) => partial && <article key={source} className="segment partial" aria-label={`Texto parcial do ${source === 'microphone' ? 'microfone' : 'computador'}`}>
        <div><span className={`source-label ${source}`}>{source === 'microphone' ? 'Microfone' : 'Computador'}</span><time dateTime={`PT${partial.startMs / 1000}S`}>{time(partial.startMs)}</time><span className="segment-kind">Parcial · pode mudar</span></div><p>{partial.text}</p>
      </article>)}
      </div>
    </div>
    <span className="sr-only" role="status">{announcement.count > 0 ? `Trecho confirmado ${announcement.count} ${announcement.text}` : ''}</span>
    {pageCount > 1 && <nav className="transcript-pagination" aria-label="Páginas da transcrição">
      <button type="button" disabled={page === 0} onClick={() => changePage(page - 1)}>Anterior</button>
      <span aria-live="polite">{page + 1} / {pageCount}</span>
      <button type="button" disabled={page === pageCount - 1} onClick={() => changePage(page + 1)}>Próxima</button>
      {page < pageCount - 1 && !historical && <button type="button" onClick={() => changePage(pageCount - 1)}>Últimos trechos</button>}
    </nav>}
  </>;
}
