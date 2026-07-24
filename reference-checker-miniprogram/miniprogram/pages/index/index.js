const app = getApp();
const {
  splitReferences,
  extractReferencesFromDocument
} = require("../../utils/references");

const MAX_REFERENCES = 20;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const SAMPLE = [
  "[1] 李书宁,刘一鸣.ChatGPT类智能对话工具兴起对图书馆行业的机遇与挑战[J].图书馆论坛,2023,43(05):104-110.",
  "[2] 陈金榜.朱民博士畅谈ChatGPT与人工智能未来[EB/OL].(2023-03-13)[2023-04-18]. https://www.shanghaitech.edu.cn/2023/0313/c1001a1075770/page.htm.",
  "[3] RADFORD A, WU J, CHILD R, et al. Language models are unsupervised multitask learners[J]. OpenAI Blog, 2019, 1(8): 9."
].join("\n");

const STATUS_META = {
  verified: { label: "真实且字段一致", mark: "✓" },
  partial: { label: "真实，部分字段待复核", mark: "✓" },
  corrected: { label: "真实但需要修正", mark: "!" },
  review: { label: "找到近似记录", mark: "?" },
  unverified: { label: "暂未核实", mark: "—" },
  error: { label: "核验失败", mark: "×" }
};

Page({
  data: {
    inputValue: "",
    count: 0,
    maxReferences: MAX_REFERENCES,
    canVerify: false,
    loading: false,
    progressText: "",
    fileMessage: "",
    fileMessageType: "",
    results: [],
    summary: [],
    showResults: false,
    historyEnabled: false,
    accountLoading: false,
    historyCount: 0
  },

  onLoad() {
    this.restoreHistoryState();
  },

  onShow() {
    const replay = wx.getStorageSync("historyReplay");
    if (replay) {
      wx.removeStorageSync("historyReplay");
      this.resetResults();
      this.updateInput(replay);
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    }
    if (this.data.historyEnabled) this.refreshHistoryCount();
  },

  onShareAppMessage() {
    return {
      title: "文证：参考文献真实性与准确性核验",
      path: "/pages/index/index"
    };
  },

  onShareTimeline() {
    return {
      title: "文证：参考文献真实性与准确性核验"
    };
  },

  onInput(event) {
    this.updateInput(event.detail.value);
  },

  updateInput(value) {
    const count = splitReferences(value).length;
    this.setData({
      inputValue: value,
      count,
      canVerify: Boolean(count && count <= MAX_REFERENCES && !this.data.loading)
    });
  },

  fillSample() {
    this.resetResults();
    this.updateInput(SAMPLE);
  },

  clearInput() {
    this.setData({
      inputValue: "",
      count: 0,
      canVerify: false,
      fileMessage: "",
      fileMessageType: ""
    });
    this.resetResults();
  },

  resetResults() {
    this.setData({
      results: [],
      summary: [],
      showResults: false,
      progressText: ""
    });
  },

  chooseDocument() {
    if (this.data.loading) return;
    wx.chooseMessageFile({
      count: 1,
      type: "file",
      extension: ["txt", "docx", "pdf"],
      success: ({ tempFiles }) => {
        const file = tempFiles?.[0];
        if (file) this.handleDocument(file);
      },
      fail: (error) => {
        if (!String(error?.errMsg || "").includes("cancel")) {
          this.showFileMessage("未能读取所选文件，请重试。", "error");
        }
      }
    });
  },

  async handleDocument(file) {
    try {
      const extension = String(file.name || "").split(".").pop().toLowerCase();
      if (!["txt", "docx", "pdf"].includes(extension)) {
        throw new Error("暂只支持 TXT、DOCX 和文字版 PDF。");
      }
      if (file.size > MAX_FILE_SIZE) {
        throw new Error("文件不能超过 10 MB。");
      }

      this.showFileMessage(`正在读取 ${file.name}…`, "working");
      let list;
      if (extension === "txt") {
        const text = await this.readTextFile(file.path);
        list = extractReferencesFromDocument(text);
      } else {
        this.ensureCloudAvailable();
        const cloudPath = `temporary/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
        let fileID = "";
        try {
          const upload = await wx.cloud.uploadFile({
            cloudPath,
            filePath: file.path
          });
          fileID = upload.fileID;
          const temp = await wx.cloud.getTempFileURL({
            fileList: [fileID]
          });
          const tempUrl = temp.fileList?.[0]?.tempFileURL;
          if (!tempUrl) throw new Error("未能生成临时文件地址。");
          const response = await this.callCloud("extractDocument", {
            tempUrl,
            fileName: file.name
          });
          if (!response.ok) throw new Error(response.message || "文档解析失败。");
          list = response.references || [];
        } finally {
          if (fileID) {
            try {
              await wx.cloud.deleteFile({ fileList: [fileID] });
            } catch (cleanupError) {
              console.warn("temporary file cleanup failed", cleanupError);
            }
          }
        }
      }

      if (!list.length) throw new Error("文档中没有识别出参考文献。");
      const shown = list.slice(0, MAX_REFERENCES);
      this.resetResults();
      this.updateInput(shown.join("\n"));
      const suffix = list.length > MAX_REFERENCES ? "，已载入前 20 条" : "";
      this.showFileMessage(`识别出 ${list.length} 条参考文献${suffix}。`, "success");
    } catch (error) {
      this.showFileMessage(error?.message || "读取文档失败。", "error");
    }
  },

  readTextFile(filePath) {
    return new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath,
        encoding: "utf8",
        success: ({ data }) => resolve(data),
        fail: () => reject(new Error("TXT 文件读取失败，请确认文件编码为 UTF-8。"))
      });
    });
  },

  showFileMessage(message, type) {
    this.setData({
      fileMessage: message,
      fileMessageType: type
    });
  },

  ensureCloudAvailable() {
    if (!wx.cloud || !app.globalData.cloudAvailable) {
      throw new Error("核验服务尚未配置，请联系小程序管理员。");
    }
  },

  async callCloud(name, data) {
    const response = await wx.cloud.callFunction({ name, data });
    return response.result || {};
  },

  restoreHistoryState() {
    const historyEnabled = wx.getStorageSync("historyEnabled") === true;
    this.setData({ historyEnabled });
    if (historyEnabled) this.refreshHistoryCount();
  },

  async enableHistory() {
    if (this.data.accountLoading) return;
    try {
      this.ensureCloudAvailable();
      this.setData({ accountLoading: true });
      const result = await this.callCloud("userHistory", { action: "login" });
      if (!result.ok) throw new Error(result.message || "登录失败。");
      wx.setStorageSync("historyEnabled", true);
      this.setData({
        historyEnabled: true,
        historyCount: Number(result.historyCount || 0)
      });
      wx.showToast({ title: "历史记录已启用", icon: "success" });
    } catch (error) {
      wx.showModal({
        title: "暂时无法启用",
        content: error?.message || "请稍后重试。",
        showCancel: false
      });
    } finally {
      this.setData({ accountLoading: false });
    }
  },

  disableHistory() {
    wx.showModal({
      title: "停止保存历史记录？",
      content: "已有记录不会被删除，重新启用后仍可查看。",
      confirmText: "停止保存",
      success: ({ confirm }) => {
        if (!confirm) return;
        wx.removeStorageSync("historyEnabled");
        this.setData({ historyEnabled: false });
      }
    });
  },

  openHistory() {
    wx.navigateTo({ url: "/pages/history/history" });
  },

  async refreshHistoryCount() {
    try {
      const result = await this.callCloud("userHistory", { action: "list" });
      if (result.ok) this.setData({ historyCount: Number(result.total || 0) });
    } catch (error) {
      console.warn("history count refresh failed", error);
    }
  },

  async saveHistory(references, results) {
    if (!this.data.historyEnabled) return;
    try {
      const result = await this.callCloud("userHistory", {
        action: "save",
        input: references.join("\n"),
        results
      });
      if (result.ok) {
        this.setData({ historyCount: Number(result.total || this.data.historyCount + 1) });
      }
    } catch (error) {
      console.warn("history save failed", error);
      wx.showToast({ title: "本次记录未能保存", icon: "none" });
    }
  },

  async verifyAll() {
    const references = splitReferences(this.data.inputValue);
    if (!references.length) return;
    if (references.length > MAX_REFERENCES) {
      wx.showToast({ title: "一次最多核验 20 条", icon: "none" });
      return;
    }

    try {
      this.ensureCloudAvailable();
    } catch (error) {
      wx.showModal({
        title: "核验服务不可用",
        content: error.message,
        showCancel: false
      });
      return;
    }

    this.setData({
      loading: true,
      canVerify: false,
      showResults: true,
      results: [],
      summary: this.buildSummary([]),
      progressText: `0 / ${references.length}`
    });

    const output = new Array(references.length);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < references.length) {
        const index = next++;
        try {
          const result = await this.callCloud("verifyReference", {
            reference: references[index]
          });
          output[index] = this.prepareResult(result, references[index], index);
        } catch (error) {
          console.error("verifyReference cloud call failed", {
            index,
            reference: references[index],
            error
          });
          output[index] = this.prepareResult({
            status: "error",
            confidence: 0,
            note: "核验服务暂时无法连接，请稍后重试。",
            differences: [],
            evidenceLinks: []
          }, references[index], index);
        }
        done += 1;
        const visible = output.filter(Boolean);
        this.setData({
          results: visible,
          summary: this.buildSummary(visible),
          progressText: `${done} / ${references.length}`
        });
      }
    };

    await Promise.all(Array.from({ length: Math.min(2, references.length) }, worker));
    this.setData({
      loading: false,
      canVerify: true,
      progressText: `已完成 ${references.length} 条`
    });
    await this.saveHistory(references, output.filter(Boolean));
    wx.pageScrollTo({ selector: "#results", duration: 260 });
  },

  prepareResult(result, submitted, index) {
    const status = STATUS_META[result.status] ? result.status : "error";
    const meta = STATUS_META[status];
    const links = [];
    if (result.sourceUrl) {
      links.push({
        label: `复制${result.source || "来源"}链接`,
        url: result.sourceUrl
      });
    }
    (result.evidenceLinks || []).forEach((link) => {
      if (link?.url && !links.some((item) => item.url === link.url)) links.push(link);
    });

    return {
      ...result,
      submitted: result.submitted || submitted,
      status,
      statusLabel: meta.label,
      statusMark: meta.mark,
      displayIndex: index + 1,
      confidencePercent: Math.round(Number(result.confidence || 0) * 100),
      differences: result.differences || [],
      links
    };
  },

  buildSummary(results) {
    const counts = {
      confirmed: 0,
      corrected: 0,
      review: 0,
      unresolved: 0
    };
    results.forEach((result) => {
      if (result.status === "verified" || result.status === "partial") counts.confirmed += 1;
      else if (result.status === "corrected") counts.corrected += 1;
      else if (result.status === "review") counts.review += 1;
      else counts.unresolved += 1;
    });
    return [
      { label: "已确认", value: counts.confirmed },
      { label: "需修正", value: counts.corrected },
      { label: "待复核", value: counts.review },
      { label: "未核实/失败", value: counts.unresolved }
    ];
  },

  copyUrl(event) {
    const url = event.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: "链接已复制", icon: "success" })
    });
  },

  copyCitation(event) {
    const citation = event.currentTarget.dataset.citation;
    if (!citation) return;
    wx.setClipboardData({
      data: citation,
      success: () => wx.showToast({ title: "建议著录已复制", icon: "success" })
    });
  }
});
