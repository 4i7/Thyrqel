"use strict";
/** Copyright (c) 2020, Microsoft Corporation (MIT License).
 * Terminal Bridge lifecycle patch: drain to EOF, then close every worker-owned resource.
 */
const { parentPort, workerData } = require('worker_threads');
const { Socket, createServer } = require('net');
const { getWorkerPipeName } = require('../shared/conout');
const conoutSocket = new Socket();
const clients = new Set();
let server;
conoutSocket.setEncoding('utf8');
conoutSocket.connect(workerData.conoutPipeName, () => {
    server = createServer(client => {
        clients.add(client);
        client.on('close', () => clients.delete(client));
        conoutSocket.pipe(client);
    });
    server.listen(getWorkerPipeName(workerData.conoutPipeName), () => parentPort.postMessage(1));
});
parentPort.on('message', message => {
    if (message !== 'dispose') throw new Error('Unexpected conout worker message');
    conoutSocket.destroy();
    for (const client of clients) client.destroy();
    server.close(() => parentPort.close());
});
