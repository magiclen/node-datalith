Datalith for Node.js
==========

[![CI](https://github.com/magiclen/node-datalith/actions/workflows/ci.yml/badge.svg)](https://github.com/magiclen/node-datalith/actions/workflows/ci.yml)

[Datalith](https://github.com/magiclen/datalith) is a file management system powered by SQLite for metadata storage and the file system for file storage. This library can help you conmunicate with Datalith in Node.js.

## Usage

```typescript
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { buffer } from "node:stream/consumers";

import { Datalith } from "node-datalith";

const API_PREFIX = "http://127.0.0.1:1111";
const FILE_PATH = "tests/data/image.png";

const datalith = new Datalith(API_PREFIX);

const resource = await datalith.putResource({ fileStream: createReadStream(FILE_PATH) });

const file = await datalith.getResource(resource.id));

const data = await buffer(file.data);

const image = await datalith.putImage({ fileStream: createReadStream(FILE_PATH), maxWidth: 128 });

const originalImageFile = await datalith.getImage(image.id, { resolution: "original" });

const thumbnailImageFile = await datalith.getImage(image.id, { resolution: "1x" });
```

## License

[MIT](LICENSE)