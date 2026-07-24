App({
  globalData: {
    cloudAvailable: false,
    envId: "cloud1-d6gtx1retbc8754fa"
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error("当前微信版本不支持云开发");
      return;
    }

    wx.cloud.init({
      env: this.globalData.envId,
      traceUser: true
    });
    this.globalData.cloudAvailable = true;
  }
});
