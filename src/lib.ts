import { Readable } from "node:stream";

import { nodeReadableToWebReadableStream, timeoutFetch } from "fetch-helper-x";

import { BadRequestError, NotFoundError, PayloadTooLargeError } from "./errors.js";
import { File } from "./file.js";
import { Image, ImageSize } from "./image.js";
import { Resource } from "./resource.js";

export * from "./file.js";
export * from "./image.js";
export * from "./resource.js";

const DEFAULT_REQUEST_TIMEOUT = 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT = 30 * 1000;
const DEFAULT_DELETE_REQUEST_TIMEOUT = DEFAULT_IDLE_TIMEOUT;

export interface WithBodyTimeoutOptions {
    /**
     * The maximum time allowed for the request to complete, in milliseconds.
     *
     * @default 86400000 (1 day)
     */
    reqeustTimeout?: number | null;
    /**
     * The maximum time the connection can remain idle before being closed, in milliseconds.
     *
     * @default 30000 (30 seconds)
     */
    idleTimeout?: number | null;
}

export interface ResourcePutOptions extends WithBodyTimeoutOptions {
    /**
     * The file content as a readable stream.
     *
     * Can be either a `ReadableStream` (for web) or a Node.js `Readable` stream.
     */
    fileStream: ReadableStream | Readable;
    /**
     * The name of the file, including its extension (e.g., `"file.txt"`).
     *
     * If not provided (`undefined`), Datalith will automatically determine the file name.
     *
     * @default undefined
     */
    fileName?: string;
    /**
     * The MIME type of the file (e.g., `"image/jpeg"`, `"application/pdf"`).
     *
     * If not provided (`undefined`), Datalith will automatically determine the file type.
     *
     * @default undefined
     */
    fileType?: string;
    /**
     * The file size.
     *
     * If not provided (`undefined`), Datalith will not be aware of the correct file size, which may result in the file being incomplete.
     *
     * If you're unsure about the file size, you can set it to the maximum file size you want it to be.
     *
     * @default undefined
     */
    fileSize?: number;
    /**
     * Indicates if the file is temporary. If `true`, the file may be deleted after a short period and can use the `getRecource` method to retrieve it only once.
     *
     * If not provided (`undefined`), Datalith will decide whether the file is temporary, defaulting to `false`.
     *
     * @default undefined (Datalith defaults to `false`)
     */
    temporary?: boolean;
}

export interface ImagePutOptions extends WithBodyTimeoutOptions {
    /**
     * The file content as a readable stream.
     *
     * Can be either a `ReadableStream` (for web) or a Node.js `Readable` stream.
     */
    fileStream: ReadableStream | Readable;
    /**
     * The name of the image file, including its extension (e.g., `"image.jpg"`).
     *
     * If not provided (`undefined`), Datalith will automatically determine the file name.
     *
     * @default undefined
     */
    fileName?: string;
    /**
     * The file size.
     *
     * If not provided (`undefined`), Datalith will not be aware of the correct file size, which may result in the file being incomplete.
     *
     * If you're unsure about the file size, you can set it to the maximum file size you want it to be.
     *
     * @default undefined
     */
    fileSize?: number;
    /**
     * The maximum width of the image in pixels.
     *
     * If not provided (`undefined`), Datalith will not resize the image by width.
     *
     * @default undefined
     */
    maxWidth?: number;
    /**
     * The maximum height of the image in pixels.
     *
     * If not provided (`undefined`), Datalith will not resize the image by height.
     *
     * @default undefined
     */
    maxHeight?: number;
    /**
     * The aspect ratio for cropping the image (e.g., `"1:1"`).
     *
     * If not provided (`undefined`), Datalith will not crop the image.
     *
     * @default undefined
     *
     * @example "1:1"
     */
    centerCrop?: string;
    /**
     * Indicates whether to save the original image file.
     *
     * If not provided (`undefined`), Datalith will automatically decide whether to save the original file, with the default being `true`.
     *
     * @default undefined (Datalith defaults to `true`)
     */
    saveOriginalFile?: boolean;
    /**
     * The maximum time allowed for the request to complete, in milliseconds.
     *
     * @default 86400000 (1 day)
     */
    reqeustTimeout?: number | null;
    /**
     * The maximum time the connection can remain idle before being closed, in milliseconds.
     *
     * @default 30000 (30 seconds)
     */
    idleTimeout?: number | null;
}

export type ResourceGetOptions = WithBodyTimeoutOptions;
export type Resolution = `${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}x` | "original";

