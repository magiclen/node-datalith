import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { encodeOptions } from "./codec.ts";
import type { UploadSource } from "./types.ts";

export interface Multipart {
    readonly contentType: string;
    readonly body: AsyncIterable<Uint8Array>;
    close: () => void;
}

export const multipart = (
    source: UploadSource,
    options?: unknown,
    signal?: AbortSignal,
): Multipart => {
    const boundary = "datalith-" + randomUUID();
    const encoder = new TextEncoder();
    const stream = source instanceof Blob ? source.stream() : source;
    const reader = stream instanceof ReadableStream ? stream.getReader() : undefined;
    const iterator =
        stream instanceof Uint8Array || reader !== undefined
            ? undefined
            : (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    let closed = false;
    const listeners = new AbortController();
    const close = (): void => {
        if (closed) {
            return;
        }
        closed = true;
        listeners.abort();
        if (stream instanceof Readable) {
            stream.destroy();
        }
        if (reader !== undefined) {
            void reader.cancel().catch(() => {});
            reader.releaseLock();
        } else if (iterator?.return !== undefined) {
            // A custom iterator may be stuck, so do not wait for it when stopping the request.
            void iterator.return().catch(() => {});
        }
    };
    signal?.addEventListener("abort", close, { once: true, signal: listeners.signal });
    const body = (async function* (): AsyncGenerator<Uint8Array> {
        try {
            signal?.throwIfAborted();
            if (options !== undefined) {
                yield encoder.encode(
                    "--" +
                        boundary +
                        '\r\nContent-Disposition: form-data; name="options"\r\nContent-Type: application/json\r\n\r\n' +
                        JSON.stringify(encodeOptions(options)) +
                        "\r\n",
                );
            }
            yield encoder.encode(
                "--" +
                    boundary +
                    '\r\nContent-Disposition: form-data; name="file"\r\nContent-Type: application/octet-stream\r\n\r\n',
            );
            if (stream instanceof Uint8Array) {
                yield stream;
            } else {
                while (true) {
                    signal?.throwIfAborted();
                    const pending = reader !== undefined ? reader.read() : iterator?.next();
                    // oxlint-disable-next-line eslint/no-await-in-loop -- Read only when the upload asks for a chunk.
                    const next = await pending;
                    signal?.throwIfAborted();
                    if (next === undefined || next.done === true) {
                        break;
                    }
                    if (!(next.value instanceof Uint8Array)) {
                        throw new TypeError("Upload chunks must be Uint8Array values.");
                    }
                    yield next.value;
                }
            }
            yield encoder.encode("\r\n--" + boundary + "--\r\n");
        } finally {
            close();
        }
    })();
    return { contentType: "multipart/form-data; boundary=" + boundary, body, close };
};
