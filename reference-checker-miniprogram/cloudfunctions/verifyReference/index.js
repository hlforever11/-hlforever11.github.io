const { verifyReference } = require("./lib/core");

exports.main = async (event) => {
  const reference = String(event?.reference || "").replace(/\s+/g, " ").trim();
  if (!reference) {
    return {
      status: "error",
      confidence: 0,
      submitted: "",
      differences: [],
      note: "没有收到参考文献内容。",
      evidenceLinks: []
    };
  }
  if (reference.length > 5000) {
    return {
      status: "error",
      confidence: 0,
      submitted: reference.slice(0, 5000),
      differences: [],
      note: "单条参考文献内容过长，无法核验。",
      evidenceLinks: []
    };
  }

  try {
    return await verifyReference(reference);
  } catch (error) {
    console.error("verifyReference failed", error);
    return {
      status: "error",
      confidence: 0,
      submitted: reference,
      differences: [],
      note: `核验服务发生错误：${error?.message || "未知错误"}。请稍后重试。`,
      evidenceLinks: []
    };
  }
};