export interface ImageGetOptions extends WithBodyTimeoutOptions {
    /**
     * The desired resolution of the image.
     *
     * Can be a scaling factor from `"1x"`, `"2x"`, `"3x"`, ..., etc, or `"original"` for the original resolution.
     *
     * If not provided (`undefined`), Datalith will automatically set the resolution to `1x`.
     *
     * @default undefined (Datalith defaults to `"1x"`)
     */
    resolution?: Resolution;
    /**
     * Whether to use a fallback image (in PNG/JPEG format instead of WebP).
     *
     * If not provided (`undefined`), Datalith will default to `false` and will not use a fallback image.
     *
     * @default undefined (Datalith defaults to `false`)
     */
    fallback?: boolean;
    /**
     * The maximum time allowed for the request to complete, in milliseconds.
     *
     * @default 86400000 (1 day)
     */
    reqeustTimeout?: number | null;
    /**
     * The maximum time the connection can remain idle before being closed, in milliseconds.
     *
     * @default 30000 (30 seconds)
     */
    idleTimeout?: number | null;
}

export interface DeleteOptions {
    /**
     * The maximum time allowed for the request to complete, in milliseconds.
     *
     * @default 30000 (30 seconds)
     */
    reqeustTimeout?: number | null;
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
     * @throws {BadRequestError}
     * @throws {PayloadTooLargeError}
     * @throws {Error}
     */
    public async putResource(options: ResourcePutOptions): Promise<Resource> {
        let fileStream: ReadableStream;

        if (options.fileStream instanceof Readable) {
            fileStream = nodeReadableToWebReadableStream(options.fileStream);
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

        const headers: Record<string, string> = {};

        if (typeof options.fileSize !== "undefined") {
            headers["x-file-length"] = options.fileSize.toString();
        }

        const response = await timeoutFetch(this._apiOperate.toString(), {
            method: "PUT",
            headers,
            body: fileStream,
            requestTimeout: typeof options.reqeustTimeout !== "undefined" ? options.reqeustTimeout : DEFAULT_REQUEST_TIMEOUT,
            idleTimeout: typeof options.idleTimeout !== "undefined" ? options.idleTimeout : DEFAULT_IDLE_TIMEOUT,
            duplex: "half",
        });

        try {
            switch (response.status) {
                case 200:
                    break;
                case 400:
                    throw new BadRequestError();
                case 413:
                    throw new PayloadTooLargeError();
                default:
                    throw new Error("unknown error");
            }

            const json = await response.json<{
                id: string,
                created_at: string,
                file_type: string,
                file_size: number,
                file_name: string,
                is_temporary: boolean,
            }>();

            return new Resource(json.id, new Date(json.created_at), json.file_type, json.file_size, json.file_name, json.is_temporary);
        } catch (error) {
            await response.cancelBody();
            throw error;
        }
    }

    /**
     * Input a image into Datalith.
     *
     * @throws {BadRequestError}
     * @throws {PayloadTooLargeError}
     * @throws {Error}
     */
    public async putImage(options: ImagePutOptions): Promise<Image> {
        let fileStream: ReadableStream;

        if (options.fileStream instanceof Readable) {
            fileStream = nodeReadableToWebReadableStream(options.fileStream);
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
        
        const headers: Record<string, string> = {};

        if (typeof options.fileSize !== "undefined") {
            headers["x-file-length"] = options.fileSize.toString();
        }

        const response = await timeoutFetch(this._apiOperateImage.toString(), {
            method: "PUT",
            headers,
            body: fileStream,
            requestTimeout: typeof options.reqeustTimeout !== "undefined" ? options.reqeustTimeout : DEFAULT_REQUEST_TIMEOUT,
            idleTimeout: typeof options.idleTimeout !== "undefined" ? options.idleTimeout : DEFAULT_IDLE_TIMEOUT,
            duplex: "half",
        });

        try {
            switch (response.status) {
                case 200:
                    break;
                case 400:
                    throw new BadRequestError();
                case 413:
                    throw new PayloadTooLargeError();
                default:
                    throw new Error("unknown error");
            }

            const json = await response.json<{
                id: string,
                created_at: string,
                image_width: number,
                image_height: number,
                image_stem: string,
            }>();

            return new Image(json.id, new Date(json.created_at), json.image_stem, {
                width: json.image_width,
                height: json.image_height,
            });
        } catch (error) {
            await response.cancelBody();
            throw error;
        }
    }

    /**
     * Get a resource from Datalith.
     *
     * @throws {BadRequestError}
     * @throws {Error}
     */
    public async getResource(id: string, options: ResourceGetOptions = {}): Promise<File | null> {
        const url = new URL(id, this._apiFetch);

        const response = await timeoutFetch(url, {
            method: "GET",
            requestTimeout: typeof options.reqeustTimeout !== "undefined" ? options.reqeustTimeout : DEFAULT_REQUEST_TIMEOUT,
            idleTimeout: typeof options.idleTimeout !== "undefined" ? options.idleTimeout : DEFAULT_IDLE_TIMEOUT,
        });

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

                return new File(response, etag, date, contentType, contentLength, body);
            }
            case 400:
                await response.cancelBody();
                throw new BadRequestError();
            case 404:
                await response.cancelBody();
                return null;
            default:
                await response.cancelBody();
                throw new Error("unknown error");
        }
    }

