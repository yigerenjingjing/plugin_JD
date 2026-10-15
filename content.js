/**
 * 内容脚本：接收后台指令，在京东页面上执行读取和滚动。
 *
 * 这个脚本跑在隔离世界里，页面自身的 JavaScript 看不到它，
 * 因此读取 DOM 这个动作本身不会给页面留下痕迹。
 * 所有的网络请求都由页面自己发出，这里不构造任何接口调用。
 */

(() => {
  // 防止同一个页面重复注入（SPA 跳转时可能出现）
  if (globalThis.__JD_PLUGIN_LOADED__) return;
  globalThis.__JD_PLUGIN_LOADED__ = true;

  /** 在页面里等待某个条件成立，带超时。 */
  async function waitFor(fn, timeout, interval = 300) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (fn()) return true;
      } catch (e) {
        // 忽略，继续等
      }
      await JD.sleep(interval);
    }
    return false;
  }

  const handlers = {
    /** 页面探测：报告页面类型和 SKU。 */
    ping() {
      return {
        pageType: JD.detectPageType(),
        sku: JD.getSkuFromLink(location.href),
        url: location.href,
        title: document.title
      };
    },

    /** 搜索结果页：提取商品列表。 */
    'extract-products'(payload) {
      const products = JD.extractProductList(payload.limit || 3);
      return { products };
    },

    /**
     * 商品详情页：只提取商品字段。
     *
     * 评论不在这里采。必须先点「全部评价」进入评论区，而点击可能触发
     * 页面跳转把本脚本销毁，所以那一步由后台单独发起、单独判断结果。
     * 详情提取和评论采集因此拆成两个阶段。
     */
    async 'extract-product'() {
      await JD.waitPageReady();
      return { detail: JD.extractProductDetail() };
    },

    /**
     * 滚到评论区并确认「全部评价」入口是否存在。
     *
     * 评论区和这个按钮都是懒渲染的：页面刚打开停在顶部时，
     * DOM 里根本没有它们，直接找必然失败。所以点击之前必须先滚过去。
     */
    async 'prepare-comments'() {
      const sectionFound = await JD.scrollToCommentArea();
      await JD.sleep(600);
      return {
        sectionFound,
        buttonFound: Boolean(JD.pickMixed(document, JD.SELECTORS.ALL_COMMENT_BUTTON))
      };
    },

    /**
     * 点击「全部评价」进入完整评论区。
     * 保持同步：点击可能触发跳转把本脚本销毁，异步函数会执行不完。
     */
    'expand-comments'() {
      return JD.expandAllComments();
    },

    /** 页面诊断：先激活评论区，再报告选择器命中情况和真实 DOM 结构。 */
    'diagnose'(payload) {
      return JD.diagnose(payload || {});
    },

    /**
     * 在当前页面滚动采集评论。
     * 用于「全部评价」原地展开后补采，以及跳转到完整评论页之后的采集。
     */
    async 'collect-comments'(payload) {
      await JD.waitPageReady();
      // 先记录滚动目标，回给后台写进日志，方便确认到底滚的是哪个元素
      const scrollTarget = JD.describeCommentScrollTarget();
      const comments = await JD.collectComments(payload.comments || 10);
      // 带上采集遥测，后台会写进日志
      return { comments, scrollTarget, stats: JD.lastCollectStats || null };
    },

    /** 检查页面上是否存在「全部评价」入口，供后台决定跳转方式。 */
    'has-comment-entry'() {
      return { hasEntry: Boolean(JD.pickMixed(document, JD.SELECTORS.ALL_COMMENT_BUTTON)) };
    }
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handler = handlers[message && message.action];

    if (!handler) {
      sendResponse({ ok: false, error: `未知指令: ${message && message.action}` });
      return false;
    }

    // 统一包装成 {ok, data} 或 {ok:false, error}，后台只认这一种形状
    Promise.resolve()
      .then(() => handler(message.payload || {}))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));

    // 返回 true 表示会异步调用 sendResponse
    return true;
  });

  // 暴露给后台的一个小工具：等待页面就绪后再回消息
  globalThis.__JD_WAIT_FOR__ = waitFor;
})();
