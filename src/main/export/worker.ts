import type { ExportWorkerSend } from '../../shared/contracts/export';
import { errorOf } from '../storage/values';
import { parentPort, workerData } from 'node:worker_threads';
import { runPreparedExport } from './pipeline';
import { readWorkerCommand, readWorkerData } from './messages';

if (!parentPort) throw new Error('导出必须运行在工作线程');
const port = parentPort;
const send: ExportWorkerSend = message => port.postMessage(message);
const prepared = readWorkerData(workerData as unknown);
const controller = new AbortController();
port.on('message', (value: unknown) => {
  try {
    const command = readWorkerCommand(value);
    if (command.type === 'cancel') controller.abort();
  } catch (caught) {
    const error = errorOf(caught);
    send({type:'error', error:{name:error.name, message:error.message, stack:error.stack}});
    controller.abort();
  }
});
let lastProgress = 0;
let lastPhase = '';
runPreparedExport({ ...prepared, signal: controller.signal, onProgress(progress) {
  const now = Date.now();
  if (progress.phase !== lastPhase || now - lastProgress >= 60 || progress.phase === 'complete') {
    send({ type: 'progress', progress }); lastProgress = now; lastPhase = progress.phase;
  }
} }).then(result => send({ type: 'result', result }), caught => {
  const error = errorOf(caught);
  send({ type: 'error', error: { name: error.name, message: error.message, stack: error.stack } });
}).finally(() => port.close());
