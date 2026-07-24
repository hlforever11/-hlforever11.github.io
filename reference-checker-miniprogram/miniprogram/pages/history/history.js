const app = getApp();

Page({
  data: {
    loading: true,
    records: [],
    errorMessage: ""
  },

  onLoad() {
    this.loadHistory();
  },

  async callHistory(data) {
    if (!wx.cloud || !app.globalData.cloudAvailable) {
      throw new Error("云服务尚未配置。");
    }
    const response = await wx.cloud.callFunction({
      name: "userHistory",
      data
    });
    return response.result || {};
  },

  async loadHistory() {
    try {
      this.setData({ loading: true, errorMessage: "" });
      const result = await this.callHistory({ action: "list" });
      if (!result.ok) throw new Error(result.message || "读取历史记录失败。");
      this.setData({
        records: (result.records || []).map((record) => ({
          ...record,
          createdText: this.formatTime(record.createdAt)
        }))
      });
    } catch (error) {
      this.setData({ errorMessage: error?.message || "读取历史记录失败。" });
    } finally {
      this.setData({ loading: false });
    }
  },

  formatTime(timestamp) {
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) return "";
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },

  reuseRecord(event) {
    const id = event.currentTarget.dataset.id;
    const record = this.data.records.find((item) => item._id === id);
    if (!record?.input) return;
    wx.setStorageSync("historyReplay", record.input);
    wx.navigateBack();
  },

  deleteRecord(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.showModal({
      title: "删除这条记录？",
      content: "删除后无法恢复。",
      confirmText: "删除",
      confirmColor: "#9d4036",
      success: async ({ confirm }) => {
        if (!confirm) return;
        try {
          const result = await this.callHistory({ action: "remove", id });
          if (!result.ok) throw new Error(result.message || "删除失败。");
          this.setData({
            records: this.data.records.filter((item) => item._id !== id)
          });
          wx.showToast({ title: "已删除", icon: "success" });
        } catch (error) {
          wx.showToast({ title: error?.message || "删除失败", icon: "none" });
        }
      }
    });
  },

  clearHistory() {
    if (!this.data.records.length) return;
    wx.showModal({
      title: "清空全部历史记录？",
      content: "所有核验记录都将永久删除。",
      confirmText: "全部删除",
      confirmColor: "#9d4036",
      success: async ({ confirm }) => {
        if (!confirm) return;
        try {
          const result = await this.callHistory({ action: "clear" });
          if (!result.ok) throw new Error(result.message || "清空失败。");
          this.setData({ records: [] });
          wx.showToast({ title: "已清空", icon: "success" });
        } catch (error) {
          wx.showToast({ title: error?.message || "清空失败", icon: "none" });
        }
      }
    });
  }
});
