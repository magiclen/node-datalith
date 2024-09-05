export enum DatalithPutErrorKind {
    BadRequest = "BadRequest",
    PayloadTooLarge = "PayloadTooLarge",
    Timeout = "Timeout",
}

export class DatalithPutError extends Error {
    public constructor(public readonly kind: DatalithPutErrorKind) {
        super(kind);
        
        this.name = "DatalithUploadError";
    }
}
