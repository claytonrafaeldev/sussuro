import { useEffect, useState } from 'react';
import type { OverlayApi, OverlayState } from '../shared/overlay';

export function Overlay({ api = window.sussurroOverlay }: { api?: OverlayApi }) {
  const [state, setState] = useState<OverlayState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!api) return;
    let alive = true, received = false;
    const unsubscribe = api.onState((next) => { received = true; if (alive) { setState(next); setError(''); } });
    void api.getState().then((next) => { if (alive && !received) setState(next); }).catch(() => { if (alive) setError('Abra o Sussurro para conferir a sessão.'); });
    return () => { alive = false; unsubscribe(); };
  }, [api]);
  async function action(command: 'pause' | 'openMain') {
    if (!api || busy) return;
    setBusy(true); setError('');
    try { await api[command](); }
    catch { setError(command === 'pause' ? 'Não foi possível pausar. Abra o Sussurro.' : 'Não foi possível abrir o Sussurro.'); }
    finally { setBusy(false); }
  }
  const active = state?.phase === 'capturing';
  const seconds = Math.floor((state?.elapsedMs || 0) / 1000);
  return <main className="overlay-card" aria-label="Popup da transcrição">
    <header className="overlay-heading"><span className="overlay-brand">Sussurro</span><span className={`overlay-phase ${active ? 'active' : ''}`} role="status"><span aria-hidden="true">●</span> {active ? 'Transcrevendo' : state?.phase === 'paused' ? 'Pausado' : 'Finalizando'}</span><time>{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</time></header>
    <p className="overlay-text">{state?.text || (active ? 'Aguardando suas palavras…' : 'Confira a sessão no Sussurro.')}</p>
    <div className="overlay-actions"><span className="overlay-cloud">{active ? 'Áudio enviado à nuvem' : 'Captura interrompida'}</span><button type="button" disabled={!active || busy} onClick={() => void action('pause')}>Pausar</button><button type="button" className="primary" disabled={busy} onClick={() => void action('openMain')}>Abrir Sussurro</button></div>
    {error && <p className="overlay-error" role="alert">{error}</p>}
  </main>;
}
