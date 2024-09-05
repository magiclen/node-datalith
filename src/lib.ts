export class Resource {
    constructor(
        public readonly id: string,
        public readonly createdAt: Date,
         public readonly fileType: string,
          public readonly fileSize: number,
          public readonly fileName: string,
           public readonly isTemporary: boolean,
    ) {
        // do nothing
    }
}

export class ResourceUploadOptions {
    constructor(
          public readonly id: string,
          public readonly createdAt: Date,
          public readonly fileType: string,
          public readonly fileSize: number,
          public readonly fileName: string,
          public readonly isTemporary: boolean,
    ) {
        // do nothing
    }
}

export class Datalith {
    private readonly _apiPrefix: URL;

    public constructor(apiPrefix: URL) {
        this._apiPrefix = apiPrefix;
    }

    // async uploadResource(filePath: string, fileName?: string, fileType?: string, temporary?: boolean): Promise<string> {
        
    // }
}
