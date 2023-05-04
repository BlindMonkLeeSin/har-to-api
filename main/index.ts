import { writeFile } from "node:fs/promises";
import { mkdir, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

// 支持 har 文件
require.extensions[".har"] = require.extensions[".json"];

type Method = "get" | "post" | "patch" | "put" | "delete";

function stringToCamel(str: string): string {
  if (str.includes("-")) {
    return str
      .split("-")
      .map((item) => stringToCamel(item))
      .join("");
  }
  if (str.includes("_")) {
    return str
      .split("_")
      .map((item) => stringToCamel(item))
      .join("");
  }
  return str.slice(0, 1).toUpperCase() + str.slice(1).toLowerCase();
}

function getFunctionNameByAPI(api: string, method: Method) {
  // 'api/v1/test/:id_./:c'.match(/([\w\.-]+)/g) => ['id_.', 'c']
  const dynamicWords = api
    .match(/(?<=:)[\w\.-]+/g)
    ?.map((item) => stringToCamel(item));
  // 'api/v1/test/:id_./:c'.match(/([\w\.-]+)/g) => ['api', 'v1', 'test', 'id_.', 'c']
  const words = api.match(/([\w\.-]+)/g)?.map((item) => stringToCamel(item));
  words?.splice(0, 2);
  if (Array.isArray(dynamicWords)) {
    const lastDynamicWord = dynamicWords[dynamicWords.length - 1];
    const filteredWords = words?.filter((word) => !dynamicWords.includes(word));
    return `${method}${filteredWords?.join("")}By${lastDynamicWord}`;
  } else {
    return `${method}${words?.join("")}`;
  }
}

export type Config = {
  /**
   * 文件输出目录
   */
  outPutDir: string;
  /** 模板 */
  template?: (option: {
    functionName: string;
    method: Method;
    api: string;
    dataName: string;
  }) => string;
  /** har 文件地址 */
  harPath: string;
  /**
   * 输出文件的后缀名
   * @default .ts
   */
  apiFileExtensions?: string;
  /**
   * 支持的请求方法
   * @default ['get']
   */
  supportMethods: string[];
  cover?:
    | boolean
    | {
        api: boolean;
        data: boolean;
      };
  dynamicApiList?: string[];
};

type Item = { text: string; dir: string; api: string; method: Method };

type Data = Map<string, Item>;

class GenerateCode {
  config: Required<Config>;
  data: Data = new Map();
  promises: Promise<any>[] = [];
  constructor(configPath: string) {
    console.log("代码生成开始");
    const configResolvePath = resolve(process.cwd(), configPath);
    const config = require(configResolvePath) as Config;
    this.config = {
      apiFileExtensions: ".ts",
      cover: false,
      dynamicApiList: [],
      template: (option) => JSON.stringify(option),
      ...config,
      harPath: resolve(process.cwd(), config.harPath),
      outPutDir: resolve(process.cwd(), config.outPutDir),
    };
    this.initData();
    this.writeDirector();
    Promise.all(this.promises).then(() => {
      console.log("代码生成完毕");
    });
  }

  private initData() {
    const { harPath, supportMethods, dynamicApiList } = this.config;

    const json = require(harPath);

    const filteredRequests = (json?.log?.entries ?? []).filter(
      (item: any) =>
        item._resourceType === "xhr" &&
        item.response.status >= 200 &&
        item.response.status < 300 &&
        supportMethods
          .map((item) => item.toUpperCase())
          .includes(item.request.method)
    );

    // '/api/v1/product/:name/user/list' => /api/v1/product/[\\w.-]+/user/list/$
    const dynamicApiRegExps = dynamicApiList.map(
      (item) => new RegExp(`^${item.replace(/:\w+/g, "[\\w.-]+")}$`)
    );

    filteredRequests.reduce((acc: Data, cur: any) => {
      const {
        request: { method, url },
        response: {
          content: { text },
        },
      } = cur;

      const pathname = new URL(url).pathname;

      let api;
      let dir;

      const matchRegExpIndex = dynamicApiRegExps.findIndex((item) =>
        item.test(pathname)
      );

      if (matchRegExpIndex !== -1) {
        const matchDynamicApi = dynamicApiList[matchRegExpIndex];
        api = matchDynamicApi;
        // '/api/v1/product/:user/user/list/' => /api/v1/product/[user]/user/list/
        dir = matchDynamicApi.replace(/(:\w+)/, (a) => {
          return `[${a.replace(":", "")}]`;
        });
      } else {
        // '/api/v1/123123' => '/api/v1/:id'
        api = pathname.replace(/\/\d+/g, "/:id");
        // '/api/v1/123123' => '/api/v1/[id]'
        dir = pathname.replace(/\/\d+/g, "/[id]");
      }

      acc.set(`${api} - ${method}`, {
        text,
        dir,
        api,
        method: method.toLowerCase(),
      });
      return acc;
    }, this.data);
  }

  /**
   * 生成目录并写入内容
   */
  private writeDirector() {
    const { outPutDir } = this.config;
    [...this.data.values()].forEach((item) => {
      const newDir = join(outPutDir, item.dir);

      if (existsSync(newDir) && statSync(newDir).isDirectory()) {
        this.writeContent(newDir, item);
      } else {
        mkdir(
          newDir,
          {
            recursive: true,
          },
          (err) => {
            if (err === null) {
              this.writeContent(newDir, item);
            } else {
              console.log(err.message);
            }
          }
        );
      }
    });
  }

  /**
   * 写入目录中的内容
   */
  private writeContent(dir: string, item: Item) {
    const { template, apiFileExtensions, cover } = this.config;
    const { api, method, text } = item;

    const apiPath = join(dir, `${method}${apiFileExtensions}`);
    const dataPath = join(dir, `${method}.json`);

    let coverApi = false;
    let coverData = false;

    if (cover) {
      coverApi = true;
      coverData = true;
      if (typeof cover === "object") {
        const { api = false, data = false } = cover;
        coverApi = api;
        coverData = data;
      }
    }

    let writeFilePromise = Promise.resolve();
    let writeDataPromise = Promise.resolve();
    const functionName = getFunctionNameByAPI(api, method);
    if (coverApi) {
      writeFilePromise = writeFile(
        apiPath,
        template({
          functionName,
          method: method,
          api: api,
          dataName: "data",
        })
      );
    } else {
      if (!existsSync(dataPath)) {
        writeFilePromise = writeFile(
          apiPath,
          template({
            functionName,
            method: method,
            api: api,
            dataName: "data",
          })
        );
      }
    }

    if (coverData) {
      writeDataPromise = writeFile(dataPath, text);
    } else {
      if (!existsSync(dataPath)) {
        writeDataPromise = writeFile(dataPath, text);
      }
    }

    this.promises.push(writeDataPromise, writeFilePromise);
  }
}

export function start(configPath: string) {
  new GenerateCode(configPath);
}