    /**
     * Get an image from Datalith.
     *
     * @throws {BadRequestError}
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

        const response = await timeoutFetch(url, {
            method: "GET",
            requestTimeout: typeof options.reqeustTimeout !== "undefined" ? options.reqeustTimeout : DEFAULT_REQUEST_TIMEOUT,
            idleTimeout: typeof options.idleTimeout !== "undefined" ? options.idleTimeout : DEFAULT_IDLE_TIMEOUT,
        });

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

                let imageSize: ImageSize | null = null;

                if (imageWidth !== null && imageHeight !== null) {
                    imageSize = {
                        width: imageWidth,
                        height: imageHeight,
                    };
                }

                return new File(response, etag, date, contentType, contentLength, body, imageSize);
            }
            case 400:
                await response.cancelBody();
                throw new BadRequestError();
            case 404:
                await response.cancelBody();
                return null;
            default:
                await response.cancelBody();
                throw new Error("unknown error");
        }
    }

    /**
     * Delete a resource from Datalith.
     *
     * @throws {BadRequestError}
     * @throws {Error}
     */
    public async deleteResource(id: string, options: DeleteOptions = {}): Promise<boolean> {
        return this.delete(id, this._apiOperate, options);
    }

    /**
     * Delete an image from Datalith.
     *
     * @throws {BadRequestError}
     * @throws {Error}
     */
    public deleteImage(id: string, options: DeleteOptions = {}): Promise<boolean> {
        return this.delete(id, this._apiOperateImage, options);
    }

    async delete(id: string, apiURL: URL, options: DeleteOptions = {}): Promise<boolean> {
        const url = new URL(id, apiURL);

        const response = await timeoutFetch(url, {
            method: "DELETE",
            requestTimeout: typeof options.reqeustTimeout !== "undefined" ? options.reqeustTimeout : DEFAULT_DELETE_REQUEST_TIMEOUT,
        });

        try {
            switch (response.status) {
                case 200:
                    return true;
                case 400:
                    throw new BadRequestError();
                case 404:
                    return false;
                default:
                    throw new Error("unknown error");
            }
        } finally {
            await response.cancelBody();
        }
    }

    /**
     * Convert a resource into an image.
     *
     * @throws {NotFoundError}
     * @throws {BadRequestError}
     * @throws {Error}
     */
    public async convertResourceToImage(id: string, options: DeleteOptions & Pick<ImagePutOptions, "maxWidth" | "maxHeight" | "centerCrop">): Promise<Image> {
        const url = new URL(id, this._apiOperate);
        const searchParams = url.searchParams;

        searchParams.append("convert-image", "");

        if (typeof options.maxWidth !== "undefined") {
            searchParams.append("max_width", options.maxWidth.toString());
        }

        if (typeof options.maxHeight !== "undefined") {
            searchParams.append("max_height", options.maxHeight.toString());
        }

        if (typeof options.centerCrop !== "undefined") {
            searchParams.append("center_crop", options.centerCrop);
        }

        const response = await timeoutFetch(url, {
            method: "DELETE",
            requestTimeout: typeof options.reqeustTimeout !== "undefined" ? options.reqeustTimeout : DEFAULT_DELETE_REQUEST_TIMEOUT,
        });

        try {
            switch (response.status) {
                case 200:
                    break;
                case 400:
                    throw new BadRequestError();
                case 404:
                    throw new NotFoundError();
                default:
                    throw new Error("unknown error");
            }

            const json = await response.json<{
                id: string,
                created_at: string,
                image_width: number,
                image_height: number,
                image_stem: string,
            }>();

            return new Image(json.id, new Date(json.created_at), json.image_stem, {
                width: json.image_width,
                height: json.image_height,
            });
        } catch (error) {
            await response.cancelBody();
            throw error;
        }
    }
}

/**
 * Validates if the input string is a valid center crop string (in the format of `"<float>:<float>"`).
 */
export const validateCenterCrop = (centerCrop?: string): boolean => {
    if (typeof centerCrop === "undefined") {
        return true;
    }

    return (/^-?\d+\.?\d*:-?\d+\.?\d*$/).test(centerCrop);
};

/**
 * Validates if the given resolution is either `undefined`, `"original"`, or follows the format of `"<positive integer>x"`.
 */
export const validateResolution = (resolution?: string): resolution is Resolution => {
    if (typeof resolution === "undefined") {
        return true;
    }

    if (resolution === "original") {
        return true;
    }

    return (/^[1-9][0-9]*x$/).test(resolution);
};
