import { Readable } from "node:stream";

import {
    DatalithGetError, DatalithGetErrorKind, DatalithPutError, DatalithPutErrorKind,
} from "./errors.js";
import { createTimeoutReadableStream, nodeStreamReadableToWebReadableStream } from "./functions.js";

export { nodeStreamReadableToWebReadableStream };

export class Resource {
    constructor(
        public readonly id: string,
        public readonly createdAt: Date,
        public readonly fileType: string,
        public readonly fileSize: number,
        public readonly fileName: string,
        public readonly isTemporary: boolean,
    ) {
        // do nothing
    }
}

export interface ResourcePutOptions {
    fileStream: ReadableStream | Readable;
    /**
     * @default undefined provided by Datalith
     */
    fileName?: string;
    /**
     * @default undefined provided by Datalith
     */
    fileType?: string;
    /**
     * @default undefined provided by Datalith (should be `false`)
     */
    temporary?: boolean;
    /**
     * In milliseconds.
     *
     * @default 15000
     */
    timeout?: number;
}

export class Image {
    constructor(
        public readonly id: string,
        public readonly createdAt: Date,
        public readonly imageWidth: number,
        public readonly imageHeight: number,
        public readonly imageStem: string,
    ) {
        // do nothing
    }
}

export interface ImagePutOptions {
    fileStream: ReadableStream | Readable;
    /**
     * @default undefined provided by Datalith
     */
    fileName?: string;
    /**
     * @default undefined Datalith will not shrink the image by width
     */
    maxWidth?: number;
    /**
     * @default undefined Datalith will not shrink the image by height
     */
    maxHeight?: number;
    /**
     * @example "1:1"
     * @default undefined Datalith will not crop the image
     */
    centerCrop?: string;
    /**
     * @default undefined provided by Datalith (should be `true`)
     */
    saveOriginalFile?: boolean;
    /**
     * In milliseconds.
     *
     * @default 15000
     */
    timeout?: number;
}

export interface ImageGetOptions {
    /**
     * @default undefined provided by Datalith (should be `1x`)
     */
    resolution?: `${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}x` | "original";
    /**
     * @default undefined provided by Datalith (should be `false`)
     */
    fallback?: boolean;
    /**
     * In milliseconds.
     *
     * @default 15000
     */
    timeout?: number;
}

export class File {
    constructor(
        public readonly etag: string,
        public readonly date: Date,
        public readonly contentType: string,
        public readonly contentLength: number,
        public readonly data: ReadableStream,
        public readonly imageWidth?: number | null,
        public readonly imageHeight?: number | null,
    ) {
        // do nothing
    }
}

export * from "./errors.js";

export class Datalith {
    private readonly _apiOperate: URL;
    private readonly _apiOperateImage: URL;
    private readonly _apiFetch: URL;
    private readonly _apiFetchImage: URL;

    public constructor(apiPrefix: URL | string) {
        if (typeof apiPrefix === "string") {
            apiPrefix = new URL(apiPrefix);
        }

        if (!apiPrefix.pathname.endsWith("/")) {
            apiPrefix.pathname = `${apiPrefix.pathname}/`;
        }

        this._apiOperate = new URL("/o/", apiPrefix);
        this._apiOperateImage = new URL("/i/o/", apiPrefix);
        this._apiFetch = new URL("/f/", apiPrefix);
        this._apiFetchImage = new URL("/i/f/", apiPrefix);
    }

    /**
     * Input a resource into Datalith.
     *
     * @throws {DatalithPutError}
     * @throws {Error}
     */
    public async putResource(options: ResourcePutOptions): Promise<Resource> {
        let fileStream: ReadableStream;

        if (options.fileStream instanceof Readable) {
            fileStream = nodeStreamReadableToWebReadableStream(options.fileStream);
        } else {
            fileStream = options.fileStream;
        }


        const url = new URL(this._apiOperate);
        const searchParams = url.searchParams;

        if (typeof options.fileName !== "undefined") {
            searchParams.append("file_name", options.fileName);
        }

        if (typeof options.fileType !== "undefined") {
            searchParams.append("file_type", options.fileType);
        }


        if (typeof options.temporary !== "undefined") {
            searchParams.append("temporary", options.temporary ? "1" : "0");
        }

        const { timeoutReadableStream, signal } = createTimeoutReadableStream(options.timeout, fileStream);

        try {
            const response = await fetch(this._apiOperate.toString(), {
                method: "PUT",
                signal,
                body: timeoutReadableStream,
                duplex: "half",
            } as RequestInit);

            switch (response.status) {
                case 200:
                    break;
                case 400:
                    throw new DatalithPutError(DatalithPutErrorKind.BadRequest);
                case 413:
                    throw new DatalithPutError(DatalithPutErrorKind.PayloadTooLarge);
                default:
                    throw new Error("unknown error");
            }

            const json = await response.json() as {
                id: string,
                created_at: string,
                file_type: string,
                file_size: number,
                file_name: string,
                is_temporary: boolean,
            };

            return new Resource(json.id, new Date(json.created_at), json.file_type, json.file_size, json.file_name, json.is_temporary);
        } catch (error) {
            if (error instanceof Error) {
                switch (error.name) {
                    case "TimeoutError":
                        throw new DatalithPutError(DatalithPutErrorKind.Timeout);
                }
            }

            throw error;
        }
    }

