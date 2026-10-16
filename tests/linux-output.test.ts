import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', () => {
  Object.defineProperty(controls.execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (...args: unknown[]) => new Promise((resolve, reject) => {
      controls.execFile(...args, (error: Error | null, stdout: string) => error ? reject(error) : resolve({ stdout, stderr: '' }));
    }),
  });
  return controls;
});
import { LinuxOutput, systemDevices } from '../src/main/audio/linux';

class FakeChild extends EventEmitter {
  pid: number | undefined = 123;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new PassThrough();
  close(signal = 'SIGTERM') { this.signalCode = signal; this.emit('exit', null, signal); this.emit('close', null, signal); }
  kill = vi.fn((signal: string) => { this.close(signal); return true; });
}
const sink = { info: { props: { 'media.class': 'Audio/Sink', 'node.name': 'selected-output', 'node.description': 'Saída sintética' } } };
let output: LinuxOutput, children: FakeChild[];
let enumerate: (callback: (error: Error | null, value?: string) => void) => void;
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers(); controls.execFile.mockReset(); controls.spawn.mockReset(); children = [];
  enumerate = (callback) => callback(null, JSON.stringify([sink]));
  controls.execFile.mockImplementation((_file, _args, _options, callback) => { enumerate(callback); });
  controls.spawn.mockImplementation(() => { const child = new FakeChild(); children.push(child); return child; });
  output = new LinuxOutput();
});
afterEach(async () => { await output.stop(); vi.useRealTimers(); });

it('enumerates only distinct explicit sinks and sanitizes inventory errors', async () => {
  enumerate = (callback) => callback(null, JSON.stringify([sink, sink, null, { info: { props: { 'media.class': 'Audio/Source', 'node.name': 'microphone' } } },
    { info: { props: { 'media.class': 'Audio/Sink', 'node.name': 'auto' } } }]));
  expect(await systemDevices()).toEqual([{ id: 'selected-output', label: 'Saída sintética' }]);
  enumerate = (callback) => callback(new Error('sensitive stderr'));
  await expect(systemDevices()).rejects.toThrow('Não foi possível consultar PipeWire');
  enumerate = (callback) => callback(null, '{}');
  await expect(systemDevices()).rejects.toThrow('Não foi possível consultar PipeWire');
});
it('rejects missing outputs without spawning or selecting a microphone', async () => {
  await expect(output.start('auto', vi.fn(), vi.fn())).rejects.toThrow('indisponível');
  expect(controls.spawn).not.toHaveBeenCalled();
});
it('uses the explicit monitor and emits intact fixed PCM frames across odd reads', async () => {
  const receive = vi.fn(), fail = vi.fn();
  await output.start('selected-output', receive, fail);
  const [command, args, options] = controls.spawn.mock.calls[0];
  expect(command).toBe('pw-record'); expect(options.shell).toBe(false);
  expect(args.slice(0, 2)).toEqual(['--target', 'selected-output']);
  expect(JSON.parse(args[3])).toMatchObject({ 'stream.capture.sink': true, 'node.dont-fallback': true, 'node.dont-reconnect': true });
  const pcm = Buffer.alloc(6401); for (let i = 0; i < pcm.length; i++) pcm[i] = i % 251;
  children[0].stdout.emit('data', pcm.subarray(0, 1)); children[0].stdout.emit('data', pcm.subarray(1));
  expect(receive).toHaveBeenCalledTimes(2);
  expect(Buffer.from(receive.mock.calls[0][0])).toEqual(pcm.subarray(0, 3200));
  expect(Buffer.from(receive.mock.calls[1][0])).toEqual(pcm.subarray(3200, 6400));
  await output.stop(); children[0].stdout.emit('data', Buffer.alloc(6400));
  expect(receive).toHaveBeenCalledTimes(2); expect(fail).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0); expect(children[0].stdout.destroyed).toBe(true);
});
it('cancels enumeration and does not resurrect an older start', async () => {
  const callbacks: Array<(error: Error | null, value?: string) => void> = [];
  enumerate = (callback) => callbacks.push(callback);
  const first = output.start('selected-output', vi.fn(), vi.fn()); await tick();
  const firstSignal = controls.execFile.mock.calls[0][2].signal;
  const second = output.start('selected-output', vi.fn(), vi.fn()); await tick();
  expect(firstSignal.aborted).toBe(true);
  callbacks[1](null, JSON.stringify([sink])); await second;
  callbacks[0](new Error('aborted')); await first;
  expect(children).toHaveLength(1);
  await output.stop(); expect(vi.getTimerCount()).toBe(0);
});
it('does not spawn after stopping an in-flight enumeration', async () => {
  let done!: (error: Error | null, value?: string) => void;
  enumerate = (callback) => { done = callback; };
  const start = output.start('selected-output', vi.fn(), vi.fn()); await tick();
  await output.stop(); done(null, JSON.stringify([sink])); await start;
  expect(children).toHaveLength(0);
});
it.each(['startup', 'stalled', 'oversize', 'exit', 'spawn-error'])('stops on %s failure and reports only sanitized errors', async (failure) => {
  const fail = vi.fn(), receive = vi.fn(); await output.start('selected-output', receive, fail);
  const child = children[0];
  if (failure === 'stalled') child.stdout.emit('data', Buffer.alloc(3200));
  if (failure === 'oversize') child.stdout.emit('data', Buffer.alloc(256 * 1024 + 1));
  else if (failure === 'exit') child.close();
  else if (failure === 'spawn-error') { child.pid = undefined; child.emit('error', new Error('private')); child.close(); }
  else await vi.advanceTimersByTimeAsync(5000);
  await tick();
  expect(fail).toHaveBeenCalledOnce(); expect(JSON.stringify(fail.mock.calls)).not.toContain('private');
  expect(child.stdout.destroyed).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it('discards the rest of a read when the owner stops on the first frame', async () => {
  const receive = vi.fn(() => { void output.stop(); });
  await output.start('selected-output', receive, vi.fn());
  children[0].stdout.emit('data', Buffer.alloc(64000)); await tick();
  expect(receive).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('waits for confirmed close after SIGKILL and blocks replacement until then', async () => {
  await output.start('selected-output', vi.fn(), vi.fn());
  const child = children[0]; child.kill.mockImplementation(() => true);
  const stopped = vi.fn(), stop = output.stop().then(stopped); await tick();
  const start = output.start('selected-output', vi.fn(), vi.fn()); await tick();
  expect(children).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  expect(stopped).not.toHaveBeenCalled();
  child.close('SIGKILL'); await stop; await start;
  expect(children).toHaveLength(2);
  await output.stop(); expect(vi.getTimerCount()).toBe(0);
});
