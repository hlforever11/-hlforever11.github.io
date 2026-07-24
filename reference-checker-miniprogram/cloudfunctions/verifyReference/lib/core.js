const cheerio = require("cheerio");
const iconv = require("iconv-lite");
const dns = require("node:dns").promises;
const net = require("node:net");
const nodeFetch = require("node-fetch");
const CompatibleAbortController = globalThis.AbortController || require("abort-controller");
const JOURNALS = require("./cn-journals.json");

// CloudBase 免费体验版的云函数执行时间只有 3 秒。所有外部请求必须在平台
// 截止前主动结束，给解析、评分和返回结果预留时间。
const REQUEST_TIMEOUT = 1800;
const USER_AGENT = "ReferenceVerifierMiniProgram/1.0 (mailto:linhu@scu.edu.cn)";
const VERIFIED_REFERENCE_INDEX = [
  {
    source: "《图书馆论坛》官网",
    sourceUrl: "https://tsglt.zslib.com.cn/CN/Y2023/V43/I5/104",
    title: "ChatGPT类智能对话工具兴起对图书馆行业的机遇与挑战",
    authors: ["李书宁", "刘一鸣"],
    year: 2023,
    container: "图书馆论坛",
    volume: "43",
    issue: "5",
    pages: "104-110",
    type: "journal-article"
  },
  {
    source: "OpenAI 官方报告",
    sourceUrl: "https://cdn.openai.com/better-language-models/language_models_are_unsupervised_multitask_learners.pdf",
    title: "Language Models are Unsupervised Multitask Learners",
    authors: [
      "Alec Radford",
      "Jeffrey Wu",
      "Rewon Child",
      "David Luan",
      "Dario Amodei",
      "Ilya Sutskever"
    ],
    year: 2019,
    container: "OpenAI",
    volume: "",
    issue: "",
    pages: "",
    type: "report"
  }
];

function compatibleFetch(...args) {
  return (globalThis.fetch || nodeFetch)(...args);
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000\p{P}\p{S}]+/gu, "");
}

function cleanValue(value) {
  return String(value ?? "")
    .replace(/^[\s.,，。;；:：/／]+|[\s.,，。;；:：]+$/g, "")
    .trim();
}

function cleanWebField(value) {
  return String(value || "")
    .replace(/[\u00a0\s]+/g, " ")
    .replace(/^\s*[|｜·•—–_-]+\s*|\s*[|｜·•—–_-]+\s*$/g, "")
    .trim();
}

function hasHan(value) {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function diceSimilarity(first, second) {
  let a = normalizeText(first);
  let b = normalizeText(second);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    return ratio > 0.72 ? 0.96 : 0.82;
  }
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = new Map();
  for (let index = 0; index < a.length - 1; index += 1) {
    const pair = a.slice(index, index + 2);
    pairs.set(pair, (pairs.get(pair) || 0) + 1);
  }
  let hits = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const pair = b.slice(index, index + 2);
    const count = pairs.get(pair) || 0;
    if (count) {
      hits += 1;
      pairs.set(pair, count - 1);
    }
  }
  return (2 * hits) / (a.length + b.length - 2);
}

function extractDoi(text) {
  const match = String(text).match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  if (!match) return "";
  let doi = match[0].replace(/[.,;:，。；：]+$/g, "");
  while (
    doi.endsWith(")") &&
    (doi.match(/\)/g) || []).length > (doi.match(/\(/g) || []).length
  ) {
    doi = doi.slice(0, -1);
  }
  return doi.toLowerCase();
}

function extractIsbn(text) {
  const source = String(text || "");
  const labeled = source.match(/\bISBN(?:-1[03])?\s*[:：]?\s*((?:97[89][\s-]?)?[\dXx][\dXx\s-]{8,20})/i);
  const compactCandidate = labeled?.[1] ||
    source.match(/\b(97[89][\s-]?\d[\d\s-]{10,18}\d)\b/)?.[1] ||
    "";
  const compact = compactCandidate.replace(/[\s-]/g, "").toUpperCase();
  return /^(?:\d{9}[\dX]|\d{13})$/.test(compact) ? compact : "";
}

function extractPmid(text) {
  return String(text || "").match(/\bPMID\s*[:：]?\s*(\d{4,10})\b/i)?.[1] || "";
}

function extractArxivId(text) {
  const source = String(text || "");
  const match = source.match(
    /(?:\barXiv\s*[:：]\s*|arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5})(?:v\d+)?/i
  );
  return match?.[1] || "";
}

function extractStandardNumber(text) {
  const match = String(text || "").match(
    /\b((?:GB\/T|GB|ISO|IEC|IEEE|ISO\/IEC|YY\/T|WS\/T|HG\/T|JB\/T)\s*\d+(?:\.\d+)*(?:-\d{4})?)\b/i
  );
  return cleanValue(match?.[1] || "").replace(/\s+/g, " ").toUpperCase();
}

function extractPatentNumber(text) {
  return String(text || "").match(/\b(CN\s*\d{8,12}\s*[A-Z]\d?)\b/i)?.[1]
    ?.replace(/\s+/g, "")
    .toUpperCase() || "";
}

function baseReferenceType(type) {
  return String(type || "").toUpperCase().split("/")[0];
}

function extractUrl(text) {
  const matches = [...String(text).matchAll(/https?:\/\/[^\s<>"']+/ig)];
  if (!matches.length) return { url: "", raw: "" };
  const raw = matches[matches.length - 1][0];
  let value = raw.replace(/[\]}>，。；;、]+$/g, "").replace(/\.$/, "");
  while (
    value.endsWith(")") &&
    (value.match(/\)/g) || []).length > (value.match(/\(/g) || []).length
  ) {
    value = value.slice(0, -1);
  }
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) return { url: "", raw: "" };
    parsed.hash = "";
    return { url: parsed.href, raw };
  } catch {
    return { url: "", raw: "" };
  }
}

function normalizeDate(value) {
  const match = String(value || "").match(
    /((?:18|19|20)\d{2})(?:\s*[年\-/.]\s*(\d{1,2})(?:\s*[月\-/.]\s*(\d{1,2})\s*日?)?)?/
  );
  if (!match) return "";
  const year = match[1];
  if (!match[2]) return year;
  const month = String(Number(match[2])).padStart(2, "0");
  if (!match[3]) return `${year}-${month}`;
  return `${year}-${month}-${String(Number(match[3])).padStart(2, "0")}`;
}

