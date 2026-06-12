/**
 * Fix JSX opening-tag attributes whose double-quoted values contain raw `"` characters
 * (e.g. Hebrew gereshayim in דוא"ל), which break MDX parsing.
 */
export function sanitizeMdxJsxAttributeQuotes(body: string): {
  body: string;
  adjusted: boolean;
} {
  let adjusted = false;
  let out = "";
  let i = 0;

  while (i < body.length) {
    if (body[i] !== "<" || !/[\w.]/.test(body[i + 1] ?? "")) {
      out += body[i];
      i += 1;
      continue;
    }

    const tagStart = i;
    i += 1;
    while (i < body.length && /[\w.-]/.test(body[i] ?? "")) i += 1;
    const tagName = body.slice(tagStart + 1, i);

    let tagOut = `<${tagName}`;
    let tagAdjusted = false;

    while (i < body.length && body[i] !== ">" && body[i] !== "/") {
      while (i < body.length && /\s/.test(body[i] ?? "")) {
        tagOut += body[i];
        i += 1;
      }
      if (i >= body.length || body[i] === ">" || body[i] === "/") break;

      const attrStart = i;
      while (i < body.length && /[\w:.-]/.test(body[i] ?? "")) i += 1;
      const attrName = body.slice(attrStart, i);
      while (i < body.length && /\s/.test(body[i] ?? "")) i += 1;
      if (body[i] !== "=") {
        tagOut += body.slice(attrStart, i);
        continue;
      }

      tagOut += body.slice(attrStart, i);
      tagOut += "=";
      i += 1;
      while (i < body.length && /\s/.test(body[i] ?? "")) i += 1;

      const quote = body[i];
      if (quote !== '"' && quote !== "'") {
        continue;
      }

      if (quote === "'") {
        const valStart = i + 1;
        i += 1;
        while (i < body.length) {
          if (body[i] === "\\") {
            i += 2;
            continue;
          }
          if (body[i] === "'") break;
          i += 1;
        }
        tagOut += body.slice(valStart - 1, i + 1);
        i += 1;
        continue;
      }

      const valStart = i + 1;
      i += 1;

      let closeIdx = -1;
      for (let scan = valStart; scan < body.length; scan += 1) {
        if (body[scan] !== '"') continue;
        let j = scan + 1;
        while (j < body.length && /\s/.test(body[j] ?? "")) j += 1;
        if (
          j < body.length &&
          (body[j] === ">" || body[j] === "/" || /[a-zA-Z]/.test(body[j] ?? ""))
        ) {
          closeIdx = scan;
          break;
        }
      }

      if (closeIdx === -1) {
        tagOut += body.slice(valStart - 1, i);
        break;
      }

      const value = body.slice(valStart, closeIdx);
      const hasInternalQuote = value.includes('"');

      if (hasInternalQuote) {
        const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        tagOut += `'${escaped}'`;
        tagAdjusted = true;
      } else {
        tagOut += `"${value}"`;
      }

      i = closeIdx + 1;
    }

    if (tagAdjusted) adjusted = true;
    tagOut += body[i] ?? "";
    out += tagOut;
    i += 1;
  }

  return { body: out, adjusted };
}
