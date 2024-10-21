/**
 * A class that represents an resource.
 */
export class Resource {
    /**
     * Constructs a new `Resource` instance. You should not new a `Resource` on your own.
     *
     * @param {string} id The resource ID (UUID).
     * @param {Date} createdAt The creation time.
     * @param {string} fileType The file type (MIME).
     * @param {number} fileSize The file size.
     * @param {string} fileName The file name.
     * @param {boolean} isTemporary Whether this resource is temporary.
     */
    constructor(
        readonly id: string,
        readonly createdAt: Date,
        readonly fileType: string,
        readonly fileSize: number,
        readonly fileName: string,
        readonly isTemporary: boolean,
    ) {
        // do nothing
    }
}