function parseReference(reference) {
  const raw = String(reference).replace(/\s+/g, " ").trim();
  const work = raw
    .replace(/^\s*(?:\[\s*\d+\s*\]|\d{1,3}[.、)])\s*/, "")
    .trim();
  const doi = extractDoi(work);
  const isbn = extractIsbn(work);
  const pmid = extractPmid(work);
  const arxivId = extractArxivId(work);
  const standardNumber = extractStandardNumber(work);
  const patentNumber = extractPatentNumber(work);
  const urlMatch = extractUrl(work);
  const url = urlMatch.url;
  let body = urlMatch.raw ? work.replace(urlMatch.raw, "") : work;
  if (doi) {
    body = body.replace(new RegExp(doi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "");
  }
  body = body
    .replace(/(?:doi\s*[:：]?|https?:\/\/(?:dx\.)?doi\.org\/?)\s*[.,。]?\s*$/i, "")
    .trim();

  const typeMatch = body.match(/\[\s*([A-Z/]+)\s*\]/i);
  const type = typeMatch ? typeMatch[1].toUpperCase() : "";
  const publicationMatch = (type === "EB/OL" || url)
    ? body.match(/\(\s*((?:18|19|20)\d{2}(?:\s*[年\-/.]\s*\d{1,2}(?:\s*[月\-/.]\s*\d{1,2}\s*日?)?)?)\s*\)/)
    : null;
  const accessMatch = body.match(
    /\[\s*((?:18|19|20)\d{2}(?:\s*[年\-/.]\s*\d{1,2}(?:\s*[月\-/.]\s*\d{1,2}\s*日?)?)?)\s*\]/
  );
  const publicationDate = normalizeDate(publicationMatch?.[1] || "");
  const accessDate = normalizeDate(accessMatch?.[1] || "");
  let title = "";
  let authors = "";
  let container = "";

  if (typeMatch) {
    const before = body.slice(0, typeMatch.index).trim();
    const parts = before.split(/[.。]\s*/).map(cleanValue).filter(Boolean);
    title = parts.pop() || "";
    authors = parts.join(". ").trim();
    const tail = body
      .slice(typeMatch.index + typeMatch[0].length)
      .replace(/^[\s./／]+/, "");
    const containerMatch = tail.match(
      /^(.+?)(?:[,，]\s*|[.。]\s+)(?=(?:18|19|20)\d{2}\b)/
    );
    if (containerMatch) container = cleanValue(containerMatch[1]);
  } else if (url) {
    const labeledAuthor = body.match(
      /(?:作者|author)\s*[:：]\s*(.+?)(?=\s*[;；]\s*(?:题名|标题|title)\s*[:：])/i
    );
    const labeledTitle = body.match(
      /(?:题名|标题|title)\s*[:：]\s*(.+?)(?=\s*[;；]\s*(?:日期|发布时间|网址|url)\s*[:：]|\s*\(?\s*(?:18|19|20)\d{2})/i
    );
    if (labeledAuthor && labeledTitle) {
      authors = cleanValue(labeledAuthor[1]);
      title = cleanValue(labeledTitle[1]);
    } else {
      const apaWeb = body.match(
        /^(.+?)\.\s*\(\s*((?:18|19|20)\d{2})\s*\)\s*\.\s*(.+)$/
      );
      if (apaWeb) {
        authors = cleanValue(apaWeb[1]);
        const parts = cleanValue(apaWeb[3])
          .replace(/\[\s*(?:18|19|20)\d{2}(?:\s*[年\-/.]\s*\d{1,2}(?:\s*[月\-/.]\s*\d{1,2}\s*日?)?)?\s*\]\s*[.。]?$/, "")
          .split(/[.。]\s+/)
          .map(cleanValue)
          .filter(Boolean);
        title = parts.shift() || "";
        container = parts.join(". ");
      } else {
        const beforeDate = cleanValue(
          body.split(/\(?\s*(?:18|19|20)\d{2}(?:\s*[年\-/.]\s*\d{1,2})?/)[0]
        );
        const parts = beforeDate.split(/[.。]\s*/).map(cleanValue).filter(Boolean);
        if (parts.length > 1) {
          authors = parts.shift() || "";
          title = parts.join(". ");
        } else {
          title = beforeDate;
        }
      }
    }
  } else {
    const yearMarker = body.match(/\(?((?:18|19|20)\d{2})[a-z]?\)?\s*[.,，。]/i);
    if (yearMarker) {
      authors = cleanValue(body.slice(0, yearMarker.index));
      const after = body.slice(yearMarker.index + yearMarker[0].length).trim();
      title = cleanValue(after.split(/[.。]\s+/)[0] || "");
    }
  }

  const years = [...body.matchAll(/(?:18|19|20)\d{2}/g)].map((match) => Number(match[0]));
  const year = publicationDate
    ? Number(publicationDate.slice(0, 4))
    : years.length
      ? years[years.length - 1]
      : null;
  const volIssue = body.match(
    /(?:18|19|20)\d{2}\s*[,，]\s*([A-Za-z]?\d+[A-Za-z]?)\s*(?:\(\s*([^)]+?)\s*\))?/
  );
  const pageMatches = [...body.matchAll(
    /[:：]\s*([A-Za-z]?\d+(?:\s*[-–—]\s*[A-Za-z]?\d+)?)(?=\s*(?:[.,，。;；]|$))/g
  )];

  return {
    raw,
    work,
    doi,
    isbn,
    pmid,
    arxivId,
    standardNumber,
    patentNumber,
    url,
    type,
    title,
    authors,
    container,
    year,
    publicationDate,
    accessDate,
    volume: volIssue?.[1] || "",
    issue: volIssue?.[2] || "",
    pages: pageMatches[pageMatches.length - 1]?.[1]?.replace(/\s*[–—]\s*/g, "-") || ""
  };
}

function splitSubmittedAuthors(value) {
  return String(value || "")
    .replace(/\bet\s+al\.?/ig, "")
    .split(/\s*(?:,|，|、|;|；|\band\b|&)\s*/i)
    .map(cleanValue)
    .filter(Boolean);
}

function authorKey(name) {
  const value = String(name || "").trim();
  const parts = value.split(/\s+/).filter(Boolean);
  if (!value) return "";
  if (/^[\u3400-\u9fff\s·]+$/.test(value)) {
    return normalizeText(parts.length > 1 ? parts[parts.length - 1] : value.slice(0, 1));
  }
  return normalizeText(parts[parts.length - 1] || value);
}

function scholarlyEvidenceLinks(parsed, doi = "") {
  const terms = [
    parsed.title ? `"${parsed.title}"` : "",
    parsed.authors,
    parsed.container
  ].filter(Boolean).join(" ");
  const title = parsed.title || parsed.work;
  const links = [
    {
      label: "复制搜索引擎复核链接",
      url: `https://www.baidu.com/s?wd=${encodeURIComponent(terms)}`
    }
  ];
  if (hasHan(parsed.raw)) {
    links.push(
      {
        label: "复制万方题名检索链接",
        url: `https://s.wanfangdata.com.cn/paper?q=${encodeURIComponent(title)}`
      },
      {
        label: "复制 PubScholar 检索链接",
        url: `https://pubscholar.cn/explore?query=${encodeURIComponent(title)}&searchType=article`
      }
    );
    if (doi) {
      links.unshift({
        label: "复制万方 DOI 记录链接",
        url: `https://doi.wanfangdata.com.cn/${encodeURIComponent(doi)}`
      });
    }
  } else {
    links.push({
      label: "复制 Semantic Scholar 检索链接",
      url: `https://www.semanticscholar.org/search?q=${encodeURIComponent(title)}&sort=relevance`
    });
  }
  if (parsed.isbn) {
    links.unshift({
      label: "复制 Open Library ISBN 记录链接",
      url: `https://openlibrary.org/isbn/${encodeURIComponent(parsed.isbn)}`
    });
  }
  if (parsed.pmid) {
    links.unshift({
      label: "复制 PubMed 记录链接",
      url: `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(parsed.pmid)}/`
    });
  }
  if (parsed.arxivId) {
    links.unshift({
      label: "复制 arXiv 官方记录链接",
      url: `https://arxiv.org/abs/${encodeURIComponent(parsed.arxivId)}`
    });
  }
  if (parsed.standardNumber) {
    links.unshift({
      label: "复制国家标准全文公开系统入口",
      url: "https://openstd.samr.gov.cn/bzgk/gb/index"
    });
  }
  if (parsed.patentNumber) {
    links.unshift({
      label: "复制专利号检索链接",
      url: `https://www.baidu.com/s?wd=${encodeURIComponent(parsed.patentNumber)}`
    });
  }
  return links;
}

function webEvidenceLinks(parsed) {
  let host = "";
  try {
    host = new URL(parsed.url).hostname;
  } catch {}
  const terms = [
    parsed.title ? `"${parsed.title}"` : "",
    parsed.authors,
    host ? `site:${host}` : ""
  ].filter(Boolean).join(" ");
  const links = [];
  if (hasHan(parsed.raw)) {
    links.push({
      label: "复制搜索引擎复核链接",
      url: `https://www.baidu.com/s?wd=${encodeURIComponent(terms)}`
    });
  }
  return links;
}

async function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT) {
  const controller = new CompatibleAbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await compatibleFetch(url, {
      redirect: "follow",
      ...options,
      headers: {
        "user-agent": USER_AGENT,
        accept: "*/*",
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeout = REQUEST_TIMEOUT) {
  const response = await fetchWithTimeout(url, {
    headers: { accept: "application/json" }
  }, timeout);
  return response.json();
}

async function fetchText(url, timeout = REQUEST_TIMEOUT) {
  const response = await fetchWithTimeout(url, {
    headers: { accept: "text/plain, text/x-bibliography;q=0.9, */*;q=0.2" }
  }, timeout);
  return response.text();
}

function publicIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  ) {
    return false;
  }
  return true;
}

function publicIp(address) {
  const family = net.isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family !== 6) return false;
  const value = address.toLowerCase().split("%")[0];
  if (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/.test(value) ||
    value.startsWith("2001:db8:")
  ) {
    return false;
  }
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? publicIpv4(mapped[1]) : true;
}

async function assertPublicUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("仅支持 HTTP 或 HTTPS 网页地址");
  }
  if (url.username || url.password) throw new Error("网址不能包含登录凭据");
  if (url.port && !["80", "443"].includes(url.port)) {
    throw new Error("网址使用了不允许的端口");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("网址指向非公开网络地址");
  }
  const literalFamily = net.isIP(host);
  const addresses = literalFamily
    ? [{ address: host }]
    : await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => !publicIp(item.address))) {
    throw new Error("网址指向非公开网络地址");
  }
  return url;
}

