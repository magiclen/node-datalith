import { TimeoutResponse } from "fetch-helper-x";

import { ImageSize } from "./image.js";

/**
 * Represents a file resource with metadata such as ETag, content type, and size.
 *
 * It may also include the image size.
 */
export class File {
    /**
     * Constructs a new `File` instance. You should not new an `File` on your own.
     *
     * @param {TimeoutResponse} resource The response from `timeoutFetch`.
     * @param {string} etag The unique identifier for the file, typically used for caching.
     * @param {Date} string The date and time when the file was created.
     * @param {string} contentType The MIME type of the file.
     * @param {number} contentLength The size of the file in bytes.
     * @param {string} contentDisposition The file name and the expected usage.
     * @param {ReadableStream} data The file content as a readable stream.
     * @param {imageSize} [imageSize] (Optional) The size of the image in pixels, or `null` if not applicable, or `undefined` if this file is not an image.
     */
    constructor(
        private readonly resource: TimeoutResponse,
        public readonly etag: string,
        public readonly date: string,
        public readonly contentType: string,
        public readonly contentLength: number,
        public readonly contentDisposition: string,
        public readonly data: ReadableStream,
        public readonly imageSize?: ImageSize | null,
    ) {
        // do nothing
    }

    /**
     * If you want to cancel the data, use this function instead of `data.cancel()` or `data.getReader().cancel()`.
     */
    public cancelData(): Promise<void> {
        return this.resource.cancelBody();
    }
}
