/** Inspect only the selected output and the capture process. Never return raw inventory. */
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const info = (object: unknown) => record(record(object).info);
const props = (object: unknown) => record(info(object).props);
const type = (object: unknown, name: string) => record(object).type === `PipeWire:Interface:${name}`;
function id(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number < 0xffffffff ? number : null;
}
const objectId = (object: unknown) => id(record(object).id);
const samePid = (value: unknown, pid: number) => id(value) === pid;

function ownedObjects(objects: unknown[], pid: number) {
  // PipeWire publishes process properties on Client. Nodes usually point to it
  // through client.id instead of repeating application.process.id themselves.
  const clients = objects.filter((object) => type(object, 'Client') && samePid(props(object)['application.process.id'], pid));
  const clientIds = new Set(clients.map(objectId).filter((value) => value !== null));
  const nodes = objects.filter((object) => type(object, 'Node') &&
    (samePid(props(object)['application.process.id'], pid) || clientIds.has(id(props(object)['client.id'])!)));
  return { clients, nodes };
}

export interface OutputGraphInspection {
  selectedOutputFound: boolean;
  processClients: number;
  processNodes: number;
  inputLinks: number;
  monitorLinks: number;
  unexpectedLinks: number;
  unverifiedLinks: number;
  selectedMonitorOnly: boolean;
  reason: 'invalid-inventory' | 'output-missing' | 'process-node-missing' | 'input-links-missing' | 'unexpected-source' | 'unverified-port' | 'verified';
}

export function inspectOutputGraph(inventory: unknown, pid: number, selectedId: string): OutputGraphInspection {
  const result: OutputGraphInspection = { selectedOutputFound: false, processClients: 0, processNodes: 0,
    inputLinks: 0, monitorLinks: 0, unexpectedLinks: 0, unverifiedLinks: 0, selectedMonitorOnly: false, reason: 'invalid-inventory' };
  if (!Array.isArray(inventory) || !Number.isSafeInteger(pid) || pid <= 0) return result;
  const { clients, nodes } = ownedObjects(inventory, pid);
  result.processClients = clients.length; result.processNodes = nodes.length;
  const sinks = inventory.filter((object) => type(object, 'Node') && props(object)['media.class'] === 'Audio/Sink' && props(object)['node.name'] === selectedId);
  const sinkId = sinks.length === 1 ? objectId(sinks[0]) : null;
  result.selectedOutputFound = sinkId !== null;
  if (sinkId === null) { result.reason = 'output-missing'; return result; }
  const nodeIds = new Set(nodes.map(objectId).filter((value) => value !== null));
  if (!nodeIds.size) { result.reason = 'process-node-missing'; return result; }
  const ports = new Map(inventory.filter((object) => type(object, 'Port') && objectId(object) !== null).map((object) => [objectId(object), object]));
  const links = inventory.filter((object) => type(object, 'Link') && nodeIds.has(id(info(object)['input-node-id'])!));
  result.inputLinks = links.length;
  for (const link of links) {
    const details = info(link);
    if (id(details['output-node-id']) !== sinkId) { result.unexpectedLinks++; continue; }
    const portId = id(details['output-port-id']);
    const port = portId === null ? undefined : ports.get(portId);
    const properties = props(port);
    if (!port || id(properties['node.id']) !== sinkId ||
      !(properties['port.monitor'] === true || properties['port.monitor'] === 'true') ||
      details.state === 'error' || (properties['port.direction'] !== undefined && properties['port.direction'] !== 'out')) {
      result.unverifiedLinks++; continue;
    }
    result.monitorLinks++;
  }
  result.reason = !links.length ? 'input-links-missing' : result.unexpectedLinks ? 'unexpected-source' : result.unverifiedLinks ? 'unverified-port' : 'verified';
  result.selectedMonitorOnly = result.reason === 'verified';
  return result;
}

export function outputProcessReleased(inventory: unknown, pid: number): boolean {
  if (!Array.isArray(inventory) || !Number.isSafeInteger(pid) || pid <= 0) return false;
  const { clients, nodes } = ownedObjects(inventory, pid);
  return clients.length === 0 && nodes.length === 0;
}