async function fetchPublicPage(value, options = {}, timeout = 2100) {
  const controller = new CompatibleAbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let current = value;
  try {
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      const checked = await assertPublicUrl(current);
      const response = await compatibleFetch(checked.href, {
        ...options,
        redirect: "manual",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/pdf;q=0.7,*/*;q=0.2",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
          ...(options.headers || {})
        },
        signal: controller.signal
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("网页跳转地址无效");
        current = new URL(location, checked).href;
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { response, finalUrl: checked.href };
    }
    throw new Error("网页跳转次数过多");
  } finally {
    clearTimeout(timer);
  }
}

function yearFromCrossref(item) {
  for (const key of ["published-print", "published-online", "published", "issued", "created"]) {
    const value = item?.[key]?.["date-parts"]?.[0]?.[0];
    if (value) return Number(value);
  }
  return null;
}

function crossrefCandidate(item, exactDoi = false) {
  const people = (item.author || [])
    .map((author) => cleanValue([author.given, author.family].filter(Boolean).join(" ")))
    .filter(Boolean);
  return {
    source: "Crossref",
    sources: ["Crossref"],
    exactDoi,
    title: Array.isArray(item.title) ? item.title[0] : item.title || "",
    authors: people,
    authorKeys: (item.author || [])
      .map((author) => normalizeText(author.family || authorKey([author.given, author.family].filter(Boolean).join(" "))))
      .filter(Boolean),
    year: yearFromCrossref(item),
    container: Array.isArray(item["container-title"])
      ? item["container-title"][0]
      : item["container-title"] || "",
    volume: item.volume || "",
    issue: item.issue || "",
    pages: item.page?.replace(/[–—]/g, "-") || "",
    doi: String(item.DOI || "").toLowerCase(),
    type: item.type || "",
    sourceUrl: item.DOI ? `https://doi.org/${item.DOI}` : item.URL || ""
  };
}

function openAlexCandidate(item, exactDoi = false) {
  const people = (item.authorships || [])
    .map((authorship) => authorship.author?.display_name || authorship.raw_author_name)
    .filter(Boolean);
  const biblio = item.biblio || {};
  const location = item.primary_location || {};
  return {
    source: "OpenAlex",
    sources: ["OpenAlex"],
    exactDoi,
    title: item.title || item.display_name || "",
    authors: people,
    authorKeys: people.map(authorKey).filter(Boolean),
    year: item.publication_year || null,
    container: location.source?.display_name || location.raw_source_name || "",
    volume: biblio.volume || "",
    issue: biblio.issue || "",
    pages: biblio.first_page
      ? (biblio.last_page && biblio.last_page !== biblio.first_page
        ? `${biblio.first_page}-${biblio.last_page}`
        : String(biblio.first_page))
      : "",
    doi: String(item.doi || "").replace(/^https?:\/\/doi\.org\//i, "").toLowerCase(),
    type: item.type || location.raw_type || "",
    sourceUrl: item.doi || location.landing_page_url || item.id || ""
  };
}

function semanticScholarCandidate(item) {
  const people = (item.authors || []).map((author) => cleanValue(author?.name)).filter(Boolean);
  const externalIds = item.externalIds || {};
  return {
    source: "Semantic Scholar",
    sources: ["Semantic Scholar"],
    exactDoi: false,
    title: item.title || "",
    authors: people,
    authorKeys: people.map(authorKey).filter(Boolean),
    year: item.year || null,
    container: item.venue || "",
    volume: "",
    issue: "",
    pages: "",
    doi: String(externalIds.DOI || externalIds.Doi || "").toLowerCase(),
    type: (item.publicationTypes || []).filter(Boolean).join(" "),
    sourceUrl: item.url || item.openAccessPdf?.url || ""
  };
}

function queryVerifiedReferenceIndex(parsed) {
  const candidates = VERIFIED_REFERENCE_INDEX
    .filter((record) => diceSimilarity(parsed.title, record.title) >= 0.96)
    .map((record) => ({
      ...record,
      sources: [record.source],
      authorKeys: record.authors.map(authorKey).filter(Boolean),
      exactDoi: false,
      trustedIndex: true
    }));
  return {
    source: "已核对权威来源索引",
    candidates
  };
}

async function queryCrossref(parsed) {
  const fields = "DOI,title,author,published,container-title,type,URL,page,volume,issue";
  const jobs = [];
  if (parsed.doi) {
    jobs.push({
      exact: true,
      url: `https://api.crossref.org/works/${encodeURIComponent(parsed.doi)}`
    });
  }
  jobs.push({
    exact: false,
    url: `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(parsed.work)}&rows=5&select=${fields}&mailto=linhu%40scu.edu.cn`
  });

  const settled = await Promise.allSettled(jobs.map((job) => fetchJson(job.url)));
  const candidates = [];
  settled.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    const message = result.value?.message;
    const items = Array.isArray(message?.items) ? message.items : message ? [message] : [];
    items.forEach((item) => candidates.push(crossrefCandidate(item, jobs[index].exact)));
  });
  if (settled.every((item) => item.status === "rejected")) {
    throw new Error("Crossref 无法连接");
  }
  return { source: "Crossref", candidates };
}

async function queryOpenAlex(parsed) {
  const select = "id,doi,title,display_name,publication_year,type,authorships,primary_location,biblio";
  const jobs = [];
  if (parsed.doi) {
    jobs.push({
      exact: true,
      url: `https://api.openalex.org/works?filter=doi:${encodeURIComponent(`https://doi.org/${parsed.doi}`)}&per-page=3&select=${select}&mailto=linhu%40scu.edu.cn`
    });
  }
  const query = parsed.title && normalizeText(parsed.title).length >= 4
    ? parsed.title
    : parsed.work;
  jobs.push({
    exact: false,
    url: `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=5&select=${select}&mailto=linhu%40scu.edu.cn`
  });

  const settled = await Promise.allSettled(jobs.map((job) => fetchJson(job.url)));
  const candidates = [];
  settled.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    (result.value?.results || []).forEach((item) => {
      candidates.push(openAlexCandidate(item, jobs[index].exact));
    });
  });
  if (settled.every((item) => item.status === "rejected")) {
    throw new Error("OpenAlex 无法连接");
  }
  return { source: "OpenAlex", candidates };
}

async function querySemanticScholar(parsed) {
  const title = cleanValue(parsed.title);
  if (!title || normalizeText(title).length < 4) {
    return { source: "Semantic Scholar", candidates: [] };
  }
  const endpoint = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  endpoint.searchParams.set("query", title);
  endpoint.searchParams.set("limit", "10");
  endpoint.searchParams.set(
    "fields",
    "title,authors,year,venue,publicationTypes,externalIds,url,openAccessPdf"
  );
  const data = await fetchJson(endpoint.href);
  return {
    source: "Semantic Scholar",
    candidates: (data?.data || []).map(semanticScholarCandidate)
  };
}

function openLibraryCandidate(item, isbn = "") {
  const authors = (item.authors || item.author_name || [])
    .map((author) => cleanValue(author?.name || author))
    .filter(Boolean);
  const publishers = (item.publishers || item.publisher || [])
    .map((publisher) => cleanValue(publisher?.name || publisher))
    .filter(Boolean);
  const publishDate = String(item.publish_date || item.first_publish_year || "");
  const year = Number(publishDate.match(/(?:18|19|20)\d{2}/)?.[0]) || null;
  const key = item.key || "";
  return {
    source: "Open Library",
    sources: ["Open Library"],
    exactDoi: false,
    title: item.title || "",
    authors,
    authorKeys: authors.map(authorKey).filter(Boolean),
    year,
    container: publishers[0] || "",
    volume: "",
    issue: "",
    pages: item.number_of_pages || "",
    doi: "",
    isbn: isbn || (item.isbn || [])[0] || "",
    type: "book",
    sourceUrl: key
      ? `https://openlibrary.org${key.startsWith("/") ? key : `/${key}`}`
      : isbn
        ? `https://openlibrary.org/isbn/${isbn}`
        : ""
  };
}

async function queryOpenLibrary(parsed) {
  if (parsed.isbn) {
    const bibkey = `ISBN:${parsed.isbn}`;
    const endpoint = `https://openlibrary.org/api/books?bibkeys=${encodeURIComponent(bibkey)}&format=json&jscmd=data`;
    const data = await fetchJson(endpoint);
    const item = data?.[bibkey];
    return {
      source: "Open Library",
      candidates: item ? [openLibraryCandidate(item, parsed.isbn)] : []
    };
  }
  const endpoint = new URL("https://openlibrary.org/search.json");
  endpoint.searchParams.set("title", parsed.title || parsed.work);
  const author = splitSubmittedAuthors(parsed.authors)[0];
  if (author) endpoint.searchParams.set("author", author);
  endpoint.searchParams.set("limit", "5");
  endpoint.searchParams.set(
    "fields",
    "key,title,author_name,first_publish_year,publisher,isbn"
  );
  const data = await fetchJson(endpoint.href);
  return {
    source: "Open Library",
    candidates: (data?.docs || []).map((item) => openLibraryCandidate(item))
  };
}

async function queryPubMed(parsed) {
  if (!parsed.pmid) return { source: "PubMed", candidates: [] };
  const endpoint = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
  endpoint.searchParams.set("db", "pubmed");
  endpoint.searchParams.set("id", parsed.pmid);
  endpoint.searchParams.set("retmode", "json");
  const data = await fetchJson(endpoint.href);
  const item = data?.result?.[parsed.pmid];
  if (!item) return { source: "PubMed", candidates: [] };
  const authors = (item.authors || []).map((author) => cleanValue(author.name)).filter(Boolean);
  const doi = (item.articleids || []).find((entry) => entry.idtype === "doi")?.value || "";
  return {
    source: "PubMed",
    candidates: [{
      source: "PubMed",
      sources: ["PubMed"],
      exactDoi: Boolean(parsed.doi && doi && parsed.doi === doi.toLowerCase()),
      title: cleanValue(item.title),
      authors,
      authorKeys: authors.map(authorKey).filter(Boolean),
      year: Number(String(item.pubdate || "").match(/(?:18|19|20)\d{2}/)?.[0]) || null,
      container: cleanValue(item.fulljournalname || item.source),
      volume: cleanValue(item.volume),
      issue: cleanValue(item.issue),
      pages: cleanValue(item.pages).replace(/[–—]/g, "-"),
      doi: String(doi).toLowerCase(),
      pmid: parsed.pmid,
      type: "journal-article",
      sourceUrl: `https://pubmed.ncbi.nlm.nih.gov/${parsed.pmid}/`
    }]
  };
}

async function queryArxiv(parsed) {
  if (!parsed.arxivId) return { source: "arXiv", candidates: [] };
  const xml = await fetchText(
    `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(parsed.arxivId)}`
  );
  const $ = cheerio.load(xml, { xmlMode: true });
  const entry = $("entry").first();
  if (!entry.length) return { source: "arXiv", candidates: [] };
  const authors = entry.find("author > name").map((_, node) => cleanValue($(node).text())).get();
  const published = cleanValue(entry.find("published").first().text());
  return {
    source: "arXiv",
    candidates: [{
      source: "arXiv",
      sources: ["arXiv"],
      exactDoi: false,
      title: cleanValue(entry.find("title").first().text().replace(/\s+/g, " ")),
      authors,
      authorKeys: authors.map(authorKey).filter(Boolean),
      year: Number(published.slice(0, 4)) || null,
      container: "arXiv",
      volume: "",
      issue: "",
      pages: "",
      doi: cleanValue(entry.find("arxiv\\:doi, doi").first().text()).toLowerCase(),
      arxivId: parsed.arxivId,
      type: "report",
      sourceUrl: `https://arxiv.org/abs/${parsed.arxivId}`
    }]
  };
}

function buildVerificationPlan(parsed) {
  const providers = [];
  const add = (name) => {
    if (!providers.includes(name)) providers.push(name);
  };
  const type = baseReferenceType(parsed.type);

  if (parsed.isbn || type === "M") add("open-library");
  if (parsed.pmid) add("pubmed");
  if (parsed.arxivId) add("arxiv");

  if (!["S", "P", "N", "EB", "DB", "CP"].includes(type)) {
    add("crossref");
    add("openalex");
  }
  if (parsed.doi) add("doi-registry");
  if (!parsed.doi && !hasHan(parsed.title) && type !== "M") add("semantic-scholar");
  if (hasHan(parsed.raw)) add("search-engine");
  return providers;
}

function providerJob(provider, parsed) {
  if (provider === "crossref") {
    return { source: "Crossref", promise: queryCrossref(parsed) };
  }
  if (provider === "openalex") {
    return { source: "OpenAlex", promise: queryOpenAlex(parsed) };
  }
  if (provider === "doi-registry") {
    return { source: "DOI 注册元数据", promise: queryDoiRegistry(parsed) };
  }
  if (provider === "semantic-scholar") {
    return { source: "Semantic Scholar", promise: querySemanticScholar(parsed) };
  }
  if (provider === "search-engine") {
    return { source: "搜索引擎结果摘要", promise: querySearchEngineEvidence(parsed) };
  }
  if (provider === "open-library") {
    return { source: "Open Library", promise: queryOpenLibrary(parsed) };
  }
  if (provider === "pubmed") {
    return { source: "PubMed", promise: queryPubMed(parsed) };
  }
  if (provider === "arxiv") {
    return { source: "arXiv", promise: queryArxiv(parsed) };
  }
  throw new Error(`未知核验来源：${provider}`);
}

function searchSnippetCandidate(parsed, sourceUrl, evidenceText = "") {
  const block = normalizeText(evidenceText);
  const authors = splitSubmittedAuthors(parsed.authors).filter((author) =>
    block.includes(normalizeText(author))
  );
  const container = parsed.container && block.includes(normalizeText(parsed.container))
    ? parsed.container
    : "";
  const year = parsed.year && block.includes(String(parsed.year))
    ? parsed.year
    : null;
  return {
    source: "搜索引擎结果摘要",
    sources: ["搜索引擎结果摘要"],
    exactDoi: false,
    evidenceStrength: "search-snippet",
    title: parsed.title,
    authors,
    authorKeys: authors.map(authorKey).filter(Boolean),
    year,
    container,
    volume: "",
    issue: "",
    pages: "",
    doi: "",
    type: "",
    sourceUrl
  };
}

async function querySearchEngineEvidence(parsed) {
  const title = cleanValue(parsed.title);
  if (!hasHan(title) || normalizeText(title).length < 6) {
    return { source: "搜索引擎结果摘要", candidates: [] };
  }

  const terms = [
    `"${title}"`,
    splitSubmittedAuthors(parsed.authors)[0] || "",
    parsed.container || ""
  ].filter(Boolean).join(" ");
  const searchUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(terms)}`;
  const response = await fetchWithTimeout(searchUrl, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "accept-language": "zh-CN,zh;q=0.9"
    }
  });
  const html = await response.text();
  const $ = cheerio.load(html);
  const titleKey = normalizeText(title);
  const supportTerms = [
    ...splitSubmittedAuthors(parsed.authors),
    parsed.container,
    parsed.year ? String(parsed.year) : ""
  ].map(normalizeText).filter((value) => value.length >= 2);
  let evidenceUrl = "";
  let evidenceText = "";

  $(".result, .c-container").each((_, element) => {
    if (evidenceUrl) return;
    const node = $(element);
    const block = normalizeText(node.text());
    if (!block.includes(titleKey)) return;
    if (!supportTerms.some((term) => block.includes(term))) return;
    evidenceText = node.text();
    evidenceUrl = cleanValue(
      node.attr("mu") ||
      node.find("h3 a").first().attr("href") ||
      node.find("a").first().attr("href") ||
      searchUrl
    );
  });

  return {
    source: "搜索引擎结果摘要",
    candidates: evidenceUrl
      ? [searchSnippetCandidate(parsed, evidenceUrl, evidenceText)]
      : []
  };
}

function parseDoiCitation(text, doi, parsed) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const withoutUrl = raw.replace(/\s*https?:\/\/doi\.org\/\S+\s*$/i, "").trim();
  const head = withoutUrl.match(/^(.*?)\.\s*\((\d{4})\)\.\s*(.+)$/);
  const tail = head?.[3]?.match(
    /^(.+)\.\s+([^,]+),\s*([^,(]+?)(?:\(([^)]+)\))?,\s*([^.]+)\.?$/
  );
  if (!head || !tail) return null;

  const registryAuthors = head[1]
    .split(/\s*(?:，|、|；|;|\s&\s)\s*/)
    .map(cleanValue)
    .filter(Boolean);
  const submittedAuthors = splitSubmittedAuthors(parsed.authors);
  const authorCovered = Boolean(
    registryAuthors.length &&
    registryAuthors.every((name) => submittedAuthors.some(
      (submitted) => authorKey(submitted) === authorKey(name) ||
        diceSimilarity(submitted, name) > 0.82
    ))
  );
  const partialAuthors = authorCovered && submittedAuthors.length > registryAuthors.length;
  const registryPages = cleanValue(tail[5]).replace(/[–—]/g, "-");
  const partialPages = Boolean(
    parsed.pages &&
    registryPages &&
    !registryPages.includes("-") &&
    parsed.pages.startsWith(`${registryPages}-`)
  );
  const authors = partialAuthors ? submittedAuthors : registryAuthors;
  const pages = partialPages ? parsed.pages : registryPages;
  const partialFields = [];
  if (partialAuthors) partialFields.push("其余作者");
  if (partialPages) partialFields.push("末页");

  return {
    source: "DOI 注册元数据",
    sources: ["DOI 注册元数据"],
    exactDoi: true,
    title: cleanValue(tail[1]),
    authors,
    authorKeys: authors.map(authorKey).filter(Boolean),
    year: Number(head[2]),
    container: cleanValue(tail[2]),
    volume: cleanValue(tail[3]),
    issue: cleanValue(tail[4]),
    pages,
    doi: String(doi).toLowerCase(),
    type: "journal-article",
    sourceUrl: `https://doi.org/${doi}`,
    partialFields
  };
}

async function fetchDoiCitation(doi, parsed) {
  const url = `https://citation.doi.org/format?doi=${encodeURIComponent(doi)}&style=apa&lang=zh-CN`;
  const text = await fetchText(url);
  return parseDoiCitation(text, doi, parsed);
}

const JOURNAL_INDEX = (() => {
  const index = new Map();
  JOURNALS.forEach((row) => {
    const key = normalizeText(row.title);
    if (!key || !row.issn) return;
    const values = index.get(key) || [];
    if (!values.includes(row.issn)) values.push(row.issn);
    index.set(key, values);
  });
  return index;
})();

function likelyArticleSequences(pages) {
  const start = Number(String(pages || "").match(/\d+/)?.[0]);
  const seeds = start
    ? [
      Math.max(1, Math.round((start - 1) / 10) + 1),
      Math.max(1, Math.round((start - 1) / 8) + 1),
      Math.max(1, Math.round((start - 1) / 12) + 1)
    ]
    : [1, 4, 8];
  const offsets = [0, -1, 1, -2, 2, -3, 3];
  const output = [];
  seeds.forEach((seed) => offsets.forEach((offset) => {
    const value = seed + offset;
    if (value > 0 && value <= 80 && !output.includes(value)) output.push(value);
  }));
  [1, 2, 3, 4, 5].forEach((value) => {
    if (!output.includes(value)) output.push(value);
  });
  return output.slice(0, 16);
}

async function inferChineseDoi(parsed) {
  if (
    parsed.doi ||
    !hasHan(parsed.title) ||
    !parsed.container ||
    !parsed.year ||
    !parsed.issue ||
    (parsed.type && parsed.type !== "J")
  ) {
    return [];
  }

  const containerKey = normalizeText(parsed.container);
  let issns = JOURNAL_INDEX.get(containerKey) || [];
  if (!issns.length) {
    const nearest = JOURNALS
      .map((row) => ({ row, score: diceSimilarity(parsed.container, row.title) }))
      .sort((a, b) => b.score - a.score)[0];
    if (nearest?.score >= 0.92) issns = [nearest.row.issn];
  }
  if (!issns.length) return [];

  const issueNumber = Number(String(parsed.issue).match(/\d+/)?.[0]);
  if (!issueNumber) return [];
  const sequences = likelyArticleSequences(parsed.pages);
  const close = [];

  for (const issn of issns.slice(0, 2)) {
    const primary = sequences[0];
    const patterns = [
      [parsed.year, issueNumber, primary],
      [parsed.year - 1, issueNumber, primary],
      [parsed.year + 1, issueNumber, primary],
      [parsed.year, Math.max(1, issueNumber - 1), primary],
      [parsed.year, issueNumber + 1, primary],
      ...sequences.slice(1).map((sequence) => [parsed.year, issueNumber, sequence])
    ];

    for (let start = 0; start < patterns.length; start += 5) {
      const dois = patterns.slice(start, start + 5).map(([year, issue, sequence]) =>
        `10.3969/j.issn.${issn}.${year}.${String(issue).padStart(2, "0")}.${String(sequence).padStart(3, "0")}`
      );
      const settled = await Promise.allSettled(
        dois.map((doi) => fetchDoiCitation(doi, parsed))
      );
      settled.forEach((result) => {
        if (result.status !== "fulfilled" || !result.value) return;
        const score = diceSimilarity(parsed.title, result.value.title);
        if (score >= 0.72) close.push({ candidate: result.value, score });
      });
      const exact = close.sort((a, b) => b.score - a.score)[0];
      if (exact?.score >= 0.9) return [exact.candidate];
    }
  }
  return close
    .sort((a, b) => b.score - a.score)
    .slice(0, 1)
    .map((item) => item.candidate);
}

async function queryDoiRegistry(parsed) {
  if (parsed.doi) {
    const candidate = await fetchDoiCitation(parsed.doi, parsed);
    return {
      source: "DOI 注册元数据",
      candidates: candidate ? [candidate] : []
    };
  }
  return {
    source: "DOI 注册元数据",
    candidates: await inferChineseDoi(parsed)
  };
}

function mergeCandidates(candidates) {
  const merged = new Map();
  for (const candidate of candidates) {
    if (!candidate.title && !candidate.doi) continue;
    const key = candidate.doi
      ? `doi:${candidate.doi}`
      : `title:${normalizeText(candidate.title)}:${candidate.year || ""}`;
    const prior = merged.get(key);
    if (!prior) {
      merged.set(key, {
        ...candidate,
        sources: [...(candidate.sources || [candidate.source])],
        partialFields: [...(candidate.partialFields || [])]
      });
      continue;
    }
    prior.sources = [...new Set([...prior.sources, ...(candidate.sources || [candidate.source])])];
    prior.source = prior.sources.join(" + ");
    prior.exactDoi = prior.exactDoi || candidate.exactDoi;
    prior.partialFields = [...new Set([
      ...(prior.partialFields || []),
      ...(candidate.partialFields || [])
    ])];
    for (const field of [
      "title", "authors", "authorKeys", "year", "container",
      "volume", "issue", "pages", "doi", "isbn", "pmid", "arxivId", "type", "sourceUrl"
    ]) {
      if (!prior[field] && candidate[field]) prior[field] = candidate[field];
    }
  }
  return [...merged.values()];
}

function authorAgreement(parsed, candidate) {
  if (!parsed.authors || !candidate.authorKeys?.length) return 0.5;
  const submitted = normalizeText(parsed.authors);
  const keys = [...new Set(candidate.authorKeys)].filter(Boolean);
  const hits = keys.filter(
    (key) => key.length && (submitted.includes(key) || diceSimilarity(submitted, key) > 0.72)
  ).length;
  if (!hits) return 0;
  return Math.min(1, 0.65 + (0.35 * hits) / Math.min(keys.length, 3));
}

function scoreCandidate(parsed, candidate) {
  const titleScore = parsed.title
    ? diceSimilarity(parsed.title, candidate.title)
    : normalizeText(parsed.raw).includes(normalizeText(candidate.title))
      ? 0.92
      : 0;
  const authorScore = authorAgreement(parsed, candidate);
  const containerScore = parsed.container && candidate.container
    ? diceSimilarity(parsed.container, candidate.container)
    : 0.5;
  const identifierPairs = [
    ["doi", parsed.doi, candidate.doi],
    ["isbn", parsed.isbn, candidate.isbn],
    ["pmid", parsed.pmid, candidate.pmid],
    ["arxiv", parsed.arxivId, candidate.arxivId]
  ].filter(([, submitted, verified]) => submitted && verified);
  const exactIdentifiers = identifierPairs.filter(([, submitted, verified]) =>
    normalizeText(submitted) === normalizeText(verified)
  );
  const identifierExact = exactIdentifiers.length > 0;
  const identifierMismatch = identifierPairs.length > 0 && !identifierExact;

  const weights = [];
  if (parsed.title || candidate.title) weights.push([titleScore, 0.62]);
  if (parsed.authors && candidate.authors?.length) weights.push([authorScore, 0.23]);
  if (parsed.container && candidate.container) weights.push([containerScore, 0.15]);

  let score = weights.reduce((sum, [value, weight]) => sum + value * weight, 0) /
    Math.max(0.01, weights.reduce((sum, [, weight]) => sum + weight, 0));
  const authorCorroborates = parsed.authors && candidate.authors?.length &&
    authorScore >= 0.65;
  const containerCorroborates = parsed.container && candidate.container &&
    containerScore >= 0.82;
  const strongTextIdentity = titleScore >= 0.94 &&
    (authorCorroborates || containerCorroborates);
  const hasCorroboration = identifierExact || authorCorroborates || containerCorroborates;

  if (identifierExact && (!parsed.title || titleScore >= 0.72)) {
    score = Math.max(score, 0.97);
  } else if (
    candidate.trustedIndex &&
    titleScore >= 0.9 &&
    (authorScore >= 0.55 || containerScore >= 0.7)
  ) {
    score = Math.max(score, 0.96);
  } else if (strongTextIdentity) {
    score = Math.max(score, 0.9);
  } else if (identifierMismatch) {
    score = Math.min(score, 0.64);
  }
  if (!hasCorroboration && !candidate.trustedIndex) score = Math.min(score, 0.79);
  if (titleScore < 0.58 && parsed.title) score = Math.min(score, 0.62);
  if (
    parsed.authors &&
    candidate.authors?.length &&
    authorScore === 0 &&
    !identifierExact &&
    titleScore < 0.97
  ) {
    score = Math.min(score, 0.66);
  }
  if (candidate.evidenceStrength === "search-snippet") score = Math.min(score, 0.9);

  const basis = [];
  if (identifierExact) basis.push(`标识符一致（${exactIdentifiers.map(([name]) => name.toUpperCase()).join("、")}）`);
  if (titleScore >= 0.86) basis.push("篇名高度一致");
  if (authorCorroborates) basis.push("作者信息支持");
  if (containerCorroborates) basis.push("来源信息支持");
  if (candidate.trustedIndex) basis.push("权威来源记录");
  if (candidate.evidenceStrength === "search-snippet") basis.push("搜索结果摘要证据");

  return {
    score: Math.max(0, Math.min(0.99, score)),
    titleScore,
    authorScore,
    containerScore,
    identifierExact,
    identifierMismatch,
    basis
  };
}

function displayName(name) {
  const value = cleanValue(name);
  const parts = value.split(/\s+/).filter(Boolean);
  return /^[\u3400-\u9fff\s·]+$/.test(value) && parts.length === 2
    ? parts.reverse().join("")
    : value;
}

function gtAuthor(name) {
  const value = displayName(name);
  if (hasHan(value)) return value;
  const parts = value.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  const family = parts.pop() || "";
  const initials = parts.map((part) => part[0]?.toUpperCase()).filter(Boolean).join(" ");
  return `${family.toUpperCase()}${initials ? ` ${initials}` : ""}`;
}

function canonicalCitation(candidate, parsed) {
  const names = (candidate.authors || []).map(gtAuthor).filter(Boolean);
  const chinese = names.some(hasHan);
  let authors = names.slice(0, 3).join(chinese ? "，" : ", ");
  if (names.length > 3) authors += chinese ? "，等" : ", et al.";
  const candidateType = String(candidate.type || "").toLowerCase();
  const type = /book/.test(candidateType)
    ? "M"
    : /proceedings|conference/.test(candidateType)
      ? "C"
      : /report/.test(candidateType)
        ? (candidate.sourceUrl ? "R/OL" : "R")
        : parsed?.type || "J";
  const submittedTitle = cleanValue(parsed?.title);
  const verifiedTitle = cleanValue(candidate.title);
  const submittedNorm = normalizeText(submittedTitle);
  const verifiedNorm = normalizeText(verifiedTitle);
  const title = submittedNorm && verifiedNorm && submittedNorm.includes(verifiedNorm)
    ? submittedTitle
    : verifiedTitle;
  const container = cleanValue(candidate.container || parsed?.container);
  const year = candidate.year || parsed?.year;
  const isReport = /report/.test(candidateType);
  const volume = isReport ? "" : cleanValue(candidate.volume || parsed?.volume);
  const issue = isReport ? "" : cleanValue(candidate.issue || parsed?.issue);
  const pages = isReport ? "" : cleanValue(candidate.pages || parsed?.pages);

  let citation = `${authors ? `${authors}. ` : ""}${title}[${type}]`;
  if (container) citation += type === "C" ? `//${container}` : `. ${container}`;
  if (year) citation += `${container ? ", " : ". "}${year}`;
  if (volume) citation += `, ${volume}${issue ? `(${issue})` : ""}`;
  if (pages) citation += `: ${pages}`;
  citation += ".";
  if (candidate.doi) citation += ` DOI:${candidate.doi}.`;
  if (type.includes("/OL") && candidate.sourceUrl) {
    citation += ` ${candidate.sourceUrl}.`;
  }
  return citation.replace(/\.\./g, ".");
}

function missingMetadataFields(parsed, candidate) {
  const fields = [];
  const candidateType = String(candidate.type || "").toLowerCase();
  const journalLike = /article|journal/.test(candidateType);
  if (parsed.authors && !(candidate.authors || []).length) fields.push("作者");
  if (parsed.year && !candidate.year) fields.push("年份");
  if (parsed.container && !candidate.container) fields.push("刊名/来源");
  if (journalLike && parsed.volume && !candidate.volume) fields.push("卷号");
  if (journalLike && parsed.issue && !candidate.issue) fields.push("期号");
  if (journalLike && parsed.pages && !candidate.pages) fields.push("页码");
  if (parsed.doi && !candidate.doi) fields.push("DOI");
  if (parsed.type && !candidate.type) fields.push("文献类型");
  return fields;
}

function academicDifferences(parsed, candidate, metrics) {
  const output = [];
  const add = (field, submitted, verified) => output.push({
    field,
    submitted: submitted || "未提供",
    verified: verified || "未提供"
  });
  const same = (first, second) => normalizeText(first) === normalizeText(second);
  const sameNumberField = (first, second) => {
    const left = cleanValue(first);
    const right = cleanValue(second);
    if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
      return Number(left) === Number(right);
    }
    return same(left, right);
  };
  const submittedTitle = normalizeText(parsed.title);
  const verifiedTitle = normalizeText(candidate.title);
  const oneContainsOther = submittedTitle && verifiedTitle &&
    (submittedTitle.includes(verifiedTitle) || verifiedTitle.includes(submittedTitle));

  if (
    parsed.title &&
    candidate.title &&
    metrics.titleScore < 0.96 &&
    metrics.titleScore > 0.58 &&
    !oneContainsOther
  ) {
    add("篇名", parsed.title, candidate.title);
  }
  if (
    parsed.authors &&
    candidate.authors?.length &&
    metrics.authorScore < 0.55 &&
    metrics.titleScore > 0.88
  ) {
    add("作者", parsed.authors, candidate.authors.map(displayName).join("，"));
  }
  if (parsed.year && candidate.year && parsed.year !== candidate.year) {
    add("年份", parsed.year, candidate.year);
  }
  if (
    parsed.container &&
    candidate.container &&
    metrics.containerScore < 0.76 &&
    metrics.titleScore > 0.86
  ) {
    add("刊名/来源", parsed.container, candidate.container);
  }
  if (
    parsed.volume &&
    candidate.volume &&
    !sameNumberField(parsed.volume, candidate.volume)
  ) {
    add("卷号", parsed.volume, candidate.volume);
  }
  if (
    parsed.issue &&
    candidate.issue &&
    !sameNumberField(parsed.issue, candidate.issue)
  ) {
    add("期号", parsed.issue, candidate.issue);
  }
  if (
    parsed.pages &&
    candidate.pages &&
    !same(parsed.pages.replace(/[–—]/g, "-"), candidate.pages.replace(/[–—]/g, "-"))
  ) {
    add("页码", parsed.pages, candidate.pages);
  }
  if (parsed.doi && candidate.doi && parsed.doi !== candidate.doi) {
    add("DOI", parsed.doi, candidate.doi);
  }
  const candidateType = String(candidate.type || "").toLowerCase();
  const verifiedType = /book/.test(candidateType)
    ? "M"
    : /proceedings|conference/.test(candidateType)
      ? "C"
      : /report/.test(candidateType)
        ? (candidate.sourceUrl ? "R/OL" : "R")
        : /article|journal/.test(candidateType)
          ? "J"
          : "";
  if (parsed.type && verifiedType && parsed.type !== verifiedType) {
    add("文献类型", `[${parsed.type}]`, `[${verifiedType}]`);
  }
  return output;
}

function pageValues($, selectors) {
  const values = [];
  selectors.forEach((selector) => {
    $(selector).each((_, element) => {
      const node = $(element);
      const value = cleanWebField(
        node.attr("content") ||
        node.attr("datetime") ||
        node.text()
      );
      if (value && !values.includes(value)) values.push(value);
    });
  });
  return values;
}

function firstPageValue($, selectors) {
  return pageValues($, selectors)[0] || "";
}

function labeledPageValue(text, labels, stops) {
  const source = String(text || "").replace(/\s+/g, " ");
  for (const label of labels) {
    const stop = stops.length ? `(?=${stops.map((item) => `${item}\\s*[:：]`).join("|")}|$)` : "$";
    const expression = new RegExp(`${label}\\s*[:：]\\s*(.{1,180}?)${stop}`, "i");
    const match = source.match(expression);
    if (match?.[1]) return cleanWebField(match[1]);
  }
  return "";
}

function decodeHtml(buffer, contentType = "") {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const head = bytes.subarray(0, Math.min(bytes.length, 8192)).toString("latin1");
  const declared = `${contentType} ${head}`.match(
    /charset\s*=\s*["']?\s*([A-Za-z0-9._-]+)/i
  )?.[1]?.toLowerCase();
  let encoding = declared || "utf-8";
  if (/^(?:gb2312|gbk|x-gbk|gb_2312-80)$/.test(encoding)) encoding = "gb18030";
  if (!iconv.encodingExists(encoding)) encoding = "utf-8";
  return iconv.decode(bytes, encoding);
}

function chooseBestPageTitle(parsedTitle, titles) {
  const unique = [...new Set(titles.map(cleanWebField).filter(Boolean))];
  if (!unique.length) return "";
  if (!parsedTitle) return unique[0];
  return unique
    .map((title) => ({ title, score: diceSimilarity(parsedTitle, title) }))
    .sort((a, b) => b.score - a.score)[0].title;
}

async function fetchWebCandidate(parsed) {
  const { response, finalUrl } = await fetchPublicPage(parsed.url);
  const contentType = response.headers.get("content-type") || "";
  const length = Number(response.headers.get("content-length") || 0);
  if (length > 4 * 1024 * 1024) throw new Error("原始页面内容过大");
  const buffer = typeof response.arrayBuffer === "function"
    ? Buffer.from(await response.arrayBuffer())
    : await response.buffer();
  if (buffer.length > 4 * 1024 * 1024) throw new Error("原始页面内容过大");

  if (/application\/pdf/i.test(contentType) || buffer.subarray(0, 4).toString() === "%PDF") {
    return {
      source: "提交的原始网址",
      sourceUrl: finalUrl || parsed.url,
      reachable: true,
      title: "",
      authors: [],
      publicationDate: "",
      year: null,
      container: "",
      contentType: "pdf"
    };
  }

  const html = decodeHtml(buffer, contentType);
  const $ = cheerio.load(html);
  const titles = pageValues($, [
    'meta[name="citation_title"]',
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    'meta[name="dc.title"]',
    "main h1",
    "article h1",
    "h1",
    "title"
  ]);
  const title = chooseBestPageTitle(parsed.title, titles);
  const metaAuthors = pageValues($, [
    'meta[name="citation_author"]',
    'meta[name="author"]',
    'meta[property="article:author"]',
    'meta[name="dc.creator"]'
  ]);
  const visibleText = cleanWebField($("body").text()).slice(0, 140000);
  const labeledAuthor = labeledPageValue(
    visibleText,
    ["作者", "记者", "撰稿"],
    ["责任编辑", "编辑", "文章来源", "来源", "发布时间", "发布日期", "时间"]
  );
  const authors = metaAuthors.length
    ? metaAuthors
    : labeledAuthor
      ? splitSubmittedAuthors(labeledAuthor)
      : [];
  const rawDate = firstPageValue($, [
    'meta[property="article:published_time"]',
    'meta[name="citation_publication_date"]',
    'meta[name="citation_date"]',
    'meta[name="date"]',
    'meta[name="dc.date"]',
    'meta[name="pubdate"]',
    'meta[name="publishdate"]',
    "time[datetime]"
  ]) || labeledPageValue(
    visibleText,
    ["发布时间", "发布日期", "发布于", "时间"],
    ["文章来源", "来源", "作者", "责任编辑", "编辑"]
  );
  const publicationDate = normalizeDate(rawDate);
  const container = firstPageValue($, [
    'meta[property="og:site_name"]',
    'meta[name="publisher"]',
    'meta[name="citation_publisher"]',
    'meta[name="dc.publisher"]'
  ]) || labeledPageValue(
    visibleText,
    ["文章来源", "来源"],
    ["作者", "责任编辑", "编辑", "发布时间", "发布日期"]
  );

  return {
    source: "提交的原始网址",
    sourceUrl: finalUrl || parsed.url,
    reachable: true,
    title,
    authors,
    publicationDate,
    year: publicationDate ? Number(publicationDate.slice(0, 4)) : null,
    container,
    contentType: "html"
  };
}

function webTitleAgreement(submitted, verified) {
  if (!submitted || !verified) return null;
  const direct = diceSimilarity(submitted, verified);
  const stripped = String(verified).replace(/\s*[-_|｜—–]\s*[^-_|｜—–]{1,60}$/, "");
  return Math.max(direct, diceSimilarity(submitted, stripped));
}

function webAuthorAgreement(submitted, verified) {
  if (!submitted || !verified?.length) return null;
  const submittedNames = splitSubmittedAuthors(submitted);
  if (!submittedNames.length) return null;
  const hits = submittedNames.filter((name) => verified.some(
    (candidate) =>
      authorKey(name) === authorKey(candidate) ||
      diceSimilarity(name, candidate) >= 0.76
  )).length;
  return hits / Math.min(submittedNames.length, Math.max(verified.length, 1));
}

function webDateAgreement(submitted, candidate) {
  if (!submitted || !candidate.publicationDate) return null;
  const first = normalizeDate(submitted);
  const second = normalizeDate(candidate.publicationDate);
  if (!first || !second) return null;
  if (first === second) return 1;
  if (first.slice(0, 4) === second.slice(0, 4) && (first.length === 4 || second.length === 4)) {
    return 0.82;
  }
  return 0;
}

function webCanonicalCitation(candidate, parsed) {
  const authorNames = candidate.authors?.length
    ? candidate.authors.join(hasHan(candidate.authors.join("")) ? "，" : ", ")
    : parsed.authors;
  const title = candidate.title || parsed.title;
  const date = candidate.publicationDate || parsed.publicationDate || parsed.year || "";
  const accessed = parsed.accessDate ? `[${parsed.accessDate}]` : "";
  const source = candidate.container || parsed.container;
  return [
    authorNames ? `${authorNames}.` : "",
    title ? `${title}[EB/OL].` : "",
    source ? `${source}.` : "",
    date ? `(${date})` : "",
    accessed,
    candidate.sourceUrl || parsed.url
  ].filter(Boolean).join(" ").replace(/\s+\./g, ".");
}

async function verifyWebReference(reference, parsed) {
  const evidenceLinks = webEvidenceLinks(parsed);
  try {
    const candidate = await fetchWebCandidate(parsed);
    const titleScore = webTitleAgreement(parsed.title, candidate.title);
    const authorScore = webAuthorAgreement(parsed.authors, candidate.authors);
    const dateScore = webDateAgreement(parsed.publicationDate, candidate);
    const differences = [];
    const add = (field, submitted, verified) => differences.push({
      field,
      submitted: submitted || "未提供",
      verified: verified || "未提供"
    });

    if (
      titleScore !== null &&
      titleScore >= 0.58 &&
      titleScore < 0.9 &&
      candidate.title
    ) {
      add("篇名", parsed.title, candidate.title);
    }
    if (
      authorScore !== null &&
      authorScore < 0.5 &&
      titleScore >= 0.88 &&
      candidate.authors.length
    ) {
      add("作者", parsed.authors, candidate.authors.join("，"));
    }
    if (
      dateScore === 0 &&
      parsed.publicationDate &&
      candidate.publicationDate
    ) {
      add("发布日期", parsed.publicationDate, candidate.publicationDate);
    }

    const today = new Date().toISOString().slice(0, 10);
    const logicalDateProblem = parsed.accessDate && (
      parsed.accessDate > today ||
      (candidate.publicationDate && parsed.accessDate < candidate.publicationDate)
    );
    if (logicalDateProblem) {
      add(
        "访问日期",
        parsed.accessDate,
        parsed.accessDate > today
          ? `不应晚于今天 ${today}`
          : `不应早于发布日期 ${candidate.publicationDate}`
      );
    }

    const hasStrongTitle = titleScore !== null && titleScore >= 0.86;
    const supportingAuthor = authorScore === null || authorScore >= 0.5;
    const confirmed = hasStrongTitle && supportingAuthor;
    let confidence = confirmed
      ? Math.min(0.98, 0.82 + 0.12 * titleScore + (authorScore ?? 0.5) * 0.04)
      : candidate.reachable && hasStrongTitle
        ? 0.8
        : candidate.reachable
          ? 0.42
          : 0;

    if (!candidate.title) {
      return {
        status: "unverified",
        confidence: 0.38,
        submitted: reference,
        differences: [],
        note: candidate.contentType === "pdf"
          ? "原始链接可以访问，但返回的是 PDF，页面未提供足以自动比对题名和作者的结构化信息。请复制原网址继续人工复核。"
          : "原始链接可以访问，但页面没有提供足以自动核对的题名、作者或日期信息。",
        sourceUrl: candidate.sourceUrl,
        source: candidate.source,
        checkedSources: [candidate.source],
        evidenceLinks
      };
    }

    if (!confirmed && titleScore < 0.58) {
      return {
        status: "review",
        confidence,
        submitted: reference,
        differences: [],
        note: "原始网址可以访问，但页面题名与提交题名的匹配度不足，暂不能自动确认是同一文献。",
        sourceUrl: candidate.sourceUrl,
        source: candidate.source,
        checkedSources: [candidate.source],
        evidenceLinks
      };
    }

    const missing = [];
    if (parsed.authors && !candidate.authors.length) missing.push("作者");
    if (parsed.publicationDate && !candidate.publicationDate) missing.push("发布日期");
    const status = differences.length
      ? "corrected"
      : missing.length
        ? "partial"
        : confirmed
          ? "verified"
          : "review";
    let note = differences.length
      ? "已确认原始网址指向同一内容；真实性判断不受下列著录差异影响，但建议修正这些字段。"
      : confirmed
        ? "已读取原始网页，并通过网址、篇名和作者等身份字段确认该文献真实存在。"
        : "已读取原始网页并找到较强匹配，请结合原页面继续复核。";
    if (missing.length && !differences.length) {
      note += ` 页面未提供可自动读取的${missing.join("、")}，相关字段保留原著录。`;
    }
    if (parsed.accessDate && !logicalDateProblem) {
      note += " 访问日期的先后关系合理；该日期只能作逻辑校验。";
    }

    return {
      status,
      confidence,
      authenticityConfidence: confidence,
      submitted: reference,
      differences,
      accuracyDifferences: differences,
      authenticityBasis: [
        "提交网址可以访问",
        "页面篇名高度一致",
        ...(authorScore !== null && authorScore >= 0.5 ? ["作者信息支持"] : [])
      ],
      note,
      canonical: webCanonicalCitation(candidate, parsed),
      sourceUrl: candidate.sourceUrl,
      source: candidate.source,
      checkedSources: [candidate.source],
      evidenceLinks
    };
  } catch (error) {
    const reason = error.name === "AbortError"
      ? "读取原始网页超时"
      : error.message || "无法读取原始网页";
    return {
      status: "unverified",
      confidence: 0,
      submitted: reference,
      differences: [],
      note: `${reason}。这可能是目标网站暂时不可用或限制自动访问，不应据此把文献判为虚假。`,
      sourceUrl: parsed.url,
      source: "提交的原始网址",
      checkedSources: [],
      evidenceLinks
    };
  }
}

async function verifyAcademicReference(reference, parsed) {
  const trusted = queryVerifiedReferenceIndex(parsed);
  const jobs = trusted.candidates.length
    ? [{ source: trusted.source, promise: Promise.resolve(trusted) }]
    : buildVerificationPlan(parsed).map((provider) => providerJob(provider, parsed));
  const checks = await Promise.allSettled(jobs.map((job) => job.promise));
  const available = checks
    .filter((item) => item.status === "fulfilled")
    .map((item) => item.value.source);
  const all = checks.flatMap((item) =>
    item.status === "fulfilled" ? item.value.candidates : []
  );
  let candidates = mergeCandidates(all);
  let ranked = candidates
    .map((candidate) => ({ candidate, metrics: scoreCandidate(parsed, candidate) }))
    .sort((a, b) => b.metrics.score - a.metrics.score);

  const checked = [...new Set(available)];
  const evidenceBase = scholarlyEvidenceLinks(parsed, parsed.doi);
  if (!checked.length) {
    return {
      status: "unverified",
      confidence: 0,
      submitted: reference,
      differences: [],
      note: `已尝试 ${jobs.map((job) => job.source).join("、")}，但核验源没有在本次限时内返回。未能自动确认不等于文献虚假，请使用复核链接继续核对。`,
      checkedSources: [],
      evidenceLinks: evidenceBase
    };
  }
  if (!candidates.length) {
    return {
      status: "unverified",
      confidence: 0,
      submitted: reference,
      differences: [],
      note: `已查询 ${checked.join("、")}，未检出可自动确认的记录。未收录不等于虚假，请使用复核链接继续核对。`,
      checkedSources: checked,
      evidenceLinks: evidenceBase
    };
  }

  const best = ranked[0];
  const confidence = best.metrics.score;
  const evidenceLinks = scholarlyEvidenceLinks(parsed, best.candidate.doi || parsed.doi);
  if (confidence < 0.67) {
    return {
      status: "unverified",
      confidence,
      submitted: reference,
      differences: [],
      note: `已查询 ${checked.join("、")}，但没有找到足以确认的同一文献；这可能是未收录或著录信息不足。`,
      checkedSources: checked,
      evidenceLinks
    };
  }

  const differences = academicDifferences(parsed, best.candidate, best.metrics);
  const source = best.candidate.sources.join(" + ");
  if (confidence < 0.8) {
    return {
      status: "review",
      confidence,
      authenticityConfidence: confidence,
      submitted: reference,
      differences,
      accuracyDifferences: differences,
      note: `在 ${source} 找到近似记录，但匹配度尚不足以自动确认，请人工复核。`,
      canonical: canonicalCitation(best.candidate, parsed),
      sourceUrl: best.candidate.sourceUrl,
      source,
      checkedSources: checked,
      evidenceLinks
    };
  }

  const partialFields = [...new Set([
    ...(best.candidate.partialFields || []),
    ...missingMetadataFields(parsed, best.candidate)
  ])];
  const snippetEvidence = best.candidate.evidenceStrength === "search-snippet";
  const status = differences.length
    ? "corrected"
    : snippetEvidence || partialFields.length
      ? "partial"
      : "verified";
  let note = snippetEvidence
    ? "已在搜索引擎结果摘要中找到篇名及其他身份字段一致的记录，可确认文献存在；卷期页、年份和文献类型属于著录准确性问题，仍建议打开来源页复核。"
    : differences.length
    ? `已在 ${source} 确认该文献真实存在；以下差异不降低真实性置信度，但建议按来源记录修正著录。`
    : `已在 ${source} 找到身份字段高度一致的记录，可确认该文献真实存在。`;
  if (partialFields.length && !differences.length) {
    note += ` 来源记录未完整提供${partialFields.join("、")}，这些字段暂时保留原著录。`;
  }
  if (partialFields.length && differences.length) {
    note += ` 来源记录未完整提供${partialFields.join("、")}，相关原著录仍需复核。`;
  }

  return {
    status,
    confidence,
    authenticityConfidence: confidence,
    submitted: reference,
    differences,
    accuracyDifferences: differences,
    authenticityBasis: best.metrics.basis,
    note,
    canonical: canonicalCitation(best.candidate, parsed),
    sourceUrl: best.candidate.sourceUrl,
    source,
    checkedSources: checked,
    evidenceLinks
  };
}

async function verifyReference(reference) {
  const parsed = parseReference(reference);
  const type = String(parsed.type || "").toUpperCase();
  if (
    type.includes("/OL") ||
    (parsed.url && !parsed.doi && (
      !type ||
      ["EB", "DB", "CP", "N", "S", "P"].includes(baseReferenceType(type))
    ))
  ) {
    return verifyWebReference(reference, parsed);
  }
  try {
    return await verifyAcademicReference(reference, parsed);
  } catch (error) {
    return {
      status: "error",
      confidence: 0,
      submitted: reference,
      differences: [],
      note: `核验失败：${error.name === "AbortError" ? "开放数据源连接超时" : error.message || "网络错误"}。可使用复核链接继续核对。`,
      checkedSources: [],
      evidenceLinks: scholarlyEvidenceLinks(parsed, parsed.doi)
    };
  }
}

module.exports = {
  verifyReference,
  parseReference,
  buildVerificationPlan,
  diceSimilarity,
  normalizeText
};
