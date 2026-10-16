import { expect, it } from 'vitest';
import { inspectOutputGraph, outputProcessReleased } from '../src/main/audio/graph';

const object = (type: string, id: number | string, props: Record<string, unknown>, extra = {}) => ({ id, type: `PipeWire:Interface:${type}`, info: { props, ...extra } });
// Synthetic topology: PID belongs to a Client; its capture Node references client.id.
function graph() {
  return [
    object('Node', 10, { 'node.name': 'chosen-output', 'media.class': 'Audio/Sink' }),
    object('Node', 20, { 'node.name': 'microphone', 'media.class': 'Audio/Source' }),
    object('Client', 30, { 'application.process.id': 1234, 'application.name': 'private application' }),
    object('Node', 40, { 'client.id': 30, 'media.class': 'Stream/Input/Audio' }),
    object('Port', 50, { 'node.id': 10, 'port.monitor': true, 'port.direction': 'out' }),
    object('Port', 51, { 'node.id': 20, 'port.direction': 'out' }),
    object('Link', 60, {}, { 'output-node-id': 10, 'output-port-id': 50, 'input-node-id': 40, state: 'active' }),
  ];
}
it('identifies capture via Client PID and node client.id without requiring PID on Node', () => {
  expect(inspectOutputGraph(graph(), 1234, 'chosen-output')).toMatchObject({ selectedMonitorOnly: true, processClients: 1, processNodes: 1, inputLinks: 1, reason: 'verified' });
});
it('accepts direct node PID and normalizes numeric string IDs without matching missing IDs', () => {
  const data = JSON.parse(JSON.stringify(graph()), (key, value) =>
    ['id', 'client.id', 'node.id', 'output-node-id', 'input-node-id', 'output-port-id', 'application.process.id'].includes(key) ? String(value) : value);
  data[2].info.props['application.process.id'] = 999;
  data[3].info.props['application.process.id'] = '1234';
  expect(inspectOutputGraph(data, 1234, 'chosen-output').selectedMonitorOnly).toBe(true);
  expect(inspectOutputGraph(data, 5678, 'chosen-output').reason).toBe('process-node-missing');
});
it('rejects microphone links even alongside a valid output monitor link', () => {
  const data = graph();
  data.push(object('Link', 61, {}, { 'output-node-id': 20, 'output-port-id': 51, 'input-node-id': 40 }));
  expect(inspectOutputGraph(data, 1234, 'chosen-output')).toMatchObject({ selectedMonitorOnly: false, reason: 'unexpected-source', unexpectedLinks: 1, monitorLinks: 1 });
});
it.each(['missing', 'not-monitor', 'wrong-owner', 'wrong-direction', 'link-error'])('rejects %s port evidence', (failure) => {
  const data = graph();
  if (failure === 'missing') data.splice(4, 1);
  else if (failure === 'not-monitor') data[4].info.props['port.monitor'] = false;
  else if (failure === 'wrong-owner') data[4].info.props['node.id'] = 20;
  else if (failure === 'wrong-direction') data[4].info.props['port.direction'] = 'in';
  else Object.assign(data[6].info, { state: 'error' });
  expect(inspectOutputGraph(data, 1234, 'chosen-output')).toMatchObject({ selectedMonitorOnly: false, reason: 'unverified-port' });
});
it('distinguishes missing sink, missing process and missing links without exposing inventory', () => {
  expect(inspectOutputGraph(graph(), 1234, 'absent').reason).toBe('output-missing');
  expect(inspectOutputGraph(graph(), 4321, 'chosen-output').reason).toBe('process-node-missing');
  expect(inspectOutputGraph(graph().slice(0, -1), 1234, 'chosen-output').reason).toBe('input-links-missing');
  expect(JSON.stringify(inspectOutputGraph(graph(), 1234, 'chosen-output'))).not.toMatch(/private application|chosen-output|1234|microphone/);
});
it('checks release using Client ownership and does not accept stale nodes with absent PID on Node', () => {
  expect(outputProcessReleased(graph(), 1234)).toBe(false);
  expect(outputProcessReleased(graph().filter((item) => ![30, 40, 60].includes(Number(item.id))), 1234)).toBe(true);
  expect(outputProcessReleased([object('Node', 40, { 'application.process.id': 1234 })], 1234)).toBe(false);
  expect(outputProcessReleased([object('Client', 30, { 'application.process.id': 1234 })], 1234)).toBe(false);
});
it.each([null, {}, [null, {}, { info: null }]])('fails safely for incomplete inventory %j', (inventory) => {
  expect(inspectOutputGraph(inventory, 1234, 'chosen-output').selectedMonitorOnly).toBe(false);
});
it.each([0, -1, NaN, Infinity])('does not identify an unknown process for invalid PID %s', (pid) => {
  expect(inspectOutputGraph(graph(), pid, 'chosen-output').reason).toBe('invalid-inventory');
  expect(outputProcessReleased([], pid)).toBe(false);
});
