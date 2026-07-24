const NUMBERED_START = /^(?:\[\s*\d{1,3}\s*\]|[（(]\s*\d{1,3}\s*[）)]|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]|\d{1,3}[.、)])\s*/;

function bibliographicCue(value) {
  return /(?:18|19|20)\d{2}|\[[A-Z/]+\]|https?:\/\/|10\.\d{4,9}\//i.test(String(value || ""));
}

function normalizeReferenceChunk(value) {
  return String(value || "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/[\t\u00a0 ]+/g, " ")
    .trim();
}

function looksLikeReferenceStart(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (NUMBERED_START.test(text)) return true;

  const apa = text.match(/^(.{1,140}?)\(\s*((?:18|19|20)\d{2})[a-z]?\s*\)\s*[.。]/);
  if (apa) {
    const author = apa[1].trim().replace(/[.。]\s*$/, "");
    if (
      /^[A-Za-z\u00c0-\u024f]/.test(author) &&
      (/[,，;&；]/.test(author) || /\band\b|&/i.test(author) || /^[A-Z][A-Z0-9 .&'’/-]{1,100}$/.test(author))
    ) {
      return true;
    }
  }

  const chineseHead = text.match(/^(.{2,48}?)[.。]/)?.[1]?.trim();
  return Boolean(
    chineseHead &&
    /^[\u3400-\u9fff·]{2,}(?:\s*[,，、]\s*[\u3400-\u9fff·]{2,}){0,12}$/.test(chineseHead) &&
    bibliographicCue(text)
  );
}

function inlineNumberedMarkers(clean) {
  const markers = [...clean.matchAll(/(?:\[\s*\d{1,3}\s*\]|[（(]\s*\d{1,3}\s*[）)]|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]|\d{1,3}[.、)])/g)]
    .filter((match) => match.index === 0 || /[\s。.;；]/.test(clean[match.index - 1] || ""));
  return markers.length >= 2 ? markers : [];
}

function splitReferences(value) {
  const clean = String(value || "")
    .replace(/\r/g, "")
    .replace(/^\s*(?:参考文献|主要参考文献|引用文献|references|bibliography|works cited)\s*[:：]?\s*/i, "")
    .trim();

  if (!clean) return [];

  const starts = new Set([0]);
  inlineNumberedMarkers(clean).forEach((marker) => starts.add(marker.index));

  for (const lineBreak of clean.matchAll(/\n+/g)) {
    const index = lineBreak.index + lineBreak[0].length;
    const nextLine = (clean.slice(index).split("\n", 1)[0] || "").trim();
    if (nextLine && (looksLikeReferenceStart(nextLine) || (lineBreak[0].length > 1 && bibliographicCue(nextLine)))) {
      starts.add(index);
    }
  }

  const positions = [...starts].sort((a, b) => a - b);
  const segmented = positions
    .map((start, index) => normalizeReferenceChunk(clean.slice(start, positions[index + 1] ?? clean.length)))
    .filter(Boolean);

  if (segmented.length > 1) return segmented;

  const paragraphs = clean.split(/\n\s*\n+/).map(normalizeReferenceChunk).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;

  const lines = clean.split("\n").map(normalizeReferenceChunk).filter(Boolean);
  if (lines.length > 1 && lines.every((line) => looksLikeReferenceStart(line) || bibliographicCue(line))) {
    return lines;
  }

  return [normalizeReferenceChunk(clean)];
}

function extractReferencesFromDocument(text) {
  const normalized = String(text || "")
    .replace(/\s*(参考文献|主要参考文献|引用文献|references|bibliography|works cited)\s*[:：]?\s*/gi, "\n$1\n")
    .replace(/\s+(?=(?:\[\s*\d{1,3}\s*\]|[（(]\s*\d{1,3}\s*[）)]|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]|\d{1,3}[.、)])\s*)/g, "\n");
  const lines = normalized
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim());

  let heading = -1;
  lines.forEach((line, index) => {
    if (/^(?:参考文献|主要参考文献|引用文献|references|bibliography|works cited)\s*[:：]?$/i.test(line)) {
      heading = index;
    }
  });

  const source = (heading >= 0 ? lines.slice(heading + 1) : lines).filter(Boolean);
  const output = [];
  let current = "";

  if (source.some((line) => NUMBERED_START.test(line))) {
    source.forEach((line) => {
      if (NUMBERED_START.test(line) || looksLikeReferenceStart(line)) {
        if (current) output.push(current.trim());
        current = line;
      } else if (current) {
        current += ` ${line}`;
      }
    });
    if (current) output.push(current.trim());
  } else {
    output.push(...source.filter((line) => bibliographicCue(line) && (/[.。]/.test(line) || /10\.\d{4,9}\//i.test(line))));
  }

  if (!output.length) {
    throw new Error("未识别出参考文献。请确认文档包含“参考文献”标题和完整条目。");
  }
  return output;
}

module.exports = {
  splitReferences,
  extractReferencesFromDocument
};

