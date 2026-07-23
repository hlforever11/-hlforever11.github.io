const iconv = require("iconv-lite");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");
const { extractReferences } = require("./lib/references");

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_TEXT_LENGTH = 2 * 1024 * 1024;

function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return iconv.decode(buffer, "utf16-le");
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return iconv.decode(buffer, "utf16-be");
  }
  return iconv.decode(buffer, "utf8");
}

async function extractText(buffer, extension) {
  if (extension === "txt") return decodeText(buffer);
  if (extension === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }
  if (extension === "pdf") {
    const result = await pdfParse(buffer, {
      max: 101
    });
    if (result.numpages > 100) {
      throw new Error("PDF 超过 100 页，请只上传包含参考文献的部分。");
    }
    if (!String(result.text || "").trim()) {
      throw new Error("PDF 没有可提取文字，扫描版 PDF 请先进行文字识别。");
    }
    return result.text;
  }
  throw new Error("暂只支持 TXT、DOCX 和文字版 PDF。");
}

function permittedTemporaryUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return (
      host.endsWith(".tcb.qcloud.la") ||
      host.endsWith(".tcb.qcloud.com") ||
      host.endsWith(".cloudbase.net") ||
      host.endsWith(".tcloudbaseapp.com") ||
      /\.cos\.[a-z0-9-]+\.myqcloud\.com$/.test(host) ||
      host.endsWith(".file.myqcloud.com")
    );
  } catch {
    return false;
  }
}

async function downloadTemporaryFile(tempUrl) {
  if (!permittedTemporaryUrl(tempUrl)) {
    throw new Error("临时文件地址无效。");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(tempUrl, {
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`临时文件下载失败（HTTP ${response.status}）。`);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_FILE_SIZE) throw new Error("文件不能超过 10 MB。");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_FILE_SIZE) throw new Error("文件不能超过 10 MB。");
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

exports.main = async (event) => {
  const tempUrl = String(event?.tempUrl || "");
  const fileName = String(event?.fileName || "");
  const extension = fileName.split(".").pop().toLowerCase();
  if (!tempUrl || !["txt", "docx", "pdf"].includes(extension)) {
    return {
      ok: false,
      message: "文件信息不完整或格式不受支持。"
    };
  }

  try {
    const buffer = await downloadTemporaryFile(tempUrl);
    if (!buffer.length) throw new Error("上传文件为空。");

    const text = await extractText(buffer, extension);
    if (text.length > MAX_TEXT_LENGTH) {
      throw new Error("文档文字过多，请只保留参考文献部分后重新上传。");
    }
    const references = extractReferences(text);
    return {
      ok: true,
      total: references.length,
      references: references.slice(0, 20)
    };
  } catch (error) {
    console.error("extractDocument failed", error);
    return {
      ok: false,
      message: error?.message || "文档解析失败。"
    };
  }
};
