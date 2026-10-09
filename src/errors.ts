import type { Task } from "./types.ts";

/** An HTTP error sent by Datalith. */
export class DatalithError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly requestId: string | null = null,
        readonly retryAfter: string | null = null,
    ) {
        super(message);
        this.name = "DatalithError";
    }

    /**
     * Reads the error from a response that is not ok, such as a download response.
     *
     * It reads the response body, so do not read the body before.
     */
    static async fromResponse(response: Response): Promise<DatalithError> {
        let data: unknown;
        try {
            data = await response.json();
        } catch (error) {
            // Only ignore invalid JSON; keep stream and timeout errors.
            if (!(error instanceof SyntaxError)) {
                throw error;
            }
        }
        const body: object = typeof data === "object" && data !== null ? data : {};
        const detail: object =
            "error" in body && typeof body.error === "object" && body.error !== null
                ? body.error
                : {};
        return new DatalithError(
            response.status,
            "code" in detail && typeof detail.code === "string" ? detail.code : "http_error",
            "message" in detail && typeof detail.message === "string"
                ? detail.message
                : "Datalith returned HTTP " + response.status + ".",
            response.headers.get("x-request-id") ??
                ("request_id" in body && typeof body.request_id === "string"
                    ? body.request_id
                    : null),
            response.headers.get("retry-after"),
        );
    }
}

/** Options for `DatalithProtocolError`. */
export interface DatalithProtocolErrorOptions extends ErrorOptions {
    /** Where the data does not match, such as `items[0].file_name`. */
    path?: string;
}

/** The service sent data that does not match its API. */
export class DatalithProtocolError extends Error {
    /**
     * Where the data does not match, such as `items[0].file_name`; it is empty for the whole
     * response.
     */
    readonly path: string;

    constructor(reason: string, options: DatalithProtocolErrorOptions = {}) {
        const path = options.path ?? "";
        super(path === "" ? reason + "." : reason + " at " + path + ".", options);
        this.name = "DatalithProtocolError";
        this.path = path;
    }
}

/** Stores a failed or cancelled task with its ID and progress. */
export class TaskError extends Error {
    constructor(readonly task: Task) {
        super(task.error?.message ?? "Task " + task.id + " was " + task.status + ".");
        this.name = "TaskError";
    }
}

/** Stops local waiting without cancelling the task on the service. */
export class TaskWaitTimeoutError extends Error {
    constructor(readonly taskId: string) {
        super("Waiting for task " + taskId + " timed out.");
        this.name = "TaskWaitTimeoutError";
    }
}
