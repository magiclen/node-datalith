import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { buffer } from "node:stream/consumers";

import { Datalith } from "../src/lib.js";

const API_PREFIX = "http://127.0.0.1:1111";
const FILE_PATH = "tests/data/image.png";

describe("Resource", () => {
    let fileData: Buffer;

    beforeAll(async () => {
        fileData = await readFile(FILE_PATH);
    });

    it("should success", async () => {
        const datalith = new Datalith(API_PREFIX);

        const resource = await datalith.putResource({ fileStream: createReadStream(FILE_PATH) });

        const file = await datalith.getResource(resource.id);
        expect(file).not.toBeNull();

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const data = await buffer(file!.data);
        
        expect(data).toEqual(fileData);
    }, 60000);
});

describe("Image", () => {
    let fileData: Buffer;

    beforeAll(async () => {
        fileData = await readFile(FILE_PATH);
    });

    it("should success", async () => {
        const datalith = new Datalith(API_PREFIX);

        const resource = await datalith.putImage({ fileStream: createReadStream(FILE_PATH) });

        const file = await datalith.getImage(resource.id, { resolution: "original" });
        expect(file).not.toBeNull();

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const data = await buffer(file!.data);
        
        expect(data).toEqual(fileData);
    }, 60000);
});
