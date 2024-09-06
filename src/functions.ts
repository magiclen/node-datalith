import { Readable } from "node:stream";

const TIMEOUT = 15000;

/**
 * Convert `Readable` to `ReadableStream`.
 */
export const nodeStreamReadableToWebReadableStream = (nodeStream: Readable) => {
    return new ReadableStream({
        start(controller) {
            nodeStream.on("data", (chunk) => {
                controller.enqueue(chunk);
            });
            nodeStream.on("end", () => {
                controller.close();
            });
            nodeStream.on("error", (err) => {
                controller.error(err);
            });
        },
        cancel() {
            nodeStream.destroy();
        },
    });
};

/**
 * @throws {RangeError}
 */
const valitadeTimeout = (timeout: number) => {
    if (!Number.isSafeInteger(timeout) || timeout < 0) {
        throw new RangeError("a timeout must be a zero or an positive integer");
    }
};

/**
 * @throws {RangeError}
 */
export const createTimeoutReadableStream = <T> (timeout = TIMEOUT, stream: ReadableStream<T>, startImmediately = false): {
    timeoutReadableStream: ReadableStream<T>
    signal: AbortSignal
} => {
    if (typeof timeout === "undefined" || timeout === 0) {
        return {
            timeoutReadableStream: stream,
            signal: AbortSignal.timeout(Number.MAX_SAFE_INTEGER),
        };
    }

    valitadeTimeout(timeout);

    let idleTimeoutHandle: NodeJS.Timeout;
    const abortController = new AbortController();

    const resetIdleTimeout = () => {
        clearTimeout(idleTimeoutHandle);
        idleTimeoutHandle = setTimeout(() => {
            abortController.abort();
        }, timeout);
    };

    // wrap the fileStream in a TransformStream to monitor data flow
    const monitoredStream = new TransformStream<T, T>({
        start() {
            if (!startImmediately) {
                resetIdleTimeout(); // start idle timeout when stream starts
            }
        },
        transform(chunk, controller) {
            resetIdleTimeout(); // reset idle timeout on each chunk
            controller.enqueue(chunk); // pass chunk to the next stream
        },
        flush(controller) {
            clearTimeout(idleTimeoutHandle); // clear timeout when stream finishes
            controller.terminate(); // terminate the stream
        },
    });

    if (startImmediately) {
        resetIdleTimeout(); // start idle timeout when stream is created
    }
    
    return {
        timeoutReadableStream: stream.pipeThrough(monitoredStream),
        signal: abortController.signal,
    };
};