    /**
     * Input a image into Datalith.
     *
     * @throws {DatalithPutError}
     * @throws {Error}
     */
    public async putImage(options: ImagePutOptions): Promise<Image> {
        let fileStream: ReadableStream;

        if (options.fileStream instanceof Readable) {
            fileStream = nodeStreamReadableToWebReadableStream(options.fileStream);
        } else {
            fileStream = options.fileStream;
        }

        const url = new URL(this._apiOperate);
        const searchParams = url.searchParams;

        if (typeof options.fileName !== "undefined") {
            searchParams.append("file_name", options.fileName);
        }

        if (typeof options.maxWidth !== "undefined") {
            searchParams.append("max_width", options.maxWidth.toString());
        }

        if (typeof options.maxHeight !== "undefined") {
            searchParams.append("max_height", options.maxHeight.toString());
        }

        if (typeof options.centerCrop !== "undefined") {
            searchParams.append("center_crop", options.centerCrop);
        }

        if (typeof options.saveOriginalFile !== "undefined") {
            searchParams.append("save_original_file", options.saveOriginalFile ? "1" : "0");
        }

        const { timeoutReadableStream, signal } = createTimeoutReadableStream(options.timeout, fileStream, true);

        try {
            const response = await fetch(this._apiOperateImage.toString(), {
                method: "PUT",
                signal,
                body: timeoutReadableStream,
                duplex: "half",
            } as RequestInit);

            switch (response.status) {
                case 200:
                    break;
                case 400:
                    throw new DatalithPutError(DatalithPutErrorKind.BadRequest);
                case 413:
                    throw new DatalithPutError(DatalithPutErrorKind.PayloadTooLarge);
                default:
                    throw new Error("unknown error");
            }

            const json = await response.json() as {
                id: string,
                created_at: string,
                image_width: number,
                image_height: number,
                image_stem: string,
            };

            return new Image(json.id, new Date(json.created_at), json.image_width, json.image_height, json.image_stem);
        } catch (error) {
            if (error instanceof Error) {
                switch (error.name) {
                    case "TimeoutError":
                        throw new DatalithPutError(DatalithPutErrorKind.Timeout);
                }
            }

            throw error;
        }
    }

    /**
     * Get a resource from Datalith.
     *
     * @params {number} [timeout = 15000] In milliseconds.
     * @throws {DatalithGetError}
     * @throws {Error}
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async getResource(id: string, _timeout?: number): Promise<File | null> {
        const url = new URL(id, this._apiFetch);

        try {
            // TODO timeout

            const response = await fetch(url, { method: "GET" });

            switch (response.status) {
                case 200:
                {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const etag = response.headers.get("etag")!;
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const date = new Date(response.headers.get("date")!);
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const contentType = response.headers.get("content-type")!;
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const contentLength = parseInt(response.headers.get("content-length")!);
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const body = response.body!;
            
                    return new File(etag, date, contentType, contentLength, body);
                }
                case 400:
                    throw new DatalithGetError(DatalithGetErrorKind.BadRequest);
                case 404:
                    return null;
                default:
                    throw new Error("unknown error");
            }
        } catch (error) {
            if (error instanceof Error) {
                switch (error.name) {
                    case "TimeoutError":
                        throw new DatalithGetError(DatalithGetErrorKind.Timeout);
                }
            }

            throw error;
        }
    }

    /**
     * Get an image from Datalith.
     *
     * @params {number} [timeout = 15000] In milliseconds.
     * @throws {DatalithGetError}
     * @throws {Error}
     */
    public async getImage(id: string, options: ImageGetOptions = {}): Promise<File | null> {
        const url = new URL(id, this._apiFetchImage);
        const searchParams = url.searchParams;

        if (typeof options.resolution !== "undefined") {
            searchParams.append("resolution", options.resolution);
        }

        if (typeof options.fallback !== "undefined") {
            searchParams.append("fallback", options.fallback ? "1" : "0");
        }

        try {
            // TODO timeout

            const response = await fetch(url, { method: "GET" });

            switch (response.status) {
                case 200:
                {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const etag = response.headers.get("etag")!;
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const date = new Date(response.headers.get("date")!);
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const contentType = response.headers.get("content-type")!;
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const contentLength = parseInt(response.headers.get("content-length")!);
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const body = response.body!;

                    const getNullableNumber = (fieldName: string): number | null => {
                        const s = response.headers.get(fieldName);

                        if (s === null) {
                            return null;
                        }

                        return parseInt(s);
                    };

                    const imageWidth = getNullableNumber("x-image-width");
                    const imageHeight = getNullableNumber("x-image-height");
            
                    return new File(etag, date, contentType, contentLength, body, imageWidth, imageHeight);
                }
                case 400:
                    throw new DatalithGetError(DatalithGetErrorKind.BadRequest);
                case 404:
                    return null;
                default:
                    throw new Error("unknown error");
            }
        } catch (error) {
            if (error instanceof Error) {
                switch (error.name) {
                    case "TimeoutError":
                        throw new DatalithGetError(DatalithGetErrorKind.Timeout);
                }
            }

            throw error;
        }
    }
}
