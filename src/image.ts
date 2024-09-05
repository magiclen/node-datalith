/**
 * Represents a size of an image.
 */
export interface ImageSize {
    readonly width: number;
    readonly height: number;
}


/**
 * A class that represents an image.
 */
export class Image {
    /**
     * Constructs a new `Image` instance. You should not new an `Image` on your own.
     *
     * @param {string} id The image ID (UUID).
     * @param {Date} createdAt The creation time.
     * @param {string} imageStem The file name of the image without the extension.
     * @param {ImageSize} imageSize The size of the 1x image.
     */
    constructor(
        public readonly id: string,
        public readonly createdAt: Date,
        public readonly imageStem: string,
        public readonly imageSize: ImageSize,
    ) {
        // do nothing
    }
}
