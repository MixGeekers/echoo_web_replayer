declare module "stream-json/Parser" {
  import { Transform } from "node:stream";
  export default class Parser extends Transform {
    constructor(options?: {
      jsonStreaming?: boolean;
      packValues?: boolean;
      packKeys?: boolean;
      packStrings?: boolean;
      packNumbers?: boolean;
    });
  }
}
declare module "stream-json" {
  import Parser from "stream-json/Parser";
  export function parser(options?: {
    jsonStreaming?: boolean;
    packValues?: boolean;
    packKeys?: boolean;
    packStrings?: boolean;
    packNumbers?: boolean;
  }): Parser;
}
