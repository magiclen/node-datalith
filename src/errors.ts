export class BadRequestError extends Error {
    public constructor() {
        super("BadRequest");
        
        this.name = "BadRequestError";
    }
}

export class PayloadTooLargeError extends Error {
    public constructor() {
        super("PayloadTooLarge");
        
        this.name = "PayloadTooLargeError";
    }
}
