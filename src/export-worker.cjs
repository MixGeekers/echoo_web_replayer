'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { runPreparedExport } = require('./exporter.cjs');
const controller = new AbortController();
parentPort.on('message', message => { if (message?.type === 'cancel') controller.abort(); });
let lastProgress = 0;
let lastPhase = '';
runPreparedExport({ ...workerData, signal: controller.signal, onProgress(progress) {
  const now = Date.now();
  if (progress.phase !== lastPhase || now - lastProgress >= 60 || progress.phase === 'complete') {
    parentPort.postMessage({ type: 'progress', progress }); lastProgress = now; lastPhase = progress.phase;
  }
} }).then(result => parentPort.postMessage({ type: 'result', result }), error => {
  parentPort.postMessage({ type: 'error', error: { name: error.name, message: error.message, stack: error.stack } });
}).finally(() => parentPort.close());
