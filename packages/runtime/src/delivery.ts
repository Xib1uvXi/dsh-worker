// Harness returns the last assistant message as text. A model may introduce
// its structured delivery with prose even when asked for JSON only. Accept
// one complete trailing document, never search for a convenient valid object
// among alternatives. The controller still applies the strict delivery schema
// and ticket/revision/attempt binding before treating this as a submission.
export function deliveryDocument(response: string): unknown {
  const text = response.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    if (start < 0) throw new Error("Delivery must contain a JSON object");
    const prefix = text.slice(0, start);
    const fence = /```(?:json)?\s*$/i.test(prefix);
    const prose = fence ? prefix.replace(/```(?:json)?\s*$/i, "") : prefix;
    // Reject actual JSON values (including multiline arrays) at a line start,
    // while allowing numbered lists, Markdown links and checked task lists.
    const lines = prose.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const candidate = lines.slice(i).join("\n").trimStart();
      if (!/^(?:\[|null\b|true\b|false\b|"|-?\d)/.test(candidate)) continue;
      for (let end = 1; end <= candidate.length; end++) {
        if (end < candidate.length && !/\s/.test(candidate[end]!)) continue;
        try {
          const value: unknown = JSON.parse(candidate.slice(0, end));
          // A count followed by words is normal prose, not a second document.
          if (typeof value === "number") {
            const restOfLine = candidate.slice(end).split("\n")[0]!.trim();
            if (
              restOfLine &&
              !/^(?:null\b|true\b|false\b|[["\d-])/.test(restOfLine)
            )
              continue;
          }
        } catch {
          continue;
        }
        throw new Error("Ambiguous delivery prefix");
      }
    }
    for (const line of prose.split(/\r?\n/).filter((line) => line.trim())) {
      let parsed = false;
      try {
        JSON.parse(line);
        parsed = true;
      } catch {
        // Ordinary introductory prose is allowed.
      }
      if (parsed) throw new Error("Multiple delivery documents");
    }
    let document = text.slice(start);
    if (fence) {
      if (!/\s*```$/.test(document))
        throw new Error("Unclosed delivery JSON fence");
      document = document.replace(/\s*```$/, "");
    }
    return JSON.parse(document);
  }
}
