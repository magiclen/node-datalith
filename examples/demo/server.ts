import { Datalith } from "node-datalith";

import { createDemoServer } from "./app.ts";

const baseUrl = process.env["DATALITH_BASE_URL"] ?? "http://127.0.0.1:1111";
const port = Number(process.env["DEMO_PORT"] ?? "1112");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("DEMO_PORT must be an integer between 1 and 65535.");
}
const server = createDemoServer(new Datalith(baseUrl));
server.once("error", (error) => {
    console.error("Could not start demo: " + error.message);
    process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
    console.log("Datalith demo: http://127.0.0.1:" + port);
    console.log("Datalith service: " + baseUrl);
});
