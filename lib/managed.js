/**
 * Read bounded parent commands and emit machine-readable lifecycle events.
 *
 * @param {object} input - Parent command readable stream.
 * @param {object} output - Status writable stream.
 * @param {function(): unknown} stop - Idempotent shutdown entry outside the work queue.
 * @returns {object} Status emitter and input cleanup.
 */
function createManagedControl(input, output, stop) {
    let pending = '';
    let overflow = false;
    let stopping = false;
    let closed = false;
    let outputFailed = false;

    /**
     * Emit one bounded JSON status record.
     *
     * @param {string} state - Lifecycle state.
     * @param {string} message - User-facing status detail.
     * @param {number} [port] - Verified or requested loopback debugger port.
     */
    function status(state, message, port) {
        if (closed || outputFailed) {
            return;
        }

        const event = { protocol: 1, state, message: String(message).slice(0, 1_000) };

        if (port !== undefined) {
            event.port = port;
        }

        const record = `${JSON.stringify(event)}\n`;

        // ponytail: retain at most 64 KiB; a parent that stops reading loses the session.
        if (output.destroyed || output.writableLength + Buffer.byteLength(record) > 65_536) {
            failOutput();
        } else {
            output.write(record);
        }
    }

    /**
     * Request shutdown once for stop, EOF or a lost parent pipe.
     */
    function requestStop() {
        if (!stopping && !closed) {
            stopping = true;
            pending = '';
            overflow = false;
            try {
                void Promise.resolve(stop()).catch((error) => status('error', error?.message ?? String(error)));
            } catch (error) {
                status('error', error?.message ?? String(error));
            }
        }
    }

    /**
     * Stop outside serialized work and drop an unusable parent output pipe.
     */
    function failOutput() {
        if (!outputFailed) {
            outputFailed = true;
            input.pause();
            output.destroy();
            requestStop();
        }
    }

    /**
     * Consume fragmented lines without retaining an unbounded command.
     *
     * @param {string} chunk - Decoded input fragment.
     */
    function onData(chunk) {
        for (const character of chunk) {
            if (stopping || closed) {
                return;
            }

            if (character === '\n') {
                if (!overflow) {
                    if (pending.replace(/\r$/, '') === 'stop') {
                        requestStop();
                    } else {
                        status('error', 'Unknown managed command; expected stop');
                    }
                }

                pending = '';
                overflow = false;
            } else if (!overflow) {
                pending += character;

                if (pending.length > 256) {
                    pending = '';
                    overflow = true;
                    status('error', 'Managed command exceeds 256 characters');
                }
            }
        }
    }

    /**
     * Detach parent listeners and close its pipe so Node can exit naturally.
     */
    function close() {
        if (closed) {
            return;
        }

        closed = true;
        input.off('data', onData);
        input.off('end', requestStop);
        input.off('error', requestStop);
        input.destroy();

        if (!outputFailed) {
            output.end();
        }
    }

    input.setEncoding('utf8');
    input.on('data', onData);
    input.once('end', requestStop);
    input.once('error', requestStop);
    output.on('error', failOutput);
    output.once('close', failOutput);
    input.resume();

    return { status, close };
}

export { createManagedControl };
