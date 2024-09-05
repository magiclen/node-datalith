import { Readable } from "node:stream";

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
