"use strict";
/**
 * Copyright (c) 2020, Microsoft Corporation (MIT License).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConoutConnection = void 0;
var worker_threads_1 = require("worker_threads");
var conout_1 = require("./shared/conout");
var path_1 = require("path");
var eventEmitter2_1 = require("./eventEmitter2");
/**
 * Connects to and manages the lifecycle of the conout socket. This socket must be drained on
 * another thread in order to avoid deadlocks where Conpty waits for the out socket to drain
 * when `ClosePseudoConsole` is called. This happens when data is being written to the terminal when
 * the pty is closed.
 *
 * See also:
 * - https://github.com/microsoft/node-pty/issues/375
 * - https://github.com/microsoft/vscode/issues/76548
 * - https://github.com/microsoft/terminal/issues/1810
 * - https://docs.microsoft.com/en-us/windows/console/closepseudoconsole
 */
var ConoutConnection = /** @class */ (function () {
    function ConoutConnection(_conoutPipeName, _useConptyDll) {
        var _this = this;
        this._conoutPipeName = _conoutPipeName;
        this._useConptyDll = _useConptyDll;
        this._isDisposed = false;
        this._onReady = new eventEmitter2_1.EventEmitter2();
        var workerData = {
            conoutPipeName: _conoutPipeName
        };
        var scriptPath = __dirname.replace('node_modules.asar', 'node_modules.asar.unpacked');
        this._worker = new worker_threads_1.Worker(path_1.join(scriptPath, 'worker/conoutSocketWorker.js'), { workerData: workerData });
        this._worker.on('message', function (message) {
            switch (message) {
                case 1 /* READY */:
                    _this._onReady.fire();
                    return;
                default:
                    console.warn('Unexpected ConoutWorkerMessage', message);
            }
        });
    }
    Object.defineProperty(ConoutConnection.prototype, "onReady", {
        get: function () { return this._onReady.event; },
        enumerable: false,
        configurable: true
    });
    ConoutConnection.prototype.dispose = function () {
        if (this._isDisposed) return;
        this._isDisposed = true;
        // Called only after output EOF and shell exit; no buffered output is discarded.
        this._worker.postMessage('dispose');
    };
    ConoutConnection.prototype.connectSocket = function (socket) {
        socket.connect(conout_1.getWorkerPipeName(this._conoutPipeName));
    };
    return ConoutConnection;
}());
exports.ConoutConnection = ConoutConnection;
