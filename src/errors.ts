export class BadRequestError extends Error {
    constructor() {
        super("BadRequest");

        this.name = "BadRequestError";
    }
}

export class NotFoundError extends Error {
    constructor() {
        super("NotFound");

        this.name = "NotFoundError";
    }
}

export class PayloadTooLargeError extends Error {
    constructor() {
        super("PayloadTooLarge");

        this.name = "PayloadTooLargeError";
    }
}
