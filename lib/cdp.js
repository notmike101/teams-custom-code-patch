import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/**
 * Correlate CDP requests and lifecycle events over one bounded WebSocket connection.
 */
class CdpConnection extends EventEmitter {
    /**
     * Initialize a single-use connection and its request timeout.
     *
     * @param {object} [options] - Connection settings.
     * @param {number} [options.timeout] - Default request and handshake timeout in milliseconds.
     */
    constructor({ timeout = 15_000 } = {}) {
        super();
        this.timeout = timeout;
        this.nextId = 0;
        this.pending = new Map();
        this.socket = null;
    }

    /**
     * Open the debugger WebSocket and install response and lifecycle handlers.
     *
     * @param {string} url - Verified local debugger WebSocket address.
     * @returns {Promise<CdpConnection>} This connection once the socket opens.
     */
    connect(url) {
        if (this.socket) {
            return Promise.reject(new Error('CDP connection already used'));
        }

        return new Promise((resolve, reject) => {
            const socket = new WebSocket(url, { handshakeTimeout: this.timeout, maxPayload: 16 * 1_024 * 1_024 });

            this.socket = socket;
            let opened = false;

            socket.on('open', () => {
                opened = true;
                resolve(this);
            });
            socket.on('error', (error) => {
                reject(error);
                this.rejectPending(error);
                socket.terminate();
            });
            socket.on('close', () => {
                const error = new Error('CDP connection closed');

                if (!opened) {
                    reject(error);
                }

                this.rejectPending(error);
                this.emit('disconnect', error);
            });
            socket.on('message', (data) => {
                let message;

                try {
                    message = JSON.parse(data.toString());

                    if (!message || typeof message !== 'object' || Array.isArray(message)) {
                        throw new Error('Invalid response');
                    }
                } catch {
                    this.rejectPending(new Error('Malformed CDP response'));
                    socket.terminate();

                    return;
                }

                if (Object.hasOwn(message, 'id')) {
                    const request = this.pending.get(message.id);

                    if (!request) {
                        return;
                    }

                    this.pending.delete(message.id);
                    clearTimeout(request.timer);

                    if (message.error) {
                        request.reject(new Error(`${request.method}: ${message.error.message} (${message.error.code})`));
                    } else {
                        request.resolve(message.result ?? {});
                    }
                } else if (typeof message.method === 'string') {
                    this.emit(message.method, message.params ?? {});
                }
            });
        });
    }

    /**
     * Send a correlated protocol request with a bounded response deadline.
     *
     * @param {string} method - CDP method name.
     * @param {object} params - Protocol method arguments.
     * @param {number} timeout - Response deadline in milliseconds.
     * @returns {Promise<object>} Protocol result or a rejection for transport and protocol failures.
     */
    send(method, params = {}, timeout = this.timeout) {
        if (this.socket?.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('CDP connection is closed'));
        }

        const id = ++this.nextId;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out after ${timeout}ms`));
            }, timeout);

            this.pending.set(id, { resolve, reject, timer, method });
            try {
                this.socket.send(JSON.stringify({ id, method, params }), (error) => {
                    if (!error) {
                        return;
                    }

                    const request = this.pending.get(id);

                    if (!request) {
                        return;
                    }

                    clearTimeout(timer);
                    this.pending.delete(id);
                    reject(error);
                });
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    /**
     * Reject every pending request and cancel its timer.
     *
     * @param {Error} error - Failure shared by all outstanding requests.
     */
    rejectPending(error) {
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }

        this.pending.clear();
    }

    /**
     * Reject pending work and terminate the local socket.
     */
    close() {
        this.rejectPending(new Error('CDP connection closed locally'));
        this.socket?.terminate();
    }
}

export { CdpConnection };
