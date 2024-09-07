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
        expect(typeof resource.id).toBe("string");
        expect(resource.createdAt).toBeInstanceOf(Date);
        expect(resource.fileType).toBe("image/png");
        expect(resource.fileSize).toBe(11658);
        expect(typeof resource.fileName).toBe("string");
        expect(resource.isTemporary).toBe(false);

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const file = (await datalith.getResource(resource.id))!;
        expect(file).not.toBeNull();
        expect(typeof file.etag).toBe("string");
        expect(file.date).toBeInstanceOf(Date);
        expect(file.contentType).toBe("image/png");
        expect(file.contentLength).toBe(11658);
        expect(file.data).toBeInstanceOf(ReadableStream);
        expect(file.imageSize).toBeUndefined();

        const data = await buffer(file.data);
        
        expect(data).toEqual(fileData);

        expect(await datalith.deleteResource(resource.id)).toBe(true);
        expect(await datalith.deleteResource(resource.id)).toBe(false);
    }, 60000);
});

describe("Image", () => {
    let fileData: Buffer;

    beforeAll(async () => {
        fileData = await readFile(FILE_PATH);
    });

    it("should success", async () => {
        const datalith = new Datalith(API_PREFIX);

        const image = await datalith.putImage({ fileStream: createReadStream(FILE_PATH), maxWidth: 128 });
        expect(typeof image.id).toBe("string");
        expect(image.createdAt).toBeInstanceOf(Date);
        expect(typeof image.imageStem).toBe("string");
        expect(image.imageSize).toEqual({
            width: 128,
            height: 128,
        });

        {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const file = (await datalith.getImage(image.id, { resolution: "original" }))!;
            expect(file).not.toBeNull();
            expect(typeof file.etag).toBe("string");
            expect(file.date).toBeInstanceOf(Date);
            expect(file.contentType).toBe("image/png");
            expect(file.contentLength).toBe(11658);
            expect(file.data).toBeInstanceOf(ReadableStream);
            expect(file.imageSize).toBeNull();

            const data = await buffer(file.data);
        
            expect(data).toEqual(fileData);
        }

        {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const file = (await datalith.getImage(image.id, { resolution: "1x" }))!;
            expect(file).not.toBeNull();
            expect(typeof file.etag).toBe("string");
            expect(file.date).toBeInstanceOf(Date);
            expect(file.contentType).toBe("image/webp");
            expect(typeof file.contentLength).toBe("number");
            expect(file.data).toBeInstanceOf(ReadableStream);
            expect(file.imageSize).toEqual({
                width: 128,
                height: 128,
            });
            
            await file.cancelData();
        }

        expect(await datalith.deleteImage(image.id)).toBe(true);
        expect(await datalith.deleteImage(image.id)).toBe(false);
    }, 60000);
});
