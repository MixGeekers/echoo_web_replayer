/** stream-json tokens with packed values disabled. */
export type JsonToken =
  | { name: "stringChunk" | "numberChunk"; value: string }
  | { name: "trueValue" | "falseValue" | "nullValue"; value: boolean | null }
  | {
      name:
        | "startKey"
        | "endKey"
        | "startString"
        | "endString"
        | "startNumber"
        | "endNumber"
        | "startObject"
        | "endObject"
        | "startArray"
        | "endArray";
      value?: undefined;
    };
