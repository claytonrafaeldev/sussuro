import { useEffect, useRef, useState } from 'react';
import { DEFAULT_OPTIONS, type Device, type Session, type SessionSummary, type StartOptions, type ViewState } from '../shared/contracts';
import type { CredentialStatus } from '../shared/runtime';
import { Microphone } from './microphone';
import { Transcript } from './Transcript';
import { savedOptions, startBlocker, emptyTranscript, languageOptions, languageLabel, phaseLabels as phases, time } from './presentation';

const api = window.sussurro;
const initial: ViewState = { microphoneChecking: false, microphoneCaptureId: null, pendingBytes: { microphone: 0, system: 0 }, audioGapCount: 0, phase: 'idle', sessionId: null, options: DEFAULT_OPTIONS, message: 'Escolha suas fontes para começar.', pendingSeconds: 0, lagSeconds: 0, elapsedMs: 0, segments: [], levels: { microphone: 0, system: 0 } };

export function App() {
  const [state, setState] = useState<ViewState>(initial);
  const [options, setOptions] = useState<StartOptions>(() => {
    try { return savedOptions(JSON.parse(localStorage.getItem('sussurro-options') || '{}')); }
    catch { return { ...DEFAULT_OPTIONS }; }
  });
  const [outputs, setOutputs] = useState<Device[]>([]), [inputs, setInputs] = useState<Device[]>([]);
  const [history, setHistory] = useState<SessionSummary[]>([]), [opened, setOpened] = useState<Session | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [devicesBusy, setDevicesBusy] = useState(false);
  const controls = useRef<HTMLDivElement>(null);
  const primaryControl = useRef<HTMLButtonElement>(null);
  const transcriptHeading = useRef<HTMLHeadingElement>(null);
  const previousPhase = useRef(state.phase);
  const actionsPending = useRef(0);
  const [cancelPending, setCancelPending] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [credential, setCredential] = useState<CredentialStatus | null>(null);
  const credentialDialog = useRef<HTMLDialogElement>(null);
  const historyDialog = useRef<HTMLDialogElement>(null);
  const [credentialError, setCredentialError] = useState('');
  const keyInput = useRef<HTMLInputElement>(null);
  const persistInput = useRef<HTMLInputElement>(null);
  const microphone = useRef(new Microphone());
  const live = ['preparing', 'capturing', 'paused', 'draining'].includes(state.phase);
  const editableSources = ['capturing', 'paused'].includes(state.phase);
  const selected = live ? state.options : options;
  const displayed = opened?.segments || state.segments;
  const displayedId = opened?.id || state.sessionId;
  const systemAvailable = outputs.some((item) => item.id === selected.systemId);
  const blocker = startBlocker(selected, ready, credential?.configured, systemAvailable);
  const empty = emptyTranscript(state, blocker, !!opened);
  const sourceLocked = busy || devicesBusy || (live && !editableSources);
  function openCredentials() { setCredentialError(''); credentialDialog.current?.showModal(); }
  function sourceStatus(source: 'microphone' | 'system'): string {
    if (!selected[source]) return 'Desativado';
    if (state.phase === 'capturing') return 'Capturando · envio à nuvem';
    if (state.phase === 'paused') return 'Pausado · sem envio';
    if (state.phase === 'preparing') return 'Preparando · sem captura';
    return 'Habilitado · sem captura';
  }
  async function devices() {
    setDevicesBusy(true);
    setError('');
    try {
      const [systemResult, mediaResult] = await Promise.allSettled([api.listSystemDevices(), navigator.mediaDevices.enumerateDevices()]);
      if (systemResult.status === 'fulfilled') {
        const system = systemResult.value;
        setOutputs(system);
        setOptions((old) => ({ ...old, systemId: old.systemId || system[0]?.id || '' }));
      } else { setOutputs([]); setError('Não foi possível listar saídas de áudio. O microfone pode ser testado separadamente.'); }
      if (mediaResult.status === 'fulfilled') {
        setInputs(mediaResult.value.filter((item) => item.kind === 'audioinput').map((item, index) => ({ id: item.deviceId || 'default', label: item.label || `Microfone ${index + 1}` })));
      } else { setInputs([]); setError('Não foi possível listar microfones. Verifique as permissões de áudio.'); }
    } catch { setError('Não foi possível atualizar os dispositivos. Tente novamente.'); }
    finally { setDevicesBusy(false); }
  }
  const refreshHistory = () => api.listSessions().then(setHistory).catch(() => setError('Não foi possível ler o histórico.'));
  async function openHistory() {
    await action(async () => {
      setHistory(await api.listSessions());
      historyDialog.current?.showModal();
    });
  }
  useEffect(() => {
    if (!api) { setError('A ponte desktop não está disponível. Abra o Sussurro pelo aplicativo.'); return; }
    const unsubscribe = api.onState(setState);
    void api.getState().then((value) => { setState(value); setReady(true); }).catch((e) => setError(String(e)));
    void api.getCredentialStatus().then(setCredential).catch(() => setError('Não foi possível consultar a configuração da chave.'));
    void devices(); void refreshHistory(); return unsubscribe;
  }, []);
  useEffect(() => { try { localStorage.setItem('sussurro-options', JSON.stringify(options)); } catch { setError('Não foi possível salvar as preferências. Elas valerão somente nesta janela.'); } }, [options]);
  useEffect(() => { if (state.phase === 'completed' || state.phase === 'error') void refreshHistory(); }, [state.phase]);
  useEffect(() => {
    if (state.phase !== 'capturing' || !state.options.microphone || !state.sessionId || !state.microphoneCaptureId) { void microphone.current.stop(); setMicLevel(0); return; }
    let active = true;
    const captureId = state.microphoneCaptureId;
    void microphone.current.start(api, state.sessionId, captureId, state.options.microphoneId, setMicLevel).catch((e) => {
      if (!active) return;
      const message = e instanceof Error ? e.message : 'Falha no microfone.';
      setError(message); api.reportCaptureError(`Microfone: ${message}`, captureId);
    });
    return () => { active = false; void microphone.current.stop(); setMicLevel(0); };
  }, [state.phase, state.sessionId, state.options.microphone, state.options.microphoneId, state.microphoneCaptureId]);
  useEffect(() => {
    if (busy || previousPhase.current === state.phase) return;
    previousPhase.current = state.phase;
    const focused = document.activeElement;
    if (!credentialDialog.current?.open && (focused === document.body || (focused && controls.current?.contains(focused)))) primaryControl.current?.focus();
  }, [state.phase, busy]);
  async function action(work: () => Promise<unknown>) {
    actionsPending.current++; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { actionsPending.current--; setBusy(actionsPending.current > 0); }
  }
  async function changeSource(patch: Partial<Pick<StartOptions, 'microphone' | 'system' | 'microphoneId' | 'systemId'>>) {
    const next = { ...selected, ...patch };
    if (editableSources) {
      await api.setSources({ microphone: next.microphone, system: next.system, microphoneId: next.microphoneId, systemId: next.systemId });
      setState(await api.getState());
    }
    setOptions((old) => ({ ...old, ...patch }));
  }

  return <main className="app-shell">
    <a className="skip-link" href="#transcript-title">Ir para a transcrição</a>
    <header className="topbar"><a className="brand" href="#transcript-title" aria-label="Sussurro, ir para a transcrição"><svg className="brand-mark" viewBox="0 0 44 44" fill="none" aria-hidden="true" focusable="false"><path d="M4 19v6M10 13v18M16 8v28M22 4v36M28 11v22M34 16v12M40 20v4" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" /></svg><span>Sussurro</span></a><div className="topbar-actions"><span className={`privacy ${state.phase === 'capturing' ? 'is-capturing' : ''}`}><span aria-hidden="true">●</span> {state.phase === 'capturing' ? 'Captura em andamento' : 'Sem captura ativa'}</span><button type="button" disabled={!api || busy} onClick={() => void openHistory()}>Histórico</button><button type="button" disabled={!ready || live || busy} onClick={openCredentials}>Configurar API key</button></div></header>
    {error && <div className="alert" role="alert">{error}{api && (!ready || !credential) && <button type="button" disabled={busy} onClick={() => void action(async () => { const [value, status] = await Promise.all([api.getState(), api.getCredentialStatus()]); setState(value); setReady(true); setCredential(status); })}>Tentar novamente</button>}<button className="text-button" onClick={() => setError('')} aria-label="Fechar aviso">×</button></div>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <dialog ref={credentialDialog} className="credential-dialog" aria-labelledby="provider-title" aria-describedby="credential-priority" onClose={(event) => { event.currentTarget.querySelector('form')?.reset(); setCredentialError(''); }}>
      <div className="workspace-heading"><h2 id="provider-title">Configurar API key</h2><button type="button" className="text-button" aria-label="Fechar configuração" onClick={() => credentialDialog.current?.close()}>×</button></div>
      <div className="credential-dialog-body">
        <p role="status">{credential?.configured ? 'Chave configurada.' : 'Nenhuma chave configurada.'} {credential?.message}</p>
        <p id="credential-priority" className="hint">Se a chave já está nas variáveis de ambiente ou no .env, você não precisa preencher este campo. Uma nova chave vale nesta execução, sem alterar esses arquivos. Ao reiniciar, a variável ou o .env volta a ter prioridade sobre a chave salva no chaveiro.</p>
        {credentialError && <p className="alert" role="alert">{credentialError}</p>}
        <form onSubmit={(event) => {
          event.preventDefault();
          const input = keyInput.current;
          const key = input?.value || '';
          const persist = persistInput.current?.checked === true;
          if (input) input.value = '';
          setBusy(true); setCredentialError('');
          void api.configureCredential({ key, persist }).then((status) => {
            setCredential(status); credentialDialog.current?.close(); setNotice('Chave configurada.');
          }).catch(() => setCredentialError('Não foi possível configurar a chave. Confira o valor e o chaveiro do sistema.')).finally(() => setBusy(false));
        }}>
          <label className="credential-field">Chave de API <input ref={keyInput} type="password" autoComplete="off" spellCheck={false} maxLength={512} disabled={live || busy} required /></label>
          <label className="credential-persist"><input ref={persistInput} type="checkbox" disabled={live || busy || !credential?.canPersist} /> Salvar protegida no chaveiro do sistema</label>
          <p className="hint">Remover limpa a memória e o arquivo protegido. Para impedir a carga no próximo início, retire também a chave das variáveis ou do .env.</p>
          <div className="credential-actions">
            <button type="button" className="text-button danger" disabled={live || busy} onClick={() => {
              if (keyInput.current) keyInput.current.value = '';
              setBusy(true); setCredentialError('');
              void api.removeCredential().then((status) => {
                setCredential(status); credentialDialog.current?.close(); setNotice('Chave removida.');
              }).catch(async () => {
                setCredentialError('Não foi possível concluir a remoção da chave. Confira as permissões do arquivo protegido.');
                await api.getCredentialStatus().then(setCredential).catch(() => {});
              }).finally(() => setBusy(false));
            }}>Remover chave</button>
            <button type="button" onClick={() => credentialDialog.current?.close()}>Cancelar</button>
            <button type="submit" className="primary" disabled={live || busy}>{busy ? 'Aguarde…' : 'Aplicar chave'}</button>
          </div>
        </form>
      </div>
    </dialog>
    <dialog ref={historyDialog} className="history-dialog" aria-labelledby="history-title">
      <div className="workspace-heading"><h2 id="history-title">Histórico de transcrições</h2><button type="button" className="text-button" aria-label="Fechar histórico" onClick={() => historyDialog.current?.close()}>Fechar</button></div>
      <div className="history-list" aria-live="polite">
        {!history.length && <p className="hint history-empty">Nenhum arquivo TXT salvo está disponível no histórico. Transcrições sem arquivo ou cujo arquivo foi removido não aparecem aqui.</p>}
        {history.map((s) => <div className="history-row" key={s.id}><button className="history-open" disabled={busy || live} onClick={() => void action(async () => { const session = await api.readSession(s.id); setOpened(session); historyDialog.current?.close(); requestAnimationFrame(() => transcriptHeading.current?.focus()); })}>{new Date(s.createdAt).toLocaleString('pt-BR')}<small>{s.count} trechos · {['capturing', 'paused', 'preparing', 'draining'].includes(s.status) ? 'Em andamento ou interrompida' : phases[s.status]}</small></button><button className="text-button danger" aria-label={`Excluir ${new Date(s.createdAt).toLocaleString('pt-BR')} do histórico`} disabled={busy || live && state.sessionId === s.id} onClick={() => { if (confirm('Excluir esta transcrição salva do histórico? O arquivo TXT escolhido permanece no disco.')) void action(async () => { await api.deleteSession(s.id); if (opened?.id === s.id) setOpened(null); await refreshHistory(); }); }}>Excluir</button></div>)}
      </div>
    </dialog>
    <div className="layout">
      <section className="workspace sources" aria-labelledby="sources-title">
        <div className="workspace-heading"><h2 id="sources-title">Fontes de áudio</h2><button className="text-button" disabled={sourceLocked} onClick={() => void devices()}>{devicesBusy ? 'Atualizando…' : 'Atualizar'}</button></div>
        <div className="source-card"><label className="toggle"><span>Microfone</span><input type="checkbox" role="switch" checked={selected.microphone} disabled={sourceLocked} onChange={(e) => void action(() => changeSource({ microphone: e.target.checked }))} /></label>
          <select aria-label="Microfone" value={selected.microphoneId} disabled={sourceLocked} onChange={(e) => void action(() => changeSource({ microphoneId: e.target.value }))}><option value="default">Microfone padrão</option>{selected.microphoneId !== 'default' && !inputs.some((d) => d.id === selected.microphoneId) && <option value={selected.microphoneId}>Microfone selecionado · ausente da lista</option>}{inputs.filter((d) => d.id !== 'default').map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select><p className={`capture-state ${state.phase === 'capturing' && selected.microphone ? 'active' : ''}`} role="status">{sourceStatus('microphone')}</p><meter aria-label="Nível do microfone" min={0} max={0.2} value={micLevel} />
        </div>
        <div className="source-card"><label className="toggle"><span>Áudio do computador</span><input type="checkbox" role="switch" checked={selected.system} disabled={sourceLocked || (!outputs.length && !selected.system)} onChange={(e) => void action(() => changeSource({ system: e.target.checked }))} /></label>
          <select aria-label="Saída de áudio do computador" value={selected.systemId} disabled={sourceLocked || !outputs.length} onChange={(e) => void action(() => changeSource({ systemId: e.target.value }))}>{selected.systemId && !outputs.some((d) => d.id === selected.systemId) && <option value={selected.systemId}>Saída selecionada · ausente da lista</option>}{!selected.systemId && <option value="">Selecione uma saída</option>}{outputs.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select><p className={`capture-state ${state.phase === 'capturing' && selected.system ? 'active' : ''}`} role="status">{sourceStatus('system')}</p><meter aria-label="Nível do computador" min={0} max={0.2} value={state.levels.system} />{selected.system && !systemAvailable && <p className="hint device-warning">Saída indisponível. Atualize a lista e selecione um dispositivo.</p>}</div>
        <div className="settings"><label>Destino da transcrição<select value={selected.persistence || 'saved'} disabled={busy || live} onChange={(e) => setOptions({ ...options, persistence: e.target.value as 'saved' | 'temporary' })}>
          <option value="saved">Salvar transcrição</option><option value="temporary">Sem histórico</option>
        </select></label>
          <p className="hint">{selected.persistence === 'temporary' ? 'Texto apenas nesta janela, sem salvamento automático ou histórico. Ao fechar ou iniciar outra transcrição, o texto será descartado. Você pode copiar ou exportar manualmente.' : 'Ao iniciar, escolha onde salvar o TXT. O texto confirmado é salvo automaticamente durante a transcrição, ao pausar, finalizar e fechar. Também fica no histórico local.'}</p>
        </div>
        <div className="settings"><label>Idioma do áudio<select value={selected.language} disabled={busy || live} onChange={(e) => setOptions({ ...options, language: e.target.value })}>{languageOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          </div>
      </section>
      <section className="workspace transcript" aria-labelledby="transcript-title">
        <div className="workspace-heading"><div><h2 id="transcript-title" ref={transcriptHeading} tabIndex={-1}>{opened ? 'Sessão salva' : 'Transcrição'}</h2><p className="section-caption">{opened ? `${new Date(opened.createdAt).toLocaleString('pt-BR')} · ${languageLabel(opened.options.language)}` : `${languageLabel(selected.language)} · Texto no idioma original`}</p></div>
        <div className="controls" ref={controls} role="group" aria-label="Controles da sessão">
          {(live || opened || state.phase === 'error') && <span className={`status phase-${opened?.status || state.phase}`}>{phases[opened?.status || state.phase]}</span>}
          {!live && <button ref={primaryControl} className="primary" data-testid="start" disabled={busy || devicesBusy || !!blocker} aria-describedby="start-reason" onClick={() => void action(async () => { const next = await api.start(options); setState(next); if (next.sessionId !== state.sessionId) setOpened(null); })}>{busy ? 'Aguarde…' : state.sessionId ? 'Nova transcrição' : 'Iniciar transcrição'}</button>}
          {state.phase === 'preparing' && <span className="operation-label" role="status">Conectando às fontes habilitadas…</span>}
          {state.phase === 'capturing' && <button ref={primaryControl} className="primary" disabled={busy} onClick={() => void action(() => api.pause())}>Pausar captura</button>}
          {state.phase === 'paused' && <button ref={primaryControl} className="primary" disabled={busy || !selected.microphone && !selected.system || selected.system && !systemAvailable} onClick={() => void action(() => api.resume())}>Retomar captura</button>}
          {live && <button disabled={state.phase === 'draining' || busy && state.phase !== 'preparing'} onClick={() => void action(() => api.stop(false))}>Finalizar</button>}
          {live && <button className="text-button danger" disabled={cancelPending || busy && state.phase !== 'preparing' && state.phase !== 'draining'} onClick={() => {
            if (confirm('Cancelar o áudio ainda não transcrito? O texto confirmado será preservado.')) {
              setCancelPending(true);
              void action(() => api.stop(true)).finally(() => setCancelPending(false));
            }
          }}>{state.phase === 'preparing' ? 'Cancelar conexão' : 'Cancelar pendências'}</button>}
          {opened && <button className="text-button" onClick={() => { setOpened(null); requestAnimationFrame(() => transcriptHeading.current?.focus()); }}>Voltar à sessão atual</button>}
        </div>
        </div>
        {!live && <div className="start-guidance" id="start-reason">{blocker || (devicesBusy ? 'Atualizando dispositivos…' : 'Pronto para iniciar. A captura começa somente ao clicar.')} {credential?.configured === false && <button type="button" className="text-button" disabled={busy} onClick={openCredentials}>Configurar API key</button>}</div>}
        {!opened && <>
          {state.sessionId && <p className="start-guidance" role="status">{state.options.persistence === 'temporary' ? 'Sem histórico · texto somente nesta janela; nada é salvo automaticamente.' : `Salvamento automático em: ${state.savePath || 'histórico local'}`}</p>}
          <p className={`session-message ${state.phase === 'paused' || state.phase === 'error' ? 'needs-attention' : ''}`} role="status">{state.message}</p>
          {state.phase === 'paused' && (!selected.microphone && !selected.system || selected.system && !systemAvailable) && <p className="start-guidance">Ative uma fonte disponível antes de retomar.</p>}
          <dl className="metrics"><div><dt>Duração da sessão</dt><dd>{time(state.elapsedMs)}</dd></div><div><dt>Áudio pendente</dt><dd>{state.pendingSeconds.toFixed(1)} s</dd></div><div><dt>Lacunas indicadas</dt><dd>{state.audioGapCount}</dd></div><div><dt>Atraso do último trecho</dt><dd>{state.segments.length ? `${state.lagSeconds.toFixed(1)} s` : '—'}</dd></div></dl>
        </>}
        <Transcript key={displayedId || 'empty'} segments={displayed} partials={opened ? undefined : state.partials} empty={empty} historical={!!opened} />
        <div className="transcript-actions"><span className="hint">{opened ? `${displayed.length} trechos salvos` : state.options.persistence === 'temporary' ? 'Sem histórico · copie ou exporte se quiser guardar' : 'Até 200 trechos recentes · cópia e exportação incluem a sessão completa'}</span><div><button disabled={!displayedId || !displayed.length || busy} onClick={() => displayedId && void action(async () => { await api.copySession(displayedId); setNotice('Transcrição copiada.'); })}>Copiar</button><button disabled={!displayedId || !displayed.length || busy} onClick={() => displayedId && void action(async () => { if (await api.exportSession(displayedId)) setNotice('Arquivo TXT exportado.'); })}>Exportar TXT</button></div></div>
      </section>
    </div>
    <footer><span>Processamento na nuvem durante a captura. Histórico de texto neste computador.</span></footer>
  </main>;
}
