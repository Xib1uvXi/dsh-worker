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
    // Arrays and standalone JSON scalars are alternative documents too.
    // Do not silently discard them as introductory prose.
    if (
      /[\[\]]/.test(prose) ||
      /^\s*(?:null\b|true\b|false\b|-?\d|")/m.test(prose)
    )
      throw new Error("Ambiguous delivery prefix");
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
