import type { AudioFrame, Device, Session, SessionSummary, StartOptions, SourceOptions, ViewState } from './contracts';

export interface RuntimeInfo {
  platform: string;
  electronVersion: string;
}

export interface CredentialStatus { configured: boolean; persisted: boolean; canPersist: boolean; message: string }

/** Limited desktop commands; credentials and arbitrary filesystem access are excluded. */
export interface SussurroApi {
  getRuntimeInfo(): RuntimeInfo;
  getState(): Promise<ViewState>;
  beginMeasurement(scenario: import('./performance').MeasurementScenario): Promise<void>;
  endMeasurement(): Promise<void>;
  exportMeasurement(): Promise<boolean>;
  getCredentialStatus(): Promise<CredentialStatus>;
  configureCredential(value: { key: string; persist: boolean }): Promise<CredentialStatus>;
  removeCredential(): Promise<CredentialStatus>;
  beginMicrophoneCheck(): Promise<void>;
  endMicrophoneCheck(): Promise<void>;
  listSystemDevices(): Promise<Device[]>;
  start(options: StartOptions): Promise<ViewState>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(cancel: boolean): Promise<void>;
  setSources(sources: SourceOptions): Promise<void>;
  sendAudio(frame: AudioFrame): Promise<boolean>;
  reportCaptureError(message: string, captureId: string): void;
  onState(callback: (state: ViewState) => void): () => void;
  listSessions(): Promise<SessionSummary[]>;
  readSession(id: string): Promise<Session>;
  deleteSession(id: string): Promise<void>;
  exportSession(id: string): Promise<boolean>;
  copySession(id: string): Promise<void>;
}
