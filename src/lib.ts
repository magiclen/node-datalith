import { Readable } from "node:stream";

import { DatalithPutError, DatalithPutErrorKind } from "./errors.js";
import { nodeStreamReadableToWebReadableStream } from "./functions.js";

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
    fileName?: string;
    fileType?: string;
    temporary?: boolean;
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
    fileName?: string;
    maxWidth?: number;
    maxHeight?: number;
    centerCrop?: string;
    saveOriginalFile?: boolean;
}

export class File {
    constructor(
        public readonly etag: string,
        public readonly contentType: string,
        public readonly contentLength: number,
        public readonly body: ReadableStream,
    ) {
        // do nothing
    }
}

// TODO Timeout 重寫 寫在function上

export * from "./errors.js";

export class Datalith {
    private readonly _apiOperate: URL;
    private readonly _apiOperateImage: URL;
    private readonly _apiFetch: URL;

    private _putTimeout = 180000;

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
    }

    /**
     * Set the timeout (in milliseconds) when putting a file. `0` means no timeout.
     *
     * @throws {RangeError}
     */
    public set putTimeout(putTimeout: number) {
        if (!Number.isSafeInteger(putTimeout) || putTimeout < 0) {
            throw new RangeError("a timeout must be a zero or an positive integer");
        }

        this._putTimeout = putTimeout;
    }

    /**
     * Get the timeout (in milliseconds) when putting a file.
     */
    public get putTimeout() {
        return this._putTimeout;
    }

    private getPutTimeoutSingal(): AbortSignal {
        if (this._putTimeout > 0) {
            return AbortSignal.timeout(this._putTimeout);
        } else {
            return AbortSignal.timeout(Number.MAX_SAFE_INTEGER);
        }
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

        try {
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

            const response = await fetch(this._apiOperate.toString(), {
                method: "PUT",
                signal: this.getPutTimeoutSingal(),
                body: fileStream,
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

        try {
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

            const response = await fetch(this._apiOperateImage.toString(), {
                method: "PUT",
                signal: this.getPutTimeoutSingal(),
                body: fileStream,
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
     * @throws {DatalithGetError}
     * @throws {Error}
     */
    public async getResource(id: string): Promise<File | null> {
        try {
            const url = new URL(id, this._apiFetch);

            const response = await fetch(url, { method: "GET" });

            switch (response.status) {
                case 200:
                {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const etag = response.headers.get("etag")!;
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const contentType = response.headers.get("content-type")!;
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const contentLength = parseInt(response.headers.get("content-length")!);
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const body = response.body!;
            
                    return new File(etag, contentType, contentLength, body);
                }
                case 404:
                    return null;
                default:
                    throw new Error("unknown error");
            }
        } catch (error) {
            // TODO
            console.log(error);
            throw error;
        }
    }
}
