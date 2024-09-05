import { createReadStream } from "node:fs";

import { Datalith } from "../src/lib.js";

const API_PREFIX = "http://127.0.0.1:1111";
const FILE_PATH = "tests/data/image.png";

describe("Resource", () => {
    it("should success", async () => {
        const datalith = new Datalith(API_PREFIX);

        const resource = await datalith.putResource({ fileStream: createReadStream(FILE_PATH) });
        console.log(resource);

        console.log(await datalith.getResource(resource.id));

        const image = await datalith.putImage({ fileStream: createReadStream(FILE_PATH) });
        console.log(image);
        
        expect(true).toBe(true);
    }, 60000);
});
