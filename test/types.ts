/** Compile-only assertions for the public recording wire contract. */
import type { ElementState, RecorderEvent, RecorderSend, SerializedNode, SnapshotPayload, InputPayload } from '../src/shared/contracts/recording';

declare const send: RecorderSend;
declare const snapshot: SnapshotPayload;
declare const input: InputPayload;
send('dom.snapshot', snapshot);
send('action.input', input);
// @ts-expect-error Input events must carry form data, not a snapshot payload.
send('action.input', snapshot);
// @ts-expect-error Snapshot events must carry the complete snapshot contract.
send('dom.snapshot', input);
// @ts-expect-error Unknown event names cannot silently enter the recorder protocol.
send('action.unknown', input);

function verifyEventNarrowing(event: RecorderEvent): void {
  if (event.type === 'dom.snapshot') {
    void event.payload.tree;
    // @ts-expect-error A snapshot is not an input event.
    void event.payload.form;
  }
  if (event.type === 'action.input') {
    void event.payload.form.value;
    // @ts-expect-error A form input does not carry a DOM tree.
    void event.payload.tree;
  }
}
function verifyNodeNarrowing(node: SerializedNode): void {
  if (node.nodeType === 1) {
    void node.attributes;
    // @ts-expect-error Serialized element nodes do not have a text-node value.
    void node.text;
  }
  if (node.nodeType === 3) {
    void node.text;
    // @ts-expect-error Serialized text nodes cannot have element attributes.
    void node.attributes;
  }
}
// @ts-expect-error Optional properties may be absent, but explicitly undefined is invalid.
const invalidState: ElementState = { checked: undefined };
// @ts-expect-error Element nodes require attributes and namespace metadata.
const incompleteElement: SerializedNode = { nodeId: 'n1', nodeName: 'INPUT', nodeType: 1 };
void verifyEventNarrowing; void verifyNodeNarrowing; void invalidState; void incompleteElement;

import type { ExportWorkerData, ExportWorkerSend, ExportWorkerCommandSend, ExportResult } from '../src/shared/contracts/export';
declare const workerSend: ExportWorkerSend;
declare const workerCommand: ExportWorkerCommandSend;
declare const workerData: ExportWorkerData;
declare const exportResult: ExportResult;
workerSend({type:'progress', progress:{phase:'archive', bytesRead:42}});
workerSend({type:'result', result:exportResult});
workerCommand({type:'cancel'});
// @ts-expect-error Worker progress must carry numeric counters.
workerSend({type:'progress', progress:{phase:'archive', bytesRead:'42'}});
// @ts-expect-error A worker result must contain the complete export result contract.
workerSend({type:'result', result:{path:'recording.zip'}});
// @ts-expect-error A command sent to the worker cannot contain a worker reply.
workerCommand({type:'progress', progress:{phase:'archive'}});
// @ts-expect-error Worker startup data cannot transfer host callbacks through structured clone.
const invalidWorkerData = {...workerData, onProgress: () => {}} satisfies ExportWorkerData;
void invalidWorkerData;

import type { ApplicationEventSink } from '../src/shared/contracts/application';
import type { NetworkResponsePayload, ConsoleMessagePayload } from '../src/shared/contracts/network';
declare const appSink: ApplicationEventSink;
declare const networkResponse: NetworkResponsePayload;
declare const consoleMessage: ConsoleMessagePayload;
appSink('network.response', networkResponse);
appSink('console.message', consoleMessage);
// @ts-expect-error A console message is not a network response.
appSink('network.response', consoleMessage);
// @ts-expect-error Console levels are a closed set.
const invalidLevel: ConsoleMessagePayload = { level: 'fatal', method: 'log', text: '' };
// @ts-expect-error Optional network fields cannot be explicitly undefined.
const invalidBody: Pick<NetworkResponsePayload, 'body'> = { body: undefined };
void invalidLevel; void invalidBody;
