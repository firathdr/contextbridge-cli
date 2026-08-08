import { getEncoding, type Tiktoken } from "js-tiktoken";

let encoding: Tiktoken | undefined;

function getLocalEncoding(): Tiktoken {
  encoding ??= getEncoding("o200k_base");
  return encoding;
}

export function countTokens(value: string): number {
  return getLocalEncoding().encode(value).length;
}

