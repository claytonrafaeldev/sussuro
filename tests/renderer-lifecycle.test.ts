import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { expect, it, vi } from 'vitest';
import { guardRenderer } from '../src/main/renderer-lifecycle';

it('revokes capture for reload/crash/hang, ignores fragments and subframes, and removes listeners on shutdown', () => {
  const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter() });
  const backend = { rendererUnavailable: vi.fn(), rendererReady: vi.fn() };
  const unguard = guardRenderer(window as unknown as BrowserWindow, backend);
  window.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  expect(backend.rendererUnavailable).not.toHaveBeenCalled();
  window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed' }); window.emit('unresponsive');
  expect(backend.rendererUnavailable).toHaveBeenCalledTimes(3);
  window.webContents.emit('did-finish-load'); expect(backend.rendererReady).toHaveBeenCalledOnce();
  unguard(); window.webContents.emit('render-process-gone'); window.emit('unresponsive');
  expect(backend.rendererUnavailable).toHaveBeenCalledTimes(3);
  expect(window.webContents.eventNames()).toEqual([]); expect(window.eventNames()).toEqual([]);
});
