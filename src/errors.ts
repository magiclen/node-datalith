export class BadRequestError extends Error {
    public constructor() {
        super("BadRequest");
        
        this.name = "BadRequestError";
    }
}

export class NotFoundError extends Error {
    public constructor() {
        super("NotFound");
        
        this.name = "NotFoundError";
    }
}

export class PayloadTooLargeError extends Error {
    public constructor() {
        super("PayloadTooLarge");
        
        this.name = "PayloadTooLargeError";
    }
}
