export enum DatalithPutErrorKind {
    BadRequest = "BadRequest",
    Timeout = "Timeout",
    PayloadTooLarge = "PayloadTooLarge",
}

export class DatalithPutError extends Error {
    public constructor(public readonly kind: DatalithPutErrorKind) {
        super(kind);
        
        this.name = "DatalithUploadError";
    }
}

export enum DatalithGetErrorKind {
    BadRequest = "BadRequest",
    Timeout = "Timeout",
}

export class DatalithGetError extends Error {
    public constructor(public readonly kind: DatalithGetErrorKind) {
        super(kind);
        
        this.name = "DatalithGetError";
    }
}
