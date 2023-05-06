import { writeFile } from "node:fs/promises";
import { mkdir, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

// 支持 har 文件
require.extensions[".har"] = require.extensions[".json"];

type Method = "get" | "post" | "patch" | "put" | "delete";

function stringToCamel(str: string, delimiters: string[]): string {
  const stringToCamelHelper = (str: string) =>
    str.slice(0, 1).toUpperCase() + str.slice(1).toLowerCase();
  return delimiters.reduce((formattedString, delimiter) => {
    return formattedString.includes(delimiter)
      ? str
          .split(delimiter)
          .map((item) => stringToCamel(stringToCamelHelper(item), delimiters))
          .join("")
      : formattedString;
  }, stringToCamelHelper(str));
}

function getFunctionNameByAPI(api: string, method: Method) {
  const delimiters = ["-", "_"];
  // '/test/:id_./:c'.match(/(?<=:)[\w\.\-]+/g) => ['id_.', 'c']
  const dynamicWords = api
    .match(/(?<=:)[\w\.\-]+/g)
    ?.map((item) => stringToCamel(item, delimiters));
  // '/test/:id_./:c'.match(/([\w\.-]+)/g) => ['test', 'id_.', 'c']
  const words = api
    .match(/([\w\.\-]+)/g)
    ?.map((item) => stringToCamel(item, delimiters));
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
  prefix?: string;
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
      prefix: "",
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
    const { harPath, supportMethods, dynamicApiList, prefix } = this.config;

    const json = require(harPath);

    const filteredRequests: {
      method: Method;
      pathname: string;
      text: string;
    }[] = (json?.log?.entries ?? [])
      .map(
        ({
          _resourceType,
          response: { status, content },
          request: { method, url },
        }: any) => {
          const pathname = new URL(url).pathname;
          const flag =
            _resourceType === "xhr" &&
            status >= 200 &&
            status < 300 &&
            pathname.startsWith(prefix) &&
            supportMethods.map((item) => item.toUpperCase()).includes(method);

          if (!flag) {
            return false;
          } else {
            return {
              method: method.toLowerCase(),
              pathname: pathname,
              text: content.text,
            };
          }
        }
      )
      .filter(Boolean);

    // '/product/:name_-c/user/list' => /product/[\\w\-\.]+/user/list/$
    const dynamicApiRegExps = dynamicApiList.map(
      (item) => new RegExp(`^${item.replace(/:[\w\-]+/g, "[\\w\\-\\.]+")}$`)
    );

    filteredRequests.reduce((acc: Data, cur) => {
      const { method, pathname, text } = cur;

      let api;
      let dir;

      const matchRegExpIndex = dynamicApiRegExps.findIndex((item) =>
        item.test(pathname)
      );

      if (matchRegExpIndex !== -1) {
        const matchDynamicApi = dynamicApiList[matchRegExpIndex];
        api = matchDynamicApi;
        // '/api/v1/product/:user-_/user/list/' => /api/v1/product/[user_-]/user/list/
        dir = matchDynamicApi.replace(/(:[\w\-]+)/, (a) => {
          return `[${a.replace(":", "")}]`;
        });
      } else {
        // '/api/v1/2876' => '/:id'
        api = pathname.replace(/\/\d+/g, "/:id");
        // '/api/v1/2876' => '/v1/[id]'
        dir = pathname.replace(/\/\d+/g, "/[id]");
      }

      acc.set(`${api} - ${method}`, {
        text,
        dir,
        api,
        method,
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
    const { template, apiFileExtensions, cover, prefix } = this.config;
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
    const functionName = getFunctionNameByAPI(api.slice(prefix.length), method);
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
