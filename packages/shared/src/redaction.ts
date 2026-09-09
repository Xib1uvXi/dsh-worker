import { StringDecoder } from "node:string_decoder";

// Exact values only: callers freeze the set at operation admission.
export function redactor(names: string[], env = process.env) {
  const entries = [...new Set(names)]
    .flatMap((name) => (env[name] ? [{ value: env[name]!, name }] : []))
    .sort(
      (a, b) => b.value.length - a.value.length || a.name.localeCompare(b.name),
    );
  const maxLength = Math.max(1, ...entries.map((e) => e.value.length));
  function replace(input: string, final = true) {
    let output = "";
    let position = 0;
    const boundary = final
      ? input.length
      : Math.max(0, input.length - maxLength + 1);
    while (position < boundary) {
      const match = entries.find((e) => input.startsWith(e.value, position));
      if (match) {
        output += `[REDACTED:${match.name}]`;
        position += match.value.length;
      } else {
        const character = String.fromCodePoint(input.codePointAt(position)!);
        output += character;
        position += character.length;
      }
    }
    return { output, rest: input.slice(position) };
  }
  const text = (input: string) => replace(input).output;
  // Native message streams retain text deltas as arrays. Match across their
  // boundaries while retaining array positions for the accompanying metadata.
  function chunks(input: string[]): string[] {
    const joined = input.join("");
    const output = input.map(() => "");
    let chunk = 0;
    let boundary = input[0]?.length ?? 0;
    for (let position = 0; position < joined.length; ) {
      while (position >= boundary && chunk < input.length - 1)
        boundary += input[++chunk]!.length;
      const match = entries.find((e) => joined.startsWith(e.value, position));
      if (match) {
        output[chunk] += `[REDACTED:${match.name}]`;
        position += match.value.length;
      } else {
        output[chunk] += joined[position]!;
        position++;
      }
    }
    return output;
  }
  function value<T>(input: T): T {
    if (typeof input === "string") return text(input) as T;
    if (Array.isArray(input))
      return (
        input.every((item: unknown) => typeof item === "string")
          ? chunks(input as string[])
          : input.map((item: unknown) => value(item))
      ) as T;
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input).map(([key, item]: [string, unknown]) => [
          text(key),
          value(item),
        ]),
      ) as T;
    return input;
  }
  return {
    text,
    value,
    stream(emit: (text: string) => void) {
      const decoder = new StringDecoder("utf8");
      let pending = "";
      return {
        write(chunk: Buffer | string) {
          pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
          const result = replace(pending, false);
          pending = result.rest;
          if (result.output) emit(result.output);
        },
        end() {
          emit(text(pending + decoder.end()));
          pending = "";
        },
      };
    },
  };
}
